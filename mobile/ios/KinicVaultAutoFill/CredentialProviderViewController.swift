import AuthenticationServices
import CryptoKit
import Foundation
import KinicVaultCore
import LocalAuthentication
import SwiftUI
import UIKit

/// System-wide iOS AutoFill credential provider backed by the App Group encrypted Vault snapshot
/// and Keychain-protected AES-256 root key. Never reads network or writes plaintext to disk.
final class CredentialProviderViewController: ASCredentialProviderViewController {
    private var hostingController: UIHostingController<AutoFillRootView>?

    private var appGroupID: String {
        (Bundle.main.object(forInfoDictionaryKey: "APP_GROUP_ID") as? String)
            ?? "group.xyz.kinic.ios.KinicWiki"
    }

    private var keychainAccessGroup: String? {
        Bundle.main.object(forInfoDictionaryKey: "KINIC_KEYCHAIN_ACCESS_GROUP") as? String
    }

    private func makeSnapshotStore() -> VaultAutoFillSnapshotStore? {
        guard let container = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: appGroupID
        ) else {
            return nil
        }
        let fileURL = container
            .appendingPathComponent("VaultAutoFill", isDirectory: true)
            .appendingPathComponent("snapshot.v1.json")
        return VaultAutoFillSnapshotStore(fileURL: fileURL)
    }

    private func makeKeyStore() -> VaultKeychainRootStore {
        VaultKeychainRootStore(accessGroup: keychainAccessGroup)
    }

    override func prepareCredentialList(for serviceIdentifiers: [ASCredentialServiceIdentifier]) {
        let hosts = serviceIdentifiers.map(\.identifier)
        Task { @MainActor in
            await presentCredentialPicker(serviceHosts: hosts)
        }
    }

    override func provideCredentialWithoutUserInteraction(
        for credentialIdentity: ASPasswordCredentialIdentity
    ) {
        // Require explicit biometric / device owner authentication before releasing any password.
        let error = NSError(
            domain: ASExtensionErrorDomain,
            code: ASExtensionError.userInteractionRequired.rawValue
        )
        extensionContext.cancelRequest(withError: error)
    }

    override func prepareInterfaceToProvideCredential(
        for credentialIdentity: ASPasswordCredentialIdentity
    ) {
        guard let recordId = credentialIdentity.recordIdentifier else {
            cancelWith(code: .credentialIdentityNotFound)
            return
        }
        Task { @MainActor in
            let unlocked = await authenticateBiometrics(
                reason: "Unlock Kinic Vault to fill your password"
            )
            guard unlocked else {
                cancelWith(code: .userCanceled)
                return
            }
            completeWithCredential(recordIdentifier: recordId)
        }
    }

    override func prepareInterfaceForExtensionConfiguration() {
        Task { @MainActor [weak self] in
            guard let self else { return }
            embed(
                AutoFillRootView(
                    state: .configurationNeeded,
                    onSelect: { _ in },
                    onCancel: { [weak self] in
                        self?.extensionContext.completeExtensionConfigurationRequest()
                    }
                )
            )
        }
    }

    @MainActor
    private func presentCredentialPicker(serviceHosts: [String]) async {
        let unlocked = await authenticateBiometrics(
            reason: "Unlock Kinic Vault to browse saved logins"
        )
        guard unlocked else {
            cancelWith(code: .userCanceled)
            return
        }

        guard let store = makeSnapshotStore() else {
            embedError("Vault storage group is not available.")
            return
        }
        guard let rootKey = try? makeKeyStore().load() else {
            embed(
                AutoFillRootView(
                    state: .configurationNeeded,
                    onSelect: { _ in },
                    onCancel: { [weak self] in self?.cancelWith(code: .userCanceled) }
                )
            )
            return
        }

        do {
            let allCandidates = try store.listCandidates(rootKey: rootKey)
            let matched = serviceHosts.isEmpty
                ? []
                : allCandidates.filter { candidate in
                    serviceHosts.contains { host in
                        VaultCredentialCodec.matchesDomain(
                            domains: candidate.domains,
                            queryHost: host
                        )
                    }
                }
            embed(
                AutoFillRootView(
                    state: .ready(matched: matched, all: allCandidates),
                    onSelect: { [weak self] recordId in
                        self?.completeWithCredential(recordIdentifier: recordId)
                    },
                    onCancel: { [weak self] in
                        self?.cancelWith(code: .userCanceled)
                    }
                )
            )
        } catch {
            embedError("Could not decrypt cached Vault logins. Open Kinic to refresh.")
        }
    }

    @MainActor
    private func completeWithCredential(recordIdentifier: String) {
        guard let store = makeSnapshotStore(),
              let rootKey = try? makeKeyStore().load(),
              let decrypted = try? store.decryptCredential(
                  recordIdentifier: recordIdentifier,
                  rootKey: rootKey
              )
        else {
            cancelWith(code: .credentialIdentityNotFound)
            return
        }

        if let totpCode = decrypted.totpCode {
            let expiry = Date().addingTimeInterval(90)
            UIPasteboard.general.setItems(
                [[UIPasteboard.typeAutomatic: totpCode]],
                options: [
                    .localOnly: true,
                    .expirationDate: expiry,
                ]
            )
        }

        let credential = ASPasswordCredential(
            user: decrypted.username,
            password: decrypted.password
        )
        extensionContext.completeRequest(withSelectedCredential: credential, completionHandler: nil)
    }

    private func authenticateBiometrics(reason: String) async -> Bool {
        let context = LAContext()
        var authError: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &authError) else {
            return false
        }
        return await withCheckedContinuation { continuation in
            context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { ok, _ in
                continuation.resume(returning: ok)
            }
        }
    }

    @MainActor
    private func embedError(_ message: String) {
        embed(
            AutoFillRootView(
                state: .error(message),
                onSelect: { _ in },
                onCancel: { [weak self] in self?.cancelWith(code: .failed) }
            )
        )
    }

    @MainActor
    private func embed(_ rootView: AutoFillRootView) {
        if let existing = hostingController {
            existing.rootView = rootView
            return
        }
        let host = UIHostingController(rootView: rootView)
        addChild(host)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(host.view)
        NSLayoutConstraint.activate([
            host.view.topAnchor.constraint(equalTo: view.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        host.didMove(toParent: self)
        hostingController = host
    }

    private func cancelWith(code: ASExtensionError.Code) {
        extensionContext.cancelRequest(
            withError: NSError(domain: ASExtensionErrorDomain, code: code.rawValue)
        )
    }
}

/// Syncs `ASCredentialIdentityStore` so iOS QuickType keyboard bar shows matching logins immediately.
public enum VaultAutoFillIdentityRegistrar {
    public static func replaceAll(candidates: [VaultAutoFillCandidate]) async throws {
        let store = ASCredentialIdentityStore.shared
        let state = await store.state()
        guard state.isEnabled else { return }

        var identities: [any ASCredentialIdentity] = []
        for candidate in candidates {
            for domain in candidate.domains {
                let service = ASCredentialServiceIdentifier(identifier: domain, type: .domain)
                let identity = ASPasswordCredentialIdentity(
                    serviceIdentifier: service,
                    user: candidate.username.isEmpty ? candidate.title : candidate.username,
                    recordIdentifier: candidate.recordIdentifier
                )
                identities.append(identity)
            }
        }
        try await store.replaceCredentialIdentities(identities)
    }

    public static func removeAll() async {
        try? await ASCredentialIdentityStore.shared.removeAllCredentialIdentities()
    }
}

private enum AutoFillViewState {
    case configurationNeeded
    case ready(matched: [VaultAutoFillCandidate], all: [VaultAutoFillCandidate])
    case error(String)
}

private struct AutoFillRootView: View {
    let state: AutoFillViewState
    let onSelect: (String) -> Void
    let onCancel: () -> Void
    @State private var query = ""

    var body: some View {
        NavigationStack {
            Group {
                switch state {
                case .configurationNeeded:
                    ContentUnavailableView(
                        "Open Kinic to Sync Vault",
                        systemImage: "lock.shield",
                        description: Text("Sign in to your Vault inside the Kinic app to enable offline AutoFill on this device.")
                    )
                case let .error(message):
                    ContentUnavailableView(
                        "AutoFill Unavailable",
                        systemImage: "exclamationmark.triangle",
                        description: Text(message)
                    )
                case let .ready(matched, all):
                    credentialList(matched: matched, all: all)
                }
            }
            .navigationTitle("Kinic Vault")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                }
            }
        }
    }

    @ViewBuilder
    private func credentialList(
        matched: [VaultAutoFillCandidate],
        all: [VaultAutoFillCandidate]
    ) -> some View {
        let filteredAll = query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? all
            : all.filter { item in
                let q = query.lowercased()
                return item.title.lowercased().contains(q)
                    || item.username.lowercased().contains(q)
                    || item.domains.contains { $0.lowercased().contains(q) }
            }

        List {
            if !matched.isEmpty && query.isEmpty {
                Section("Suggested for this site") {
                    ForEach(matched, id: \.recordIdentifier) { item in
                        candidateRow(item)
                    }
                }
            }
            Section(matched.isEmpty ? "Saved logins" : "All logins") {
                ForEach(filteredAll, id: \.recordIdentifier) { item in
                    candidateRow(item)
                }
            }
        }
        .searchable(text: $query, prompt: "Search logins or domains")
    }

    private func candidateRow(_ item: VaultAutoFillCandidate) -> some View {
        Button {
            onSelect(item.recordIdentifier)
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.title.isEmpty ? "Untitled" : item.title)
                        .font(.headline)
                        .foregroundStyle(.primary)
                    if !item.username.isEmpty {
                        Text(item.username)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    } else if let firstDomain = item.domains.first {
                        Text(firstDomain)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
                if item.hasTotp {
                    Label("2FA", systemImage: "key.fill")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
            }
        }
    }
}
