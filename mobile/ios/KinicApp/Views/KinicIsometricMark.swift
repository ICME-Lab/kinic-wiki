// Where: mobile/ios/KinicApp/Views/KinicIsometricMark.swift
// What: Small geometric status mark inspired by Kinic's isometric blocks.
// Why: It brings the website's 3D-block motif into native UI without adding animation dependencies.

import SwiftUI

struct KinicIsometricMark: View {
    let pendingCount: Int

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 18)
                .fill(KinicDesign.panelGray)

            RoundedRectangle(cornerRadius: 10)
                .fill(KinicDesign.palePink)
                .frame(width: 52, height: 52)
                .rotationEffect(.degrees(45))
                .offset(x: -8, y: 5)

            RoundedRectangle(cornerRadius: 8)
                .fill(KinicDesign.hotPink)
                .frame(width: 34, height: 34)
                .rotationEffect(.degrees(45))
                .offset(x: 16, y: -11)

            Text("\(pendingCount)")
                .font(.title3)
                .bold()
                .foregroundStyle(.white)
                .monospacedDigit()
                .offset(x: 16, y: -11)
        }
    }
}
