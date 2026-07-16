// Where: mobile/ios/KinicApp/Views/SessionPanel.swift
// What: Native Internet Identity session controls.
// Why: Capture cannot proceed until the user has an IC session.

import SwiftUI

struct SessionPanel: View {
    @Bindable var model: AppModel

    private var account: InternetIdentityPresentation {
        InternetIdentityPresentation(principal: model.isSignedIn ? model.principalText : nil)
    }

    var body: some View {
        KinicPanel(title: account.compactPrincipal ?? "Not signed in", systemImage: "person.crop.circle") {
            if model.isSignedIn {
                Button("Sign out", systemImage: "rectangle.portrait.and.arrow.right", action: model.signOut)
                    .labelStyle(.iconOnly)
                    .buttonStyle(KinicIconButtonStyle())
                    .accessibilityLabel("Sign out")
            }
        } content: {
            if !model.isSignedIn {
                VStack(alignment: .leading, spacing: 12) {
                    Button("Sign in with Internet Identity", systemImage: "person.crop.circle.badge.checkmark", action: model.startSignIn)
                        .labelStyle(.iconOnly)
                        .buttonStyle(KinicPrimaryButtonStyle())
                        .accessibilityLabel("Sign in with Internet Identity")
                        .disabled(model.isSigningIn)

                    if model.isSigningIn {
                        ProgressView()
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
