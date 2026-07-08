// Where: mobile/ios/KinicApp/Views/KinicSecondaryButtonStyle.swift
// What: Secondary Kinic action button style.
// Why: White bordered actions keep the surface light while preserving clear tap targets.

import SwiftUI

struct KinicSecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .foregroundStyle(configuration.isPressed ? .white : .primary)
            .frame(maxWidth: .infinity, minHeight: 50)
            .padding(.horizontal, 18)
            .background(configuration.isPressed ? KinicDesign.hotPink : KinicDesign.controlBackground)
            .clipShape(RoundedRectangle(cornerRadius: KinicDesign.radius))
            .overlay {
                RoundedRectangle(cornerRadius: KinicDesign.radius)
                    .stroke(configuration.isPressed ? KinicDesign.hotPink : .primary.opacity(0.12), lineWidth: 0.5)
            }
    }
}

struct KinicIconButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    enum Tone {
        case primary
        case secondary
    }

    let tone: Tone

    init(_ tone: Tone = .secondary) {
        self.tone = tone
    }

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .foregroundStyle(foreground)
            .frame(width: 44, height: 44)
            .background(background(configuration: configuration))
            .clipShape(RoundedRectangle(cornerRadius: 14))
            .overlay {
                RoundedRectangle(cornerRadius: 14)
                    .stroke(border(configuration: configuration), lineWidth: 0.5)
            }
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
    }

    private var foreground: Color {
        guard isEnabled else {
            return KinicDesign.bodyGray
        }

        switch tone {
        case .primary:
            return KinicDesign.primaryButtonForeground
        case .secondary:
            return KinicDesign.hotPink
        }
    }

    private func background(configuration: Configuration) -> Color {
        guard isEnabled else {
            return KinicDesign.controlBackground.opacity(0.55)
        }

        switch tone {
        case .primary:
            return configuration.isPressed ? KinicDesign.hotPink : KinicDesign.primaryButtonBackground
        case .secondary:
            return configuration.isPressed ? KinicDesign.hotPink.opacity(0.16) : KinicDesign.controlBackground
        }
    }

    private func border(configuration: Configuration) -> Color {
        if configuration.isPressed {
            return KinicDesign.hotPink.opacity(0.35)
        }

        return .primary.opacity(isEnabled ? 0.10 : 0.06)
    }
}
