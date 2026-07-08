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
    func queuesCaptureMetadataWhenSessionIsMissing() async throws {
        let harness = try ShareCaptureHarness()
        let submitter = harness.submitter(session: nil, databaseId: "db_demo")
        let metadata = ShareCaptureMetadata(
            title: "Since AI (@sinceaihq)",
            description: "Building an AI product is one thing.",
            imageURL: nil,
            source: ShareCaptureMetadata.xOpenGraphSource,
            fetchedAt: Date(timeIntervalSince1970: 1_700_000_000)
        )

        let result = await submitter.submitSharedURL(
            URL(string: "https://x.com/sinceaihq/status/2074424777675046913")!,
            captureMetadata: metadata
        )

        guard case .queued = result else {
            Issue.record("Expected queued result, got \(result)")
            return
        }
        #expect(harness.pendingURLs().first?.captureMetadata == metadata)
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
    func savesAndQueuesTriggerWithoutWaitingForWorker() async throws {
        let harness = try ShareCaptureHarness()
        let submitter = harness.submitter(session: makeSession(), databaseId: "db_demo") { request, _ in
            CaptureSubmission(databaseId: request.databaseId, requestPath: request.requestPath, requestId: request.requestId, url: request.normalizedURL, sessionNonce: "session-1")
        } triggerSourceCapture: { _, _ in
            throw ShareCaptureTestError.triggerFailed
        }

        let result = await submitter.submitSharedURL(URL(string: "https://example.com/page")!)

        guard case let .saved(requestPath) = result else {
            Issue.record("Expected saved result, got \(result)")
            return
        }
        #expect(requestPath.hasPrefix("/Sources/source-capture-requests/"))
        #expect(harness.pendingURLs().isEmpty)
        let pending = try #require(harness.pendingTriggers().first)
        #expect(pending.requestPath == requestPath)
        #expect(pending.sessionNonce == "session-1")
    }

    @Test
    func immediateSubmissionIncludesCaptureMetadata() async throws {
        let harness = try ShareCaptureHarness()
        let probe = RequestMetadataProbe()
        let metadata = ShareCaptureMetadata(
            title: "Since AI (@sinceaihq)",
            description: "Building an AI product is one thing.",
            imageURL: nil,
            source: ShareCaptureMetadata.xOpenGraphSource,
            fetchedAt: Date(timeIntervalSince1970: 1_700_000_000)
        )
        let submitter = harness.submitter(session: makeSession(), databaseId: "db_demo") { request, _ in
            await probe.record(request.metadataJson)
            return CaptureSubmission(databaseId: request.databaseId, requestPath: request.requestPath, requestId: request.requestId, url: request.normalizedURL, sessionNonce: "session-metadata")
        } triggerSourceCapture: { _, _ in
            throw ShareCaptureTestError.triggerFailed
        }

        let result = await submitter.submitSharedURL(
            URL(string: "https://x.com/sinceaihq/status/2074424777675046913")!,
            captureMetadata: metadata
        )

        guard case .saved = result else {
            Issue.record("Expected saved result, got \(result)")
            return
        }
        #expect(await probe.load().contains("\"shared_description\":\"Building an AI product is one thing.\""))
    }

    @Test
    func explicitDatabaseOverrideSelectsSubmissionDatabase() async throws {
        let harness = try ShareCaptureHarness()
        let databaseProbe = RequestDatabaseProbe()
        let submitter = harness.submitter(session: makeSession(), databaseId: "db_default") { request, _ in
            await databaseProbe.record(request.databaseId)
            return CaptureSubmission(databaseId: request.databaseId, requestPath: request.requestPath, requestId: request.requestId, url: request.normalizedURL, sessionNonce: "session-override")
        } triggerSourceCapture: { _, _ in
            throw ShareCaptureTestError.triggerFailed
        }

        let result = await submitter.submitSharedURL(
            URL(string: "https://example.com/page")!,
            databaseIdOverride: "db_override"
        )

        guard case .saved = result else {
            Issue.record("Expected saved result, got \(result)")
            return
        }
        #expect(await databaseProbe.load() == "db_override")
    }

    @Test
    func keepsPendingTriggerWhenWorkerTriggerFails() async throws {
        let harness = try ShareCaptureHarness()
        let submitter = harness.submitter(session: makeSession(), databaseId: "db_demo") { request, _ in
            CaptureSubmission(databaseId: request.databaseId, requestPath: request.requestPath, requestId: request.requestId, url: request.normalizedURL, sessionNonce: "session-failed-trigger")
        } triggerSourceCapture: { _, _ in
            throw ShareCaptureTestError.triggerFailed
        }

        let result = await submitter.submitSharedURL(URL(string: "https://example.com/page")!)

        guard case .saved = result else {
            Issue.record("Expected saved result, got \(result)")
            return
        }
        #expect(harness.pendingURLs().isEmpty)
        #expect(harness.pendingTriggers().count == 1)
    }

    @Test
    func triggersImmediatelyWhenTriggerQueueFails() async throws {
        let harness = try ShareCaptureHarness()
        let triggerProbe = TriggerProbe()
        let submitter = harness.submitter(
            session: makeSession(),
            databaseId: "db_demo",
            saveRequest: { request, _ in
                CaptureSubmission(databaseId: request.databaseId, requestPath: request.requestPath, requestId: request.requestId, url: request.normalizedURL, sessionNonce: "session-immediate")
            },
            triggerSourceCapture: { submission, _ in
                await triggerProbe.record(submission)
            },
            enqueueTrigger: { _, _, _ in
                throw ShareCaptureTestError.triggerQueueFailed
            }
        )

        let result = await submitter.submitSharedURL(URL(string: "https://example.com/page")!)

        guard case let .saved(requestPath) = result else {
            Issue.record("Expected saved result, got \(result)")
            return
        }
        #expect(await triggerProbe.requestPaths() == [requestPath])
        #expect(harness.pendingTriggers().isEmpty)
    }

    @Test
    func reportsSavedButUntriggeredWhenTriggerQueueAndImmediateTriggerFail() async throws {
        let harness = try ShareCaptureHarness()
        let triggerProbe = TriggerProbe()
        let submitter = harness.submitter(
            session: makeSession(),
            databaseId: "db_demo",
            saveRequest: { request, _ in
                CaptureSubmission(databaseId: request.databaseId, requestPath: request.requestPath, requestId: request.requestId, url: request.normalizedURL, sessionNonce: "session-untriggered")
            },
            triggerSourceCapture: { submission, _ in
                await triggerProbe.record(submission)
                throw ShareCaptureTestError.triggerFailed
            },
            enqueueTrigger: { _, _, _ in
                throw ShareCaptureTestError.triggerQueueFailed
            }
        )

        let result = await submitter.submitSharedURL(URL(string: "https://example.com/page")!)

        guard case let .failed(message) = result else {
            Issue.record("Expected failed result, got \(result)")
            return
        }
        #expect(message.contains("Source capture request was saved"))
        #expect(message.contains("could not queue for retry"))
        #expect(message.contains("trigger immediately"))
        #expect(await triggerProbe.requestPaths().count == 1)
        #expect(harness.pendingTriggers().isEmpty)
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
    func makeLiveThrowsInsteadOfCrashingWhenAppGroupIsMissing() {
        #expect(throws: (any Error).self) {
            try ShareCaptureSubmitter.makeLive(configuration: .preview)
        }
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

private actor RequestDatabaseProbe {
    private var value = ""

    func record(_ value: String) {
        self.value = value
    }

    func load() -> String {
        value
    }
}

private actor RequestMetadataProbe {
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
            CaptureSubmission(databaseId: request.databaseId, requestPath: request.requestPath, requestId: request.requestId, url: request.normalizedURL, sessionNonce: "session-default")
        },
        triggerSourceCapture: @escaping @Sendable (CaptureSubmission, ICAuthSession) async throws -> Void = { _, _ in
        },
        enqueueTrigger: (@Sendable (SourceCaptureRequest, String, Date) throws -> Void)? = nil
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
            enqueueURL: { url, receivedAt, requestId, captureMetadata in
                let inbox = try ShareInbox(testQueueDirectory: queueDirectory)
                try inbox.enqueue(url, receivedAt: receivedAt, requestId: requestId, captureMetadata: captureMetadata)
            },
            enqueueTrigger: { request, sessionNonce, createdAt in
                if let enqueueTrigger {
                    try enqueueTrigger(request, sessionNonce, createdAt)
                    return
                }
                let queue = try SourceCaptureTriggerQueue(testQueueDirectory: triggerQueueDirectory)
                try queue.enqueue(request, sessionNonce: sessionNonce, createdAt: createdAt)
            },
            removeTrigger: { requestId in
                do {
                    let queue = try SourceCaptureTriggerQueue(testQueueDirectory: triggerQueueDirectory)
                    queue.remove(requestId: requestId)
                } catch {
                    Issue.record("Could not remove trigger: \(error.localizedDescription)")
                }
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
    case triggerQueueFailed
    case triggerFailed
}
