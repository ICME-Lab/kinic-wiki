// Where: mobile/ios/KinicApp/Views/SettingsView.swift
// What: Runtime settings for selecting the target wiki database.
// Why: The canister is fixed, while the writable database is user-specific.

import SwiftUI

struct SettingsView: View {
    @Bindable var model: AppModel

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                KinicPanel(title: "Runtime", systemImage: "network") {
                    VStack(alignment: .leading, spacing: 12) {
                        LabeledContent("Canister", value: model.configuration.canisterId)
                        LabeledContent("Host", value: model.configuration.apiBaseURL.absoluteString)
                        LabeledContent("Bridge", value: model.configuration.authOrigin.absoluteString)
                    }
                    .font(.subheadline)
                    .foregroundStyle(KinicDesign.bodyGray)
                }

                KinicPanel(title: "Database", systemImage: "externaldrive") {
                    VStack(alignment: .leading, spacing: 12) {
                        if let database = model.selectedDatabase {
                            LabeledContent("Selected", value: database.displayTitle)
                            LabeledContent("Role", value: database.role.displayName)
                        } else {
                            Text("No writable database selected.")
                                .foregroundStyle(KinicDesign.bodyGray)
                        }

                        Button("Refresh databases", systemImage: "arrow.clockwise", action: model.startRefreshDatabases)
                            .buttonStyle(KinicSecondaryButtonStyle())
                            .disabled(!model.isSignedIn || model.isLoadingDatabases)
                    }
                }
            }
            .padding(KinicDesign.screenPadding)
        }
        .background(.white)
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
    }
}

#Preview {
    NavigationStack {
        SettingsView(model: .preview())
    }
}
