// Where: mobile/ios/KinicApp/Views/VaultAutoFillSettingsSection.swift
// What: Settings section for Kinic Vault AutoFill sync, environment visibility, and revocation.
// Why: Cold-launch AutoFill revocation and Vault switching remain accessible directly from Settings.

import KinicVaultNative
import SwiftUI

struct VaultAutoFillSettingsSection: View {
    @Bindable var model: VaultWorkspaceModel
    @State private var autoCopyTOTP: Bool = Self.loadAutoCopyTOTP()
    @State private var showsVaultSignOutConfirmation = false
    @State private var pendingVaultSelection: Data?? = nil

    private static let autoCopyTOTPKey = "vault.autofill.autoCopyTOTP"
    private static var sharedDefaults: UserDefaults? {
        let appGroupID = (Bundle.main.object(forInfoDictionaryKey: "APP_GROUP_ID") as? String)
            ?? "group.xyz.kinic.ios.KinicWiki"
        return UserDefaults(suiteName: appGroupID)
    }

    private static func loadAutoCopyTOTP() -> Bool {
        guard let defaults = sharedDefaults else { return true }
        if defaults.object(forKey: autoCopyTOTPKey) == nil {
            return true
        }
        return defaults.bool(forKey: autoCopyTOTPKey)
    }

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
                if model.canConnect && model.principal == nil {
                    Button(
                        model.connectionMode == .local ? "Sign in to local Vault" : "Sign in to Kinic Vault",
                        systemImage: "lock.shield"
                    ) {
                        Task { await model.signIn() }
                    }
                    .disabled(model.busy)
                } else if model.canConnect {
                    if model.vaults.count > 1 || model.selectedVault == nil {
                        Picker(
                            "Vault for AutoFill",
                            selection: Binding(
                                get: { model.selectedVault },
                                set: { newValue in
                                    guard newValue != model.selectedVault else { return }
                                    if model.hasOfflineSnapshot {
                                        pendingVaultSelection = newValue
                                    } else {
                                        model.selectVault(newValue)
                                    }
                                }
                            )
                        ) {
                            if model.selectedVault == nil {
                                Text("Select a Vault").tag(Optional<Data>.none)
                            }
                            ForEach(model.vaults) { vault in
                                Text(vault.name).tag(Optional(vault.id))
                            }
                        }
                        .disabled(model.busy)
                    }

                    Button(
                        model.hasOfflineSnapshot ? "Sync Vault now" : "Sync and enable offline AutoFill",
                        systemImage: "arrow.triangle.2.circlepath"
                    ) {
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

                    Toggle("Auto-copy 2FA code on AutoFill", isOn: $autoCopyTOTP)
                        .onChange(of: autoCopyTOTP) { _, newValue in
                            Self.sharedDefaults?.set(newValue, forKey: Self.autoCopyTOTPKey)
                        }
                }

                if model.busy {
                    ProgressView("Updating Vault…")
                } else if !model.status.isEmpty {
                    Text(model.status)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                if let principal = model.principal {
                    DisclosureGroup("Vault Details") {
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
                    .font(.footnote)
                }

                if model.principal != nil || model.hasOfflineSnapshot {
                    Button("Sign out of Vault & clear offline AutoFill", role: .destructive) {
                        showsVaultSignOutConfirmation = true
                    }
                    .disabled(model.busy)
                }
            } header: {
                Text(sectionTitle)
            } footer: {
                Text("Vault uses its own dedicated Internet Identity session, separate from Kinic Wiki. Your selected Vault stays available offline until you disable AutoFill or sign out.")
            }
            .alert("Sign out of Vault?", isPresented: $showsVaultSignOutConfirmation) {
                Button("Cancel", role: .cancel) {}
                Button("Sign Out & Clear", role: .destructive) {
                    model.signOut()
                }
            } message: {
                Text("This signs out of Kinic Vault only and removes offline AutoFill data from this device. Your Kinic Wiki session stays signed in.")
            }
            .alert("Switch AutoFill Vault?", isPresented: Binding(
                get: { pendingVaultSelection != nil },
                set: { if !$0 { pendingVaultSelection = nil } }
            )) {
                Button("Cancel", role: .cancel) { pendingVaultSelection = nil }
                Button("Switch Vault", role: .destructive) {
                    if let target = pendingVaultSelection {
                        pendingVaultSelection = nil
                        model.selectVault(target)
                    }
                }
            } message: {
                Text("Switching Vaults locks the current Vault and clears its offline AutoFill cache until you sync the newly selected Vault.")
            }
        }
    }
}
