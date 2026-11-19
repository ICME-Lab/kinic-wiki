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
    @ObservationIgnored private var session: ICAuthSession?
    @ObservationIgnored private var native: VaultNativeClient?
    @ObservationIgnored private var authenticator: ICInternetIdentityAuthenticator?
    @ObservationIgnored private var cache: VaultAutoFillSyncController?
    @ObservationIgnored private var generation = 0

    init(configuration: AppConfiguration) {
        if let group = configuration.appGroupId,
           let url = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group),
           let accessGroup = configuration.keychainAccessGroup {
            let store = VaultAutoFillSnapshotStore(fileURL: url.appendingPathComponent("VaultAutoFill/snapshot.v1.json"))
            cache = VaultAutoFillSyncController(snapshotStore: store, keys: VaultSystemRootKeys(accessGroup: accessGroup), identities: VaultSystemIdentityStore())
        }
#if DEBUG
        guard let path = ProcessInfo.processInfo.environment["KINIC_LOCAL_VAULT_CONFIG"] else { return }
        available = true
        do {
            let local = try VaultLocalConfiguration(data: Data(contentsOf: URL(fileURLWithPath: path)))
            vaultCanister = local.client.canisterId
            native = VaultNativeClient(configuration: local.client, local: true)
            authenticator = try ICInternetIdentityAuthenticator(configuration: local.client, callbackURL: local.callbackURL)
            status = "Sign in to your local Vault to sync offline AutoFill."
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
            try await cache.disable()
            guard generation == ticket else { return }
            let identity = try await authenticator.authenticate(prefersEphemeralWebBrowserSession: true)
            guard generation == ticket else { return }
            let list = try await native.ownedVaults(identity: identity)
            guard generation == ticket else { return }
            session = identity; principal = identity.principal; vaults = list; selectedVault = list.first?.id
            status = list.isEmpty ? "No active owned Vaults were found." : "Select a Vault and enable offline AutoFill."
        } catch {
            if generation == ticket { status = error.localizedDescription }
        }
    }

    func synchronize() async {
        guard !busy, let identity = session, let native, let cache,
              let selected = vaults.first(where: { $0.id == selectedVault }) else { return }
        let ticket = generation
        busy = true
        defer { if generation == ticket { busy = false } }
        do {
            let context = try selected.context(canister: nativeCanister(), owner: identity.principal)
            try await cache.synchronize(context: context) {
                let payload = try await native.fetchSnapshot(header: selected, identity: identity)
                guard self.generation == ticket else { throw CancellationError() }
                return payload
            }
            guard generation == ticket else { return }
            status = "Offline AutoFill is ready. Enable Kinic Vault in iOS AutoFill settings."
        } catch {
            guard generation == ticket else { return }
            if case VaultNativeError.accessLost = error { _ = try? cache.invalidate() }
            if case VaultNativeError.changedDuringSync = error { _ = try? cache.invalidate() }
            status = error.localizedDescription
        }
    }

    // The session is sealed and bound to the configured canister, which is kept
    // separately rather than inferred from a Wiki principal or a returned header.
    @ObservationIgnored private var vaultCanister: String?
    private func nativeCanister() throws -> String {
        guard let vaultCanister else { throw VaultCryptoError.invalidContext }
        return vaultCanister
    }

    func selectVault(_ id: Data?) {
        guard !busy, selectedVault != id else { return }
        generation += 1
        selectedVault = id
        do { _ = try cache?.invalidate(); status = "Sync this Vault to enable offline AutoFill." }
        catch { status = "Could not clear the previous Vault cache. Disable AutoFill and try again." }
    }

    func signOut() {
        generation += 1
        busy = false; session = nil; principal = nil; vaults = []; selectedVault = nil
        let client = native
        Task { await client?.forgetKeys() }
        do { _ = try cache?.invalidate(); status = "Offline AutoFill disabled on this device." }
        catch { status = "Could not finish clearing the offline Vault cache. Try disabling again." }
    }
}
