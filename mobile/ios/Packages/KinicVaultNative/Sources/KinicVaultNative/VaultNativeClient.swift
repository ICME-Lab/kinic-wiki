import CryptoKit
import Foundation
import ICNativeClient
import KinicVaultCore
import Security

public enum VaultNativeError: Error, LocalizedError {
    case invalidResponse, rejected, accessLost, changedDuringSync, snapshotTooLarge, providerDisabled, cleanupFailed
    public var errorDescription: String? {
        switch self {
        case .providerDisabled: "Enable Kinic Vault in iOS AutoFill settings, then return and sync again."
        case .cleanupFailed: "Offline Vault cleanup is incomplete. Try disabling again."
        case .invalidResponse: "The Vault response was invalid."
        case .accessLost: "Access to this Vault was lost. Its offline cache has been removed."
        case .rejected: "The Vault rejected this request. Check access and local operating credit."
        case .changedDuringSync: "The Vault changed during synchronization. Try again."
        case .snapshotTooLarge: "This Vault exceeds the offline AutoFill cache limit."
        }
    }
}

enum VaultWire {
    static func unwrap(_ value: CandidValue) throws -> CandidValue {
        guard case .variant(let result) = value else { throw VaultNativeError.invalidResponse }
        guard result.tag == Candid.fieldID("Ok") else {
            if case .variant(let error) = result.value,
               ["Unauthorized", "NotFound", "VaultInactive"].contains(where: { Candid.fieldID($0) == error.tag }) {
                throw VaultNativeError.accessLost
            }
            throw VaultNativeError.rejected
        }
        return result.value
    }
    static func field<T: CandidConvertible>(_ name: String, _ value: CandidValue, as: T.Type = T.self) throws -> T {
        guard case .record(_, let values) = value, let field = values[Candid.fieldID(name)] else { throw VaultNativeError.invalidResponse }
        return try T(candidValue: field)
    }
    static func rawField(_ name: String, _ value: CandidValue) throws -> CandidValue {
        guard case .record(_, let values) = value, let field = values[Candid.fieldID(name)] else { throw VaultNativeError.invalidResponse }
        return field
    }
    static func array(_ value: CandidValue) throws -> [CandidValue] {
        guard case .vector(_, let values) = value else { throw VaultNativeError.invalidResponse }
        return values
    }
    static func arguments(_ values: CandidTypedValue...) -> CandidArguments { CandidArguments(values) }
    static func bytesRecord(_ entries: [(String, Data)]) throws -> CandidArguments {
        let fields = entries.map { CandidField($0.0, type: .vector(.nat8)) }
        let value = CandidValue.record(fields, Dictionary(uniqueKeysWithValues: entries.map { (Candid.fieldID($0.0), .blob($0.1)) }))
        return CandidArguments([try CandidTypedValue(type: .record(fields), value: value)])
    }
}

public struct VaultNativeHeader: Sendable, Identifiable, Equatable {
    public let id: Data
    public let name: String
    public let nonce: Data
    public let keyName: String
    public let publicKey: Data
    public let sequence: UInt64
    init(_ value: CandidValue) throws {
        id = try VaultWire.field("id", value)
        nonce = try VaultWire.field("nonce", value)
        publicKey = try VaultWire.field("public_key", value)
        keyName = try VaultWire.field("key_name", value)
        name = try VaultWire.field("name", value, as: Optional<String>.self) ?? "Unnamed Vault"
        sequence = try VaultWire.field("sequence", value)
        guard case .variant(let state) = try VaultWire.rawField("state", value) else { throw VaultNativeError.invalidResponse }
        if ["Deleting", "Pending"].contains(where: { state.tag == Candid.fieldID($0) }) { throw VaultNativeError.accessLost }
        guard state.tag == Candid.fieldID("Active"), id.count == 16, nonce.count == 32, publicKey.count == 96, !keyName.isEmpty, keyName.utf8.count <= 64 else { throw VaultNativeError.invalidResponse }
    }
    public func context(canister: String, owner: String) throws -> VaultContext {
        try VaultContext(canister: canister, owner: owner, vault: id, nonce: nonce, keyName: keyName)
    }
}

/// All authorization-sensitive reads use certified update replies, matching Web.
public actor VaultNativeClient {
    private let configuration: ICClientConfiguration
    private let local: Bool
    private let client: ICClient
    private struct Attempt {
        let operation: Data
        let transport: VaultNativeTransport
    }
    private var epoch = 0
    public func forgetKeys() { epoch += 1; attempts.removeAll(); roots.removeAll() }
    private var attempts: [Data: Attempt] = [:]
    private var roots: [Data: SymmetricKey] = [:]

    public init(configuration: ICClientConfiguration, local: Bool, session: URLSession = .shared) {
        self.configuration = configuration; self.local = local
        client = ICClient(configuration: configuration, session: session)
    }
    private func call(_ method: String, _ arguments: CandidArguments = CandidArguments(), identity: ICAuthSession) async throws -> CandidValue {
        try Task.checkCancellation()
        let ticket = epoch
        let reply = try await client.callCandid(method: method, arguments: arguments, identity: identity)
        guard epoch == ticket else { throw CancellationError() }
        guard reply.values.count == 1 else { throw VaultNativeError.invalidResponse }
        return try VaultWire.unwrap(reply.values[0].value)
    }
    public func ownedVaults(identity: ICAuthSession) async throws -> [VaultNativeHeader] {
        let values = try VaultWire.array(await call("list_vaults", identity: identity))
        return try values.compactMap { value in
            guard case .variant(let state) = try VaultWire.rawField("state", value) else { throw VaultNativeError.invalidResponse }
            guard state.tag == Candid.fieldID("Active") else { return nil }
            return try VaultNativeHeader(value)
        }
    }
    private func header(_ id: Data, identity: ICAuthSession) async throws -> VaultNativeHeader {
        try VaultNativeHeader(await call("get_vault_header", CandidArguments(id), identity: identity))
    }
    private static func randomOperation() throws -> Data {
        var bytes = [UInt8](repeating: 0, count: 16)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw VaultCryptoError.randomFailure }
        return Data(bytes)
    }
    public func fetchSnapshot(header selected: VaultNativeHeader, identity: ICAuthSession) async throws -> VaultAutoFillSyncPayload {
        let ticket = epoch
        let first = try await header(selected.id, identity: identity)
        let context = try first.context(canister: configuration.canisterId, owner: identity.principal)
        guard first.nonce == selected.nonce, first.keyName == selected.keyName, first.publicKey == selected.publicKey else { throw VaultNativeError.changedDuringSync }
        var binding = try context.contextInput(); binding.append(first.publicKey)
        let root: SymmetricKey
        if let cached = roots[binding] { root = cached }
        else {
            let attempt: Attempt
            if let existing = attempts[binding] { attempt = existing }
            else {
                attempt = Attempt(operation: try Self.randomOperation(), transport: try VaultNativeTransport())
                attempts[binding] = attempt
            }
            // Keep this exact transport+operation until the reply is verified, even on network errors.
            let reply = try await call("derive_vault_key", VaultWire.bytesRecord([("vault", first.id), ("operation", attempt.operation), ("transport", attempt.transport.publicKey)]), identity: identity)
            root = try attempt.transport.rootKey(context: context, headerPublicKey: first.publicKey, replyInput: VaultWire.field("input", reply), replyPublicKey: VaultWire.field("public_key", reply), encryptedKey: VaultWire.field("encrypted_key", reply), local: local)
            guard epoch == ticket else { throw CancellationError() }
            roots[binding] = root
            attempts[binding] = nil
        }
        let before = try await header(first.id, identity: identity)
        guard before.nonce == first.nonce, before.publicKey == first.publicKey, before.keyName == first.keyName else { throw VaultNativeError.changedDuringSync }
        var records: [VaultAutoFillRecordSnapshot] = []
        var cursor = Data()
        var seenCursors = Set<Data>()
        var scanned = 0
        var bytes = 0
        repeat {
            guard seenCursors.insert(cursor).inserted else { throw VaultNativeError.invalidResponse }
            let page = try await call("list_objects", VaultWire.arguments(CandidTypedValue(first.id), CandidTypedValue(cursor)), identity: identity)
            for revision in try VaultWire.array(VaultWire.rawField("entries", page)) {
                scanned += 1
                guard scanned <= 10_000 else { throw VaultNativeError.snapshotTooLarge }
                let deleted: Bool = try VaultWire.field("deleted", revision)
                if deleted { continue }
                let object: Data = try VaultWire.field("object", revision)
                let vault: Data = try VaultWire.field("vault", revision)
                let rev: UInt64 = try VaultWire.field("revision", revision)
                let manifest: Data = try VaultWire.field("manifest", revision)
                guard vault == first.id else { throw VaultNativeError.invalidResponse }
                let parsed = try VaultDocumentV3.readManifest(rootKey: root, context: context, object: object, revision: rev, manifestBytes: manifest)
                guard parsed.metadata.kind == .credential else { continue }
                let hashes: [Data] = try VaultWire.field("chunk_hashes", revision)
                guard hashes.count == parsed.chunkCount else { throw VaultNativeError.invalidResponse }
                var chunks: [Data] = []
                for index in 0..<parsed.chunkCount {
                    chunks.append(try Data(candidValue: await call("get_chunk", VaultWire.arguments(CandidTypedValue(first.id), CandidTypedValue(object), CandidTypedValue(rev), CandidTypedValue(UInt32(index))), identity: identity)))
                }
                // Validate every chunk before publishing a usable offline cache.
                var plaintext = try VaultDocumentV3.decrypt(rootKey: root, context: context, object: object, revision: rev, manifestBytes: manifest, chunks: chunks, hashes: hashes).plaintext
                plaintext.resetBytes(in: 0..<plaintext.count)
                bytes += manifest.count + chunks.reduce(0) { $0 + $1.count }
                guard records.count < 1_000, bytes <= 8 * 1_048_576 else { throw VaultNativeError.snapshotTooLarge }
                records.append(VaultAutoFillRecordSnapshot(objectIdBase64URL: Base64URL.encode(object), revision: rev, manifestBase64URL: Base64URL.encode(manifest), chunksBase64URL: chunks.map(Base64URL.encode), hashesBase64URL: hashes.map(Base64URL.encode)))
            }
            cursor = try VaultWire.field("next", page, as: Optional<Data>.self) ?? Data()
        } while !cursor.isEmpty
        let after = try await header(first.id, identity: identity)
        guard epoch == ticket else { throw CancellationError() }
        guard after == before else { throw VaultNativeError.changedDuringSync }
        return VaultAutoFillSyncPayload(snapshot: VaultAutoFillSnapshot(context: context, records: records), rootKey: root)
    }
}
