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
    func savesWithoutQueueingWhenSubmissionSucceeds() async throws {
        let harness = try ShareCaptureHarness()
        let submitter = harness.submitter(session: makeSession(), databaseId: "db_demo") { request, _ in
            CaptureSubmission(requestPath: request.requestPath, triggered: true, triggerError: nil)
        }

        let result = await submitter.submitSharedURL(URL(string: "https://example.com/page")!)

        guard case let .saved(requestPath, triggerError) = result else {
            Issue.record("Expected saved result, got \(result)")
            return
        }
        #expect(requestPath.hasPrefix("/Sources/source-capture-requests/"))
        #expect(triggerError == nil)
        #expect(harness.pendingURLs().isEmpty)
    }

    @Test
    func triggerFailureStillCountsAsSaved() async throws {
        let harness = try ShareCaptureHarness()
        let submitter = harness.submitter(session: makeSession(), databaseId: "db_demo") { request, _ in
            CaptureSubmission(requestPath: request.requestPath, triggered: false, triggerError: "worker trigger failed")
        }

        let result = await submitter.submitSharedURL(URL(string: "https://example.com/page")!)

        guard case let .saved(_, triggerError) = result else {
            Issue.record("Expected saved result, got \(result)")
            return
        }
        #expect(triggerError == "worker trigger failed")
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
        #expect(harness.pendingURLs().count == 1)
    }
}

private struct ShareCaptureHarness {
    let suiteName: String
    let defaults: UserDefaults
    let configuration: AppConfiguration

    init() throws {
        suiteName = "kinic.share-capture.tests.\(UUID().uuidString)"
        defaults = try #require(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        configuration = AppConfiguration(
            canisterId: "xis3j-paaaa-aaaai-axumq-cai",
            apiBaseURL: URL(string: "https://icp0.io")!,
            derivationOrigin: "https://xis3j-paaaa-aaaai-axumq-cai.icp0.io",
            authOrigin: URL(string: "https://wiki.kinic.xyz")!,
            callbackDomain: "wiki.kinic.xyz",
            appGroupId: suiteName,
            keychainAccessGroup: "AKN976G7AK.xyz.kinic.ios.KinicWiki",
            openURL: URL(string: "kinicwiki://share")!
        )
    }

    func submitter(
        session: ICAuthSession?,
        databaseId: String,
        submitRequest: @escaping @Sendable (SourceCaptureRequest, ICAuthSession) async throws -> CaptureSubmission = { request, _ in
            CaptureSubmission(requestPath: request.requestPath, triggered: true, triggerError: nil)
        }
    ) -> ShareCaptureSubmitter {
        defaults.set(databaseId, forKey: "kinic.database-id.v1")
        let suiteName = suiteName
        return ShareCaptureSubmitter(
            configuration: configuration,
            timeoutNanoseconds: nil,
            restoreSession: {
                session
            },
            selectedDatabaseId: {
                databaseId
            },
            enqueueURL: { url in
                let inbox = try ShareInbox(strictAppGroupId: suiteName)
                try inbox.enqueue(url)
            },
            submitRequest: submitRequest
        )
    }

    func pendingURLs() -> [PendingSharedURL] {
        ShareInbox(appGroupId: suiteName).loadPendingURLs()
    }
}

private func makeSession() -> ICAuthSession {
    ICAuthSession(
        principal: "aaaaa-aa",
        canisterId: "xis3j-paaaa-aaaai-axumq-cai",
        identityProvider: "https://id.ai/#authorize",
        derivationOrigin: "https://xis3j-paaaa-aaaai-axumq-cai.icp0.io",
        sessionPublicKey: Data(),
        sessionPrivateKey: Data(),
        delegation: ICDelegationChain(publicKey: Data(), delegations: []),
        createdAt: Date(timeIntervalSince1970: 1_700_000_000)
    )
}

private enum ShareCaptureTestError: Error {
    case submissionFailed
}
