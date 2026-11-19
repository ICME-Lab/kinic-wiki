import SwiftUI

struct VaultAutoFillSettingsSection: View {
    @Bindable var model: VaultAutoFillSettingsModel
    var body: some View {
        if model.available {
            Section {
                if model.canConnect && model.principal == nil {
                    Button("Sign in to local Vault") { Task { await model.signIn() } }
                        .disabled(model.busy)
                } else if model.canConnect {
                    Picker("Vault for AutoFill", selection: Binding(get: { model.selectedVault }, set: { model.selectVault($0) })) {
                        Text("Select a Vault").tag(Optional<Data>.none)
                        ForEach(model.vaults) { vault in Text(vault.name).tag(Optional(vault.id)) }
                    }
                    .disabled(model.busy)
                    Button("Sync and enable offline AutoFill") { Task { await model.synchronize() } }
                        .disabled(model.busy || model.selectedVault == nil)
                }
                Button("Disable AutoFill and sign out", role: .destructive) { model.signOut() }
                if model.busy { ProgressView("Updating Vault") }
                if !model.status.isEmpty { Text(model.status).font(.footnote).foregroundStyle(.secondary) }
            } header: {
                Text(model.canConnect ? "Local Vault AutoFill" : "Vault AutoFill")
            } footer: {
                Text("Your selected Vault stays available offline on this device until you disable AutoFill or sign out. Sync replaces the cached Vault.")
            }
        }
    }
}
