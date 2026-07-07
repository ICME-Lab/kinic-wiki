// Where: mobile/ios/KinicTests/ShareCaptureSubmitterTests.swift
// What: Unit tests for Share Extension immediate-submit decisions.
// Why: Browser shares must either save immediately or preserve the URL for later.

import Foundation
import ICNativeClient
import Testing
@testable import Kinic

struct ShareCaptureSubmitterTests {
    @Test
    func queuesWhenSessionIsMissing() async throws {
        let harness = try ShareCaptureHarness()
        let submitter = harness.submitter(session: nil, databaseId: "db_demo")

        let result = await submitter.submitSharedURL(URL(string: "https://example.com/page")!)

        guard case .queued = result else {
            Issue.record("Expected queued result, got \(result)")
            return
        }
        #expect(harness.pendingURLs().map(\.url.absoluteString) == ["https://example.com/page"])
    }

    @Test
    func queuesWhenDatabaseIsMissing() async throws {
        let harness = try ShareCaptureHarness()
        let submitter = harness.submitter(session: makeSession(), databaseId: "")

        let result = await submitter.submitSharedURL(URL(string: "https://example.com/page")!)

        guard case .queued = result else {
            Issue.record("Expected queued result, got \(result)")
            return
        }
        #expect(harness.pendingURLs().count == 1)
    }

    @Test
    func rejectsUnsupportedURLsWithoutQueueing() async throws {
        let harness = try ShareCaptureHarness()
        let submitter = harness.submitter(session: makeSession(), databaseId: "db_demo")

        let result = await submitter.submitSharedURL(URL(string: "file:///tmp/page")!)

        guard case .failed = result else {
            Issue.record("Expected failed result, got \(result)")
            return
        }
        #expect(harness.pendingURLs().isEmpty)
    }

    @Test
    func savesWithoutQueueingWhenSubmissionAndTriggerSucceed() async throws {
        let harness = try ShareCaptureHarness()
        let triggerProbe = TriggerProbe()
        let submitter = harness.submitter(session: makeSession(), databaseId: "db_demo") { request, _ in
            CaptureSubmission(databaseId: request.databaseId, requestPath: request.requestPath, requestId: request.requestId, url: request.normalizedURL)
        } triggerSourceCapture: { submission, _ in
            await triggerProbe.record(submission)
        }

        let result = await submitter.submitSharedURL(URL(string: "https://example.com/page")!)

        guard case let .saved(requestPath) = result else {
            Issue.record("Expected saved result, got \(result)")
            return
        }
        #expect(requestPath.hasPrefix("/Sources/source-capture-requests/"))
        #expect(harness.pendingURLs().isEmpty)
        #expect(harness.pendingTriggers().isEmpty)
        #expect(await triggerProbe.requestPaths() == [requestPath])
    }

    @Test
    func failsAndKeepsPendingTriggerWhenWorkerTriggerFails() async throws {
        let harness = try ShareCaptureHarness()
        let submitter = harness.submitter(session: makeSession(), databaseId: "db_demo") { request, _ in
            CaptureSubmission(databaseId: request.databaseId, requestPath: request.requestPath, requestId: request.requestId, url: request.normalizedURL)
        } triggerSourceCapture: { _, _ in
            throw ShareCaptureTestError.triggerFailed
        }

        let result = await submitter.submitSharedURL(URL(string: "https://example.com/page")!)

        guard case .failed = result else {
            Issue.record("Expected failed result, got \(result)")
            return
        }
        #expect(harness.pendingURLs().isEmpty)
        #expect(harness.pendingTriggers().count == 1)
    }

    @Test
    func queuesWhenSubmissionFails() async throws {
        let harness = try ShareCaptureHarness()
        let submitter = harness.submitter(session: makeSession(), databaseId: "db_demo") { _, _ in
            throw ShareCaptureTestError.submissionFailed
        }

        let result = await submitter.submitSharedURL(URL(string: "https://example.com/page")!)

        guard case .queued = result else {
            Issue.record("Expected queued result, got \(result)")
            return
        }
        #expect(harness.pendingURLs().count == 1)
    }

    @Test
    func queuedRetryKeepsFailedSubmissionRequestId() async throws {
        let harness = try ShareCaptureHarness()
        let probe = RequestPathProbe()
        let submitter = harness.submitter(session: makeSession(), databaseId: "db_demo") { request, _ in
            await probe.record(request.requestPath)
            throw ShareCaptureTestError.submissionFailed
        }

        let result = await submitter.submitSharedURL(URL(string: "https://example.com/page")!)

        guard case .queued = result else {
            Issue.record("Expected queued result, got \(result)")
            return
        }
        let queued = try #require(harness.pendingURLs().first)
        let attemptedRequestPath = await probe.load()
        #expect(attemptedRequestPath == "/Sources/source-capture-requests/\(queued.requestId).md")
    }
}

private actor RequestPathProbe {
    private var value = ""

    func record(_ value: String) {
        self.value = value
    }

    func load() -> String {
        value
    }
}

private struct ShareCaptureHarness {
    let queueDirectory: URL
    let triggerQueueDirectory: URL
    let configuration: AppConfiguration

    init() throws {
        queueDirectory = FileManager.default.temporaryDirectory
            .appending(path: "kinic-share-capture-tests")
            .appending(path: UUID().uuidString)
        triggerQueueDirectory = FileManager.default.temporaryDirectory
            .appending(path: "kinic-share-trigger-tests")
            .appending(path: UUID().uuidString)
        configuration = AppConfiguration(
            canisterId: "6emaw-iyaaa-aaaay-aacka-cai",
            apiBaseURL: URL(string: "https://icp0.io")!,
            identityProvider: URL(string: "https://id.ai/#authorize")!,
            derivationOrigin: "https://6emaw-iyaaa-aaaay-aacka-cai.icp0.io",
            authOrigin: URL(string: "https://wiki.kinic.xyz")!,
            callbackDomain: "wiki.kinic.xyz",
            appGroupId: "group.xyz.kinic.ios.KinicWiki",
            keychainAccessGroup: "AKN976G7AK.xyz.kinic.ios.KinicWiki"
        )
        try FileManager.default.createDirectory(at: queueDirectory, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: triggerQueueDirectory, withIntermediateDirectories: true)
    }

    func submitter(
        session: ICAuthSession?,
        databaseId: String,
        saveRequest: @escaping @Sendable (SourceCaptureRequest, ICAuthSession) async throws -> CaptureSubmission = { request, _ in
            CaptureSubmission(databaseId: request.databaseId, requestPath: request.requestPath, requestId: request.requestId, url: request.normalizedURL)
        },
        triggerSourceCapture: @escaping @Sendable (CaptureSubmission, ICAuthSession) async throws -> Void = { _, _ in
        }
    ) -> ShareCaptureSubmitter {
        let queueDirectory = queueDirectory
        let triggerQueueDirectory = triggerQueueDirectory
        return ShareCaptureSubmitter(
            configuration: configuration,
            timeoutNanoseconds: nil,
            restoreSession: {
                session
            },
            selectedDatabaseId: {
                databaseId
            },
            enqueueURL: { url, receivedAt, requestId in
                let inbox = try ShareInbox(testQueueDirectory: queueDirectory)
                try inbox.enqueue(url, receivedAt: receivedAt, requestId: requestId)
            },
            enqueueTrigger: { request, createdAt in
                let queue = try SourceCaptureTriggerQueue(testQueueDirectory: triggerQueueDirectory)
                try queue.enqueue(request, createdAt: createdAt)
            },
            saveRequest: saveRequest,
            triggerSourceCapture: triggerSourceCapture
        )
    }

    func pendingURLs() -> [PendingSharedURL] {
        do {
            return try ShareInbox(testQueueDirectory: queueDirectory).loadPendingURLs()
        } catch {
            Issue.record("Could not load pending URLs: \(error.localizedDescription)")
            return []
        }
    }

    func pendingTriggers() -> [PendingSourceCaptureTrigger] {
        do {
            return try SourceCaptureTriggerQueue(testQueueDirectory: triggerQueueDirectory).loadPendingTriggers()
        } catch {
            Issue.record("Could not load pending triggers: \(error.localizedDescription)")
            return []
        }
    }
}

private func makeSession() -> ICAuthSession {
    ICAuthSession(
        principal: "aaaaa-aa",
        canisterId: "6emaw-iyaaa-aaaay-aacka-cai",
        identityProvider: "https://id.ai/#authorize",
        derivationOrigin: "https://6emaw-iyaaa-aaaay-aacka-cai.icp0.io",
        sessionPublicKey: Data(),
        sessionPrivateKey: Data(),
        delegation: ICDelegationChain(publicKey: Data(), delegations: []),
        createdAt: Date(timeIntervalSince1970: 1_700_000_000)
    )
}

private actor TriggerProbe {
    private var submissions: [CaptureSubmission] = []

    func record(_ submission: CaptureSubmission) {
        submissions.append(submission)
    }

    func requestPaths() -> [String] {
        submissions.map(\.requestPath)
    }
}

private enum ShareCaptureTestError: Error {
    case submissionFailed
    case triggerFailed
}
