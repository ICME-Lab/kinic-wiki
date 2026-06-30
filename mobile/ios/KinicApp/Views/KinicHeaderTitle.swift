// Where: mobile/ios/KinicApp/Views/KinicHeaderTitle.swift
// What: Compact Kinic brand title for the navigation bar.
// Why: The header should carry the app icon and name instead of repeating the name in the page body.

import SwiftUI

struct KinicHeaderTitle: View {
    var body: some View {
        Label {
            Text("KinicWiki")
                .font(.headline)
                .bold()
                .foregroundStyle(.black)
        } icon: {
            Image("KinicMark")
                .resizable()
                .scaledToFit()
                .frame(width: 24, height: 24)
                .accessibilityHidden(true)
        }
        .labelStyle(.titleAndIcon)
        .accessibilityLabel("KinicWiki")
    }
}

#Preview {
    NavigationStack {
        Color.white
            .toolbar {
                ToolbarItem(placement: .principal) {
                    KinicHeaderTitle()
                }
            }
    }
}
