// Where: mobile/ios/KinicApp/Views/KinicPrimaryButtonStyle.swift
// What: Primary Kinic CTA button style.
// Why: Black CTA with Hot Pink pressed state matches the public Kinic product UI.

import SwiftUI

struct KinicPrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .foregroundStyle(KinicDesign.primaryButtonForeground)
            .frame(maxWidth: .infinity, minHeight: 52)
            .padding(.horizontal, 18)
            .background(configuration.isPressed ? KinicDesign.hotPink : KinicDesign.primaryButtonBackground)
            .clipShape(RoundedRectangle(cornerRadius: KinicDesign.radius))
            .offset(y: configuration.isPressed ? 1 : 0)
    }
}
