// Where: mobile/ios/KinicApp/Views/AppearanceSettingsView.swift
// What: Small appearance settings sheet opened from Capture.
// Why: Users need one explicit switch to keep the app in light or dark mode.

import SwiftUI

struct AppearanceSettingsView: View {
    @Bindable var model: AppModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        Form {
            Section("Appearance") {
                Toggle("Dark Mode", isOn: $model.isDarkAppearanceEnabled)
                    .tint(KinicDesign.hotPink)
            }
        }
        .navigationTitle("Appearance")
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
        AppearanceSettingsView(model: .preview())
    }
}
