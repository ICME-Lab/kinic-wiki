// Where: mobile/ios/KinicApp/Views/KinicPanel.swift
// What: Shared panel container for Kinic app sections.
// Why: Brand hierarchy is expressed with white/panel-gray surfaces, not heavy shadows.

import SwiftUI

struct KinicPanel<Content: View>: View {
    let title: String
    let systemImage: String
    let content: Content

    init(title: String, systemImage: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.systemImage = systemImage
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label(title, systemImage: systemImage)
                .font(.headline)
                .foregroundStyle(.black)

            content
        }
        .padding(KinicDesign.panelPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(KinicDesign.panelGray)
        .clipShape(RoundedRectangle(cornerRadius: KinicDesign.largeRadius))
    }
}
