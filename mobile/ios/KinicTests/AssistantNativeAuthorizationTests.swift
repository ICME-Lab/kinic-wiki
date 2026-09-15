import XCTest
@testable import Kinic

@MainActor
final class AssistantNativeAuthorizationTests: XCTestCase {
    func testLiveDataChannelUsesOpenAIContract() {
        XCTAssertEqual(AssistantAudioSession.eventChannelLabel, "oai-events")
    }

    private let callback = URL(string: "https://wiki.kinic.xyz/ios-auth-callback")!
    private func url(state: String = "state", id: String = "request") -> URL {
        let object: [String: Any] = ["jsonrpc": "2.0", "id": id, "result": ["publicKey": "test"]]
        var fragment = URLComponents()
        fragment.queryItems = [URLQueryItem(name: "state", value: state), URLQueryItem(name: "message", value: String(decoding: try! JSONSerialization.data(withJSONObject: object), as: UTF8.self))]
        var result = URLComponents(url: callback, resolvingAgainstBaseURL: false)!
        result.percentEncodedFragment = fragment.percentEncodedQuery
        return result.url!
    }
    func testValidCallbackPreservesResponseForServerVerification() throws {
        let response = try AssistantNativeAuthorization.response(from: url(), callback: callback, state: "state", requestID: "request")
        XCTAssertNotNil(response as? [String: Any])
    }
    func testWrongStateAndRequestAreRejected() {
        XCTAssertThrowsError(try AssistantNativeAuthorization.response(from: url(state: "old"), callback: callback, state: "state", requestID: "request"))
        XCTAssertThrowsError(try AssistantNativeAuthorization.response(from: url(id: "old"), callback: callback, state: "state", requestID: "request"))
    }
    func testCallbackQueryAndDuplicateParametersAreRejected() {
        var value = URLComponents(url: url(), resolvingAgainstBaseURL: false)!
        value.query = "token=secret"
        XCTAssertThrowsError(try AssistantNativeAuthorization.response(from: value.url!, callback: callback, state: "state", requestID: "request"))
        value.query = nil
        value.percentEncodedFragment! += "&state=state"
        XCTAssertThrowsError(try AssistantNativeAuthorization.response(from: value.url!, callback: callback, state: "state", requestID: "request"))
    }
    func testDifferentOriginAndPathAreRejected() {
        for replacement in ["https://evil.example/ios-auth-callback", "https://wiki.kinic.xyz/other"] {
            var value = URLComponents(string: replacement)!
            value.percentEncodedFragment = URLComponents(url: url(), resolvingAgainstBaseURL: false)!.percentEncodedFragment
            XCTAssertThrowsError(try AssistantNativeAuthorization.response(from: value.url!, callback: callback, state: "state", requestID: "request"))
        }
    }
    func testTerminalAndTransientRecoveryErrors() {
        XCTAssertTrue(AssistantHTTPError(status: 401, code: "authentication_required").terminal)
        XCTAssertTrue(AssistantHTTPError(status: 503, code: "assistant_disabled").terminal)
        XCTAssertFalse(AssistantHTTPError(status: 502, code: "request_failed").terminal)
    }

    func testPreviewCacheIsProtectedExcludedFromBackupAndSeparateFromHistory() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let history = root.appending(path: "qa-history.json")
        try Data("existing history".utf8).write(to: history)
        let cache = AssistantConversationCache(directory: root.appending(path: "preview", directoryHint: .isDirectory))
        let data = Data("""
        {"id":"conversation","databaseId":"db","scope":"/Knowledge","status":"ready","error":null,"generation":1,"reconnectGraceMs":120000,"messages":[],"voice":"off"}
        """.utf8)
        let snapshot = try JSONDecoder().decode(AssistantSnapshot.self, from: data)
        try cache.save(principal: "owner", snapshot: snapshot)
        XCTAssertEqual(try cache.load()?.principal, "owner")
        XCTAssertEqual(try cache.load()?.snapshot.id, "conversation")
        XCTAssertEqual(try cache.directory.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
        #if !targetEnvironment(simulator)
        let attributes = try FileManager.default.attributesOfItem(atPath: cache.directory.appending(path: "conversation.json").path)
        XCTAssertEqual(attributes[.protectionKey] as? FileProtectionType, .completeUntilFirstUserAuthentication)
        #endif
        try cache.clear()
        XCTAssertNil(try cache.load())
        XCTAssertEqual(try String(contentsOf: history, encoding: .utf8), "existing history")
    }
}
