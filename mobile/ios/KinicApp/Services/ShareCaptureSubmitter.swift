// Where: mobile/ios/KinicApp/Services/ShareCaptureSubmitter.swift
// What: Best-effort Share Extension source-capture submission.
// Why: Browser shares should save immediately when auth and database state are already available.

import Foundation
import ICNativeClient

struct ShareCaptureSubmitter: Sendable {
    private let configuration: AppConfiguration
    private let timeoutNanoseconds: UInt64?
    private let restoreSession: @Sendable () -> ICAuthSession?
    private let selectedDatabaseId: @Sendable () -> String
    private let enqueueURL: @Sendable (URL, Date, String?, ShareCaptureMetadata?) throws -> Void
    private let enqueueTrigger: @Sendable (SourceCaptureRequest, String, Date) throws -> Void
    private let removeTrigger: @Sendable (String) -> Void
    private let saveRequest: @Sendable (SourceCaptureRequest, ICAuthSession) async throws -> CaptureSubmission
    private let triggerSourceCapture: @Sendable (CaptureSubmission, ICAuthSession) async throws -> Void

    static func makeLive(configuration: AppConfiguration, timeoutNanoseconds: UInt64? = 12_000_000_000) throws -> ShareCaptureSubmitter {
        let sessionStore = KinicAuthSessionStore(configuration: configuration)
        let settingsStore = try SharedDefaultsStore(appGroupId: configuration.appGroupId, strict: true)
        let triggerQueue = try SourceCaptureTriggerQueue(strictAppGroupId: configuration.appGroupId)
        let client = KinicICClient(configuration: configuration)
        return ShareCaptureSubmitter(
            configuration: configuration,
            timeoutNanoseconds: timeoutNanoseconds,
            restoreSession: {
                sessionStore.restore()
            },
            selectedDatabaseId: {
                settingsStore.databaseId
            },
            enqueueURL: { url, receivedAt, requestId, captureMetadata in
                let inbox = try ShareInbox(strictAppGroupId: configuration.appGroupId)
                try inbox.enqueue(url, receivedAt: receivedAt, requestId: requestId, captureMetadata: captureMetadata)
            },
            enqueueTrigger: { request, sessionNonce, createdAt in
                try triggerQueue.enqueue(request, sessionNonce: sessionNonce, createdAt: createdAt)
            },
            removeTrigger: { requestId in
                triggerQueue.remove(requestId: requestId)
            },
            saveRequest: { request, session in
                try await client.saveSourceCaptureRequest(request, session: session)
            },
            triggerSourceCapture: { submission, session in
                try await client.triggerSourceCapture(
                    databaseId: submission.databaseId,
                    requestPath: submission.requestPath,
                    sessionNonce: submission.sessionNonce,
                    session: session
                )
            }
        )
    }

    init(
        configuration: AppConfiguration,
        timeoutNanoseconds: UInt64?,
        restoreSession: @escaping @Sendable () -> ICAuthSession?,
        selectedDatabaseId: @escaping @Sendable () -> String,
        enqueueURL: @escaping @Sendable (URL, Date, String?, ShareCaptureMetadata?) throws -> Void,
        enqueueTrigger: @escaping @Sendable (SourceCaptureRequest, String, Date) throws -> Void,
        removeTrigger: @escaping @Sendable (String) -> Void,
        saveRequest: @escaping @Sendable (SourceCaptureRequest, ICAuthSession) async throws -> CaptureSubmission,
        triggerSourceCapture: @escaping @Sendable (CaptureSubmission, ICAuthSession) async throws -> Void
    ) {
        self.configuration = configuration
        self.timeoutNanoseconds = timeoutNanoseconds
        self.restoreSession = restoreSession
        self.selectedDatabaseId = selectedDatabaseId
        self.enqueueURL = enqueueURL
        self.enqueueTrigger = enqueueTrigger
        self.removeTrigger = removeTrigger
        self.saveRequest = saveRequest
        self.triggerSourceCapture = triggerSourceCapture
    }

    func submitSharedURL(
        _ url: URL,
        databaseIdOverride: String? = nil,
        captureMetadata: ShareCaptureMetadata? = nil
    ) async -> ShareCaptureResult {
        let normalizedURL: URL
        do {
            normalizedURL = try URLNormalizer.normalizedHTTPURL(url)
        } catch {
            return .failed(message: error.localizedDescription)
        }
        guard let session = restoreSession() else {
            return queue(
                normalizedURL,
                captureMetadata: captureMetadata,
                reason: "Sign in in KinicWikiApp to send this URL later."
            )
        }
        let databaseId: String
        if let overrideDatabaseId = databaseIdOverride?.trimmingCharacters(in: .whitespacesAndNewlines),
           !overrideDatabaseId.isEmpty {
            databaseId = overrideDatabaseId
        } else {
            databaseId = selectedDatabaseId().trimmingCharacters(in: .whitespacesAndNewlines)
        }
        guard !databaseId.isEmpty else {
            return queue(
                normalizedURL,
                captureMetadata: captureMetadata,
                reason: "Select a writable database in KinicWikiApp to send this URL later."
            )
        }
        let receivedAt = Date.now
        let request: SourceCaptureRequest
        do {
            request = try SourceCaptureRequestBuilder.request(
                url: normalizedURL,
                databaseId: databaseId,
                requestedBy: session.principal,
                now: receivedAt,
                captureMetadata: captureMetadata
            )
        } catch {
            return .failed(message: error.localizedDescription)
        }
        let submission: CaptureSubmission
        do {
            submission = try await withTimeout {
                try await saveRequest(request, session)
            }
        } catch {
            return queue(
                normalizedURL,
                receivedAt: receivedAt,
                requestId: request.requestId,
                captureMetadata: captureMetadata,
                reason: "Saved for later because immediate submission failed."
            )
        }
        do {
            try enqueueTrigger(request, submission.sessionNonce, receivedAt)
        } catch {
            let queueError = error
            do {
                try await triggerSourceCapture(submission, session)
                return .saved(requestPath: submission.requestPath)
            } catch {
                let message = "Source capture request was saved, but capture could not queue for retry " +
                    "(\(queueError.localizedDescription)) or trigger immediately (\(error.localizedDescription))."
                return .failed(
                    message: message
                )
            }
        }
        Task {
            do {
                try await triggerSourceCapture(submission, session)
                removeTrigger(submission.requestId)
            } catch {
                // Retry remains queued for the containing app.
            }
        }
        return .saved(requestPath: submission.requestPath)
    }

    private func queue(
        _ url: URL,
        receivedAt: Date = .now,
        requestId: String? = nil,
        captureMetadata: ShareCaptureMetadata? = nil,
        reason: String
    ) -> ShareCaptureResult {
        do {
            try enqueueURL(url, receivedAt, requestId, captureMetadata)
            return .queued(reason: reason)
        } catch {
            return .failed(message: error.localizedDescription)
        }
    }

    private func withTimeout<T: Sendable>(
        operation: @escaping @Sendable () async throws -> T
    ) async throws -> T {
        guard let timeoutNanoseconds else {
            return try await operation()
        }
        return try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask {
                try await operation()
            }
            group.addTask {
                try await Task.sleep(nanoseconds: timeoutNanoseconds)
                throw ShareCaptureSubmitterError.timeout
            }
            guard let value = try await group.next() else {
                throw ShareCaptureSubmitterError.timeout
            }
            group.cancelAll()
            return value
        }
    }
}

private enum ShareCaptureSubmitterError: LocalizedError {
    case timeout

    var errorDescription: String? {
        switch self {
        case .timeout:
            "Immediate submission timed out."
        }
    }
}
