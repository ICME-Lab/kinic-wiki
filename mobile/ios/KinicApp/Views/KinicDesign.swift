// Where: mobile/ios/KinicApp/Views/KinicDesign.swift
// What: Kinic brand tokens for the native app surface.
// Why: The iOS UI should follow the public Kinic design language consistently.

import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

enum KinicDesign {
    // Rich magenta for readable text on light surfaces; brighter pink on dark surfaces.
    #if canImport(UIKit)
    static let hotPink = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 1.0, green: 0.36, blue: 0.65, alpha: 1)
            : UIColor(red: 0.72, green: 0.078, blue: 0.349, alpha: 1)
    })
    // Guideline Body Gray #636161 on light surfaces; system secondary label keeps dark mode legible.
    static let bodyGray = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? .secondaryLabel
            : UIColor(red: 0.388, green: 0.38, blue: 0.38, alpha: 1)
    })
    static let supportGray = Color(uiColor: .secondaryLabel)
    static let hairlineGray = Color(uiColor: .separator)
    #else
    static let hotPink = Color(red: 0.72, green: 0.078, blue: 0.349)
    static let bodyGray = Color(red: 0.388, green: 0.38, blue: 0.38)
    static let supportGray = Color(red: 0.302, green: 0.302, blue: 0.302)
    static let hairlineGray = Color(red: 0.902, green: 0.902, blue: 0.902)
    #endif
    // White button text needs the darker tone in either appearance.
    static let actionPink = Color(red: 0.72, green: 0.078, blue: 0.349)
    static let palePink = Color(red: 1.0, green: 0.804, blue: 0.898)
    static let panelGray = Color(red: 0.973, green: 0.973, blue: 0.973)
    static let electricIndigo = Color(red: 0.2, green: 0.141, blue: 0.835)
    static let warmYellow = Color(red: 0.992, green: 0.71, blue: 0.165)
    static let radius: CGFloat = 16
    static let largeRadius: CGFloat = 20
    static let panelPadding: CGFloat = 20
    static let screenPadding: CGFloat = 16

    #if canImport(UIKit)
    static let appBackground = Color(uiColor: .systemBackground)
    static let panelBackground = Color(uiColor: .secondarySystemBackground)
    static let controlBackground = Color(uiColor: .systemBackground)
    static let primaryButtonBackground = Color(uiColor: .label)
    static let primaryButtonForeground = Color(uiColor: .systemBackground)
    // Guideline Soft Panel Gray #f8f8f8 for cards on a white page.
    static let cardBackground = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.11, green: 0.11, blue: 0.12, alpha: 1)
            : UIColor(red: 0.973, green: 0.973, blue: 0.973, alpha: 1)
    })

    static let uiHotPink = UIColor(red: 1.0, green: 0.149, blue: 0.525, alpha: 1.0)
    static let uiBodyGray = UIColor(red: 0.388, green: 0.38, blue: 0.38, alpha: 1.0)
    static let uiHairlineGray = UIColor(red: 0.902, green: 0.902, blue: 0.902, alpha: 1.0)
    #else
    static let appBackground = Color.white
    static let panelBackground = panelGray
    static let controlBackground = Color.white
    static let primaryButtonBackground = Color.black
    static let primaryButtonForeground = Color.white
    static let cardBackground = panelGray
    #endif

    // Guideline system colors.
    static let successGreen = Color(red: 0.020, green: 0.757, blue: 0.408)   // #05c168
    static let errorRed = Color(red: 0.863, green: 0.169, blue: 0.169)       // #dc2b2b
    static let vividPink = Color(red: 1.0, green: 0.149, blue: 0.525)        // #ff2686 Kinic Hot Pink

    // Signature brand gradient: Kinic pink only (deep pink into hot pink).
    // Kept slightly deeper than #ff2686 so white text on it stays at WCAG AA contrast.
    static let auroraGradient = LinearGradient(
        colors: [Color(red: 0.72, green: 0.078, blue: 0.349), Color(red: 0.88, green: 0.10, blue: 0.44)],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )
    static let cardRadius: CGFloat = 22
    static let spring = Animation.spring(response: 0.38, dampingFraction: 0.78)
}

// MARK: - Aurora

/// A slowly breathing mesh gradient built from the Kinic brand palette.
/// Pink tints live at the edges (guideline: gradients stay off the text area); the center stays near white.
struct KinicAurora: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var intensity: Double = 1

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion)) { context in
            let t = reduceMotion ? 0 : context.date.timeIntervalSinceReferenceDate
            MeshGradient(
                width: 3,
                height: 3,
                points: [
                    [0, 0], [0.5, 0], [1, 0],
                    [0, 0.5], [Float(0.5 + 0.16 * sin(t * 0.31)), Float(0.5 + 0.12 * cos(t * 0.27))], [1, 0.5],
                    [0, 1], [Float(0.5 + 0.12 * cos(t * 0.23)), 1], [1, 1]
                ],
                colors: palette(t)
            )
        }
        .opacity(intensity)
        .accessibilityHidden(true)
    }

    private func palette(_ t: Double) -> [Color] {
        let wave = (sin(t * 0.4) + 1) / 2
        if colorScheme == .dark {
            return [
                Color(red: 0.22 + 0.06 * wave, green: 0.02, blue: 0.10), Color(red: 0.14, green: 0.02, blue: 0.07), Color(red: 0.20, green: 0.07, blue: 0.04),
                Color(red: 0.08, green: 0.01, blue: 0.04), Color.black, Color(red: 0.06, green: 0.02, blue: 0.02),
                Color.black, Color.black, Color.black
            ]
        }
        return [
            Color(red: 1.00, green: 0.80 + 0.04 * wave, blue: 0.90), Color(red: 1.00, green: 0.91, blue: 0.95), Color(red: 1.00, green: 0.90, blue: 0.84),
            Color(red: 1.00, green: 0.94, blue: 0.97), Color.white, Color(red: 1.00, green: 0.96, blue: 0.94),
            Color.white, Color.white, Color.white
        ]
    }
}

/// The living Kinic mark: a glowing aurora sphere that breathes slowly.
struct KinicAuroraOrb: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var size: CGFloat = 96
    var isActive = false

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion)) { context in
            let t = reduceMotion ? 0 : context.date.timeIntervalSinceReferenceDate
            let speed = isActive ? 2.4 : 0.9
            let breath = 1 + 0.04 * sin(t * speed)
            ZStack {
                Circle()
                    .fill(KinicDesign.vividPink)
                    .blur(radius: size * 0.28)
                    .opacity(0.55)
                    .scaleEffect(breath * 1.08)
                Circle()
                    .fill(
                        AngularGradient(
                            colors: [
                                KinicDesign.vividPink,
                                Color(red: 1.0, green: 0.506, blue: 0.745),   // Vivid Pink Line #ff81be
                                Color(red: 1.0, green: 0.48, blue: 0.40),     // coral
                                Color(red: 1.0, green: 0.68, blue: 0.42),     // peach
                                KinicDesign.vividPink
                            ],
                            center: .center,
                            angle: .degrees(t * (isActive ? 90 : 18))
                        )
                    )
                    .overlay {
                        Circle().fill(
                            RadialGradient(colors: [.white.opacity(0.85), .white.opacity(0)], center: UnitPoint(x: 0.32, y: 0.28), startRadius: 0, endRadius: size * 0.55)
                        )
                    }
                    .overlay { Circle().strokeBorder(.white.opacity(0.5), lineWidth: 1) }
                    .scaleEffect(breath)
            }
            .frame(width: size, height: size)
        }
        .accessibilityHidden(true)
    }
}

// MARK: - Surfaces & motion

extension View {
    /// Flat Soft Panel Gray card: hierarchy comes from surface color and radius, not shadows (guideline).
    func kinicCard(radius: CGFloat = KinicDesign.cardRadius) -> some View {
        modifier(KinicCardModifier(radius: radius))
    }
}

private struct KinicCardModifier: ViewModifier {
    @Environment(\.colorScheme) private var colorScheme
    let radius: CGFloat

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        content
            .background {
                shape.fill(KinicDesign.cardBackground)
            }
            .overlay {
                if colorScheme == .dark { shape.strokeBorder(.white.opacity(0.08), lineWidth: 0.5) }
            }
    }
}

extension View {
    /// A light sweep across text while work is in progress (Apple Intelligence style).
    func kinicShimmer() -> some View { modifier(KinicShimmerModifier()) }
}

private struct KinicShimmerModifier: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        if reduceMotion {
            content
        } else {
            content
                .overlay {
                    TimelineView(.animation) { context in
                        let phase = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.8) / 1.8
                        GeometryReader { geometry in
                            LinearGradient(
                                colors: [.clear, KinicDesign.hotPink.opacity(0.9), .clear],
                                startPoint: .leading,
                                endPoint: .trailing
                            )
                            .frame(width: geometry.size.width * 0.5)
                            .offset(x: (geometry.size.width * 1.5) * phase - geometry.size.width * 0.5)
                        }
                    }
                    .mask(content)
                    .allowsHitTesting(false)
                }
        }
    }
}

/// Springy press feedback shared by tiles and cards.
struct KinicPressableStyle: ButtonStyle {
    var scale: CGFloat = 0.96

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? scale : 1)
            .brightness(configuration.isPressed ? -0.03 : 0)
            .animation(KinicDesign.spring, value: configuration.isPressed)
    }
}

/// The app's canvas: Pure White (guideline), true black in dark mode.
struct KinicCanvas: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        (colorScheme == .dark ? Color.black : Color.white)
            .ignoresSafeArea()
    }
}
