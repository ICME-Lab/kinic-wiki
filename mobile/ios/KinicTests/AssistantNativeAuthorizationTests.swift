import CryptoKit
import ICNativeClient
import XCTest
@testable import Kinic

@MainActor
final class AssistantNativeAuthorizationTests: XCTestCase {
    func testSlowHistoryDoesNotBlockQuestionAcknowledgement() async throws {
        let http = AssistantHTTPStub(), socket = AssistantSocketStub()
        let model = AssistantConversationModel(configuration: .preview, http: http, makeSocket: { _ in socket })
        model.loadScreenshotFixture()
        let original = try XCTUnwrap(model.snapshot), gate = AssistantSnapshotGate()
        var reads = 0
        var completed: AssistantSnapshot?
        http.onSnapshot = {
            reads += 1
            if reads == 2 { await gate.wait(); return original.withRevision(2) }
            return completed ?? original
        }
        defer { gate.release(); model.end(revoke: false) }
        socket.push(try original.controlMessage())
        model.sceneChanged(active: true)
        await waitUntil { model.controlReady }
        socket.push(try original.withRevision(2).controlMessage())
        await waitUntil { gate.entered }
        socket.onSend = { message in
            guard case let .string(text) = message,
                  let value = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
                  value["action"] as? String == "questions",
                  let requestID = value["requestId"] as? String else { return }
            completed = try original.answering(requestID: requestID, revision: 3)
            socket.push(.string("{\"type\":\"command.result\",\"requestId\":\"\(requestID)\",\"status\":202,\"body\":{}}"))
        }
        var answerReceived = false
        let question = Task {
            let answer = try await model.askText("Summarize this Wiki")
            answerReceived = answer.answer != nil
        }
        await waitUntil { answerReceived }
        XCTAssertTrue(answerReceived, "The answer must arrive before the blocked history read is released")
        XCTAssertTrue(model.controlReady)
        XCTAssertEqual(socket.cancellations, 0)
        gate.release()
        try await question.value
        XCTAssertFalse(http.dataCalls.contains { $0.path == "questions" }, "The socket acknowledgement must have been consumed")
    }

    func testLostQuestionReplyResendsSameRequestIDOnReconnectedSocket() async throws {
        let http = AssistantHTTPStub(), first = AssistantSocketStub(), second = AssistantSocketStub()
        var socketCount = 0
        let model = AssistantConversationModel(configuration: .preview, http: http, makeSocket: { _ in
            socketCount += 1
            return socketCount == 1 ? first : second
        })
        model.loadScreenshotFixture()
        let original = try XCTUnwrap(model.snapshot)
        var completed: AssistantSnapshot?, sentID: String?
        http.onSnapshot = { completed ?? original }
        // Match the production entrypoint: HTTP question submission is forbidden.
        http.onData = { _ in throw AssistantHTTPError(status: 405, code: "control_connection_required") }
        first.onSend = { message in
            guard case let .string(text) = message,
                  let value = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
                  value["action"] as? String == "questions" else { return }
            sentID = value["requestId"] as? String
            first.cancel(with: .goingAway, reason: nil)
        }
        second.onSend = { message in
            guard case let .string(text) = message,
                  let value = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
                  value["action"] as? String == "questions",
                  let requestID = value["requestId"] as? String else { return }
            XCTAssertEqual(requestID, sentID)
            let payload = try XCTUnwrap(value["payload"] as? [String: Any])
            XCTAssertEqual(payload["requestId"] as? String, sentID)
            completed = try original.answering(requestID: requestID, revision: 3)
            second.push(.string("{\"type\":\"command.result\",\"requestId\":\"\(requestID)\",\"status\":202,\"body\":{}}"))
        }
        defer { model.end(revoke: false) }
        first.push(try original.controlMessage())
        second.push(try original.controlMessage())
        model.sceneChanged(active: true)
        await waitUntil { model.controlReady }
        let answer = try await model.askText("Summarize this Wiki")
        XCTAssertEqual(answer.requestId, sentID)
        XCTAssertNotNil(answer.answer)
        XCTAssertEqual(socketCount, 2)
        XCTAssertFalse(http.dataCalls.contains { $0.path == "questions" })
    }

    func testTerminalHistoryFailureStillEndsTheConversation() async throws {
        let http = AssistantHTTPStub(), socket = AssistantSocketStub()
        let model = AssistantConversationModel(configuration: .preview, http: http, makeSocket: { _ in socket })
        model.loadScreenshotFixture()
        let original = try XCTUnwrap(model.snapshot)
        var reads = 0
        http.onSnapshot = {
            reads += 1
            if reads > 1 { throw AssistantHTTPError(status: 401, code: "authentication_required") }
            return original
        }
        defer { model.end(revoke: false) }
        socket.push(try original.controlMessage())
        model.sceneChanged(active: true)
        await waitUntil { model.controlReady }
        socket.push(try original.withRevision(2).controlMessage())
        await waitUntil { model.snapshot == nil }
        XCTAssertNil(model.snapshot)
        XCTAssertFalse(model.controlReady)
        XCTAssertEqual(model.failureCode, "authentication_required")
    }

    func testStaleHistoryRetriesWithoutClosingTheSocket() async throws {
        let http = AssistantHTTPStub(), socket = AssistantSocketStub()
        let model = AssistantConversationModel(configuration: .preview, http: http, makeSocket: { _ in socket })
        model.loadScreenshotFixture()
        let original = try XCTUnwrap(model.snapshot)
        var reads = 0
        http.onSnapshot = {
            reads += 1
            if reads == 2 { throw AssistantHTTPError(status: 409, code: "stale_state") }
            return reads == 1 ? original : original.withRevision(2)
        }
        defer { model.end(revoke: false) }
        socket.push(try original.controlMessage())
        model.sceneChanged(active: true)
        await waitUntil { model.controlReady }
        for _ in 0..<20 { socket.push(try original.withRevision(2).controlMessage()) }
        await waitUntil(timeout: 5) { model.snapshot?.revision == 2 }
        XCTAssertTrue(model.controlReady)
        XCTAssertEqual(socket.cancellations, 0)
        XCTAssertEqual(reads, 3, "Revision notifications must coalesce into one retried history load")
    }

    func testLostReplyDoesNotResubmitAfterDatabaseChanges() async throws {
        let http = AssistantHTTPStub(), socket = AssistantSocketStub()
        let model = AssistantConversationModel(configuration: .preview, http: http, makeSocket: { _ in socket })
        model.loadScreenshotFixture()
        let original = try XCTUnwrap(model.snapshot)
        http.onSnapshot = { original }
        socket.onSend = { _ in model.contextChanged(databaseId: "other", principal: "owner") }
        defer { model.end(revoke: false) }
        socket.push(try original.controlMessage())
        model.sceneChanged(active: true)
        await waitUntil { model.controlReady }
        do {
            _ = try await model.askText("Summarize this Wiki")
            XCTFail("A question must not be retried in another context")
        } catch is CancellationError {
        }
        XCTAssertNil(model.snapshot)
        XCTAssertFalse(http.dataCalls.contains { $0.path == "questions" })
    }

    private func waitUntil(timeout: TimeInterval = 2, _ condition: () -> Bool) async {
        let deadline = ProcessInfo.processInfo.systemUptime + timeout
        while !condition(), ProcessInfo.processInfo.systemUptime < deadline {
            try? await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(condition(), "Timed out waiting for the test event")
    }

    func testStopCancelsUnsentQuestionWithoutCancellingItsTask() async throws {
        let http = AssistantHTTPStub()
        let model = AssistantConversationModel(configuration: .preview, http: http)
        model.loadScreenshotFixture()
        let conversationID = model.snapshot?.id
        let task = Task { try await model.askText("Summarize this Wiki") }
        for _ in 0..<100 where !model.busy {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(model.busy)
        try await model.cancelQuestionAndWait()
        try await model.cancelQuestionAndWait()
        do {
            _ = try await task.value
            XCTFail("A stopped question must not be sent after reconnection")
        } catch is CancellationError {
        }
        XCTAssertFalse(model.busy)
        XCTAssertFalse(task.isCancelled)
        XCTAssertEqual(model.snapshot?.id, conversationID)
        XCTAssertTrue(http.sentPaths.isEmpty)
    }

    func testAskTextWaitsForControlAndCanBeCancelled() async {
        let model = AssistantConversationModel(configuration: .preview)
        model.loadScreenshotFixture()
        let task = Task { try await model.askText("Summarize this Wiki") }
        // A created conversation with no socket used to fail immediately with
        // -1009. It must remain pending while the listener is connecting.
        try? await Task.sleep(for: .milliseconds(20))
        XCTAssertTrue(model.busy)
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("A cancelled question must not be sent")
        } catch is CancellationError {
        } catch {
            XCTFail("Unexpected failure while waiting for control: \(error)")
        }
        XCTAssertFalse(model.busy)
        XCTAssertEqual(model.snapshot?.databaseId, "demo")
    }

    func testAskTextStopsWaitingWhenConversationEnds() async {
        let model = AssistantConversationModel(configuration: .preview)
        model.loadScreenshotFixture()
        let task = Task { try await model.askText("Summarize this Wiki") }
        try? await Task.sleep(for: .milliseconds(20))
        XCTAssertTrue(model.busy)
        model.contextChanged(databaseId: "other", principal: "owner")
        do {
            _ = try await task.value
            XCTFail("The question must not reach a different conversation")
        } catch is CancellationError {
        } catch {
            XCTFail("Unexpected failure after context changed: \(error)")
        }
        XCTAssertNil(model.snapshot)
    }

    func testCancelRequiresControlConnectionAndPreservesLocalConversation() async {
        let model = AssistantConversationModel(configuration: .preview)
        model.loadScreenshotFixture()
        let conversationID = model.snapshot?.id
        do {
            try await model.cancelQuestionAndWait()
            XCTFail("Cancellation must wait for an available control connection")
        } catch let error as URLError {
            XCTAssertEqual(error.code, .notConnectedToInternet)
        } catch {
            XCTFail("Unexpected cancellation failure: \(error)")
        }
        XCTAssertEqual(model.snapshot?.id, conversationID)
    }

    func testRequestedEndNotificationDoesNotCancelHTTPTeardown() async throws {
        let http = AssistantHTTPStub()
        let model = AssistantConversationModel(configuration: .preview, http: http)
        model.loadScreenshotFixture()
        http.onData = { [weak model] path in
            XCTAssertEqual(path, "end")
            XCTAssertTrue(model?.endingRequested == true)
            model?.receiveEndNotification()
            XCTAssertNotNil(model?.snapshot)
            XCTAssertNil(model?.error)
            return Data()
        }

        try await model.endAndRevoke()

        XCTAssertNil(model.snapshot)
        XCTAssertFalse(model.busy)
        XCTAssertFalse(model.endingRequested)
        XCTAssertNil(model.error)
        XCTAssertEqual(http.sentPaths, ["logout"])
    }

    func testUnrequestedEndNotificationEndsConversation() {
        let model = AssistantConversationModel(configuration: .preview, http: AssistantHTTPStub())
        model.loadScreenshotFixture()
        model.receiveEndNotification()
        XCTAssertNil(model.snapshot)
        XCTAssertNotNil(model.error)
    }

    func testLateSnapshotCannotRestoreConversationAfterSignOutOrDatabaseChange() async throws {
        for changeDatabase in [false, true] {
            let http = AssistantHTTPStub()
            let model = AssistantConversationModel(configuration: .preview, http: http)
            model.loadScreenshotFixture()
            let old = try XCTUnwrap(model.snapshot)
            let gate = AssistantSnapshotGate()
            http.onSnapshot = { await gate.wait(); return old }
            let task = Task { try await model.refreshSnapshot(old) }
            while !gate.entered { await Task.yield() }
            if changeDatabase { model.contextChanged(databaseId: "other", principal: "owner") }
            else { model.end(revoke: false) }
            gate.release()

            do {
                _ = try await task.value
                XCTFail("A response from an ended context must be discarded")
            } catch is CancellationError {
            } catch { XCTFail("Unexpected late-response error: \(error)") }
            XCTAssertNil(model.snapshot)
        }
    }

    func testCancelledSnapshotReadDoesNotApplyItsResponse() async throws {
        let http = AssistantHTTPStub()
        let model = AssistantConversationModel(configuration: .preview, http: http)
        model.loadScreenshotFixture()
        let original = try XCTUnwrap(model.snapshot)
        let gate = AssistantSnapshotGate()
        let newer = original.withRevision(original.revision + 1)
        http.onSnapshot = { await gate.wait(); return newer }
        let task = Task { try await model.refreshSnapshot(original) }
        while !gate.entered { await Task.yield() }
        task.cancel()
        gate.release()
        do {
            _ = try await task.value
            XCTFail("A cancelled read must not update the conversation")
        } catch is CancellationError {
        } catch { XCTFail("Unexpected cancellation error: \(error)") }
        XCTAssertEqual(model.snapshot?.revision, original.revision)
    }

    func testSnapshotReadUpdatesTheCurrentConversation() async throws {
        let http = AssistantHTTPStub()
        let model = AssistantConversationModel(configuration: .preview, http: http)
        model.loadScreenshotFixture()
        let original = try XCTUnwrap(model.snapshot)
        let newer = original.withRevision(original.revision + 1)
        http.onSnapshot = { newer }
        _ = try await model.refreshSnapshot(original)
        XCTAssertEqual(model.snapshot?.revision, newer.revision)
    }

    func testHistoryCacheStillChecksAuthorizationAndReloadsOnRevisionChange() async throws {
        let stub = AssistantHistoryTransport()
        AssistantHistoryURLProtocol.transport = stub
        defer { AssistantHistoryURLProtocol.transport = nil }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AssistantHistoryURLProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let client = AssistantHTTPClient(configuration: historyTestConfiguration(), urlSession: session)
        defer { client.clearToken() }
        let first = try await client.snapshot(conversation: "conversation")
        let cached = try await client.snapshot(conversation: "conversation")
        XCTAssertEqual(first.messages.first?.question, "Question 1")
        XCTAssertEqual(cached.messages.first?.question, "Question 1")
        XCTAssertEqual(stub.counts.metadata, 2)
        XCTAssertEqual(stub.counts.history, 1)

        stub.update(revision: 2)
        let newer = try await client.snapshot(conversation: "conversation")
        XCTAssertEqual(newer.messages.first?.question, "Question 2")
        XCTAssertEqual(stub.counts.history, 2)
        stub.update(status: 401)
        do {
            _ = try await client.snapshot(conversation: "conversation")
            XCTFail("Cached history must never hide authentication failure")
        } catch let error as AssistantHTTPError { XCTAssertEqual(error.status, 401) }
        XCTAssertEqual(stub.counts.history, 2)
        stub.update(status: 200)
        client.clearToken()
        _ = try await client.snapshot(conversation: "conversation")
        XCTAssertEqual(stub.counts.history, 3)
    }

    func testHistoryRetriesAConcurrentRevisionInsteadOfCombiningPages() async throws {
        let stub = AssistantHistoryTransport()
        stub.update(staleOnce: true)
        AssistantHistoryURLProtocol.transport = stub
        defer { AssistantHistoryURLProtocol.transport = nil }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AssistantHistoryURLProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let client = AssistantHTTPClient(configuration: historyTestConfiguration(), urlSession: session)
        defer { client.clearToken() }
        let value = try await client.snapshot(conversation: "conversation")
        XCTAssertEqual(value.revision, 2)
        XCTAssertEqual(value.messages.map(\.question), ["Question 2"])
        XCTAssertEqual(stub.counts.metadata, 2)
        XCTAssertEqual(stub.counts.history, 2)
    }

    private func historyTestConfiguration() -> AppConfiguration {
        let c = AppConfiguration.preview
        return AppConfiguration(canisterId: "test-" + UUID().uuidString,
            apiBaseURL: c.apiBaseURL, identityProvider: c.identityProvider,
            derivationOrigin: c.derivationOrigin, authOrigin: URL(string: "https://example.invalid")!,
            paymentBaseURL: c.paymentBaseURL, callbackDomain: c.callbackDomain,
            appGroupId: nil, keychainAccessGroup: nil, iapProductIds: [],
            askAIURL: c.askAIURL, deploymentEnvironment: c.deploymentEnvironment)
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
        let model = AssistantConversationModel(configuration: .preview)
        model.loadScreenshotFixture()

        model.contextChanged(databaseId: "demo", principal: "owner")

        XCTAssertEqual(model.snapshot?.databaseId, "demo")
    }

    func testPreviewEndsConversationWhenBoundDatabaseChanges() {
        let model = AssistantConversationModel(configuration: .preview)
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
        {"revision":1,"id":"conversation","databaseId":"db","scope":"/Knowledge","status":"ready","error":null,"generation":1,"reconnectGraceMs":120000,"messages":[],"utterances":[],"voice":"off"}
        """.utf8)
        let snapshot = try JSONDecoder().decode(AssistantSnapshot.self, from: data)
        try cache.save(principal: "owner", snapshot: snapshot, conversationID: UUID(), databaseTitle: "Test")
        XCTAssertEqual(try cache.load()?.principal, "owner")
        XCTAssertEqual(try cache.load()?.snapshot.id, "conversation")
        XCTAssertEqual(try cache.directory.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
        #if !targetEnvironment(simulator)
        let attributes = try FileManager.default.attributesOfItem(atPath: cache.directory.appending(path: "conversation-v3.json").path)
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

    func testStartupDiscardsAllRetiredVoiceRecoveryAndPreservesTextData() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: root) }
        // Remove even damaged/older cache formats without decoding private content.
        for path in ["VoiceHistoryRecovery/account-one/conversation-v3.json",
                     "VoiceHistoryRecovery/account-two/conversation-v2.json",
                     "VoicePreviewCache/conversation-v1.json"] {
            let file = root.appending(path: path)
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data("retired recovery".utf8).write(to: file)
        }
        let textRecovery = root.appending(path: "AssistantHistoryRecovery/account-one/conversation-v3.json")
        try FileManager.default.createDirectory(at: textRecovery.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("current text recovery".utf8).write(to: textRecovery)
        let history = root.appending(path: "qa-history.json")
        try Data("saved conversation history".utf8).write(to: history)
        let http = AssistantHTTPStub()

        for _ in 0..<2 {
            let model = AssistantConversationModel(configuration: .preview, http: http, applicationSupportDirectory: root)
            XCTAssertNil(model.error)
            XCTAssertFalse(FileManager.default.fileExists(atPath: root.appending(path: "VoiceHistoryRecovery").path))
            XCTAssertFalse(FileManager.default.fileExists(atPath: root.appending(path: "VoicePreviewCache").path))
            XCTAssertEqual(try String(contentsOf: textRecovery, encoding: .utf8), "current text recovery")
            XCTAssertEqual(try String(contentsOf: history, encoding: .utf8), "saved conversation history")
            XCTAssertTrue(http.sentPaths.isEmpty)
        }
    }
}

@MainActor
private final class AssistantHTTPStub: AssistantHTTPProviding {
    var hasToken = false
    var onData: ((String) async throws -> Data)?
    var onSnapshot: (() async throws -> AssistantSnapshot)?
    var sentPaths: [String] = []
    var dataCalls: [(path: String, conversation: String?, body: [String: Any]?)] = []
    func setToken(_ token: String) throws { hasToken = true }
    func clearToken() { hasToken = false }
    func request(_ path: String, conversation: String?, method: String, body: [String: Any]?) throws -> URLRequest {
        URLRequest(url: URL(string: "https://example.invalid/" + path)!)
    }
    func send(_ request: URLRequest) async throws -> Data {
        sentPaths.append(request.url!.lastPathComponent)
        return Data()
    }
    func data(_ path: String, conversation: String?, method: String, body: [String: Any]?) async throws -> Data {
        dataCalls.append((path, conversation, body))
        return try await onData?(path) ?? Data()
    }
    func snapshot(conversation: String, metadata: Data?) async throws -> AssistantSnapshot {
        try await onSnapshot!()
    }
}

@MainActor
private final class AssistantSnapshotGate {
    var entered = false
    private var continuation: CheckedContinuation<Void, Never>?
    func wait() async {
        entered = true
        await withCheckedContinuation { continuation = $0 }
    }
    func release() { continuation?.resume(); continuation = nil }
}

private extension AssistantSnapshot {
    func controlMessage() throws -> URLSessionWebSocketTask.Message {
        var value = try JSONSerialization.jsonObject(with: JSONEncoder().encode(self)) as! [String: Any]
        value["type"] = "snapshot"
        return .data(try JSONSerialization.data(withJSONObject: value))
    }
    func answering(requestID: String, revision: Int) throws -> Self {
        var value = try JSONSerialization.jsonObject(with: JSONEncoder().encode(self)) as! [String: Any]
        value["revision"] = revision
        value["messages"] = [["requestId": requestID, "question": "Summarize this Wiki", "voice": false,
                              "answer": ["answer": "A recovered answer", "citations": [], "insufficient": false,
                                         "contradictions": [], "unverified": []]]]
        return try JSONDecoder().decode(Self.self, from: JSONSerialization.data(withJSONObject: value))
    }
    func withRevision(_ revision: Int) -> Self {
        Self(revision: revision, id: id, databaseId: databaseId, scope: scope,
             status: status, error: error, generation: generation, reconnectGraceMs: reconnectGraceMs,
             messages: messages, utterances: utterances, voice: voice, voiceDeadline: voiceDeadline,
             voiceId: voiceId, progress: progress)
    }
}

@MainActor
private final class AssistantSocketStub: AssistantControlSocket {
    var onSend: ((URLSessionWebSocketTask.Message) async throws -> Void)?
    private var messages: [URLSessionWebSocketTask.Message] = []
    private var receiver: CheckedContinuation<URLSessionWebSocketTask.Message, Error>?
    private var closed = false
    private(set) var cancellations = 0
    func resume() {}
    func send(_ message: URLSessionWebSocketTask.Message) async throws { try await onSend?(message) }
    func receive() async throws -> URLSessionWebSocketTask.Message {
        if closed { throw URLError(.networkConnectionLost) }
        if !messages.isEmpty { return messages.removeFirst() }
        return try await withCheckedThrowingContinuation { receiver = $0 }
    }
    func push(_ message: URLSessionWebSocketTask.Message) {
        if let receiver { self.receiver = nil; receiver.resume(returning: message) }
        else { messages.append(message) }
    }
    func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        cancellations += 1
        closed = true
        receiver?.resume(throwing: URLError(.networkConnectionLost))
        receiver = nil
    }
}

private final class AssistantHistoryTransport: @unchecked Sendable {
    private let lock = NSLock()
    private var revision = 1
    private var status = 200
    private var staleOnce = false
    private var metadataCount = 0
    private var historyCount = 0
    var counts: (metadata: Int, history: Int) {
        lock.lock(); defer { lock.unlock() }
        return (metadataCount, historyCount)
    }
    func update(revision: Int? = nil, status: Int? = nil, staleOnce: Bool? = nil) {
        lock.lock(); defer { lock.unlock() }
        if let revision { self.revision = revision }
        if let status { self.status = status }
        if let staleOnce { self.staleOnce = staleOnce }
    }
    func response(for request: URLRequest) throws -> (Int, Data) {
        lock.lock(); defer { lock.unlock() }
        if request.url!.lastPathComponent == "conversation" {
            metadataCount += 1
            if status != 200 { return (status, Data(#"{"error":"authentication_required"}"#.utf8)) }
            return (200, Data("""
            {"revision":\(revision),"id":"conversation","databaseId":"db","scope":"database","status":"ready","generation":1,"reconnectGraceMs":120000,"voice":"off"}
            """.utf8))
        }
        historyCount += 1
        if staleOnce {
            staleOnce = false
            revision += 1
            return (409, Data(#"{"error":"stale_state"}"#.utf8))
        }
        return (200, Data("""
        {"revision":\(revision),"messages":[{"voice":false,"requestId":"request","question":"Question \(revision)"}],"utterances":[],"nextCursor":null}
        """.utf8))
    }
}

private final class AssistantHistoryURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var transport: AssistantHistoryTransport?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            guard let transport = Self.transport else { throw URLError(.unknown) }
            let (status, data) = try transport.response(for: request)
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}
