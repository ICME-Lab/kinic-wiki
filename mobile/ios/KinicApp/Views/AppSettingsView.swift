// Where: mobile/ios/KinicApp/Views/AppSettingsView.swift
// What: Small app settings sheet opened from Capture.
// Why: Common appearance and Browse preferences should be quick to adjust without entering management.

import SwiftUI

struct AppSettingsView: View {
    @Bindable var model: AppModel
    let askAIModel: AskAIModel
    @Environment(\.dismiss) private var dismiss
    @State private var didCopyPrincipal = false
    @State private var showsDeleteAccountConfirmation = false

    private var account: InternetIdentityPresentation {
        InternetIdentityPresentation(principal: model.isSignedIn ? model.principalText : nil)
    }

    var body: some View {
        Form {
            if let principal = account.principal {
                Section("Account") {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(spacing: 0) {
                            Text("Principal")
                                .font(.subheadline)

                            Button(
                                didCopyPrincipal ? "Principal copied" : "Copy principal",
                                systemImage: didCopyPrincipal ? "checkmark" : "doc.on.doc",
                                action: copyPrincipal
                            )
                            .labelStyle(.iconOnly)
                            .frame(minWidth: 44, minHeight: 44)
                        }

                        Text(principal)
                            .font(.footnote.monospaced())
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                }
            }

            Section("Appearance") {
                Toggle("Dark Mode", isOn: $model.isDarkAppearanceEnabled)
                    .tint(KinicDesign.hotPink)
            }

            Section {
                Picker("Output Language", selection: $model.wikiOutputLanguage) {
                    ForEach(WikiOutputLanguage.allCases) { language in
                        Text(language.displayName)
                            .tag(language)
                    }
                }
            } header: {
                Text("Generation")
            } footer: {
                Text("New captures generate wiki pages in this language.")
            }

            Section("Browse") {
                Toggle("Show Public Databases", isOn: $model.showPublicBrowseDatabases)
                    .onChange(of: model.showPublicBrowseDatabases) {
                        model.startRefreshDatabases()
                    }
                Toggle("Show Purchased Databases", isOn: $model.showPurchasedBrowseDatabases)
                    .onChange(of: model.showPurchasedBrowseDatabases) {
                        model.startRefreshDatabases()
                    }
            }

            Section("Privacy") {
                Link("Privacy Policy", destination: AppConfiguration.privacyPolicyURL)
            }

            if model.isSignedIn {
                Section {
                    Button("Delete Account", role: .destructive) {
                        showsDeleteAccountConfirmation = true
                    }
                    .disabled(model.isDeletingAccount)

                    if model.isDeletingAccount {
                        HStack(spacing: 10) {
                            ProgressView()
                            Text("Deleting account…")
                                .foregroundStyle(.secondary)
                        }
                    }

                    if let error = model.accountDeletionError {
                        Text(error)
                            .foregroundStyle(.red)
                    }
                } header: {
                    Text("Account Deletion")
                } footer: {
                    Text("Permanently removes your KinicWiki account data and access. Your Internet Identity is not deleted.")
                }
            }
        }
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Done", action: close)
                    .disabled(model.isDeletingAccount)
            }
        }
        .interactiveDismissDisabled(model.isDeletingAccount)
        .alert("Delete Account?", isPresented: $showsDeleteAccountConfirmation) {
            Button("Cancel", role: .cancel) {}
            Button("Delete Account", role: .destructive, action: deleteAccount)
        } message: {
            Text("Databases you solely own will be permanently deleted. Shared databases will remain, but your access and purchased access will be removed. Ask AI history, capture history, and queued URLs on this device will be erased. Your Internet Identity will not be deleted. This cannot be undone.")
        }
    }

    private func close() {
        model.setDarkAppearanceEnabled(model.isDarkAppearanceEnabled)
        dismiss()
    }

    private func copyPrincipal() {
        guard let principal = account.principal else {
            return
        }
        UIPasteboard.general.string = principal
        didCopyPrincipal = true
    }

    private func deleteAccount() {
        Task {
            if await model.deleteAccount(
                coordinatedHistoryDeletion: askAIModel.deleteStoredHistoryForAccountDeletion
            ) {
                dismiss()
            }
        }
    }
}

#Preview {
    let appModel = AppModel.preview()
    NavigationStack {
        AppSettingsView(model: appModel, askAIModel: AskAIModel(appModel: appModel))
    }
}
