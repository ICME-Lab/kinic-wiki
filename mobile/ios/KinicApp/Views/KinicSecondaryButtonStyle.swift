// Where: mobile/ios/KinicApp/Views/KinicSecondaryButtonStyle.swift
// What: Secondary Kinic action button style.
// Why: White bordered actions keep the surface light while preserving clear tap targets.

import SwiftUI

struct KinicSecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .foregroundStyle(configuration.isPressed ? .white : .black)
            .frame(maxWidth: .infinity, minHeight: 50)
            .padding(.horizontal, 18)
            .background(configuration.isPressed ? KinicDesign.hotPink : .white)
            .clipShape(RoundedRectangle(cornerRadius: KinicDesign.radius))
            .overlay {
                RoundedRectangle(cornerRadius: KinicDesign.radius)
                    .stroke(configuration.isPressed ? KinicDesign.hotPink : KinicDesign.hairlineGray)
            }
    }
}
