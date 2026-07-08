// Where: mobile/ios/KinicApp/Views/KinicPanel.swift
// What: Shared panel container for Kinic app sections.
// Why: Brand hierarchy is expressed with white/panel-gray surfaces, not heavy shadows.

import SwiftUI

struct KinicPanel<Content: View, Trailing: View>: View {
    let title: String
    let systemImage: String
    let trailing: Trailing
    let content: Content

    init(title: String, systemImage: String, @ViewBuilder content: () -> Content) where Trailing == EmptyView {
        self.title = title
        self.systemImage = systemImage
        trailing = EmptyView()
        self.content = content()
    }

    init(
        title: String,
        systemImage: String,
        @ViewBuilder trailing: () -> Trailing,
        @ViewBuilder content: () -> Content
    ) {
        self.title = title
        self.systemImage = systemImage
        self.trailing = trailing()
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .center, spacing: 12) {
                Label(title, systemImage: systemImage)
                    .font(.headline)
                    .foregroundStyle(.primary)

                Spacer(minLength: 0)

                trailing
            }

            content
        }
        .padding(KinicDesign.panelPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(KinicDesign.panelBackground)
        .clipShape(RoundedRectangle(cornerRadius: KinicDesign.largeRadius))
    }
}
