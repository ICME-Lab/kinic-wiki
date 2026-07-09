// Where: mobile/ios/KinicApp/ViewModels/AppModel.swift
// What: Main-actor state and actions for the app shell.
// Why: SwiftUI views stay declarative while auth, settings, and submission are coordinated here.

import Foundation
import ICNativeClient
import Observation
import os

enum AppTab: Hashable {
    case home
    case browse
    case manage
}

enum BrowseNavigationTarget: Equatable {
    case folder(String)
    case document(path: String, parentPath: String)
}

enum AppOpenURLDestination: Equatable {
    case ignore
    case authCallback
    case shareHandoff
    case browse(databaseId: String, nodePath: String)
    case manage
    case home(String?)
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

struct BrowseDatabaseMergeResult: Equatable, Sendable {
    let databases: [DatabaseSummary]
    let memberDatabaseIds: Set<String>
    let publicDatabaseIds: Set<String>
    let purchasedDatabaseIds: Set<String>
}

struct PublicDatabaseRefreshResult: Equatable, Sendable {
    let databases: [DatabaseSummary]
    let errorMessage: String?
}

enum PendingSubmissionDatabaseResolution: Equatable, Sendable {
    case ready(String)
    case missingSelection
    case unavailable(String)

    var statusMessage: String {
        switch self {
        case .ready:
            ""
        case .missingSelection:
            "Select a writable database."
        case let .unavailable(databaseId):
            "Queued database is no longer writable: \(databaseId). Restore access before retrying."
        }
    }
}

@MainActor
@Observable
final class AppModel {
    private let authService: KinicAuthService
    private let client: KinicICClient
    private let shareInbox: ShareInbox
    private let settingsStore: SharedDefaultsStore
    private let logger: Logger
    private var session: ICAuthSession?
    private var browsePathLoadRequestID: Int
    private var documentLoadRequestID: Int
    private var searchRequestID: Int
    private var databaseManagementRequestID: Int
    private var deepLinkResolveRequestID: Int

    let configuration: AppConfiguration
    var selectedDatabaseId: String
    var selectedBrowseDatabaseId: String
    var isDarkAppearanceEnabled: Bool {
        didSet {
            settingsStore.isDarkAppearanceEnabled = isDarkAppearanceEnabled
        }
    }
    var showPublicBrowseDatabases: Bool {
        didSet {
            settingsStore.showPublicBrowseDatabases = showPublicBrowseDatabases
        }
    }
    var showPurchasedBrowseDatabases: Bool {
        didSet {
            settingsStore.showPurchasedBrowseDatabases = showPurchasedBrowseDatabases
        }
    }
    var databases: [DatabaseSummary]
    var readableDatabases: [DatabaseSummary]
    var memberBrowseDatabaseIds: Set<String>
    var publicBrowseDatabaseIds: Set<String>
    var purchasedBrowseDatabaseIds: Set<String>
    var directBrowseDatabaseIds: Set<String>
    var pendingURLs: [PendingSharedURL]
    var rootNavigationID: Int
    var requestedTab: AppTab
    var tabSelectionRequestID: Int
    var requestedBrowseTarget: BrowseNavigationTarget
    var browseNavigationRequestID: Int
    var currentPath: String
    var currentNode: VFSNode?
    var childNodes: [ChildNode]
    var loadedBrowsePath: String?
    var selectedBrowseNodePath: String?
    var documentNode: VFSNode?
    var cyclesBillingConfig: CyclesBillingConfig?
    var databaseMembers: [DatabaseMember]
    var databaseMembersDatabaseId: String?
    var databaseCycleEntries: [DatabaseCycleEntry]
    var databaseCycleEntriesDatabaseId: String?
    var databaseCycleEntriesCurrentCursor: UInt64?
    var databaseCycleEntriesNextCursor: UInt64?
    var databaseCycleEntryPageIndex: Int
    var databaseCycleEntryPreviousCursors: [UInt64?]
    var databaseCyclesPendingPurchases: [DatabaseCyclesPendingPurchase]
    var databaseCyclesPendingPurchasesDatabaseId: String?
    var searchQuery: String
    var searchResults: [SearchNodeHit]
    var statusMessage: String?
    var browseError: String?
    var documentError: String?
    var cyclesConfigError: String?
    var databaseMetadataError: String?
    var databaseMembersError: String?
    var databaseCyclesHistoryError: String?
    var databasePendingPurchasesError: String?
    var databaseDeleteError: String?
    var databaseListLastRefreshed: Date?
    var cyclesConfigLastRefreshed: Date?
    var isLoadingDatabases: Bool
    var isLoadingBrowsePath: Bool
    var isLoadingDocument: Bool
    var isLoadingCyclesConfig: Bool
    var isLoadingDatabaseMembers: Bool
    var isLoadingDatabaseCycleEntries: Bool
    var isLoadingDatabasePendingPurchases: Bool
    var isSearching: Bool
    var isSigningIn: Bool
    var isCreatingDatabase: Bool
    var isUpdatingDatabaseMetadata: Bool
    var databaseAccessBusyAction: DatabaseAccessBusyAction?
    var isSubmitting: Bool

    var principalText: String {
        session?.principal ?? "Not signed in"
    }

    var isSignedIn: Bool {
        session != nil
    }

    var canSubmit: Bool {
        guard session != nil,
              let item = pendingURLs.first,
              !isSubmitting else {
            return false
        }
        if case .ready = Self.pendingSubmissionDatabaseId(
            for: item,
            selectedDatabaseId: selectedDatabaseId,
            writableDatabaseIds: Set(databases.map(\.databaseId))
        ) {
            return true
        }
        return false
    }

    var selectedDatabase: DatabaseSummary? {
        databases.first { $0.databaseId == selectedDatabaseId }
    }

    var selectedBrowseDatabase: DatabaseSummary? {
        readableDatabases.first { $0.databaseId == selectedBrowseDatabaseId }
    }

    var managementDatabases: [DatabaseSummary] {
        readableDatabases.filter { memberBrowseDatabaseIds.contains($0.databaseId) }
    }

    var canListBrowseDatabases: Bool {
        session != nil || showPublicBrowseDatabases || !directBrowseDatabaseIds.isEmpty
    }

    var browseListDatabases: [DatabaseSummary] {
        var result = readableDatabases
        for databaseId in directBrowseDatabaseIds.sorted()
            where !result.contains(where: { $0.databaseId == databaseId }) {
            result.append(Self.directBrowseDatabaseSummary(databaseId: databaseId))
        }
        return result
    }

    var canBrowse: Bool {
        let databaseId = selectedBrowseDatabaseId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !databaseId.isEmpty else {
            return false
        }
        return session != nil || publicBrowseDatabaseIds.contains(databaseId) || directBrowseDatabaseIds.contains(databaseId)
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
        logger = Logger(subsystem: "xyz.kinic.ios.KinicWiki", category: "AppModel")
        selectedDatabaseId = settingsStore.databaseId
        selectedBrowseDatabaseId = settingsStore.browseDatabaseId
        isDarkAppearanceEnabled = settingsStore.isDarkAppearanceEnabled
        showPublicBrowseDatabases = settingsStore.showPublicBrowseDatabases
        showPurchasedBrowseDatabases = settingsStore.showPurchasedBrowseDatabases
        databases = []
        readableDatabases = []
        memberBrowseDatabaseIds = []
        publicBrowseDatabaseIds = []
        purchasedBrowseDatabaseIds = []
        directBrowseDatabaseIds = []
        pendingURLs = shareInbox.loadPendingURLs()
        rootNavigationID = 0
        requestedTab = .home
        tabSelectionRequestID = 0
        requestedBrowseTarget = .folder("/")
        browseNavigationRequestID = 0
        currentPath = "/"
        currentNode = nil
        childNodes = []
        loadedBrowsePath = nil
        selectedBrowseNodePath = nil
        documentNode = nil
        cyclesBillingConfig = nil
        databaseMembers = []
        databaseMembersDatabaseId = nil
        databaseCycleEntries = []
        databaseCycleEntriesDatabaseId = nil
        databaseCycleEntriesCurrentCursor = nil
        databaseCycleEntriesNextCursor = nil
        databaseCycleEntryPageIndex = 0
        databaseCycleEntryPreviousCursors = []
        databaseCyclesPendingPurchases = []
        databaseCyclesPendingPurchasesDatabaseId = nil
        searchQuery = ""
        searchResults = []
        session = authService.restore()
        browsePathLoadRequestID = 0
        documentLoadRequestID = 0
        searchRequestID = 0
        databaseManagementRequestID = 0
        deepLinkResolveRequestID = 0
        browseError = nil
        documentError = nil
        cyclesConfigError = nil
        databaseMetadataError = nil
        databaseMembersError = nil
        databaseCyclesHistoryError = nil
        databasePendingPurchasesError = nil
        databaseDeleteError = nil
        databaseListLastRefreshed = nil
        cyclesConfigLastRefreshed = nil
        isLoadingDatabases = false
        isLoadingBrowsePath = false
        isLoadingDocument = false
        isLoadingCyclesConfig = false
        isLoadingDatabaseMembers = false
        isLoadingDatabaseCycleEntries = false
        isLoadingDatabasePendingPurchases = false
        isSearching = false
        isSigningIn = false
        isCreatingDatabase = false
        isUpdatingDatabaseMetadata = false
        databaseAccessBusyAction = nil
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
                settingsStore: settingsStore
            )
        } catch {
            fatalError(error.localizedDescription)
        }
    }

    func refreshInbox() {
        pendingURLs = shareInbox.loadPendingURLs()
    }

    func setDarkAppearanceEnabled(_ enabled: Bool) {
        isDarkAppearanceEnabled = enabled
    }

    func setShowPublicBrowseDatabases(_ enabled: Bool) {
        showPublicBrowseDatabases = enabled
    }

    func setShowPurchasedBrowseDatabases(_ enabled: Bool) {
        showPurchasedBrowseDatabases = enabled
    }

    func isPublicBrowseDatabase(_ databaseId: String) -> Bool {
        publicBrowseDatabaseIds.contains(databaseId)
    }

    func isPurchasedBrowseDatabase(_ databaseId: String) -> Bool {
        purchasedBrowseDatabaseIds.contains(databaseId)
    }

    func handleOpenURL(_ url: URL) {
        switch Self.openURLDestination(for: url, callbackDomain: configuration.callbackDomain) {
        case .ignore:
            return
        case .authCallback:
            requestTab(.home)
        case .shareHandoff:
            requestTab(.home)
            refreshInbox()
            autoSubmitPendingURL()
        case let .browse(databaseId, nodePath):
            openBrowseDeepLink(databaseId: databaseId, nodePath: nodePath)
        case .manage:
            requestTab(.manage)
        case let .home(message):
            requestTab(.home)
            if let message {
                statusMessage = message
            }
        }
    }

    nonisolated static func openURLDestination(for url: URL, callbackDomain: String) -> AppOpenURLDestination {
        guard url.scheme?.lowercased() == "https",
              url.host?.lowercased() == callbackDomain.lowercased() else {
            return .ignore
        }
        let segments = decodedPathSegments(from: url)
        let firstSegment = segments.first ?? ""
        if firstSegment == "ios-share" {
            return .shareHandoff
        }
        if firstSegment == "ios-auth-callback" {
            return .authCallback
        }
        if firstSegment == "db",
           let databaseId = segments.dropFirst().first?.trimmingCharacters(in: .whitespacesAndNewlines),
           !databaseId.isEmpty {
            let nodeSegments = segments.dropFirst(2)
            let nodePath = nodeSegments.isEmpty ? "/Knowledge" : "/\(nodeSegments.joined(separator: "/"))"
            return .browse(databaseId: databaseId, nodePath: normalizedBrowsePath(nodePath))
        }
        if ["dashboard", "profile", "cycles"].contains(firstSegment) {
            return .manage
        }
        if firstSegment.isEmpty {
            return .home(nil)
        }
        return .home(nil)
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
            statusMessage = nil
            autoSubmitPendingURL()
            return true
        } catch {
            statusMessage = error.localizedDescription
            return false
        }
    }

    func selectDatabase(_ databaseId: String) {
        setSelectedDatabase(databaseId)
        statusMessage = nil
        autoSubmitPendingURL()
    }

    func selectBrowseDatabase(_ databaseId: String) {
        setSelectedBrowseDatabase(databaseId)
        resetBrowseStateForRoot()
        startLoadBrowsePath(currentPath)
    }

    private func requestTab(_ tab: AppTab) {
        requestedTab = tab
        tabSelectionRequestID += 1
    }

    private func openBrowseDeepLink(databaseId: String, nodePath: String) {
        let normalizedPath = Self.normalizedBrowsePath(nodePath)
        directBrowseDatabaseIds.insert(databaseId)
        setSelectedBrowseDatabase(databaseId)
        resetBrowseStateForRoot()
        requestTab(.browse)
        deepLinkResolveRequestID += 1
        let requestID = deepLinkResolveRequestID
        requestedBrowseTarget = .folder("/")
        browseNavigationRequestID += 1
        Task {
            await resolveBrowseDeepLink(databaseId: databaseId, nodePath: normalizedPath, requestID: requestID)
        }
    }

    private func resolveBrowseDeepLink(databaseId: String, nodePath: String, requestID: Int) async {
        guard deepLinkResolveRequestID == requestID else {
            return
        }
        let session = browseSession(for: databaseId)
        do {
            guard let node = try await client.readBrowseNode(databaseId: databaseId, path: nodePath, session: session) else {
                await applyMissingBrowseDeepLink(nodePath: nodePath, requestID: requestID)
                return
            }
            guard deepLinkResolveRequestID == requestID else {
                return
            }
            if node.kind == .folder {
                requestedBrowseTarget = .folder(node.path)
                browseNavigationRequestID += 1
                await loadBrowsePath(node.path)
            } else {
                let parentPath = Self.parentPath(node.path)
                requestedBrowseTarget = .document(path: node.path, parentPath: parentPath)
                browseNavigationRequestID += 1
                await loadBrowsePath(parentPath)
                await loadBrowseDocument(node.path)
            }
        } catch {
            guard deepLinkResolveRequestID == requestID else {
                return
            }
            let parentPath = Self.parentPath(nodePath)
            requestedBrowseTarget = .folder(parentPath)
            browseNavigationRequestID += 1
            await loadBrowsePath(parentPath)
            guard deepLinkResolveRequestID == requestID else {
                return
            }
            browseError = error.localizedDescription
        }
    }

    private func applyMissingBrowseDeepLink(nodePath: String, requestID: Int) async {
        guard deepLinkResolveRequestID == requestID else {
            return
        }
        let parentPath = Self.parentPath(nodePath)
        requestedBrowseTarget = .folder(parentPath)
        browseNavigationRequestID += 1
        await loadBrowsePath(parentPath)
        guard deepLinkResolveRequestID == requestID else {
            return
        }
        browseError = "Node not found: \(nodePath)"
    }

    private func resetBrowseRoot() {
        rootNavigationID += 1
        requestedBrowseTarget = .folder("/")
        browseNavigationRequestID += 1
        resetBrowseStateForRoot()
        if canBrowse {
            startLoadBrowsePath(currentPath)
        }
    }

    private func resetBrowseStateForRoot() {
        browsePathLoadRequestID += 1
        documentLoadRequestID += 1
        searchRequestID += 1
        currentPath = "/"
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

    private func resetDatabaseManagementState() {
        databaseManagementRequestID += 1
        databaseMembers = []
        databaseMembersDatabaseId = nil
        databaseCycleEntries = []
        databaseCycleEntriesDatabaseId = nil
        databaseCycleEntriesCurrentCursor = nil
        databaseCycleEntriesNextCursor = nil
        databaseCycleEntryPageIndex = 0
        databaseCycleEntryPreviousCursors = []
        databaseCyclesPendingPurchases = []
        databaseCyclesPendingPurchasesDatabaseId = nil
        databaseMembersError = nil
        databaseCyclesHistoryError = nil
        databasePendingPurchasesError = nil
        databaseDeleteError = nil
        isLoadingDatabaseMembers = false
        isLoadingDatabaseCycleEntries = false
        isLoadingDatabasePendingPurchases = false
        databaseAccessBusyAction = nil
    }

    private func setSelectedDatabase(_ databaseId: String) {
        selectedDatabaseId = databaseId
        settingsStore.databaseId = databaseId
    }

    private func setSelectedBrowseDatabase(_ databaseId: String) {
        if selectedBrowseDatabaseId != databaseId {
            resetDatabaseManagementState()
        }
        selectedBrowseDatabaseId = databaseId
        settingsStore.browseDatabaseId = databaseId
    }

    func startSignIn() {
        statusMessage = nil
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
        memberBrowseDatabaseIds = []
        publicBrowseDatabaseIds = []
        purchasedBrowseDatabaseIds = []
        directBrowseDatabaseIds = []
        selectedDatabaseId = ""
        settingsStore.databaseId = ""
        settingsStore.writableDatabases = []
        setSelectedBrowseDatabase("")
        resetBrowseStateForRoot()
        resetDatabaseManagementState()
        cyclesBillingConfig = nil
        cyclesConfigError = nil
        databaseMetadataError = nil
        databaseListLastRefreshed = nil
        cyclesConfigLastRefreshed = nil
        statusMessage = nil
        if showPublicBrowseDatabases {
            startRefreshDatabases()
        }
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

    func startLoadDatabaseManagementDetails(databaseId: String) {
        Task {
            await loadDatabaseManagementDetails(databaseId: databaseId)
        }
    }

    func startRefreshDatabaseManagementDetails(databaseId: String) {
        Task {
            await refreshDatabaseManagementDetails(databaseId: databaseId)
        }
    }

    func startLoadNextDatabaseCycleEntries(databaseId: String) {
        Task {
            await loadNextDatabaseCycleEntries(databaseId: databaseId)
        }
    }

    func startLoadPreviousDatabaseCycleEntries(databaseId: String) {
        Task {
            await loadPreviousDatabaseCycleEntries(databaseId: databaseId)
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
            statusMessage = nil
            return true
        } catch {
            databaseMetadataError = error.localizedDescription
            return false
        }
    }

    func grantDatabaseAccess(databaseId: String, principal: String, role: DatabaseRole) async -> Bool {
        let trimmedPrincipal = principal.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedPrincipal.isEmpty else {
            databaseMembersError = "Principal is required."
            return false
        }
        guard let session else {
            databaseMembersError = "Sign in before changing access."
            return false
        }
        guard readableDatabases.first(where: { $0.databaseId == databaseId })?.role.canManageDatabase == true else {
            databaseMembersError = "Only database owners can change access."
            return false
        }
        databaseAccessBusyAction = .grant(principal: trimmedPrincipal, role: role)
        databaseMembersError = nil
        defer {
            databaseAccessBusyAction = nil
        }
        do {
            try await client.grantDatabaseAccess(databaseId: databaseId, principal: trimmedPrincipal, role: role, session: session)
            await loadDatabaseMembers(databaseId: databaseId, requestID: databaseManagementRequestID)
            statusMessage = nil
            return true
        } catch {
            databaseMembersError = error.localizedDescription
            return false
        }
    }

    func revokeDatabaseAccess(databaseId: String, principal: String) async -> Bool {
        let trimmedPrincipal = principal.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedPrincipal.isEmpty else {
            databaseMembersError = "Principal is required."
            return false
        }
        guard let session else {
            databaseMembersError = "Sign in before changing access."
            return false
        }
        guard readableDatabases.first(where: { $0.databaseId == databaseId })?.role.canManageDatabase == true else {
            databaseMembersError = "Only database owners can change access."
            return false
        }
        databaseAccessBusyAction = .revoke(principal: trimmedPrincipal)
        databaseMembersError = nil
        defer {
            databaseAccessBusyAction = nil
        }
        do {
            try await client.revokeDatabaseAccess(databaseId: databaseId, principal: trimmedPrincipal, session: session)
            await loadDatabaseMembers(databaseId: databaseId, requestID: databaseManagementRequestID)
            statusMessage = nil
            return true
        } catch {
            databaseMembersError = error.localizedDescription
            return false
        }
    }

    func deleteDatabase(databaseId: String) async -> Bool {
        guard let session else {
            databaseDeleteError = "Sign in before deleting a database."
            return false
        }
        guard readableDatabases.first(where: { $0.databaseId == databaseId })?.role.canManageDatabase == true else {
            databaseDeleteError = "Only database owners can delete databases."
            return false
        }
        databaseAccessBusyAction = .delete
        databaseDeleteError = nil
        defer {
            databaseAccessBusyAction = nil
        }
        do {
            try await client.deleteDatabase(databaseId: databaseId, session: session)
            resetDatabaseManagementState()
            await refreshDatabases(selectFirstIfNeeded: true)
            statusMessage = nil
            return true
        } catch {
            databaseDeleteError = error.localizedDescription
            return false
        }
    }

    func startLoadBrowsePath(_ path: String) {
        Task {
            await loadBrowsePath(path)
        }
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
            statusMessage = nil
            logger.info("Kinic sign in succeeded principal=\(self.session?.principal ?? "", privacy: .public)")
            await refreshDatabases()
            await loadBrowsePath(currentPath)
            await submitNextPendingURL()
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
                statusMessage = nil
                await loadBrowsePath("/")
                if !pendingURLs.isEmpty {
                    await submitNextPendingURL()
                }
            } else {
                statusMessage = "Database created pending. Fund it from the web dashboard before capture."
            }
        } catch {
            statusMessage = error.localizedDescription
        }
    }

    private func refreshDatabases(selectFirstIfNeeded: Bool = true) async {
        isLoadingDatabases = true
        defer {
            isLoadingDatabases = false
        }
        do {
            let currentSession = session
            let memberDatabases: [DatabaseSummary]
            if let currentSession {
                memberDatabases = try await client.listReadableDatabases(session: currentSession)
            } else {
                memberDatabases = []
            }

            let publicRefresh = await Self.publicDatabasesForRefresh(showPublic: showPublicBrowseDatabases) {
                try await client.listPublicDatabases()
            }
            let publicDatabases = publicRefresh.databases
            if let errorMessage = publicRefresh.errorMessage {
                statusMessage = errorMessage
            }

            var purchasedIds = purchasedBrowseDatabaseIds
            var purchasedLookupSucceeded = currentSession == nil
            if let currentSession {
                do {
                    purchasedIds = try await loadPurchasedDatabaseIds(session: currentSession)
                    purchasedLookupSucceeded = true
                } catch {
                    purchasedLookupSucceeded = false
                    statusMessage = "Purchased database list unavailable: \(error.localizedDescription)"
                }
            }

            let merged = Self.mergeBrowseDatabases(
                memberDatabases: memberDatabases,
                publicDatabases: publicDatabases,
                purchasedDatabaseIds: purchasedIds,
                purchasedLookupSucceeded: purchasedLookupSucceeded,
                showPublic: showPublicBrowseDatabases,
                showPurchased: showPurchasedBrowseDatabases
            )
            readableDatabases = merged.databases
            memberBrowseDatabaseIds = merged.memberDatabaseIds
            publicBrowseDatabaseIds = merged.publicDatabaseIds
            if purchasedLookupSucceeded {
                purchasedBrowseDatabaseIds = merged.purchasedDatabaseIds
            }
            databases = memberDatabases.filter(\.canWrite)
            settingsStore.writableDatabases = databases
            databaseListLastRefreshed = Date()
            if !selectedDatabaseId.isEmpty,
               !databases.contains(where: { $0.databaseId == selectedDatabaseId }) {
                selectedDatabaseId = ""
                settingsStore.databaseId = ""
            }
            if !selectedBrowseDatabaseId.isEmpty,
               !readableDatabases.contains(where: { $0.databaseId == selectedBrowseDatabaseId }),
               !directBrowseDatabaseIds.contains(selectedBrowseDatabaseId) {
                clearBrowseSelectionAndState()
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
                await loadBrowsePath("/")
            } else if !selectedBrowseDatabaseId.isEmpty {
                await loadBrowsePath(currentPath)
            }
            if currentSession != nil {
                await loadCyclesBillingConfigIfNeeded()
            } else {
                cyclesBillingConfig = nil
                cyclesConfigError = nil
            }
        } catch {
            statusMessage = error.localizedDescription
        }
    }

    private func refreshDatabaseManagementInfo() async {
        await refreshDatabases(selectFirstIfNeeded: false)
        await loadCyclesBillingConfig(force: true)
    }

    private func loadPurchasedDatabaseIds(session: ICAuthSession) async throws -> Set<String> {
        var cursor: String?
        var ids = Set<String>()
        repeat {
            let page = try await client.marketListEntitlements(session: session, cursor: cursor, limit: 100)
            ids.formUnion(page.entitlements.map(\.databaseId))
            cursor = page.nextCursor
        } while cursor != nil
        return ids
    }

    private func clearBrowseSelectionAndState() {
        setSelectedBrowseDatabase("")
        resetBrowseStateForRoot()
    }

    private func browseSession(for databaseId: String) -> ICAuthSession? {
        if let session, memberBrowseDatabaseIds.contains(databaseId) || !publicBrowseDatabaseIds.contains(databaseId) {
            return session
        }
        if publicBrowseDatabaseIds.contains(databaseId) {
            return nil
        }
        return session
    }

    private func loadDatabaseManagementDetails(databaseId: String) async {
        guard !databaseId.isEmpty else {
            resetDatabaseManagementState()
            return
        }
        if databaseMembersDatabaseId == databaseId,
           databaseCycleEntriesDatabaseId == databaseId,
           databaseCyclesPendingPurchasesDatabaseId == databaseId {
            return
        }
        resetDatabaseManagementState()
        let requestID = databaseManagementRequestID
        await loadDatabaseMembers(databaseId: databaseId, requestID: requestID)
        await loadDatabaseCycleEntries(databaseId: databaseId, cursor: nil, requestID: requestID, pageIndex: 0, previousCursors: [])
        await loadDatabasePendingPurchases(databaseId: databaseId, requestID: requestID)
    }

    private func refreshDatabaseManagementDetails(databaseId: String) async {
        resetDatabaseManagementState()
        let requestID = databaseManagementRequestID
        await loadCyclesBillingConfig(force: true)
        await loadDatabaseMembers(databaseId: databaseId, requestID: requestID)
        await loadDatabaseCycleEntries(databaseId: databaseId, cursor: nil, requestID: requestID, pageIndex: 0, previousCursors: [])
        await loadDatabasePendingPurchases(databaseId: databaseId, requestID: requestID)
    }

    private func loadNextDatabaseCycleEntries(databaseId: String) async {
        guard let nextCursor = databaseCycleEntriesNextCursor else {
            return
        }
        let requestID = databaseManagementRequestID
        var previous = databaseCycleEntryPreviousCursors
        previous.append(databaseCycleEntriesDatabaseId == databaseId ? databaseCycleEntriesCurrentCursor : nil)
        await loadDatabaseCycleEntries(
            databaseId: databaseId,
            cursor: nextCursor,
            requestID: requestID,
            pageIndex: databaseCycleEntryPageIndex + 1,
            previousCursors: previous
        )
    }

    private func loadPreviousDatabaseCycleEntries(databaseId: String) async {
        guard !databaseCycleEntryPreviousCursors.isEmpty else {
            return
        }
        let requestID = databaseManagementRequestID
        var previous = databaseCycleEntryPreviousCursors
        let cursor = previous.removeLast()
        await loadDatabaseCycleEntries(
            databaseId: databaseId,
            cursor: cursor,
            requestID: requestID,
            pageIndex: max(databaseCycleEntryPageIndex - 1, 0),
            previousCursors: previous
        )
    }

    private func loadDatabaseMembers(databaseId: String, requestID: Int) async {
        guard let session else {
            databaseMembers = []
            databaseMembersDatabaseId = nil
            databaseMembersError = "Sign in before loading members."
            return
        }
        isLoadingDatabaseMembers = true
        databaseMembersError = nil
        defer {
            if requestID == databaseManagementRequestID {
                isLoadingDatabaseMembers = false
            }
        }
        do {
            let members = try await client.listDatabaseMembers(databaseId: databaseId, session: session)
            guard requestID == databaseManagementRequestID else {
                return
            }
            databaseMembers = members
            databaseMembersDatabaseId = databaseId
        } catch {
            guard requestID == databaseManagementRequestID else {
                return
            }
            databaseMembersError = error.localizedDescription
        }
    }

    private func loadDatabaseCycleEntries(databaseId: String, cursor: UInt64?, requestID: Int, pageIndex: Int, previousCursors: [UInt64?]) async {
        guard let session else {
            databaseCycleEntries = []
            databaseCycleEntriesDatabaseId = nil
            databaseCyclesHistoryError = "Sign in before loading cycle history."
            return
        }
        isLoadingDatabaseCycleEntries = true
        databaseCyclesHistoryError = nil
        defer {
            if requestID == databaseManagementRequestID {
                isLoadingDatabaseCycleEntries = false
            }
        }
        do {
            let page = try await client.listDatabaseCycleEntries(databaseId: databaseId, cursor: cursor, limit: 20, session: session)
            guard requestID == databaseManagementRequestID else {
                return
            }
            databaseCycleEntries = page.entries
            databaseCycleEntriesDatabaseId = databaseId
            databaseCycleEntriesCurrentCursor = cursor
            databaseCycleEntriesNextCursor = page.nextCursor
            databaseCycleEntryPageIndex = pageIndex
            databaseCycleEntryPreviousCursors = previousCursors
        } catch {
            guard requestID == databaseManagementRequestID else {
                return
            }
            databaseCyclesHistoryError = error.localizedDescription
        }
    }

    private func loadDatabasePendingPurchases(databaseId: String, requestID: Int) async {
        guard let session else {
            databaseCyclesPendingPurchases = []
            databaseCyclesPendingPurchasesDatabaseId = nil
            databasePendingPurchasesError = "Sign in before loading pending purchases."
            return
        }
        isLoadingDatabasePendingPurchases = true
        databasePendingPurchasesError = nil
        defer {
            if requestID == databaseManagementRequestID {
                isLoadingDatabasePendingPurchases = false
            }
        }
        do {
            let pending = try await client.listDatabaseCyclesPendingPurchases(databaseId: databaseId, session: session)
            guard requestID == databaseManagementRequestID else {
                return
            }
            databaseCyclesPendingPurchases = pending
            databaseCyclesPendingPurchasesDatabaseId = databaseId
        } catch {
            guard requestID == databaseManagementRequestID else {
                return
            }
            databasePendingPurchasesError = error.localizedDescription
        }
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
        let databaseId = selectedBrowseDatabaseId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !databaseId.isEmpty else {
            browseError = "Select a database to browse."
            return
        }
        guard canBrowse else {
            browseError = "Sign in before browsing."
            return
        }
        let session = browseSession(for: databaseId)
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
            if normalizedPath == "/" {
                let loadedChildren = try await client.listBrowseChildren(databaseId: databaseId, path: normalizedPath, session: session)
                if browsePathLoadRequestID == requestID {
                    currentNode = nil
                    childNodes = loadedChildren
                    loadedBrowsePath = normalizedPath
                }
                return
            }
            guard let node = try await client.readBrowseNode(databaseId: databaseId, path: normalizedPath, session: session) else {
                if browsePathLoadRequestID == requestID {
                    currentNode = nil
                    childNodes = []
                    loadedBrowsePath = nil
                    browseError = "Node not found: \(normalizedPath)"
                }
                return
            }
            let loadedChildren = node.kind == .folder
                ? try await client.listBrowseChildren(databaseId: databaseId, path: normalizedPath, session: session)
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
        let databaseId = selectedBrowseDatabaseId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !databaseId.isEmpty else {
            documentError = "Select a database to browse."
            return
        }
        guard canBrowse else {
            documentError = "Sign in before browsing."
            return
        }
        let session = browseSession(for: databaseId)
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
            guard let node = try await client.readBrowseNode(databaseId: databaseId, path: normalizedPath, session: session) else {
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
        let databaseId = selectedBrowseDatabaseId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !databaseId.isEmpty else {
            browseError = "Select a database to search."
            return
        }
        guard canBrowse else {
            browseError = "Sign in before searching."
            return
        }
        let session = browseSession(for: databaseId)
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
            let hits = try await client.searchBrowseNodes(databaseId: databaseId, query: query, prefix: nil, limit: 20, session: session)
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
        guard let item = pendingURLs.first else {
            return
        }
        let databaseResolution = Self.pendingSubmissionDatabaseId(
            for: item,
            selectedDatabaseId: selectedDatabaseId,
            writableDatabaseIds: Set(databases.map(\.databaseId))
        )
        let databaseId: String
        switch databaseResolution {
        case let .ready(resolvedDatabaseId):
            databaseId = resolvedDatabaseId
        case .missingSelection, .unavailable:
            statusMessage = databaseResolution.statusMessage
            return
        }
        isSubmitting = true
        defer {
            isSubmitting = false
        }
        do {
            let request = try Self.sourceCaptureRequest(
                for: item,
                databaseId: databaseId,
                requestedBy: session.principal
            )
            let submission = try await client.saveSourceCaptureRequest(request, session: session)
            do {
                try await client.triggerSourceCapture(
                    databaseId: submission.databaseId,
                    requestPath: submission.requestPath,
                    sessionNonce: submission.sessionNonce,
                    session: session
                )
                shareInbox.remove(item)
                refreshInbox()
                statusMessage = nil
            } catch {
                statusMessage = "Source saved, but capture could not start for \(submission.requestPath). It remains queued for retry: \(error.localizedDescription)"
            }
        } catch {
            statusMessage = error.localizedDescription
        }
    }

    nonisolated static func sourceCaptureRequest(
        for item: PendingSharedURL,
        databaseId: String,
        requestedBy: String
    ) throws -> SourceCaptureRequest {
        try SourceCaptureRequestBuilder.request(
            url: item.url,
            databaseId: databaseId,
            requestedBy: requestedBy,
            requestId: item.requestId,
            now: item.receivedAt,
            captureMetadata: item.captureMetadata
        )
    }

    nonisolated static func pendingSubmissionDatabaseId(
        for item: PendingSharedURL,
        selectedDatabaseId: String,
        writableDatabaseIds: Set<String>
    ) -> PendingSubmissionDatabaseResolution {
        if let queuedDatabaseId = item.databaseId?.trimmingCharacters(in: .whitespacesAndNewlines),
           !queuedDatabaseId.isEmpty {
            if writableDatabaseIds.contains(queuedDatabaseId) {
                return .ready(queuedDatabaseId)
            }
            return .unavailable(queuedDatabaseId)
        }
        let selected = selectedDatabaseId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !selected.isEmpty else {
            return .missingSelection
        }
        return .ready(selected)
    }

    nonisolated static func publicDatabasesForRefresh(
        showPublic: Bool,
        load: @Sendable () async throws -> [DatabaseSummary]
    ) async -> PublicDatabaseRefreshResult {
        guard showPublic else {
            return PublicDatabaseRefreshResult(databases: [], errorMessage: nil)
        }
        do {
            return PublicDatabaseRefreshResult(databases: try await load(), errorMessage: nil)
        } catch {
            return PublicDatabaseRefreshResult(
                databases: [],
                errorMessage: "Public database list unavailable: \(error.localizedDescription)"
            )
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

    nonisolated static func mergeBrowseDatabases(
        memberDatabases: [DatabaseSummary],
        publicDatabases: [DatabaseSummary],
        purchasedDatabaseIds: Set<String>,
        purchasedLookupSucceeded: Bool,
        showPublic: Bool,
        showPurchased: Bool
    ) -> BrowseDatabaseMergeResult {
        let memberIds = Set(memberDatabases.map(\.databaseId))
        let visiblePublicIds = showPublic ? Set(publicDatabases.map(\.databaseId)) : []
        var byId: [String: DatabaseSummary] = [:]

        if showPublic {
            for database in publicDatabases where database.canRead {
                byId[database.databaseId] = database
            }
        }

        for database in memberDatabases where database.canRead {
            if !showPurchased, database.role == .reader {
                if !purchasedLookupSucceeded || purchasedDatabaseIds.contains(database.databaseId) {
                    continue
                }
            }
            byId[database.databaseId] = database
        }

        let databases = byId.values.sorted { left, right in
            left.displayTitle.localizedCaseInsensitiveCompare(right.displayTitle) == .orderedAscending
        }
        return BrowseDatabaseMergeResult(
            databases: databases,
            memberDatabaseIds: memberIds,
            publicDatabaseIds: visiblePublicIds,
            purchasedDatabaseIds: purchasedDatabaseIds
        )
    }

    nonisolated static func normalizedBrowsePath(_ path: String) -> String {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return "/"
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

    nonisolated private static func directBrowseDatabaseSummary(databaseId: String) -> DatabaseSummary {
        DatabaseSummary(
            databaseId: databaseId,
            title: databaseId,
            description: "Opened from direct link.",
            metadata: nil,
            role: .reader,
            status: .active,
            logicalSizeBytes: 0,
            cyclesBalance: nil,
            cyclesSuspendedAtMs: nil,
            deletedAtMs: nil
        )
    }

    nonisolated static func folderRoutes(to path: String) -> [BrowseFolderRoute] {
        let normalized = normalizedBrowsePath(path)
        guard normalized != "/" else {
            return []
        }
        var routes: [BrowseFolderRoute] = []
        var currentPath = ""
        for segment in normalized.split(separator: "/").map(String.init) {
            currentPath += "/\(segment)"
            routes.append(BrowseFolderRoute(path: currentPath))
        }
        return routes
    }

    nonisolated private static func decodedPathSegments(from url: URL) -> [String] {
        url.path(percentEncoded: true)
            .split(separator: "/")
            .map(String.init)
            .map { $0.removingPercentEncoding ?? $0 }
    }
}
