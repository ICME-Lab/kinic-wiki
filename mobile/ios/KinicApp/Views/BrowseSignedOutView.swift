// Where: mobile/ios/KinicApp/Views/BrowseSignedOutView.swift
// What: Empty state shown before authentication.
// Why: Readable databases require an IC session before native canister queries can run.

import SwiftUI

struct BrowseSignedOutView: View {
    @Bindable var model: AppModel

    var body: some View {
        VStack(spacing: 12) {
            ContentUnavailableView("Sign in to browse", systemImage: "person.crop.circle")

            Button("Sign in", systemImage: "person.crop.circle", action: model.startSignIn)
                .buttonStyle(.borderedProminent)
                .disabled(model.isSigningIn)

            if model.isSigningIn {
                ProgressView("Starting sign in...")
                    .font(.footnote)
            } else if let message = model.statusMessage {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(KinicDesign.bodyGray)
                    .multilineTextAlignment(.center)
            }
        }
        .padding(KinicDesign.screenPadding)
    }
}
