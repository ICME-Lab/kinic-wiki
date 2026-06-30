// Where: mobile/ios/KinicApp/Views/PendingURLRow.swift
// What: Row for a URL captured by the Share Extension.
// Why: Users need to verify the browser URL before native submission.

import SwiftUI

struct PendingURLRow: View {
    let item: PendingSharedURL

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(item.url.absoluteString)
                .font(.body)
                .foregroundStyle(.black)
                .lineLimit(3)
            Text(item.receivedAt, format: .dateTime)
                .font(.footnote)
                .foregroundStyle(KinicDesign.bodyGray)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.white)
        .clipShape(RoundedRectangle(cornerRadius: KinicDesign.radius))
        .overlay {
            RoundedRectangle(cornerRadius: KinicDesign.radius)
                .stroke(KinicDesign.hairlineGray)
        }
        .accessibilityElement(children: .combine)
    }
}

#Preview {
    PendingURLRow(item: PendingSharedURL(url: URL(string: "https://example.com/article")!, receivedAt: .now))
}
