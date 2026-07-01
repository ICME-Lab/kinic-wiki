// Where: mobile/ios/KinicApp/Views/SessionPanel.swift
// What: Native Internet Identity session controls.
// Why: Capture cannot proceed until the user has an IC session.

import SwiftUI

struct SessionPanel: View {
    @Bindable var model: AppModel

    var body: some View {
        KinicPanel(title: "Session", systemImage: "person.crop.circle") {
            VStack(alignment: .leading, spacing: 12) {
                LabeledContent("Principal", value: model.principalText)
                    .font(.subheadline)
                    .foregroundStyle(KinicDesign.bodyGray)

                if model.isSignedIn {
                    Button("Sign out", systemImage: "rectangle.portrait.and.arrow.right", action: model.signOut)
                        .buttonStyle(KinicSecondaryButtonStyle())
                } else {
                    Button("Sign in with Internet Identity", systemImage: "person.crop.circle.badge.checkmark", action: model.startSignIn)
                        .buttonStyle(KinicPrimaryButtonStyle())
                }
            }
        }
    }
}

#Preview {
    SessionPanel(model: .preview())
        .padding()
}
