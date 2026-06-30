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
    private let enqueueURL: @Sendable (URL) throws -> Void
    private let submitRequest: @Sendable (SourceCaptureRequest, ICAuthSession) async throws -> CaptureSubmission

    init(configuration: AppConfiguration, timeoutNanoseconds: UInt64? = 12_000_000_000) {
        let sessionStore = KinicAuthSessionStore(configuration: configuration)
        let settingsStore = SharedDefaultsStore(appGroupId: configuration.appGroupId)
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
            enqueueURL: { url in
                let inbox = try ShareInbox(strictAppGroupId: configuration.appGroupId)
                try inbox.enqueue(url)
            },
            submitRequest: { request, session in
                try await client.submit(request, session: session)
            }
        )
    }

    init(
        configuration: AppConfiguration,
        timeoutNanoseconds: UInt64?,
        restoreSession: @escaping @Sendable () -> ICAuthSession?,
        selectedDatabaseId: @escaping @Sendable () -> String,
        enqueueURL: @escaping @Sendable (URL) throws -> Void,
        submitRequest: @escaping @Sendable (SourceCaptureRequest, ICAuthSession) async throws -> CaptureSubmission
    ) {
        self.configuration = configuration
        self.timeoutNanoseconds = timeoutNanoseconds
        self.restoreSession = restoreSession
        self.selectedDatabaseId = selectedDatabaseId
        self.enqueueURL = enqueueURL
        self.submitRequest = submitRequest
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
        do {
            let submission = try await withTimeout {
                let request = try SourceCaptureRequestBuilder.request(
                    url: normalizedURL,
                    databaseId: databaseId,
                    requestedBy: session.principal
                )
                return try await submitRequest(request, session)
            }
            return .saved(requestPath: submission.requestPath, triggerError: submission.triggerError)
        } catch {
            return queue(normalizedURL, reason: "Saved for later because immediate submission failed.")
        }
    }

    private func queue(_ url: URL, reason: String) -> ShareCaptureResult {
        do {
            try enqueueURL(url)
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
