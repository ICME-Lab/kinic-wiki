// Where: mobile/ios/KinicApp/Views/SessionPanel.swift
// What: Native Internet Identity session controls and the signed-out welcome hero.
// Why: Capture cannot proceed until the user has an IC session, so the first screen must invite sign-in.

import SwiftUI

struct SessionPanel: View {
    @Bindable var model: AppModel

    private var account: InternetIdentityPresentation {
        InternetIdentityPresentation(principal: model.isSignedIn ? model.principalText : nil)
    }

    var body: some View {
        if model.isSignedIn {
            KinicPanel(title: account.compactPrincipal ?? "Signed in", systemImage: "person.crop.circle") {
                Button("Sign out", systemImage: "rectangle.portrait.and.arrow.right", action: model.signOut)
                    .labelStyle(.iconOnly)
                    .buttonStyle(KinicIconButtonStyle())
                    .accessibilityLabel("Sign out")
            } content: {
                EmptyView()
            }
        } else {
            KinicWelcomeHero(model: model)
        }
    }
}

/// The first impression: a living aurora mark, one confident promise, one clear action.
struct KinicWelcomeHero: View {
    @Bindable var model: AppModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var appeared = false

    var body: some View {
        VStack(alignment: .leading, spacing: 28) {
            KinicAuroraOrb(size: 84, isActive: model.isSigningIn)
                .padding(.top, 24)

            VStack(alignment: .leading, spacing: 12) {
                Text("KINIC WIKI")
                    .font(.caption.weight(.semibold))
                    .tracking(2.4)
                    .foregroundStyle(KinicDesign.hotPink)
                Text("Your memory,\nbeautifully kept.")
                    .font(.system(.largeTitle, weight: .bold))
                    .fixedSize(horizontal: false, vertical: true)
                Text("Save anything you read. Ask questions across everything you know. Owned by you, not a platform.")
                    .font(.body)
                    .foregroundStyle(KinicDesign.bodyGray)
                    .fixedSize(horizontal: false, vertical: true)
            }

            VStack(alignment: .leading, spacing: 18) {
                feature("square.and.arrow.down", "Capture from anywhere", "Share a link from Safari and it becomes a page.")
                feature("sparkles", "Ask, with receipts", "Answers cite the exact notes they came from.")
                feature("lock.shield", "Yours on the Internet Computer", "Your wiki lives in databases you control.")
            }

            VStack(spacing: 12) {
                Button(action: model.startSignIn) {
                    HStack(spacing: 10) {
                        if model.isSigningIn {
                            ProgressView().tint(KinicDesign.primaryButtonForeground)
                        } else {
                            Image(systemName: "person.badge.key.fill")
                        }
                        Text("Sign in with Internet Identity")
                    }
                    .font(.headline)
                    .foregroundStyle(KinicDesign.primaryButtonForeground)
                    .frame(maxWidth: .infinity, minHeight: 56)
                    .background(KinicDesign.primaryButtonBackground, in: Capsule())
                }
                .buttonStyle(KinicPressableStyle(scale: 0.97))
                .disabled(model.isSigningIn)
                .accessibilityLabel("Sign in with Internet Identity")
                .sensoryFeedback(.impact(weight: .medium), trigger: model.isSigningIn) { _, new in new }

                if let message = model.statusMessage, !model.isSigningIn {
                    Text(message)
                        .font(.footnote)
                        .foregroundStyle(KinicDesign.bodyGray)
                        .frame(maxWidth: .infinity)
                        .multilineTextAlignment(.center)
                }
            }
        }
        .frame(maxWidth: 560, alignment: .leading)
        .opacity(appeared ? 1 : 0)
        .offset(y: appeared || reduceMotion ? 0 : 16)
        .onAppear {
            withAnimation(reduceMotion ? .easeOut(duration: 0.2) : .spring(response: 0.7, dampingFraction: 0.85).delay(0.05)) {
                appeared = true
            }
        }
    }

    private func feature(_ symbol: String, _ title: String, _ detail: String) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: symbol)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(KinicDesign.hotPink)
                .frame(width: 40, height: 40)
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.weight(.semibold))
                Text(detail).font(.subheadline).foregroundStyle(KinicDesign.bodyGray)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

#Preview {
    SessionPanel(model: .preview())
        .padding()
}
