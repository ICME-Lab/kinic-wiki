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
    private let enqueueURL: @Sendable (URL, Date, String?, String?, WikiOutputLanguage, ShareCaptureMetadata?) throws -> Void
    private let saveRequest: @Sendable (SourceCaptureRequest, ICAuthSession) async throws -> CaptureSubmission
    private let saveHistory: @Sendable (SourceCaptureRequest, Date) throws -> Void
    private let triggerSourceCapture: @Sendable (CaptureSubmission, ICAuthSession) async throws -> Void
    private let selectedOutputLanguage: @Sendable () -> WikiOutputLanguage

    static func makeLive(configuration: AppConfiguration, timeoutNanoseconds: UInt64? = 12_000_000_000) throws -> ShareCaptureSubmitter {
        let sessionStore = KinicAuthSessionStore(configuration: configuration)
        let settingsStore = try SharedDefaultsStore(appGroupId: configuration.appGroupId, strict: true)
        let historyStore = try SourceCaptureHistoryStore(appGroupId: configuration.appGroupId, strict: true)
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
            enqueueURL: { url, receivedAt, requestId, databaseId, outputLanguage, captureMetadata in
                let inbox = try ShareInbox(strictAppGroupId: configuration.appGroupId)
                try inbox.enqueue(
                    url,
                    receivedAt: receivedAt,
                    requestId: requestId,
                    databaseId: databaseId,
                    outputLanguage: outputLanguage,
                    captureMetadata: captureMetadata
                )
            },
            saveRequest: { request, session in
                try await client.saveSourceCaptureRequest(request, session: session)
            },
            saveHistory: { request, requestedAt in
                try historyStore.save(SourceCaptureHistoryRecord(request: request, requestedAt: requestedAt))
            },
            triggerSourceCapture: { submission, session in
                try await client.triggerSourceCapture(
                    databaseId: submission.databaseId,
                    requestPath: submission.requestPath,
                    sessionNonce: submission.sessionNonce,
                    session: session
                )
            },
            selectedOutputLanguage: { settingsStore.wikiOutputLanguage }
        )
    }

    init(
        configuration: AppConfiguration,
        timeoutNanoseconds: UInt64?,
        restoreSession: @escaping @Sendable () -> ICAuthSession?,
        selectedDatabaseId: @escaping @Sendable () -> String,
        enqueueURL: @escaping @Sendable (URL, Date, String?, String?, WikiOutputLanguage, ShareCaptureMetadata?) throws -> Void,
        saveRequest: @escaping @Sendable (SourceCaptureRequest, ICAuthSession) async throws -> CaptureSubmission,
        saveHistory: @escaping @Sendable (SourceCaptureRequest, Date) throws -> Void = { _, _ in },
        triggerSourceCapture: @escaping @Sendable (CaptureSubmission, ICAuthSession) async throws -> Void,
        selectedOutputLanguage: @escaping @Sendable () -> WikiOutputLanguage = { .english }
    ) {
        self.configuration = configuration
        self.timeoutNanoseconds = timeoutNanoseconds
        self.restoreSession = restoreSession
        self.selectedDatabaseId = selectedDatabaseId
        self.enqueueURL = enqueueURL
        self.saveRequest = saveRequest
        self.saveHistory = saveHistory
        self.triggerSourceCapture = triggerSourceCapture
        self.selectedOutputLanguage = selectedOutputLanguage
    }

    func submitSharedURL(
        _ url: URL,
        databaseIdOverride: String? = nil,
        captureMetadata: ShareCaptureMetadata? = nil
    ) async -> ShareCaptureResult {
        let outputLanguage = selectedOutputLanguage()
        let normalizedURL: URL
        do {
            normalizedURL = try URLNormalizer.normalizedHTTPURL(url)
        } catch {
            return .failed(message: error.localizedDescription)
        }
        guard let session = restoreSession() else {
            return queue(
                normalizedURL,
                outputLanguage: outputLanguage,
                captureMetadata: captureMetadata,
                reason: "Sign in in KinicWiki to send this URL later."
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
                outputLanguage: outputLanguage,
                captureMetadata: captureMetadata,
                reason: "Select a writable database in KinicWiki to send this URL later."
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
                outputLanguage: outputLanguage,
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
                databaseId: request.databaseId,
                outputLanguage: request.outputLanguage,
                captureMetadata: captureMetadata,
                reason: "Saved for later because immediate submission failed."
            )
        }
        do {
            try saveHistory(request, receivedAt)
        } catch {
            return queue(
                normalizedURL,
                receivedAt: receivedAt,
                requestId: request.requestId,
                databaseId: request.databaseId,
                outputLanguage: request.outputLanguage,
                captureMetadata: captureMetadata,
                reason: "The source request was saved remotely, but its local history could not be saved.",
                enqueueFailureMessage: "The source request was saved remotely, but the local retry record could not be saved."
            )
        }
        do {
            try await withTimeout {
                try await triggerSourceCapture(submission, session)
            }
        } catch {
            return .savedPendingRetry(requestPath: submission.requestPath)
        }
        return .saved(requestPath: submission.requestPath)
    }

    private func queue(
        _ url: URL,
        receivedAt: Date = .now,
        requestId: String? = nil,
        databaseId: String? = nil,
        outputLanguage: WikiOutputLanguage,
        captureMetadata: ShareCaptureMetadata? = nil,
        reason: String,
        enqueueFailureMessage: String? = nil
    ) -> ShareCaptureResult {
        do {
            try enqueueURL(url, receivedAt, requestId, databaseId, outputLanguage, captureMetadata)
            return .queued(reason: reason)
        } catch {
            if let enqueueFailureMessage {
                return .failed(message: "\(enqueueFailureMessage) \(error.localizedDescription)")
            }
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
                try await Task.sleep(for: .nanoseconds(Int64(timeoutNanoseconds)))
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
