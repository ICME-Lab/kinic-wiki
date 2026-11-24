// Where: mobile/ios/KinicApp/Views/VaultAutoFillSettingsSection.swift
// What: Settings section for Kinic Vault AutoFill sync, environment visibility, and revocation.
// Why: Cold-launch AutoFill revocation and Vault switching remain accessible directly from Settings.

import KinicVaultNative
import SwiftUI

struct VaultAutoFillSettingsSection: View {
    @Bindable var model: VaultWorkspaceModel

    private var sectionTitle: String {
        guard let mode = model.connectionMode else { return "Vault AutoFill" }
        switch mode {
        case .production: return "Kinic Vault AutoFill"
        case .staging: return "Staging Vault AutoFill"
        case .local: return "Local Vault AutoFill"
        }
    }

    var body: some View {
        if model.available {
            Section {
                if let principal = model.principal {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Vault Principal")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(principal)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                }

                if model.canConnect && model.principal == nil {
                    Button(
                        model.connectionMode == .local ? "Sign in to local Vault" : "Sign in to Kinic Vault",
                        systemImage: "lock.shield"
                    ) {
                        Task { await model.signIn() }
                    }
                    .disabled(model.busy)
                } else if model.canConnect {
                    Picker("Vault for AutoFill", selection: Binding(get: { model.selectedVault }, set: { model.selectVault($0) })) {
                        Text("Select a Vault").tag(Optional<Data>.none)
                        ForEach(model.vaults) { vault in
                            Text(vault.name).tag(Optional(vault.id))
                        }
                    }
                    .disabled(model.busy)

                    Button("Sync and enable offline AutoFill", systemImage: "arrow.triangle.2.circlepath") {
                        Task { await model.synchronize() }
                    }
                    .disabled(model.busy || model.selectedVault == nil)
                }

                if model.hasOfflineSnapshot {
                    let activeVaultName = model.vaults.first(where: { $0.id == model.selectedVault })?.name
                    HStack {
                        Label("Offline AutoFill Vault", systemImage: "checkmark.shield")
                            .foregroundStyle(.secondary)
                        Spacer()
                        Text(activeVaultName ?? "Synced")
                            .foregroundStyle(.secondary)
                    }
                    .font(.footnote)
                }

                if model.principal != nil || model.hasOfflineSnapshot {
                    Button("Disable AutoFill and sign out", role: .destructive) {
                        model.signOut()
                    }
                    .disabled(model.busy)
                }

                if model.busy {
                    ProgressView("Updating Vault")
                }

                if !model.status.isEmpty {
                    Text(model.status)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            } header: {
                Text(sectionTitle)
            } footer: {
                Text("Vault uses its own dedicated Internet Identity session, separate from Kinic Wiki. Your selected Vault stays available offline until you disable AutoFill or sign out.")
            }
        }
    }
}
