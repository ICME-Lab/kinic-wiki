// Where: mobile/ios/KinicApp/ViewModels/AppModel.swift
// What: Main-actor state and actions for the app shell.
// Why: SwiftUI views stay declarative while auth, settings, and submission are coordinated here.

import Foundation
import ICNativeClient
import Observation

@MainActor
@Observable
final class AppModel {
    private let authService: KinicAuthService
    private let client: KinicICClient
    private let shareInbox: ShareInbox
    private let settingsStore: SharedDefaultsStore
    private var session: ICAuthSession?

    let configuration: AppConfiguration
    var selectedDatabaseId: String
    var databases: [DatabaseSummary]
    var pendingURLs: [PendingSharedURL]
    var statusMessage: String?
    var isLoadingDatabases: Bool
    var isSubmitting: Bool

    var principalText: String {
        session?.principal ?? "Not signed in"
    }

    var isSignedIn: Bool {
        session != nil
    }

    var canSubmit: Bool {
        session != nil && !selectedDatabaseId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !pendingURLs.isEmpty && !isSubmitting
    }

    var selectedDatabase: DatabaseSummary? {
        databases.first { $0.databaseId == selectedDatabaseId }
    }

    init(
        configuration: AppConfiguration,
        authService: KinicAuthService,
        client: KinicICClient,
        shareInbox: ShareInbox,
        settingsStore: SharedDefaultsStore
    ) {
        self.configuration = configuration
        self.authService = authService
        self.client = client
        self.shareInbox = shareInbox
        self.settingsStore = settingsStore
        selectedDatabaseId = settingsStore.databaseId
        databases = []
        pendingURLs = shareInbox.loadPendingURLs()
        session = authService.restore()
        isLoadingDatabases = false
        isSubmitting = false
    }

    static func live() -> AppModel {
        let configuration = AppConfiguration.liveFromBundle()
        let settingsStore = SharedDefaultsStore(appGroupId: configuration.appGroupId)
        return AppModel(
            configuration: configuration,
            authService: KinicAuthService(configuration: configuration),
            client: KinicICClient(configuration: configuration),
            shareInbox: ShareInbox(appGroupId: configuration.appGroupId),
            settingsStore: settingsStore
        )
    }

    static func preview() -> AppModel {
        let configuration = AppConfiguration.preview
        let settingsStore = SharedDefaultsStore(appGroupId: nil)
        return AppModel(
            configuration: configuration,
            authService: KinicAuthService(configuration: configuration),
            client: KinicICClient(configuration: configuration),
            shareInbox: ShareInbox(appGroupId: nil),
            settingsStore: settingsStore
        )
    }

    func refreshInbox() {
        pendingURLs = shareInbox.loadPendingURLs()
    }

    func handleOpenURL(_ url: URL) {
        refreshInbox()
        statusMessage = "Opened from \(url.scheme ?? "URL")."
        autoSubmitPendingURL()
    }

    func enqueueManualURL(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let rawURL = URL(string: trimmed) else {
            statusMessage = "Enter a valid URL."
            return false
        }
        do {
            let normalizedURL = try URLNormalizer.normalizedHTTPURL(rawURL)
            try shareInbox.enqueue(normalizedURL)
            refreshInbox()
            statusMessage = "URL queued."
            autoSubmitPendingURL()
            return true
        } catch {
            statusMessage = error.localizedDescription
            return false
        }
    }

    func selectDatabase(_ databaseId: String) {
        selectedDatabaseId = databaseId
        settingsStore.databaseId = databaseId
        statusMessage = "Database selected."
        autoSubmitPendingURL()
    }

    func startSignIn() {
        Task {
            await signIn()
        }
    }

    func signOut() {
        authService.signOut()
        session = nil
        databases = []
        selectedDatabaseId = ""
        settingsStore.databaseId = ""
        statusMessage = "Signed out."
    }

    func startSubmitNextPendingURL() {
        Task {
            await submitNextPendingURL()
        }
    }

    func startRefreshDatabases() {
        Task {
            await refreshDatabases()
        }
    }

    func autoSubmitPendingURL() {
        Task {
            await submitNextPendingURL()
        }
    }

    private func signIn() async {
        do {
            session = try await authService.signIn()
            statusMessage = "Signed in."
            await refreshDatabases()
            await submitNextPendingURL()
        } catch {
            statusMessage = error.localizedDescription
        }
    }

    private func refreshDatabases() async {
        guard let session else {
            databases = []
            return
        }
        isLoadingDatabases = true
        defer {
            isLoadingDatabases = false
        }
        do {
            databases = try await client.listWritableDatabases(session: session)
            if !selectedDatabaseId.isEmpty,
               !databases.contains(where: { $0.databaseId == selectedDatabaseId }) {
                selectedDatabaseId = ""
                settingsStore.databaseId = ""
            }
            if selectedDatabaseId.isEmpty,
               let first = databases.first {
                selectDatabase(first.databaseId)
            }
        } catch {
            statusMessage = error.localizedDescription
        }
    }

    private func submitNextPendingURL() async {
        guard !isSubmitting else {
            return
        }
        guard let session else {
            statusMessage = "Sign in before submitting."
            return
        }
        let databaseId = selectedDatabaseId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !databaseId.isEmpty else {
            statusMessage = "Select a writable database."
            return
        }
        guard let item = pendingURLs.first else {
            statusMessage = "No shared URL to submit."
            return
        }
        isSubmitting = true
        defer {
            isSubmitting = false
        }
        do {
            let request = try SourceCaptureRequestBuilder.request(
                url: item.url,
                databaseId: databaseId,
                requestedBy: session.principal
            )
            let submission = try await client.submit(request, session: session)
            shareInbox.remove(item)
            refreshInbox()
            if submission.triggered {
                statusMessage = "Submitted \(submission.requestPath)."
            } else {
                statusMessage = submission.triggerError ?? "Submitted, but worker trigger failed."
            }
        } catch {
            statusMessage = error.localizedDescription
        }
    }
}
