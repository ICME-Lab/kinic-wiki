import CryptoKit
import Foundation
import ICNativeClient
import KinicVaultCore
import Testing
@testable import KinicVaultNative

// Test-only HTTPS facade: forwards bytes to the local PocketIC HTTP gateway.
// ICNativeClient still verifies the real canister reply certificate and signatures.
private final class LocalReplicaProtocol: URLProtocol, @unchecked Sendable {
    private var forwarded: URLSessionDataTask?
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "native-vault.test" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let file = ProcessInfo.processInfo.environment["KINIC_NATIVE_VAULT_FIXTURE"]!
            let fixture = try JSONDecoder().decode(LocalFixture.self, from: Data(contentsOf: URL(fileURLWithPath: file)))
            let original = request.url!
            var proxied = request
            proxied.url = URL(string: fixture.replica)!.appending(path: original.path)
            if let stream = request.httpBodyStream, request.httpBody == nil {
                stream.open(); defer { stream.close() }
                var body = Data(); var buffer = [UInt8](repeating: 0, count: 4096)
                while stream.hasBytesAvailable {
                    let n = stream.read(&buffer, maxLength: buffer.count)
                    guard n >= 0 else { throw VaultNativeError.invalidResponse }
                    if n == 0 { break }
                    body.append(contentsOf: buffer.prefix(n))
                }
                proxied.httpBodyStream = nil; proxied.httpBody = body
            }
            forwarded = URLSession.shared.dataTask(with: proxied) { data, response, error in
                if let error { self.client?.urlProtocol(self, didFailWithError: error); return }
                guard let response = response as? HTTPURLResponse, let data else { self.client?.urlProtocol(self, didFailWithError: VaultNativeError.invalidResponse); return }
                let headers = response.allHeaderFields.reduce(into: [String: String]()) { $0[String(describing: $1.key)] = String(describing: $1.value) }
                let mapped = HTTPURLResponse(url: original, statusCode: response.statusCode, httpVersion: "HTTP/1.1", headerFields: headers)!
                self.client?.urlProtocol(self, didReceive: mapped, cacheStoragePolicy: .notAllowed)
                self.client?.urlProtocol(self, didLoad: data)
                self.client?.urlProtocolDidFinishLoading(self)
            }
            forwarded?.resume()
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() { forwarded?.cancel() }
}
private struct LocalFixture: Decodable {
    let replica: String
    let canister: String
    let rootKey: Data
    let seed: Data
    let principal: String
    let swiftCipherOutput: String
}

@MainActor @Test(.enabled(if: ProcessInfo.processInfo.environment["KINIC_NATIVE_VAULT_FIXTURE"] != nil))
func localReplicaRoundTrip() async throws {
    let fixtureURL = URL(fileURLWithPath: ProcessInfo.processInfo.environment["KINIC_NATIVE_VAULT_FIXTURE"]!)
    let fixture = try JSONDecoder().decode(LocalFixture.self, from: Data(contentsOf: fixtureURL))
    let configuration = try ICClientConfiguration(canisterId: fixture.canister, apiBaseURL: URL(string: "https://native-vault.test")!, internetIdentityURL: URL(string: "https://native-ii.test/authorize")!, derivationOrigin: "https://\(fixture.canister).native-vault.test", trustRoot: .custom(fixture.rootKey))
    let identity = try ICAuthSession.delegating(ed25519PrivateKey: fixture.seed, configuration: configuration)
    #expect(identity.principal == fixture.principal)
    let settings = URLSessionConfiguration.ephemeral; settings.protocolClasses = [LocalReplicaProtocol.self]
    let session = URLSession(configuration: settings)
    defer { session.invalidateAndCancel() }
    let client = VaultNativeClient(configuration: configuration, local: true, session: session)
    let headers = try await client.ownedVaults(identity: identity)
    #expect(headers.count == 1)
    let payload = try await client.fetchSnapshot(header: #require(headers.first), identity: identity)
    #expect(payload.snapshot.records.count == 1)
    let url = fixtureURL.deletingLastPathComponent().appendingPathComponent("autofill-cache.json")
    let store = VaultAutoFillSnapshotStore(fileURL: url)
    let keys = TestKeys(); let identities = TestIdentities()
    let controller = VaultAutoFillSyncController(snapshotStore: store, keys: keys, identities: identities)
    try await controller.synchronize(context: payload.snapshot.context) { payload }
    #expect(identities.candidates.count == 1)
    let candidate = try #require(identities.candidates.first)
    let credential = try store.decryptCredential(recordIdentifier: candidate.recordIdentifier, rootKey: keys.load(context: payload.snapshot.context))
    #expect(credential?.username == "native-user")
    #expect(credential?.password == "local-only-password")
    #expect(credential?.totpCode?.count == 6)
    #expect(!(try String(contentsOf: url, encoding: .utf8)).contains("local-only-password"))
    // Verify Swift write mutations (RenameVault, SaveInline create & update, DeleteObject) against the real canister.
    let selected = try #require(headers.first)
    try await client.renameVault(header: selected, name: "Swift Renamed Vault", identity: identity)
    let renamedHeaders = try await client.ownedVaults(identity: identity)
    let renamed = try #require(renamedHeaders.first(where: { $0.id == selected.id }))
    #expect(renamed.name == "Swift Renamed Vault")

    let createdRecord = VaultCredentialRecord(
        label: "Swift Created Login",
        username: "swift-user@example.com",
        password: "initial-swift-password",
        url: "https://swift.example.com/login",
        urls: ["https://swift.example.com/login"],
        totp: "JBSWY3DPEHPK3PXP",
        notes: "Created from iOS",
        customFields: [VaultCustomField(label: "PIN", value: "1234", hidden: true)],
        favorite: true,
        tags: ["ios"]
    )
    let created = try await client.saveInline(
        header: renamed,
        metadata: VaultCredentialCodec.buildMetadata(title: "Swift Created Login", record: createdRecord),
        plaintext: try VaultCredentialCodec.serialize(createdRecord),
        identity: identity
    )
    #expect(created.revision == 1)

    var updatedRecord = createdRecord
    updatedRecord.password = "updated-swift-password"
    updatedRecord.customFields = [VaultCustomField(label: "PIN", value: "5678", hidden: true)]
    let updated = try await client.saveInline(
        header: renamed,
        metadata: VaultCredentialCodec.buildMetadata(title: "Swift Created Login", record: updatedRecord),
        plaintext: try VaultCredentialCodec.serialize(updatedRecord),
        existingObject: try Base64URL.decode(created.snapshotRecord.objectIdBase64URL),
        expectedRevision: created.revision,
        identity: identity
    )
    #expect(updated.revision == 2)

    let tempNote = try await client.saveInline(
        header: renamed,
        metadata: VaultMetadata(kind: .note, title: "Temporary Note"),
        plaintext: Data("delete me".utf8),
        identity: identity
    )
    try await client.deleteObject(
        header: renamed,
        object: try Base64URL.decode(tempNote.snapshotRecord.objectIdBase64URL),
        expectedRevision: tempNote.revision,
        identity: identity
    )

    let refreshed = try await client.fetchSnapshot(header: renamed, identity: identity)
    #expect(refreshed.snapshot.records.count == 2)
    let refreshedItems = try refreshed.snapshot.listItems(rootKey: refreshed.rootKey)
    #expect(refreshedItems.contains(where: { $0.title == "Swift Created Login" && $0.revision == 2 }))
    #expect(!refreshedItems.contains(where: { $0.title == "Temporary Note" }))

    // Return ciphertext only; Node decrypts it with the existing non-extractable Web key.
    let object = Data(repeating: 44, count: 16)
    let encrypted = try VaultDocumentV3.encrypt(rootKey: payload.rootKey, context: payload.snapshot.context, object: object, revision: 1, metadata: VaultMetadata(kind: .note, title: "Swift interoperability"), plaintext: Data("Swift to Web root continuity".utf8))
    let output: [String: Any] = ["manifest": Base64URL.encode(encrypted.manifest), "chunks": encrypted.chunks.map(Base64URL.encode), "hashes": encrypted.hashes.map(Base64URL.encode), "object": Base64URL.encode(object), "savedObject": created.snapshotRecord.objectIdBase64URL]
    try JSONSerialization.data(withJSONObject: output).write(to: URL(fileURLWithPath: fixture.swiftCipherOutput))
    try await controller.disable()
    #expect(try store.load() == nil)
    #expect(identities.candidates.isEmpty)
}
