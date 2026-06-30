// Where: mobile/ios/KinicApp/Views/KinicHeroView.swift
// What: Brand header for the native capture flow.
// Why: The public Kinic design uses logo, white space, pink accents, and light geometric blocks.

import SwiftUI

struct KinicHeroView: View {
    let pendingCount: Int
    let isSignedIn: Bool

    var body: some View {
        HStack(alignment: .center, spacing: 18) {
            VStack(alignment: .leading, spacing: 10) {
                Text("Share links into your writable Kinic Wiki database.")
                    .font(.body)
                    .foregroundStyle(KinicDesign.bodyGray)
                    .fixedSize(horizontal: false, vertical: true)

                Label(isSignedIn ? "Signed in" : "Sign in required", systemImage: isSignedIn ? "checkmark.circle.fill" : "person.crop.circle.badge.exclamationmark")
                    .font(.subheadline)
                    .foregroundStyle(isSignedIn ? KinicDesign.hotPink : KinicDesign.supportGray)
            }

            Spacer(minLength: 8)

            KinicIsometricMark(pendingCount: pendingCount)
                .frame(width: 92, height: 92)
                .accessibilityLabel("\(pendingCount) pending shared URLs")
        }
        .padding(20)
        .background(.white)
        .clipShape(RoundedRectangle(cornerRadius: KinicDesign.largeRadius))
        .overlay(alignment: .top) {
            KinicPinkLines()
                .padding(.horizontal, 28)
        }
    }
}
