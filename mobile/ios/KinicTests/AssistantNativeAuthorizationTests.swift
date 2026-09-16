import CryptoKit
import ICNativeClient
import XCTest
@testable import Kinic

@MainActor
final class AssistantNativeAuthorizationTests: XCTestCase {
    func testLiveDataChannelUsesOpenAIContract() {
        XCTAssertEqual(AssistantAudioSession.eventChannelLabel, "oai-events")
    }

    private func identity(configuration: AppConfiguration = .preview) throws -> KinicIdentitySession {
        let session = try ICAuthSession.delegating(
            ed25519PrivateKey: Data(repeating: 7, count: 32),
            configuration: configuration.makeICClientConfiguration(),
            options: ICAuthenticationOptions(
                maxTimeToLiveNanoseconds: 3_600_000_000_000,
                targets: [configuration.canisterId]
            )
        )
        return KinicIdentitySession(nativeSession: session)
    }

    private func workerPublicKey() -> Data {
        Data([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00])
            + Curve25519.Signing.PrivateKey().publicKey.rawRepresentation
    }

    private func pending(configuration: AppConfiguration = .preview, key: Data? = nil) -> [String: Any] {
        [
            "requestId": "request",
            "publicKey": (key ?? workerPublicKey()).base64EncodedString(),
            "maxTimeToLive": "3000000000000",
            "derivationOrigin": configuration.derivationOrigin,
        ]
    }

    func testExistingSessionCreatesQueryOnlyCanisterScopedChildDelegation() throws {
        let identity = try identity()
        let key = workerPublicKey()
        let value = try AssistantNativeAuthorization().authorize(
            configuration: .preview,
            pending: pending(key: key),
            identity: identity
        ) as! [String: Any]
        let result = value["result"] as! [String: Any]
        let delegations = result["signerDelegation"] as! [[String: Any]]
        let leaf = delegations.last!["delegation"] as! [String: Any]

        XCTAssertEqual(value["id"] as? String, "request")
        XCTAssertEqual(result["publicKey"] as? String, try identity.requireNativeSession().delegation.publicKey.base64EncodedString())
        XCTAssertEqual(leaf["pubkey"] as? String, key.base64EncodedString())
        XCTAssertEqual(leaf["permissions"] as? String, "queries")
        XCTAssertEqual(leaf["targets"] as? [String], [AppConfiguration.preview.canisterId])
        XCTAssertNoThrow(try JSONSerialization.data(withJSONObject: value))
    }

    func testChildDelegationRejectsInvalidServerBoundsAndExpiredParent() throws {
        let identity = try identity()
        var value = pending()
        value["publicKey"] = "not-base64"
        XCTAssertThrowsError(try AssistantNativeAuthorization().authorize(configuration: .preview, pending: value, identity: identity))
        value = pending()
        value["maxTimeToLive"] = "3600000000001"
        XCTAssertThrowsError(try AssistantNativeAuthorization().authorize(configuration: .preview, pending: value, identity: identity))
        value = pending()
        value["derivationOrigin"] = "https://evil.example"
        XCTAssertThrowsError(try AssistantNativeAuthorization().authorize(configuration: .preview, pending: value, identity: identity))
        XCTAssertThrowsError(try AssistantNativeAuthorization().authorize(
            configuration: .preview,
            pending: pending(),
            identity: identity,
            now: Date().addingTimeInterval(3_601)
        ))
    }
    func testTerminalAndTransientRecoveryErrors() {
        XCTAssertTrue(AssistantHTTPError(status: 401, code: "authentication_required").terminal)
        XCTAssertTrue(AssistantHTTPError(status: 503, code: "assistant_disabled").terminal)
        XCTAssertFalse(AssistantHTTPError(status: 502, code: "request_failed").terminal)
    }

    func testPreviewKeepsConversationForItsBoundContext() {
        let model = VoicePreviewModel(configuration: .preview)
        model.loadScreenshotFixture()

        model.contextChanged(databaseId: "demo", principal: "owner")

        XCTAssertEqual(model.snapshot?.databaseId, "demo")
    }

    func testPreviewEndsConversationWhenBoundDatabaseChanges() {
        let model = VoicePreviewModel(configuration: .preview)
        model.loadScreenshotFixture()

        model.contextChanged(databaseId: "other", principal: "owner")

        XCTAssertNil(model.snapshot)
    }

    func testPreviewCacheIsProtectedExcludedFromBackupAndSeparateFromHistory() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let history = root.appending(path: "qa-history.json")
        try Data("existing history".utf8).write(to: history)
        let cache = AssistantConversationCache(directory: root.appending(path: "preview", directoryHint: .isDirectory))
        let data = Data("""
        {"id":"conversation","databaseId":"db","scope":"/Knowledge","status":"ready","error":null,"generation":1,"reconnectGraceMs":120000,"messages":[],"utterances":[],"voice":"off"}
        """.utf8)
        let snapshot = try JSONDecoder().decode(AssistantSnapshot.self, from: data)
        try cache.save(principal: "owner", snapshot: snapshot, conversationID: UUID(), databaseTitle: "Test")
        XCTAssertEqual(try cache.load()?.principal, "owner")
        XCTAssertEqual(try cache.load()?.snapshot.id, "conversation")
        XCTAssertEqual(try cache.directory.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
        #if !targetEnvironment(simulator)
        let attributes = try FileManager.default.attributesOfItem(atPath: cache.directory.appending(path: "conversation-v2.json").path)
        XCTAssertEqual(attributes[.protectionKey] as? FileProtectionType, .completeUntilFirstUserAuthentication)
        #endif
        let conversationID = try XCTUnwrap(cache.load()?.conversationID)
        try cache.markEnding(conversationID: conversationID)
        let reopened = AssistantConversationCache(directory: cache.directory)
        XCTAssertTrue(try reopened.isEnding(conversationID: conversationID))
        XCTAssertFalse(try reopened.isEnding(conversationID: UUID()))
        try cache.clear()
        XCTAssertFalse(try reopened.isEnding(conversationID: conversationID))
        XCTAssertNil(try cache.load())
        XCTAssertEqual(try String(contentsOf: history, encoding: .utf8), "existing history")
    }
}
