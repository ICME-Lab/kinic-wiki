// Where: mobile/ios/KinicApp/ViewModels/AppModel.swift
// What: Main-actor state and actions for the app shell.
// Why: SwiftUI views stay declarative while auth, settings, and submission are coordinated here.

import Foundation
import ICNativeClient
import Observation
import os

enum AppOpenURLAction: Equatable {
    case ignore
    case authCallback
    case shareHandoff
    case appRoot
}

enum DatabaseMetadataValidationError: Error, LocalizedError, Equatable {
    case emptyName
    case invalidTags

    var errorDescription: String? {
        switch self {
        case .emptyName:
            "Database name is required."
        case .invalidTags:
            "Tags must be comma-separated text values."
        }
    }
}

@MainActor
@Observable
final class AppModel {
    private let authService: KinicAuthService
    private let client: KinicICClient
    private let shareInbox: ShareInbox
    private let triggerQueue: SourceCaptureTriggerQueue
    private let settingsStore: SharedDefaultsStore
    private let logger: Logger
    private var session: ICAuthSession?
    private var isTriggeringSourceCapture: Bool
    private var browsePathLoadRequestID: Int
    private var documentLoadRequestID: Int
    private var searchRequestID: Int

    let configuration: AppConfiguration
    var selectedDatabaseId: String
    var selectedBrowseDatabaseId: String
    var databases: [DatabaseSummary]
    var readableDatabases: [DatabaseSummary]
    var pendingURLs: [PendingSharedURL]
    var rootNavigationID: Int
    var currentPath: String
    var currentNode: VFSNode?
    var childNodes: [ChildNode]
    var loadedBrowsePath: String?
    var selectedBrowseNodePath: String?
    var documentNode: VFSNode?
    var cyclesBillingConfig: CyclesBillingConfig?
    var searchQuery: String
    var searchResults: [SearchNodeHit]
    var statusMessage: String?
    var browseError: String?
    var documentError: String?
    var cyclesConfigError: String?
    var databaseMetadataError: String?
    var databaseListLastRefreshed: Date?
    var cyclesConfigLastRefreshed: Date?
    var isLoadingDatabases: Bool
    var isLoadingBrowsePath: Bool
    var isLoadingDocument: Bool
    var isLoadingCyclesConfig: Bool
    var isSearching: Bool
    var isSigningIn: Bool
    var isCreatingDatabase: Bool
    var isUpdatingDatabaseMetadata: Bool
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

    var selectedBrowseDatabase: DatabaseSummary? {
        readableDatabases.first { $0.databaseId == selectedBrowseDatabaseId }
    }

    var canBrowse: Bool {
        session != nil && !selectedBrowseDatabaseId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    init(
        configuration: AppConfiguration,
        authService: KinicAuthService,
        client: KinicICClient,
        shareInbox: ShareInbox,
        triggerQueue: SourceCaptureTriggerQueue,
        settingsStore: SharedDefaultsStore
    ) {
        self.configuration = configuration
        self.authService = authService
        self.client = client
        self.shareInbox = shareInbox
        self.triggerQueue = triggerQueue
        self.settingsStore = settingsStore
        logger = Logger(subsystem: "xyz.kinic.ios.KinicWiki", category: "AppModel")
        selectedDatabaseId = settingsStore.databaseId
        selectedBrowseDatabaseId = settingsStore.browseDatabaseId
        databases = []
        readableDatabases = []
        pendingURLs = shareInbox.loadPendingURLs()
        rootNavigationID = 0
        currentPath = "/Knowledge"
        currentNode = nil
        childNodes = []
        loadedBrowsePath = nil
        selectedBrowseNodePath = nil
        documentNode = nil
        cyclesBillingConfig = nil
        searchQuery = ""
        searchResults = []
        session = authService.restore()
        isTriggeringSourceCapture = false
        browsePathLoadRequestID = 0
        documentLoadRequestID = 0
        searchRequestID = 0
        browseError = nil
        documentError = nil
        cyclesConfigError = nil
        databaseMetadataError = nil
        databaseListLastRefreshed = nil
        cyclesConfigLastRefreshed = nil
        isLoadingDatabases = false
        isLoadingBrowsePath = false
        isLoadingDocument = false
        isLoadingCyclesConfig = false
        isSearching = false
        isSigningIn = false
        isCreatingDatabase = false
        isUpdatingDatabaseMetadata = false
        isSubmitting = false
    }

    static func live() -> AppModel {
        let configuration = AppConfiguration.liveFromBundle()
        let strictAppGroup = !isRunningUnitTests
        do {
            let settingsStore = try SharedDefaultsStore(appGroupId: configuration.appGroupId, strict: strictAppGroup)
            return AppModel(
                configuration: configuration,
                authService: KinicAuthService(configuration: configuration),
                client: KinicICClient(configuration: configuration),
                shareInbox: try ShareInbox(appGroupId: configuration.appGroupId, strict: strictAppGroup),
                triggerQueue: try SourceCaptureTriggerQueue(appGroupId: configuration.appGroupId, strict: strictAppGroup),
                settingsStore: settingsStore
            )
        } catch {
            fatalError(error.localizedDescription)
        }
    }

    private nonisolated static var isRunningUnitTests: Bool {
        let environment = ProcessInfo.processInfo.environment
        return environment["XCTestConfigurationFilePath"] != nil || environment["XCTestSessionIdentifier"] != nil
    }

    static func preview() -> AppModel {
        let configuration = AppConfiguration.preview
        do {
            let settingsStore = try SharedDefaultsStore(appGroupId: nil)
            return AppModel(
                configuration: configuration,
                authService: KinicAuthService(configuration: configuration),
                client: KinicICClient(configuration: configuration),
                shareInbox: try ShareInbox(appGroupId: nil),
                triggerQueue: try SourceCaptureTriggerQueue(appGroupId: nil),
                settingsStore: settingsStore
            )
        } catch {
            fatalError(error.localizedDescription)
        }
    }

    func refreshInbox() {
        pendingURLs = shareInbox.loadPendingURLs()
    }

    func handleOpenURL(_ url: URL) {
        switch Self.openURLAction(for: url, callbackDomain: configuration.callbackDomain) {
        case .ignore:
            return
        case .authCallback:
            statusMessage = "Returned from sign in."
        case .shareHandoff:
            refreshInbox()
            statusMessage = "Opened from share handoff."
            autoSubmitPendingURL()
            startRetryPendingTriggers()
        case .appRoot:
            resetBrowseRoot()
        }
    }

    nonisolated static func openURLAction(for url: URL, callbackDomain: String) -> AppOpenURLAction {
        guard url.scheme?.lowercased() == "https",
              url.host?.lowercased() == callbackDomain.lowercased() else {
            return .ignore
        }
        if url.path.hasPrefix("/ios-share") {
            return .shareHandoff
        }
        if url.path.hasPrefix("/ios-auth-callback") {
            return .authCallback
        }
        return .appRoot
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
            startRetryPendingTriggers()
            return true
        } catch {
            statusMessage = error.localizedDescription
            return false
        }
    }

    func selectDatabase(_ databaseId: String) {
        setSelectedDatabase(databaseId)
        statusMessage = "Database selected."
        autoSubmitPendingURL()
        startRetryPendingTriggers()
    }

    func selectBrowseDatabase(_ databaseId: String) {
        setSelectedBrowseDatabase(databaseId)
        resetBrowseStateForRoot()
        startLoadBrowsePath(currentPath)
    }

    private func resetBrowseRoot() {
        rootNavigationID += 1
        resetBrowseStateForRoot()
        if canBrowse {
            startLoadBrowsePath(currentPath)
        }
    }

    private func resetBrowseStateForRoot() {
        browsePathLoadRequestID += 1
        documentLoadRequestID += 1
        searchRequestID += 1
        currentPath = "/Knowledge"
        currentNode = nil
        childNodes = []
        loadedBrowsePath = nil
        selectedBrowseNodePath = nil
        documentNode = nil
        isLoadingBrowsePath = false
        isLoadingDocument = false
        isSearching = false
        searchQuery = ""
        searchResults = []
        browseError = nil
        documentError = nil
    }

    private func setSelectedDatabase(_ databaseId: String) {
        selectedDatabaseId = databaseId
        settingsStore.databaseId = databaseId
    }

    private func setSelectedBrowseDatabase(_ databaseId: String) {
        selectedBrowseDatabaseId = databaseId
        settingsStore.browseDatabaseId = databaseId
    }

    func startSignIn() {
        statusMessage = "Starting sign in..."
        logger.info("Kinic sign in requested authOrigin=\(self.configuration.authOrigin.absoluteString, privacy: .public) callbackDomain=\(self.configuration.callbackDomain, privacy: .public)")
        Task {
            await signIn()
        }
    }

    func signOut() {
        authService.signOut()
        session = nil
        databases = []
        readableDatabases = []
        selectedDatabaseId = ""
        selectedBrowseDatabaseId = ""
        settingsStore.databaseId = ""
        settingsStore.browseDatabaseId = ""
        settingsStore.writableDatabases = []
        browsePathLoadRequestID += 1
        documentLoadRequestID += 1
        searchRequestID += 1
        currentNode = nil
        childNodes = []
        loadedBrowsePath = nil
        selectedBrowseNodePath = nil
        documentNode = nil
        isLoadingBrowsePath = false
        isLoadingDocument = false
        isSearching = false
        cyclesBillingConfig = nil
        searchResults = []
        browseError = nil
        documentError = nil
        cyclesConfigError = nil
        databaseMetadataError = nil
        databaseListLastRefreshed = nil
        cyclesConfigLastRefreshed = nil
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

    func startRefreshDatabaseManagementInfo() {
        Task {
            await refreshDatabaseManagementInfo()
        }
    }

    func startLoadCyclesBillingConfigIfNeeded() {
        Task {
            await loadCyclesBillingConfigIfNeeded()
        }
    }

    func startCreateDatabase(name: String) {
        Task {
            await createDatabase(name: name)
        }
    }

    func updateDatabaseMetadata(databaseId: String, name: String, description: String, tagsInput: String, llmSummary: String) async -> Bool {
        guard !isUpdatingDatabaseMetadata else {
            return false
        }
        guard let session else {
            databaseMetadataError = "Sign in before updating database settings."
            return false
        }
        guard readableDatabases.first(where: { $0.databaseId == databaseId })?.role.canManageDatabase == true else {
            databaseMetadataError = "Only database owners can edit settings."
            return false
        }
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if let error = Self.databaseNameError(trimmedName) {
            databaseMetadataError = error
            return false
        }
        let tagsJson: String
        do {
            tagsJson = try Self.databaseTagsJson(from: tagsInput)
        } catch {
            databaseMetadataError = error.localizedDescription
            return false
        }
        let trimmedSummary = llmSummary.trimmingCharacters(in: .whitespacesAndNewlines)
        isUpdatingDatabaseMetadata = true
        databaseMetadataError = nil
        defer {
            isUpdatingDatabaseMetadata = false
        }
        do {
            _ = try await client.updateDatabaseMetadata(
                databaseId: databaseId,
                name: trimmedName,
                description: description,
                llmSummary: trimmedSummary.isEmpty ? nil : trimmedSummary,
                tagsJson: tagsJson,
                session: session
            )
            await refreshDatabases(selectFirstIfNeeded: false)
            statusMessage = "Database settings updated."
            return true
        } catch {
            databaseMetadataError = error.localizedDescription
            return false
        }
    }

    func startLoadBrowsePath(_ path: String) {
        Task {
            await loadBrowsePath(path)
        }
    }

    func openBrowsePath(_ path: String) {
        startLoadBrowsePath(path)
    }

    func startLoadBrowseDocument(_ path: String) {
        Task {
            await loadBrowseDocument(path)
        }
    }

    func openBrowseParent() {
        startLoadBrowsePath(Self.parentPath(currentPath))
    }

    func searchQueryDidChange(from oldQuery: String, to newQuery: String) {
        let previousQuery = oldQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        let nextQuery = newQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        if nextQuery.isEmpty || nextQuery != previousQuery {
            searchResults = []
        }
    }

    func startSearch() {
        Task {
            await searchBrowseDatabase()
        }
    }

    func autoSubmitPendingURL() {
        Task {
            await submitNextPendingURL()
        }
    }

    func startRetryPendingTriggers() {
        Task {
            await retryPendingTriggers()
        }
    }

    private func signIn() async {
        guard !isSigningIn else {
            return
        }
        isSigningIn = true
        defer {
            isSigningIn = false
        }
        do {
            session = try await authService.signIn()
            statusMessage = "Signed in."
            logger.info("Kinic sign in succeeded principal=\(self.session?.principal ?? "", privacy: .public)")
            await refreshDatabases()
            await loadBrowsePath(currentPath)
            await submitNextPendingURL()
            await retryPendingTriggers()
        } catch {
            statusMessage = error.localizedDescription
            logger.error("Kinic sign in failed error=\(error.localizedDescription, privacy: .public)")
        }
    }

    private func createDatabase(name: String) async {
        guard !isCreatingDatabase else {
            return
        }
        guard let session else {
            statusMessage = "Sign in before creating a database."
            return
        }
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if let error = Self.databaseNameError(trimmedName) {
            statusMessage = error
            return
        }
        isCreatingDatabase = true
        defer {
            isCreatingDatabase = false
        }
        do {
            let created = try await client.createDatabase(name: trimmedName, session: session)
            await refreshDatabases(selectFirstIfNeeded: false)
            if created.initialFreeGrantApplied || created.status == .active {
                setSelectedDatabase(created.databaseId)
                setSelectedBrowseDatabase(created.databaseId)
                statusMessage = created.initialFreeGrantApplied
                    ? "Database created with the initial free grant."
                    : "Database created active."
                await loadBrowsePath("/Knowledge")
                if !pendingURLs.isEmpty {
                    await submitNextPendingURL()
                }
                await retryPendingTriggers()
            } else {
                statusMessage = "Database created pending. Fund it from the web dashboard before capture."
            }
        } catch {
            statusMessage = error.localizedDescription
        }
    }

    private func refreshDatabases(selectFirstIfNeeded: Bool = true) async {
        guard let session else {
            currentNode = nil
            childNodes = []
            loadedBrowsePath = nil
            databases = []
            readableDatabases = []
            cyclesBillingConfig = nil
            cyclesConfigError = nil
            return
        }
        isLoadingDatabases = true
        defer {
            isLoadingDatabases = false
        }
        do {
            readableDatabases = try await client.listReadableDatabases(session: session)
            databases = readableDatabases.filter(\.canWrite)
            settingsStore.writableDatabases = databases
            databaseListLastRefreshed = Date()
            if !selectedDatabaseId.isEmpty,
               !databases.contains(where: { $0.databaseId == selectedDatabaseId }) {
                selectedDatabaseId = ""
                settingsStore.databaseId = ""
            }
            if !selectedBrowseDatabaseId.isEmpty,
               !readableDatabases.contains(where: { $0.databaseId == selectedBrowseDatabaseId }) {
                selectedBrowseDatabaseId = ""
                settingsStore.browseDatabaseId = ""
                currentNode = nil
                childNodes = []
                loadedBrowsePath = nil
                selectedBrowseNodePath = nil
                documentNode = nil
                documentLoadRequestID += 1
                isLoadingDocument = false
                searchResults = []
                documentError = nil
            }
            if selectFirstIfNeeded,
               selectedDatabaseId.isEmpty,
               let first = databases.first {
                selectDatabase(first.databaseId)
            }
            if selectFirstIfNeeded,
               selectedBrowseDatabaseId.isEmpty,
               let first = readableDatabases.first {
                setSelectedBrowseDatabase(first.databaseId)
                await loadBrowsePath("/Knowledge")
            } else if !selectedBrowseDatabaseId.isEmpty {
                await loadBrowsePath(currentPath)
            }
            await loadCyclesBillingConfigIfNeeded()
            await retryPendingTriggers()
        } catch {
            statusMessage = error.localizedDescription
        }
    }

    private func refreshDatabaseManagementInfo() async {
        await refreshDatabases(selectFirstIfNeeded: false)
        await loadCyclesBillingConfig(force: true)
    }

    private func loadCyclesBillingConfigIfNeeded() async {
        guard cyclesBillingConfig == nil else {
            return
        }
        await loadCyclesBillingConfig(force: false)
    }

    private func loadCyclesBillingConfig(force: Bool) async {
        guard !isLoadingCyclesConfig else {
            return
        }
        guard let session else {
            cyclesBillingConfig = nil
            cyclesConfigError = "Sign in before loading database management info."
            return
        }
        if !force, cyclesBillingConfig != nil {
            return
        }
        isLoadingCyclesConfig = true
        cyclesConfigError = nil
        defer {
            isLoadingCyclesConfig = false
        }
        do {
            cyclesBillingConfig = try await client.getCyclesBillingConfig(session: session)
            cyclesConfigLastRefreshed = Date()
        } catch {
            cyclesConfigError = error.localizedDescription
        }
    }

    private func loadBrowsePath(_ path: String) async {
        guard let session else {
            browseError = "Sign in before browsing."
            return
        }
        let databaseId = selectedBrowseDatabaseId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !databaseId.isEmpty else {
            browseError = "Select a database to browse."
            return
        }
        let normalizedPath = Self.normalizedBrowsePath(path)
        browsePathLoadRequestID += 1
        let requestID = browsePathLoadRequestID
        isLoadingBrowsePath = true
        currentPath = normalizedPath
        if loadedBrowsePath != normalizedPath {
            currentNode = nil
            childNodes = []
            loadedBrowsePath = nil
        }
        browseError = nil
        defer {
            if browsePathLoadRequestID == requestID {
                isLoadingBrowsePath = false
            }
        }
        do {
            guard let node = try await client.readNode(databaseId: databaseId, path: normalizedPath, session: session) else {
                if browsePathLoadRequestID == requestID {
                    currentNode = nil
                    childNodes = []
                    loadedBrowsePath = nil
                    browseError = "Node not found: \(normalizedPath)"
                }
                return
            }
            let loadedChildren = node.kind == .folder
                ? try await client.listChildren(databaseId: databaseId, path: normalizedPath, session: session)
                : []
            if browsePathLoadRequestID == requestID {
                currentNode = node
                childNodes = loadedChildren
                loadedBrowsePath = normalizedPath
            }
        } catch {
            if browsePathLoadRequestID == requestID {
                currentNode = nil
                childNodes = []
                loadedBrowsePath = nil
                browseError = error.localizedDescription
            }
        }
    }

    private func loadBrowseDocument(_ path: String) async {
        guard let session else {
            documentError = "Sign in before browsing."
            return
        }
        let databaseId = selectedBrowseDatabaseId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !databaseId.isEmpty else {
            documentError = "Select a database to browse."
            return
        }
        let normalizedPath = Self.normalizedBrowsePath(path)
        documentLoadRequestID += 1
        let requestID = documentLoadRequestID
        selectedBrowseNodePath = normalizedPath
        isLoadingDocument = true
        documentError = nil
        defer {
            if isCurrentDocumentLoad(requestID: requestID, databaseId: databaseId, path: normalizedPath) {
                isLoadingDocument = false
            }
        }
        do {
            guard let node = try await client.readNode(databaseId: databaseId, path: normalizedPath, session: session) else {
                if isCurrentDocumentLoad(requestID: requestID, databaseId: databaseId, path: normalizedPath) {
                    documentNode = nil
                    documentError = "Node not found: \(normalizedPath)"
                }
                return
            }
            guard node.kind != .folder else {
                if isCurrentDocumentLoad(requestID: requestID, databaseId: databaseId, path: normalizedPath) {
                    documentNode = nil
                    documentError = "Folder cannot be previewed: \(normalizedPath)"
                }
                return
            }
            if isCurrentDocumentLoad(requestID: requestID, databaseId: databaseId, path: normalizedPath) {
                documentNode = node
                documentError = nil
            }
        } catch {
            if isCurrentDocumentLoad(requestID: requestID, databaseId: databaseId, path: normalizedPath) {
                documentError = error.localizedDescription
            }
        }
    }

    private func isCurrentDocumentLoad(requestID: Int, databaseId: String, path: String) -> Bool {
        documentLoadRequestID == requestID
            && selectedBrowseDatabaseId.trimmingCharacters(in: .whitespacesAndNewlines) == databaseId
            && selectedBrowseNodePath == path
    }

    private func searchBrowseDatabase() async {
        guard let session else {
            browseError = "Sign in before searching."
            return
        }
        let databaseId = selectedBrowseDatabaseId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !databaseId.isEmpty else {
            browseError = "Select a database to search."
            return
        }
        let query = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else {
            searchResults = []
            return
        }
        searchRequestID += 1
        let requestID = searchRequestID
        isSearching = true
        browseError = nil
        defer {
            if searchRequestID == requestID {
                isSearching = false
            }
        }
        do {
            let hits = try await client.searchNodes(databaseId: databaseId, query: query, prefix: nil, limit: 20, session: session)
            if searchRequestID == requestID,
               selectedBrowseDatabaseId.trimmingCharacters(in: .whitespacesAndNewlines) == databaseId,
               searchQuery.trimmingCharacters(in: .whitespacesAndNewlines) == query {
                searchResults = hits
            }
        } catch {
            if searchRequestID == requestID {
                browseError = error.localizedDescription
            }
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
                requestedBy: session.principal,
                requestId: item.requestId
            )
            let submission = try await client.saveSourceCaptureRequest(request, session: session)
            try triggerQueue.enqueue(request, sessionNonce: submission.sessionNonce, createdAt: item.receivedAt)
            shareInbox.remove(item)
            refreshInbox()
            statusMessage = "Saved \(submission.requestPath)."
            startRetryPendingTriggers()
        } catch {
            statusMessage = error.localizedDescription
        }
    }

    private func retryPendingTriggers() async {
        guard !isTriggeringSourceCapture else {
            return
        }
        guard let session else {
            return
        }
        isTriggeringSourceCapture = true
        defer {
            isTriggeringSourceCapture = false
        }
        for trigger in triggerQueue.loadPendingTriggers() {
            do {
                try await client.triggerSourceCapture(
                    databaseId: trigger.databaseId,
                    requestPath: trigger.requestPath,
                    sessionNonce: trigger.sessionNonce,
                    session: session
                )
                triggerQueue.remove(trigger)
            } catch {
                triggerQueue.updateFailure(trigger, error: error.localizedDescription)
            }
        }
    }

    nonisolated static func databaseNameError(_ databaseName: String) -> String? {
        if databaseName.isEmpty {
            return "Database name is required."
        }
        if Array(databaseName).count > 80 {
            return "Database name must be 1..80 characters."
        }
        if databaseName.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f }) {
            return "Database name may not contain control characters."
        }
        return nil
    }

    nonisolated static func databaseTagsJson(from input: String) throws -> String {
        let tags = input
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        guard tags.allSatisfy({ !$0.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f }) }) else {
            throw DatabaseMetadataValidationError.invalidTags
        }
        let data = try JSONEncoder().encode(tags)
        guard let json = String(data: data, encoding: .utf8) else {
            throw DatabaseMetadataValidationError.invalidTags
        }
        return json
    }

    nonisolated static func normalizedBrowsePath(_ path: String) -> String {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return "/Knowledge"
        }
        let prefixed = trimmed.hasPrefix("/") ? trimmed : "/\(trimmed)"
        let segments = prefixed.split(separator: "/").map(String.init)
        return segments.isEmpty ? "/" : "/\(segments.joined(separator: "/"))"
    }

    nonisolated static func parentPath(_ path: String) -> String {
        let normalized = normalizedBrowsePath(path)
        guard normalized != "/" else {
            return "/"
        }
        let segments = normalized.split(separator: "/").map(String.init)
        guard segments.count > 1 else {
            return "/"
        }
        return "/\(segments.dropLast().joined(separator: "/"))"
    }
}
