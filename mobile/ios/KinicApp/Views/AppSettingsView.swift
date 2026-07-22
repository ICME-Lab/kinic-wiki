// Where: mobile/ios/KinicApp/Views/AppSettingsView.swift
// What: Small app settings sheet opened from Capture.
// Why: Common appearance and Browse preferences should be quick to adjust without entering management.

import SwiftUI

struct AppSettingsView: View {
    @Bindable var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var didCopyPrincipal = false

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
        }
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Done", action: close)
            }
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
}

#Preview {
    NavigationStack {
        AppSettingsView(model: .preview())
    }
}
