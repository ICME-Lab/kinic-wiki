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
    private let enqueueURL: @Sendable (URL, Date, String?) throws -> Void
    private let enqueueTrigger: @Sendable (SourceCaptureRequest, Date) throws -> Void
    private let saveRequest: @Sendable (SourceCaptureRequest, ICAuthSession) async throws -> CaptureSubmission

    init(configuration: AppConfiguration, timeoutNanoseconds: UInt64? = 12_000_000_000) {
        let sessionStore = KinicAuthSessionStore(configuration: configuration)
        do {
            let settingsStore = try SharedDefaultsStore(appGroupId: configuration.appGroupId, strict: true)
            let triggerQueue = try SourceCaptureTriggerQueue(strictAppGroupId: configuration.appGroupId)
            let client = KinicICClient(configuration: configuration)
            self.init(
                configuration: configuration,
                timeoutNanoseconds: timeoutNanoseconds,
                restoreSession: {
                    sessionStore.restore()
                },
                selectedDatabaseId: {
                    settingsStore.databaseId
                },
                enqueueURL: { url, receivedAt, requestId in
                    let inbox = try ShareInbox(strictAppGroupId: configuration.appGroupId)
                    try inbox.enqueue(url, receivedAt: receivedAt, requestId: requestId)
                },
                enqueueTrigger: { request, createdAt in
                    try triggerQueue.enqueue(request, createdAt: createdAt)
                },
                saveRequest: { request, session in
                    try await client.saveSourceCaptureRequest(request, session: session)
                }
            )
        } catch {
            fatalError(error.localizedDescription)
        }
    }

    init(
        configuration: AppConfiguration,
        timeoutNanoseconds: UInt64?,
        restoreSession: @escaping @Sendable () -> ICAuthSession?,
        selectedDatabaseId: @escaping @Sendable () -> String,
        enqueueURL: @escaping @Sendable (URL, Date, String?) throws -> Void,
        enqueueTrigger: @escaping @Sendable (SourceCaptureRequest, Date) throws -> Void,
        saveRequest: @escaping @Sendable (SourceCaptureRequest, ICAuthSession) async throws -> CaptureSubmission
    ) {
        self.configuration = configuration
        self.timeoutNanoseconds = timeoutNanoseconds
        self.restoreSession = restoreSession
        self.selectedDatabaseId = selectedDatabaseId
        self.enqueueURL = enqueueURL
        self.enqueueTrigger = enqueueTrigger
        self.saveRequest = saveRequest
    }

    func submitSharedURL(_ url: URL) async -> ShareCaptureResult {
        let normalizedURL: URL
        do {
            normalizedURL = try URLNormalizer.normalizedHTTPURL(url)
        } catch {
            return .failed(message: error.localizedDescription)
        }
        guard let session = restoreSession() else {
            return queue(normalizedURL, reason: "Sign in in KinicWikiApp to send this URL later.")
        }
        let databaseId = selectedDatabaseId().trimmingCharacters(in: .whitespacesAndNewlines)
        guard !databaseId.isEmpty else {
            return queue(normalizedURL, reason: "Select a writable database in KinicWikiApp to send this URL later.")
        }
        let receivedAt = Date.now
        let request: SourceCaptureRequest
        do {
            request = try SourceCaptureRequestBuilder.request(
                url: normalizedURL,
                databaseId: databaseId,
                requestedBy: session.principal,
                now: receivedAt
            )
        } catch {
            return .failed(message: error.localizedDescription)
        }
        do {
            let submission = try await withTimeout {
                return try await saveRequest(request, session)
            }
            try enqueueTrigger(request, receivedAt)
            return .saved(requestPath: submission.requestPath)
        } catch {
            return queue(
                normalizedURL,
                receivedAt: receivedAt,
                requestId: request.requestId,
                reason: "Saved for later because immediate submission failed."
            )
        }
    }

    private func queue(
        _ url: URL,
        receivedAt: Date = .now,
        requestId: String? = nil,
        reason: String
    ) -> ShareCaptureResult {
        do {
            try enqueueURL(url, receivedAt, requestId)
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
