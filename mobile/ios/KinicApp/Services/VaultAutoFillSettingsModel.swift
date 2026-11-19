import AuthenticationServices
import Foundation
import ICNativeClient
import KinicVaultCore
import KinicVaultNative
import Observation

/// Vault has its own derivation origin and session; never reuse the Wiki session.
@MainActor @Observable
final class VaultAutoFillSettingsModel {
    private(set) var available = false
    private(set) var busy = false
    private(set) var principal: String?
    private(set) var vaults: [VaultNativeHeader] = []
    private(set) var status = ""
    private(set) var selectedVault: Data?
    var canConnect: Bool { native != nil && authenticator != nil && cache != nil }
    @ObservationIgnored private var session: ICAuthSession?
    @ObservationIgnored private var native: VaultNativeClient?
    @ObservationIgnored private var authenticator: ICInternetIdentityAuthenticator?
    @ObservationIgnored private var cache: VaultAutoFillSyncController?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var vaultCanister: String?
    @ObservationIgnored private let onCleanupFailure: (String) -> Void

    init(configuration: AppConfiguration, onCleanupFailure: @escaping (String) -> Void = { _ in }) {
        self.onCleanupFailure = onCleanupFailure
        if let group = configuration.appGroupId,
           let url = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group),
           let accessGroup = configuration.keychainAccessGroup {
            let store = VaultAutoFillSnapshotStore(fileURL: url.appendingPathComponent("VaultAutoFill/snapshot.v1.json"))
            cache = VaultAutoFillSyncController(snapshotStore: store, keys: VaultSystemRootKeys(accessGroup: accessGroup), identities: VaultSystemIdentityStore())
            // Revocation remains available on a normal cold launch, without any
            // development configuration or an active authentication session.
            available = true
        }
#if DEBUG
        guard let path = ProcessInfo.processInfo.environment["KINIC_LOCAL_VAULT_CONFIG"] else { return }
        available = true
        do {
            let local = try VaultLocalConfiguration(data: Data(contentsOf: URL(fileURLWithPath: path)))
            vaultCanister = local.client.canisterId
            native = VaultNativeClient(configuration: local.client, local: true)
            authenticator = try ICInternetIdentityAuthenticator(configuration: local.client, callbackURL: local.callbackURL)
            status = "Enable Kinic Vault in iOS AutoFill settings, then sign in and sync here."
        } catch { status = "The local Vault configuration is invalid." }
#endif
    }

    func signIn() async {
        guard !busy, let authenticator, let native, let cache else { return }
        generation += 1
        let ticket = generation
        busy = true
        session = nil; principal = nil; vaults = []; selectedVault = nil
        defer { if generation == ticket { busy = false } }
        do {
            await native.forgetKeys()
            guard generation == ticket else { return }
            try await cache.disable()
            guard generation == ticket else { return }
            let identity = try await authenticator.authenticate(prefersEphemeralWebBrowserSession: true)
            guard generation == ticket else { return }
            let list = try await native.ownedVaults(identity: identity)
            guard generation == ticket else { return }
            session = identity; principal = identity.principal; vaults = list; selectedVault = list.first?.id
            status = list.isEmpty ? "No active owned Vaults were found." : "Enable Kinic Vault in iOS AutoFill settings, then select a Vault and sync."
        } catch {
            if generation == ticket { status = error.localizedDescription }
        }
    }

    func synchronize() async {
        guard !busy, let identity = session, let native, let cache, let canister = vaultCanister,
              let selected = vaults.first(where: { $0.id == selectedVault }) else { return }
        let ticket = generation
        busy = true
        defer { if generation == ticket { busy = false } }
        do {
            let context = try selected.context(canister: canister, owner: identity.principal)
            try await cache.synchronize(context: context) {
                let payload = try await native.fetchSnapshot(header: selected, identity: identity)
                guard self.generation == ticket else { throw CancellationError() }
                return payload
            }
            guard generation == ticket else { return }
            status = "Offline AutoFill and QuickType are ready."
        } catch {
            guard generation == ticket else { return }
            if case VaultNativeError.accessLost = error {
                vaults.removeAll { $0.id == selected.id }; selectedVault = nil
                revokeMaterial(message: "Access to this Vault was lost. Its offline data has been removed.")
            } else if case VaultNativeError.changedDuringSync = error {
                revokeMaterial(message: "The Vault changed. Sync again to refresh it.", refreshList: true)
            } else { status = error.localizedDescription }
        }
    }

    private func revokeMaterial(message: String, refreshList: Bool = false) {
        generation += 1
        let ticket = generation
        busy = true
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
                onCleanupFailure(status)
            }
            if generation == ticket { busy = false }
        }
    }

    func selectVault(_ id: Data?) {
        guard !busy, selectedVault != id, id == nil || vaults.contains(where: { $0.id == id }) else { return }
        selectedVault = id
        revokeMaterial(message: "Sync this Vault to enable offline AutoFill.")
    }

    func signOut() {
        session = nil; principal = nil; vaults = []; selectedVault = nil
        revokeMaterial(message: "Offline AutoFill disabled on this device.")
    }
}
