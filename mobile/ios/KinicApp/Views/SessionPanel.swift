// Where: mobile/ios/KinicApp/Views/SessionPanel.swift
// What: Native Internet Identity session controls.
// Why: Capture cannot proceed until the user has an IC session.

import SwiftUI

struct SessionPanel: View {
    @Bindable var model: AppModel

    var body: some View {
        KinicPanel(title: "Principal", systemImage: "person.crop.circle") {
            VStack(alignment: .leading, spacing: 12) {
                Text(model.principalText)
                    .font(.subheadline)
                    .foregroundStyle(KinicDesign.bodyGray)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)

                if model.isSignedIn {
                    Button("Sign out", systemImage: "rectangle.portrait.and.arrow.right", action: model.signOut)
                        .labelStyle(.iconOnly)
                        .buttonStyle(KinicSecondaryButtonStyle())
                        .accessibilityLabel("Sign out")
                } else {
                    Button("Sign in with Internet Identity", systemImage: "person.crop.circle.badge.checkmark", action: model.startSignIn)
                        .labelStyle(.iconOnly)
                        .buttonStyle(KinicPrimaryButtonStyle())
                        .accessibilityLabel("Sign in with Internet Identity")
                        .disabled(model.isSigningIn)

                    if model.isSigningIn {
                        ProgressView("Starting sign in...")
                            .font(.footnote)
                    } else if let message = model.statusMessage {
                        Text(message)
                            .font(.footnote)
                            .foregroundStyle(KinicDesign.bodyGray)
                    }
                }
            }
        }
    }
}

#Preview {
    SessionPanel(model: .preview())
        .padding()
}
