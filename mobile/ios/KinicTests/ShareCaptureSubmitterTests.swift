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
        let submitter = harness.submitter(session: nil, databaseId: "db_demo", outputLanguage: .japanese)

        let result = await submitter.submitSharedURL(URL(string: "https://example.com/page")!)
        guard case .queued = result else {
            Issue.record("Expected queued result, got \(result)")
            return
        }
        #expect(harness.pendingURLs().map(\.url.absoluteString) == ["https://example.com/page"])
        #expect(harness.pendingURLs().map(\.outputLanguage) == [.japanese])
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
    func savesAndTriggersWorker() async throws {
        let harness = try ShareCaptureHarness()
        let triggerProbe = TriggerProbe()
        let submitter = harness.submitter(session: makeSession(), databaseId: "db_demo") { request, _ in
            CaptureSubmission(databaseId: request.databaseId, requestPath: request.requestPath, requestId: request.requestId, url: request.normalizedURL, sessionNonce: "session-1")
        } triggerSourceCapture: { submission, _ in
            await triggerProbe.record(submission)
        }

        let result = await submitter.submitSharedURL(URL(string: "https://example.com/page")!)
        await Task.yield()

        guard case let .saved(requestPath) = result else {
            Issue.record("Expected saved result, got \(result)")
            return
        }
        #expect(requestPath.hasPrefix("/Sources/source-capture-requests/"))
        #expect(harness.pendingURLs().isEmpty)
        #expect(await triggerProbe.requestPaths() == [requestPath])
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
    func immediateSubmissionIncludesSelectedOutputLanguage() async throws {
        let harness = try ShareCaptureHarness()
        let probe = RequestMetadataProbe()
        let submitter = harness.submitter(session: makeSession(), databaseId: "db_demo", outputLanguage: .simplifiedChinese) { request, _ in
            await probe.record(request.metadataJson)
            return CaptureSubmission(databaseId: request.databaseId, requestPath: request.requestPath, requestId: request.requestId, url: request.normalizedURL, sessionNonce: "session-language")
        }

        let result = await submitter.submitSharedURL(URL(string: "https://example.com/page")!)

        guard case .saved = result else {
            Issue.record("Expected saved result, got \(result)")
            return
        }
        #expect(await probe.load().contains("\"output_language\":\"zh-Hans\""))
    }

    @Test
    func explicitDatabaseOverrideSelectsSubmissionDatabase() async throws {
        let harness = try ShareCaptureHarness()
        let databaseProbe = RequestDatabaseProbe()
        let submitter = harness.submitter(session: makeSession(), databaseId: "db_default") { request, _ in
            await databaseProbe.record(request.databaseId)
            return CaptureSubmission(databaseId: request.databaseId, requestPath: request.requestPath, requestId: request.requestId, url: request.normalizedURL, sessionNonce: "session-override")
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
    func keepsRemoteRequestInLocalHistoryWhenWorkerTriggerFailsAfterSave() async throws {
        let harness = try ShareCaptureHarness()
        let probe = RequestPathProbe()
        let metadata = ShareCaptureMetadata(
            title: "Example",
            description: "A shared page",
            imageURL: nil,
            source: ShareCaptureMetadata.xOpenGraphSource,
            fetchedAt: Date(timeIntervalSince1970: 1_700_000_000)
        )
        let submitter = harness.submitter(session: makeSession(), databaseId: "db_demo", outputLanguage: .japanese) { request, _ in
            await probe.record(request.requestPath)
            return CaptureSubmission(databaseId: request.databaseId, requestPath: request.requestPath, requestId: request.requestId, url: request.normalizedURL, sessionNonce: "session-failed-trigger")
        } triggerSourceCapture: { _, _ in
            throw ShareCaptureTestError.triggerFailed
        }

        let result = await submitter.submitSharedURL(
            URL(string: "https://example.com/page")!,
            captureMetadata: metadata
        )

        guard case let .savedPendingRetry(requestPath) = result else {
            Issue.record("Expected saved-pending-retry result, got \(result)")
            return
        }
        let attemptedRequestPath = await probe.load()
        #expect(requestPath == attemptedRequestPath)
        #expect(harness.pendingURLs().isEmpty)
        #expect(harness.history(databaseId: "db_demo").map(\.item.requestPath) == [requestPath])
    }

    @Test
    func doesNotCreateRetryQueueWhenWorkerTriggerFailsAfterRemoteSave() async throws {
        let harness = try ShareCaptureHarness()
        let submitter = harness.submitter(
            session: makeSession(),
            databaseId: "db_demo",
            saveRequest: { request, _ in
                CaptureSubmission(databaseId: request.databaseId, requestPath: request.requestPath, requestId: request.requestId, url: request.normalizedURL, sessionNonce: "session-queue-failed")
            },
            triggerSourceCapture: { _, _ in
                throw ShareCaptureTestError.triggerFailed
            },
        )

        let result = await submitter.submitSharedURL(URL(string: "https://example.com/page")!)

        guard case .savedPendingRetry = result else {
            Issue.record("Expected saved-pending-retry result, got \(result)")
            return
        }
        #expect(harness.pendingURLs().isEmpty)
    }

    @Test
    func shareExtensionCopyDistinguishesStartedAndPendingRetry() {
        let requestPath = "/Sources/source-capture-requests/request.md"

        let started = ShareCaptureResult.saved(requestPath: requestPath)
        #expect(started.shareExtensionTitleText == "Capture started")
        #expect(started.shareExtensionMessageText == "KinicWiki is generating the source capture.")

        let pendingRetry = ShareCaptureResult.savedPendingRetry(requestPath: requestPath)
        #expect(pendingRetry.shareExtensionTitleText == "Saved, retry required")
        #expect(pendingRetry.shareExtensionMessageText.contains("Capture history"))
    }

    @Test
    func keepsRemoteRequestWhenWorkerTriggerTimesOutAfterSave() async throws {
        let harness = try ShareCaptureHarness()
        let submitter = harness.submitter(
            session: makeSession(),
            databaseId: "db_demo",
            timeoutNanoseconds: 50_000_000
        ) { request, _ in
            CaptureSubmission(databaseId: request.databaseId, requestPath: request.requestPath, requestId: request.requestId, url: request.normalizedURL, sessionNonce: "session-timeout")
        } triggerSourceCapture: { _, _ in
            try await Task.sleep(for: .seconds(1))
        }

        let result = await submitter.submitSharedURL(URL(string: "https://example.com/page")!)

        guard case .savedPendingRetry = result else {
            Issue.record("Expected saved-pending-retry result, got \(result)")
            return
        }
        #expect(harness.pendingURLs().isEmpty)
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
        let queued = try #require(harness.pendingURLs().first)
        #expect(queued.databaseId == "db_demo")
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
        #expect(queued.databaseId == "db_demo")
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
    let historyDirectory: URL
    let configuration: AppConfiguration

    init() throws {
        queueDirectory = FileManager.default.temporaryDirectory
            .appending(path: "kinic-share-capture-tests")
            .appending(path: UUID().uuidString)
        historyDirectory = queueDirectory.appending(path: "history")
        configuration = AppConfiguration(
            canisterId: "6emaw-iyaaa-aaaay-aacka-cai",
            apiBaseURL: URL(string: "https://icp0.io")!,
            identityProvider: URL(string: "https://id.ai/authorize")!,
            derivationOrigin: "https://6emaw-iyaaa-aaaay-aacka-cai.icp0.io",
            authOrigin: URL(string: "https://wiki.kinic.xyz")!,
            paymentBaseURL: URL(string: "https://payment.kinic.xyz")!,
            callbackDomain: "wiki.kinic.xyz",
            appGroupId: "group.xyz.kinic.ios.KinicWiki",
            keychainAccessGroup: "AKN976G7AK.xyz.kinic.ios.KinicWiki",
            iapProductIds: [],
            askAIURL: URL(string: "https://api.kinic.io/chat")!,
            deploymentEnvironment: .production
        )
        try FileManager.default.createDirectory(at: queueDirectory, withIntermediateDirectories: true)
    }

    func submitter(
        session: KinicIdentitySession?,
        databaseId: String,
        outputLanguage: WikiOutputLanguage = .english,
        timeoutNanoseconds: UInt64? = nil,
        saveRequest: @escaping @Sendable (SourceCaptureRequest, KinicIdentitySession) async throws -> CaptureSubmission = { request, _ in
            CaptureSubmission(databaseId: request.databaseId, requestPath: request.requestPath, requestId: request.requestId, url: request.normalizedURL, sessionNonce: "session-default")
        },
        saveHistory: (@Sendable (SourceCaptureRequest, Date) throws -> Void)? = nil,
        triggerSourceCapture: @escaping @Sendable (CaptureSubmission, KinicIdentitySession) async throws -> Void = { _, _ in },
        enqueueURL: (@Sendable (URL, Date, String?, String?, WikiOutputLanguage, ShareCaptureMetadata?) throws -> Void)? = nil
    ) -> ShareCaptureSubmitter {
        let queueDirectory = queueDirectory
        let historyDirectory = historyDirectory
        let resolvedEnqueueURL = enqueueURL ?? { url, receivedAt, requestId, databaseId, outputLanguage, captureMetadata in
            let inbox = try ShareInbox(testQueueDirectory: queueDirectory)
            try inbox.enqueue(
                url,
                receivedAt: receivedAt,
                requestId: requestId,
                databaseId: databaseId,
                outputLanguage: outputLanguage,
                captureMetadata: captureMetadata
            )
        }
        let resolvedSaveHistory = saveHistory ?? { request, receivedAt in
            let store = try SourceCaptureHistoryStore(testHistoryDirectory: historyDirectory)
            try store.save(SourceCaptureHistoryRecord(request: request, requestedAt: receivedAt))
        }
        return ShareCaptureSubmitter(
            configuration: configuration,
            timeoutNanoseconds: timeoutNanoseconds,
            restoreSession: {
                session
            },
            selectedDatabaseId: {
                databaseId
            },
            enqueueURL: resolvedEnqueueURL,
            saveRequest: saveRequest,
            saveHistory: resolvedSaveHistory,
            triggerSourceCapture: triggerSourceCapture,
            selectedOutputLanguage: { outputLanguage }
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

    func history(databaseId: String) -> [SourceCaptureHistoryRecord] {
        do {
            return try SourceCaptureHistoryStore(testHistoryDirectory: historyDirectory).load(databaseId: databaseId)
        } catch {
            Issue.record("Could not load capture history: \(error.localizedDescription)")
            return []
        }
    }
}

private func makeSession() -> KinicIdentitySession {
    .testing(principal: "aaaaa-aa")
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
