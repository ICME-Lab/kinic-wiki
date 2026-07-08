// Where: mobile/ios/KinicApp/Views/AppSettingsView.swift
// What: Small app settings sheet opened from Capture.
// Why: Common appearance and Browse preferences should be quick to adjust without entering management.

import SwiftUI

struct AppSettingsView: View {
    @Bindable var model: AppModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        Form {
            Section("Appearance") {
                Toggle("Dark Mode", isOn: $model.isDarkAppearanceEnabled)
                    .tint(KinicDesign.hotPink)
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
}

#Preview {
    NavigationStack {
        AppSettingsView(model: .preview())
    }
}
