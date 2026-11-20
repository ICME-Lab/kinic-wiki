// Where: mobile/ios/KinicApp/ViewModels/VaultWorkspaceModel.swift
// What: Unified main-actor state and operations for the Kinic Vault tab and AutoFill sync.
// Why: Vault keeps its own canister, derivation origin, II session, and Keychain store separate from Wiki.

import AuthenticationServices
import CryptoKit
import Foundation
import ICNativeClient
import KinicVaultCore
import KinicVaultNative
import LocalAuthentication
import Observation

enum VaultCategoryFilter: String, CaseIterable, Identifiable, Sendable {
    case all
    case favorites
    case logins
    case twoFactor
    case notes

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .all: "All"
        case .favorites: "Favorites"
        case .logins: "Logins"
        case .twoFactor: "2FA"
        case .notes: "Notes"
        }
    }

    var systemImage: String {
        switch self {
        case .all: "square.grid.2x2"
        case .favorites: "star.fill"
        case .logins: "key.fill"
        case .twoFactor: "lock.rotation"
        case .notes: "doc.text.fill"
        }
    }

    func matches(_ item: VaultItemSummary) -> Bool {
        switch self {
        case .all: true
        case .favorites: item.favorite
        case .logins: item.kind == .credential
        case .twoFactor: item.kind == .credential && item.hasTotp
        case .notes: item.kind == .note
        }
    }
}

enum VaultAutoFillStatus: Equatable, Sendable {
    case notSynced
    case syncing
    case ready(credentialCount: Int, syncedAt: Date)
    case providerDisabled(cachedCount: Int, syncedAt: Date)
    case error(String)
}

enum VaultWorkspaceError: Error, LocalizedError, Equatable {
    case notSignedIn
    case noSelectedVault
    case locked
    case invalidInput(String)
    case unavailableOffline

    var errorDescription: String? {
        switch self {
        case .notSignedIn: "Sign in to your Vault to save changes."
        case .noSelectedVault: "Select or create a Vault first."
        case .locked: "Unlock your Vault before opening or editing items."
        case .invalidInput(let message): message
        case .unavailableOffline: "Editing requires an active Vault sign-in."
        }
    }
}

/// Vault has its own derivation origin, II session, and Keychain scope; never reuse the Wiki session.
@MainActor @Observable
final class VaultWorkspaceModel {
    private(set) var available = false
    private(set) var busy = false
    private(set) var isAuthenticating = false
    private(set) var isSaving = false
    private(set) var connectionMode: VaultEnvironment?
    private(set) var configurationError: String?
    private(set) var principal: String?
    private(set) var vaults: [VaultNativeHeader] = []
    private(set) var selectedVault: Data?
    private(set) var status = ""
    private(set) var autoFillStatus: VaultAutoFillStatus = .notSynced
    private(set) var isUnlocked = false
    private(set) var hasOfflineSnapshot = false
    private(set) var lastSyncedAt: Date?
    private(set) var items: [VaultItemSummary] = []

    var searchQuery = ""
    var selectedCategory: VaultCategoryFilter = .all
    var selectedTag: String?

    var canConnect: Bool { native != nil && authenticator != nil && cache != nil }
    var isSignedIn: Bool { isPreviewFixture ? principal != nil : (principal != nil && session != nil) }
    var canWrite: Bool { isSignedIn && selectedVaultHeader != nil && !busy && !isSaving }
    var selectedVaultHeader: VaultNativeHeader? {
        vaults.first(where: { $0.id == selectedVault })
    }
    var vaultCanisterId: String? { connection?.canisterId }
    var webOriginURL: URL? { connection?.webOrigin }

    var availableTags: [String] {
        Array(Set(items.flatMap(\.tags))).sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
    }

    var filteredItems: [VaultItemSummary] {
        items
            .filter { item in
                guard selectedCategory.matches(item) else { return false }
                if let selectedTag, !item.tags.contains(selectedTag) {
                    return false
                }
                return item.matches(query: searchQuery)
            }
            .sorted { lhs, rhs in
                if lhs.favorite != rhs.favorite {
                    return lhs.favorite && !rhs.favorite
                }
                let cmp = lhs.title.localizedCaseInsensitiveCompare(rhs.title)
                if cmp != .orderedSame { return cmp == .orderedAscending }
                return lhs.username.localizedCaseInsensitiveCompare(rhs.username) == .orderedAscending
            }
    }

    func itemCount(for category: VaultCategoryFilter) -> Int {
        items.count(where: category.matches)
    }

    @ObservationIgnored private var connection: VaultConnectionConfiguration?
    @ObservationIgnored private var sessionStore: VaultAuthSessionStore?
    @ObservationIgnored private var session: ICAuthSession?
    @ObservationIgnored private var native: VaultNativeClient?
    @ObservationIgnored private var authenticator: ICInternetIdentityAuthenticator?
    @ObservationIgnored private var cache: VaultAutoFillSyncController?
    @ObservationIgnored private var activeSnapshot: VaultAutoFillSnapshot?
    @ObservationIgnored private var activeRootKey: SymmetricKey?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var didAttemptInitialRestore = false
    @ObservationIgnored private let onCleanupFailure: (String) -> Void
    @ObservationIgnored private let isPreviewFixture: Bool

    init(
        configuration: AppConfiguration,
        onCleanupFailure: @escaping (String) -> Void = { _ in }
    ) {
        self.onCleanupFailure = onCleanupFailure
        self.isPreviewFixture = false

        if let group = configuration.appGroupId,
           let url = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group),
           let accessGroup = configuration.keychainAccessGroup {
            let store = VaultAutoFillSnapshotStore(fileURL: url.appendingPathComponent("VaultAutoFill/snapshot.v1.json"))
            let controller = VaultAutoFillSyncController(
                snapshotStore: store,
                keys: VaultSystemRootKeys(accessGroup: accessGroup),
                identities: VaultSystemIdentityStore()
            )
            cache = controller
            // Revocation remains available on a normal cold launch, without any
            // development configuration or an active authentication session.
            available = true
            hasOfflineSnapshot = controller.hasOfflineSnapshot()
        }

        switch Self.resolveConnection(from: configuration) {
        case .success(let resolved):
            if let resolved {
                configureConnection(resolved, accessGroup: configuration.keychainAccessGroup)
            }
        case .failure(let error):
            available = true
            configurationError = error.localizedDescription
            status = error.localizedDescription
        }
    }

    private init(
        previewSnapshot: VaultAutoFillSnapshot?,
        previewRootKey: SymmetricKey?,
        previewHeader: VaultNativeHeader?,
        previewUnlocked: Bool,
        previewCanConnect: Bool = false
    ) {
        self.onCleanupFailure = { _ in }
        self.isPreviewFixture = true
        self.available = true
        self.connectionMode = .production
        if previewCanConnect {
            let dummy = try? VaultConnectionConfiguration.remote(
                environment: .production,
                canisterId: "rrkah-fqaaa-aaaaa-aaaaq-cai"
            )
            if let dummy {
                self.connection = dummy
                self.native = VaultNativeClient(configuration: dummy.client, local: false)
                self.authenticator = try? ICInternetIdentityAuthenticator(
                    configuration: dummy.client,
                    callbackURL: dummy.callbackURL
                )
                let store = VaultAutoFillSnapshotStore(fileURL: FileManager.default.temporaryDirectory.appendingPathComponent("preview-vault-\(UUID().uuidString).json"))
                self.cache = VaultAutoFillSyncController(
                    snapshotStore: store,
                    keys: VaultSystemRootKeys(accessGroup: nil),
                    identities: VaultSystemIdentityStore()
                )
            }
        }
        if let previewSnapshot, let previewHeader {
            self.principal = previewSnapshot.context.owner
            self.vaults = [previewHeader]
            self.selectedVault = previewHeader.id
            self.hasOfflineSnapshot = true
            let syncedAt = Date(timeIntervalSince1970: TimeInterval(previewSnapshot.updatedAtEpochSeconds))
            self.lastSyncedAt = syncedAt
            if previewUnlocked, let previewRootKey {
                self.activeSnapshot = previewSnapshot
                self.activeRootKey = previewRootKey
                self.items = (try? previewSnapshot.listItems(rootKey: previewRootKey)) ?? []
                self.isUnlocked = true
                let credCount = items.count(where: { $0.kind == .credential })
                self.autoFillStatus = .ready(credentialCount: credCount, syncedAt: syncedAt)
                self.status = "Offline AutoFill and QuickType are ready."
            } else {
                self.isUnlocked = false
                self.status = ""
            }
        }
    }

    private func configureConnection(_ resolved: VaultConnectionConfiguration, accessGroup: String?) {
        connection = resolved
        connectionMode = resolved.environment
        available = true
        native = VaultNativeClient(configuration: resolved.client, local: resolved.isLocal)
        sessionStore = VaultAuthSessionStore(configuration: resolved, accessGroup: accessGroup)
        do {
            authenticator = try ICInternetIdentityAuthenticator(
                configuration: resolved.client,
                callbackURL: resolved.callbackURL
            )
            if status.isEmpty {
                status = "Sign in to Kinic Vault to sync your passwords and enable iOS AutoFill."
            }
        } catch {
            configurationError = error.localizedDescription
            status = "Vault authentication could not be configured."
        }
    }

    static func resolveConnection(from configuration: AppConfiguration) -> Result<VaultConnectionConfiguration?, Error> {
#if DEBUG
        if let path = ProcessInfo.processInfo.environment["KINIC_LOCAL_VAULT_CONFIG"],
           !path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            do {
                let data = try Data(contentsOf: URL(fileURLWithPath: path))
                return .success(try VaultConnectionConfiguration.local(from: data))
            } catch {
                return .failure(VaultWorkspaceError.invalidInput("The local Vault configuration is invalid."))
            }
        }
#endif
        guard let bundleVault = configuration.vault else {
            return .success(nil)
        }
        guard let environment = VaultEnvironment(rawValue: bundleVault.environment.lowercased()),
              environment != .local else {
            return .failure(VaultConnectionConfigurationError.invalidEnvironment(bundleVault.environment))
        }
        do {
            let resolved = try VaultConnectionConfiguration.remote(
                environment: environment,
                canisterId: bundleVault.canisterId,
                apiBaseURL: bundleVault.apiBaseURL,
                internetIdentityURL: bundleVault.identityProvider,
                derivationOrigin: bundleVault.derivationOrigin,
                callbackDomain: bundleVault.callbackDomain,
                forbiddenCanisterIds: [configuration.canisterId],
                forbiddenCallbackDomains: [configuration.callbackDomain]
            )
            return .success(resolved)
        } catch {
            return .failure(error)
        }
    }

    // MARK: - Lifecycle

    func prepareOnAppear() async {
        guard !isPreviewFixture else { return }
        refreshOfflinePresence()
        await refreshAutoFillProviderState()
        guard !didAttemptInitialRestore else { return }
        didAttemptInitialRestore = true
        await restoreSavedSessionIfPresent()
    }

    func appDidBecomeActive() {
        guard !isPreviewFixture else { return }
        refreshOfflinePresence()
        Task { await refreshAutoFillProviderState() }
    }

    func appDidEnterBackground() {
        guard !isPreviewFixture, !isAuthenticating else { return }
        if isUnlocked && hasOfflineSnapshot {
            lock()
        }
    }

    func lock() {
        activeRootKey = nil
        activeSnapshot = nil
        items = []
        isUnlocked = false
    }

    private func refreshOfflinePresence() {
        guard let cache else { return }
        hasOfflineSnapshot = cache.hasOfflineSnapshot()
        if !hasOfflineSnapshot && !isSignedIn {
            autoFillStatus = .notSynced
            lastSyncedAt = nil
        }
    }

    func refreshAutoFillProviderState() async {
        guard let cache else { return }
        hasOfflineSnapshot = cache.hasOfflineSnapshot()
        let enabled = await cache.isProviderEnabled()
        if case .syncing = autoFillStatus { return }
        if let snapshot = activeSnapshot {
            let credCount = items.count(where: { $0.kind == .credential })
            let syncedAt = Date(timeIntervalSince1970: TimeInterval(snapshot.updatedAtEpochSeconds))
            lastSyncedAt = syncedAt
            autoFillStatus = enabled
                ? .ready(credentialCount: credCount, syncedAt: syncedAt)
                : .providerDisabled(cachedCount: credCount, syncedAt: syncedAt)
        } else if !hasOfflineSnapshot {
            autoFillStatus = .notSynced
        }
    }

    private func restoreSavedSessionIfPresent() async {
        guard !busy, session == nil, let sessionStore, let native else { return }
        guard let restored = try? sessionStore.load() else { return }
        let ticket = generation
        busy = true
        defer { if generation == ticket { busy = false } }
        do {
            let list = try await native.ownedVaults(identity: restored)
            guard generation == ticket else { return }
            session = restored
            principal = restored.principal
            vaults = list
            if let existing = selectedVault, list.contains(where: { $0.id == existing }) {
                selectedVault = existing
            } else if let cachedVault = cache?.offlineSnapshotVaultId(),
                      list.contains(where: { $0.id == cachedVault }) {
                selectedVault = cachedVault
            } else {
                selectedVault = list.first?.id
            }
            if list.isEmpty {
                status = "Signed in. Create a Vault to start saving passwords."
            } else if hasOfflineSnapshot {
                status = "Signed in. Unlock with Face ID or sync to refresh."
            } else {
                status = "Signed in. Sync your Vault to browse items and enable AutoFill."
            }
        } catch {
            guard generation == ticket else { return }
            // Keep offline snapshot accessible if network is unavailable on launch.
            session = restored
            principal = restored.principal
            if hasOfflineSnapshot {
                status = "Offline mode. Unlock your synced Vault with Face ID."
            } else {
                status = error.localizedDescription
            }
        }
    }

    // MARK: - Biometric Unlock

    func unlockOfflineWithBiometrics() async {
        guard !isPreviewFixture, let cache else { return }
        guard hasOfflineSnapshot else {
            status = "No synced Vault is stored on this device yet."
            return
        }
        let ticket = generation
        let unlocked = await evaluateDeviceOwnerAuthentication(
            reason: "Unlock Kinic Vault to view your saved logins and codes"
        )
        guard unlocked, generation == ticket else { return }
        do {
            guard let (snapshot, rootKey) = try cache.loadOfflineSnapshot() else {
                hasOfflineSnapshot = false
                status = "No synced Vault was found on this device."
                return
            }
            let loadedItems = try snapshot.listItems(rootKey: rootKey)
            let enabled = await cache.isProviderEnabled()
            guard generation == ticket else { return }
            activeSnapshot = snapshot
            activeRootKey = rootKey
            items = loadedItems
            isUnlocked = true
            if vaults.contains(where: { $0.id == snapshot.context.vault }) {
                selectedVault = snapshot.context.vault
            }
            let syncedAt = Date(timeIntervalSince1970: TimeInterval(snapshot.updatedAtEpochSeconds))
            lastSyncedAt = syncedAt
            let credCount = loadedItems.count(where: { $0.kind == .credential })
            autoFillStatus = enabled
                ? .ready(credentialCount: credCount, syncedAt: syncedAt)
                : .providerDisabled(cachedCount: credCount, syncedAt: syncedAt)
            status = isSignedIn
                ? "Vault unlocked."
                : "Viewing offline Vault. Sign in to sync or edit items."
        } catch {
            if generation == ticket {
                status = "Could not decrypt the cached Vault. Sign in and sync again."
            }
        }
    }

    private func evaluateDeviceOwnerAuthentication(reason: String) async -> Bool {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            return false
        }
        return await withCheckedContinuation { continuation in
            context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { ok, _ in
                continuation.resume(returning: ok)
            }
        }
    }

    // MARK: - Authentication & Vault Management

    func signIn() async {
        guard !busy, let authenticator, let native, let cache else { return }
        generation += 1
        let ticket = generation
        busy = true
        isSaving = false
        isAuthenticating = true
        session = nil; principal = nil; vaults = []; selectedVault = nil
        lock()
        defer {
            if generation == ticket {
                busy = false
                isAuthenticating = false
            }
        }
        do {
            await native.forgetKeys()
            guard generation == ticket else { return }
            try? sessionStore?.clear()
            try await cache.disable()
            guard generation == ticket else { return }
            hasOfflineSnapshot = false
            autoFillStatus = .notSynced

            let prefersEphemeral = (connection?.isLocal == true)
                || KinicAuthService.debugPrefersEphemeralWebBrowserSession(environment: ProcessInfo.processInfo.environment)
            let identity = try await authenticator.authenticate(prefersEphemeralWebBrowserSession: prefersEphemeral)
            guard generation == ticket else { return }
            try? sessionStore?.save(identity)
            let list = try await native.ownedVaults(identity: identity)
            guard generation == ticket else { return }

            session = identity
            principal = identity.principal
            vaults = list
            selectedVault = list.first?.id
            if list.isEmpty {
                status = "No Vaults yet. Create your first Vault to begin."
            } else {
                status = "Syncing your Vault…"
                busy = false
                isAuthenticating = false
                await synchronize()
            }
        } catch {
            if generation == ticket {
                status = error.localizedDescription
            }
        }
    }

    func createFirstVault() async {
        guard !busy, let identity = session, let native else { return }
        let ticket = generation
        busy = true
        defer { if generation == ticket { busy = false } }
        do {
            // Initialize free starter operating credit if this is a brand-new Vault principal.
            try? await native.initializeAccount(identity: identity)
            guard generation == ticket else { return }
            let header = try await native.createVault(identity: identity)
            guard generation == ticket else { return }
            vaults.append(header)
            selectedVault = header.id
            status = "Vault created. Syncing…"
            busy = false
            await synchronize()
        } catch {
            if generation == ticket {
                status = error.localizedDescription
            }
        }
    }

    func renameSelectedVault(to name: String) async throws {
        guard !busy, !isSaving else { throw VaultNativeError.busy }
        guard let identity = session, let native, let selected = selectedVaultHeader else {
            throw VaultWorkspaceError.noSelectedVault
        }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard VaultNativeClient.isValidVaultName(trimmed) else {
            throw VaultWorkspaceError.invalidInput("Vault name must be 1–64 characters with no control characters.")
        }
        let ticket = generation
        isSaving = true
        defer { if generation == ticket { isSaving = false } }
        try await native.renameVault(header: selected, name: trimmed, identity: identity)
        guard generation == ticket else { return }
        let updated = try await native.ownedVaults(identity: identity)
        guard generation == ticket else { return }
        vaults = updated
        if !updated.contains(where: { $0.id == selected.id }) {
            selectedVault = updated.first?.id
        }
        status = "Vault renamed to \(trimmed)."
    }

    func synchronize() async {
        guard !busy, let identity = session, let native, let cache, let canister = vaultCanisterId,
              let selected = selectedVaultHeader else { return }
        let ticket = generation
        busy = true
        autoFillStatus = .syncing
        defer { if generation == ticket { busy = false } }
        do {
            let context = try selected.context(canister: canister, owner: identity.principal)
            var fetchedPayload: VaultAutoFillSyncPayload?
            do {
                try await cache.synchronize(context: context) {
                    let payload = try await native.fetchSnapshot(header: selected, identity: identity)
                    guard self.generation == ticket else { throw CancellationError() }
                    fetchedPayload = payload
                    return payload
                }
                guard generation == ticket else { return }
                if let payload = fetchedPayload {
                    try applyUnlockedPayload(payload, providerEnabled: true)
                }
                status = "Offline AutoFill and QuickType are ready."
            } catch VaultNativeError.providerDisabled {
                guard generation == ticket else { return }
                // The Vault tab still stays usable even before iOS AutoFill is enabled in System Settings.
                if let payload = fetchedPayload {
                    try applyUnlockedPayload(payload, providerEnabled: false)
                }
                status = "Vault synced. Enable Kinic Vault in iOS AutoFill settings for QuickType."
            }
        } catch {
            guard generation == ticket else { return }
            if case VaultNativeError.accessLost = error {
                vaults.removeAll { $0.id == selected.id }; selectedVault = nil
                revokeMaterial(message: "Access to this Vault was lost. Its offline data has been removed.")
            } else if case VaultNativeError.changedDuringSync = error {
                revokeMaterial(message: "The Vault changed. Sync again to refresh it.", refreshList: true)
            } else {
                autoFillStatus = .error(error.localizedDescription)
                status = error.localizedDescription
            }
        }
    }

    private func applyUnlockedPayload(_ payload: VaultAutoFillSyncPayload, providerEnabled: Bool) throws {
        let loadedItems = try payload.snapshot.listItems(rootKey: payload.rootKey)
        activeSnapshot = payload.snapshot
        activeRootKey = payload.rootKey
        items = loadedItems
        isUnlocked = true
        hasOfflineSnapshot = true
        let syncedAt = Date(timeIntervalSince1970: TimeInterval(payload.snapshot.updatedAtEpochSeconds))
        lastSyncedAt = syncedAt
        let credCount = loadedItems.count(where: { $0.kind == .credential })
        autoFillStatus = providerEnabled
            ? .ready(credentialCount: credCount, syncedAt: syncedAt)
            : .providerDisabled(cachedCount: credCount, syncedAt: syncedAt)
    }

    // MARK: - Decryption & CRUD (SaveInline / DeleteObject)

    func decryptItem(objectId: String) throws -> VaultDecryptedItem? {
        guard isUnlocked, let snapshot = activeSnapshot, let rootKey = activeRootKey else {
            throw VaultWorkspaceError.locked
        }
        return try snapshot.decryptItem(objectIdBase64URL: objectId, rootKey: rootKey)
    }

    func saveCredential(
        existing: VaultItemSummary?,
        title: String,
        record: VaultCredentialRecord
    ) async throws -> String {
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedTitle.isEmpty else {
            throw VaultWorkspaceError.invalidInput("Enter a title for this login.")
        }
        var sanitizedRecord = record
        sanitizedRecord.tags = Array(
            record.tags
                .map { String($0.trimmingCharacters(in: .whitespacesAndNewlines).prefix(64)) }
                .filter { !$0.isEmpty }
                .prefix(32)
        )
        let metadata = VaultCredentialCodec.buildMetadata(title: trimmedTitle, record: sanitizedRecord)
        let plaintext = try VaultCredentialCodec.serialize(sanitizedRecord)
        return try await saveInlineDocument(
            existing: existing,
            metadata: metadata,
            plaintext: plaintext
        )
    }

    func saveNote(
        existing: VaultItemSummary?,
        title: String,
        body: String,
        favorite: Bool,
        tags: [String]
    ) async throws -> String {
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedTitle.isEmpty else {
            throw VaultWorkspaceError.invalidInput("Enter a title for this note.")
        }
        let cleanTags = Array(
            Set(
                tags
                    .map { String($0.trimmingCharacters(in: .whitespacesAndNewlines).prefix(64)) }
                    .filter { !$0.isEmpty }
            )
        ).sorted()
        let metadata = VaultMetadata(
            kind: .note,
            title: String(trimmedTitle.prefix(512)),
            favorite: favorite ? true : nil,
            tags: cleanTags.isEmpty ? nil : Array(cleanTags.prefix(32))
        )
        return try await saveInlineDocument(
            existing: existing,
            metadata: metadata,
            plaintext: Data(body.utf8)
        )
    }

    func toggleFavorite(for summary: VaultItemSummary) async throws {
        guard let decrypted = try decryptItem(objectId: summary.objectIdBase64URL) else {
            throw VaultNativeError.notFound
        }
        switch summary.kind {
        case .credential:
            guard var record = decrypted.credential else { throw VaultNativeError.invalidResponse }
            record.favorite.toggle()
            _ = try await saveCredential(existing: summary, title: summary.title, record: record)
        case .note:
            _ = try await saveNote(
                existing: summary,
                title: summary.title,
                body: decrypted.noteText ?? "",
                favorite: !summary.favorite,
                tags: summary.tags
            )
        case .attachment:
            break
        }
    }

    private func saveInlineDocument(
        existing: VaultItemSummary?,
        metadata: VaultMetadata,
        plaintext: Data
    ) async throws -> String {
        if isPreviewFixture {
            return try savePreviewDocument(existing: existing, metadata: metadata, plaintext: plaintext)
        }
        guard !busy, !isSaving else { throw VaultNativeError.busy }
        guard let identity = session, let native, let selected = selectedVaultHeader else {
            throw isSignedIn ? VaultWorkspaceError.noSelectedVault : VaultWorkspaceError.notSignedIn
        }
        let existingObjectData: Data?
        if let existing {
            existingObjectData = try Base64URL.decode(existing.objectIdBase64URL)
        } else {
            existingObjectData = nil
        }

        let ticket = generation
        isSaving = true
        defer { if generation == ticket { isSaving = false } }

        let saved: VaultNativeSavedRecord
        do {
            saved = try await native.saveInline(
                header: selected,
                metadata: metadata,
                plaintext: plaintext,
                existingObject: existingObjectData,
                expectedRevision: existing?.revision ?? 0,
                identity: identity
            )
        } catch VaultNativeError.accessLost {
            if generation == ticket {
                vaults.removeAll { $0.id == selected.id }; selectedVault = nil
                revokeMaterial(message: "Access to this Vault was lost. Its offline data has been removed.")
            }
            throw VaultNativeError.accessLost
        }
        guard generation == ticket else { throw CancellationError() }

        let baseSnapshot = (activeSnapshot?.context == saved.context ? activeSnapshot : nil)
            ?? VaultAutoFillSnapshot(context: saved.context, records: [])
        let updatedSnapshot = baseSnapshot.upsertingRecord(saved.snapshotRecord)
        let payload = VaultAutoFillSyncPayload(snapshot: updatedSnapshot, rootKey: saved.rootKey)
        await publishLocalMutationPayload(payload, ticket: ticket)
        return saved.snapshotRecord.objectIdBase64URL
    }

    func deleteItem(_ summary: VaultItemSummary) async throws {
        if isPreviewFixture {
            guard let snapshot = activeSnapshot, let rootKey = activeRootKey else { return }
            let updated = snapshot.removingRecord(objectIdBase64URL: summary.objectIdBase64URL)
            try applyUnlockedPayload(VaultAutoFillSyncPayload(snapshot: updated, rootKey: rootKey), providerEnabled: true)
            return
        }
        guard !busy, !isSaving else { throw VaultNativeError.busy }
        guard let identity = session, let native, let selected = selectedVaultHeader else {
            throw isSignedIn ? VaultWorkspaceError.noSelectedVault : VaultWorkspaceError.notSignedIn
        }
        let objectData = try Base64URL.decode(summary.objectIdBase64URL)
        let ticket = generation
        isSaving = true
        defer { if generation == ticket { isSaving = false } }

        do {
            try await native.deleteObject(
                header: selected,
                object: objectData,
                expectedRevision: summary.revision,
                identity: identity
            )
        } catch VaultNativeError.accessLost {
            if generation == ticket {
                vaults.removeAll { $0.id == selected.id }; selectedVault = nil
                revokeMaterial(message: "Access to this Vault was lost. Its offline data has been removed.")
            }
            throw VaultNativeError.accessLost
        }
        guard generation == ticket else { throw CancellationError() }

        if let snapshot = activeSnapshot, let rootKey = activeRootKey {
            let updatedSnapshot = snapshot.removingRecord(objectIdBase64URL: summary.objectIdBase64URL)
            let payload = VaultAutoFillSyncPayload(snapshot: updatedSnapshot, rootKey: rootKey)
            await publishLocalMutationPayload(payload, ticket: ticket)
        }
        status = "Deleted \"\(summary.title)\"."
    }

    private func publishLocalMutationPayload(_ payload: VaultAutoFillSyncPayload, ticket: Int) async {
        guard let cache else {
            try? applyUnlockedPayload(payload, providerEnabled: false)
            return
        }
        do {
            try await cache.synchronize(context: payload.snapshot.context) { payload }
            guard generation == ticket else { return }
            try applyUnlockedPayload(payload, providerEnabled: true)
            status = "Saved and synced to AutoFill."
        } catch VaultNativeError.providerDisabled {
            guard generation == ticket else { return }
            try? applyUnlockedPayload(payload, providerEnabled: false)
            status = "Saved to Vault. Enable Kinic Vault in iOS AutoFill settings for QuickType."
        } catch {
            guard generation == ticket else { return }
            try? applyUnlockedPayload(payload, providerEnabled: false)
            status = "Saved to Vault, but AutoFill cache update failed: \(error.localizedDescription)"
        }
    }

    private func savePreviewDocument(
        existing: VaultItemSummary?,
        metadata: VaultMetadata,
        plaintext: Data
    ) throws -> String {
        guard let snapshot = activeSnapshot, let rootKey = activeRootKey else {
            throw VaultWorkspaceError.locked
        }
        let object = try existing.map { try Base64URL.decode($0.objectIdBase64URL) } ?? Data((0..<16).map { _ in UInt8.random(in: 0...255) })
        let nextRev = (existing?.revision ?? 0) + 1
        let encrypted = try VaultDocumentV3.encrypt(
            rootKey: rootKey,
            context: snapshot.context,
            object: object,
            revision: nextRev,
            metadata: metadata,
            plaintext: plaintext
        )
        let record = VaultAutoFillRecordSnapshot(
            objectIdBase64URL: Base64URL.encode(object),
            revision: nextRev,
            manifestBase64URL: Base64URL.encode(encrypted.manifest),
            chunksBase64URL: encrypted.chunks.map(Base64URL.encode),
            hashesBase64URL: encrypted.hashes.map(Base64URL.encode)
        )
        let updated = snapshot.upsertingRecord(record)
        try applyUnlockedPayload(VaultAutoFillSyncPayload(snapshot: updated, rootKey: rootKey), providerEnabled: true)
        return record.objectIdBase64URL
    }

    // MARK: - Selection & Revocation

    private func revokeMaterial(message: String, refreshList: Bool = false) {
        generation += 1
        let ticket = generation
        busy = true
        isSaving = false
        isAuthenticating = false
        lock()
        hasOfflineSnapshot = false
        lastSyncedAt = nil
        autoFillStatus = .notSynced
        status = "Removing offline Vault data…"
        let cleanup = cache?.invalidate() // fence fetches and try every local channel synchronously
        let client = native
        Task {
            await client?.forgetKeys()
            do {
                try await cleanup?.value
                guard generation == ticket else { return }
                if refreshList, let client, let identity = session {
                    let previous = selectedVault
                    let list = try await client.ownedVaults(identity: identity)
                    guard generation == ticket else { return }
                    vaults = list
                    selectedVault = list.first(where: { $0.id == previous })?.id
                }
                status = message
            } catch {
                guard generation == ticket else { return }
                status = "Offline Vault cleanup is incomplete. Try disabling again."
                autoFillStatus = .error(status)
                onCleanupFailure(status)
            }
            if generation == ticket { busy = false }
        }
    }

    func selectVault(_ id: Data?) {
        guard !busy, selectedVault != id, id == nil || vaults.contains(where: { $0.id == id }) else { return }
        selectedVault = id
        revokeMaterial(message: "Sync this Vault to browse items and enable offline AutoFill.")
    }

    func signOut() {
        session = nil
        principal = nil
        vaults = []
        selectedVault = nil
        try? sessionStore?.clear()
        revokeMaterial(message: "Offline AutoFill disabled on this device.")
    }

    // MARK: - Preview Fixture

    enum PreviewScenario: String {
        case unlocked
        case locked
        case welcome
    }

    static func preview(_ scenario: PreviewScenario = .unlocked) -> VaultWorkspaceModel {
        if scenario == .welcome {
            return VaultWorkspaceModel(
                previewSnapshot: nil,
                previewRootKey: nil,
                previewHeader: nil,
                previewUnlocked: false,
                previewCanConnect: true
            )
        }
        let vaultID = Data(repeating: 1, count: 16)
        let nonce = Data(repeating: 2, count: 32)
        let publicKey = Data(repeating: 3, count: 96)
        let rootKey = SymmetricKey(data: Data(repeating: 9, count: 32))
        let canister = "rrkah-fqaaa-aaaaa-aaaaq-cai"
        let owner = "rrkah-fqaaa-aaaaa-aaaaq-cai"
        let context = try! VaultContext(
            canister: canister,
            owner: owner,
            vault: vaultID,
            nonce: nonce,
            keyName: "test_key_1"
        )
        let header = VaultNativeHeader(
            id: vaultID,
            name: "Personal Vault",
            nonce: nonce,
            keyName: "test_key_1",
            publicKey: publicKey,
            sequence: 1
        )

        let githubRecord = VaultCredentialRecord(
            label: "GitHub",
            username: "alice@kinic.xyz",
            password: "S3cur3!Vault-Password-99",
            url: "https://github.com/login",
            urls: ["https://github.com/login", "https://gist.github.com"],
            totp: "JBSWY3DPEHPK3PXP",
            notes: "Hardware key + TOTP backup enabled.",
            customFields: [VaultCustomField(label: "Recovery PIN", value: "482910", hidden: true)],
            favorite: true,
            tags: ["work", "dev"]
        )
        let linearRecord = VaultCredentialRecord(
            label: "Linear",
            username: "alice@kinic.xyz",
            password: "Maple-Beacon-Quartz42-Harbor",
            url: "https://linear.app/login",
            urls: ["https://linear.app/login"],
            totp: "",
            notes: "",
            favorite: false,
            tags: ["work"]
        )

        func makeRecord(byte: UInt8, meta: VaultMetadata, plain: Data) -> VaultAutoFillRecordSnapshot {
            let obj = Data(repeating: byte, count: 16)
            let enc = try! VaultDocumentV3.encrypt(
                rootKey: rootKey,
                context: context,
                object: obj,
                revision: 1,
                metadata: meta,
                plaintext: plain
            )
            return VaultAutoFillRecordSnapshot(
                objectIdBase64URL: Base64URL.encode(obj),
                revision: 1,
                manifestBase64URL: Base64URL.encode(enc.manifest),
                chunksBase64URL: enc.chunks.map(Base64URL.encode),
                hashesBase64URL: enc.hashes.map(Base64URL.encode)
            )
        }

        let records = [
            makeRecord(
                byte: 10,
                meta: VaultCredentialCodec.buildMetadata(title: "GitHub", record: githubRecord),
                plain: try! VaultCredentialCodec.serialize(githubRecord)
            ),
            makeRecord(
                byte: 11,
                meta: VaultCredentialCodec.buildMetadata(title: "Linear", record: linearRecord),
                plain: try! VaultCredentialCodec.serialize(linearRecord)
            ),
            makeRecord(
                byte: 12,
                meta: VaultMetadata(kind: .note, title: "SSH & Recovery Checklist", favorite: true, tags: ["ops"]),
                plain: Data("1. Keep two Internet Identity passkeys registered.\n2. Export a backup quarterly.".utf8)
            ),
        ]

        let snapshot = VaultAutoFillSnapshot(context: context, records: records)
        return VaultWorkspaceModel(
            previewSnapshot: snapshot,
            previewRootKey: rootKey,
            previewHeader: header,
            previewUnlocked: scenario == .unlocked
        )
    }
}
