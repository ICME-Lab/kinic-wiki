// Where: mobile/ios/KinicApp/Views/KinicPinkLines.swift
// What: Three-line pink accent used by Kinic cards.
// Why: The public design repeats layered pink horizontal lines as a compact brand marker.

import SwiftUI

struct KinicPinkLines: View {
    var body: some View {
        VStack(spacing: 3) {
            Capsule().fill(KinicDesign.hotPink)
            Capsule().fill(KinicDesign.palePink)
            Capsule().fill(KinicDesign.hotPink.opacity(0.18))
        }
        .frame(height: 15)
        .accessibilityHidden(true)
    }
}
