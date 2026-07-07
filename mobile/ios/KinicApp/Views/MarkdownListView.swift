// Where: mobile/ios/KinicApp/Views/MarkdownListView.swift
// What: Native ordered and unordered Markdown list renderer.
// Why: List structure disappears when a whole document is rendered in one Text view.

import SwiftUI

struct MarkdownListView: View {
    let items: [String]
    let isNumbered: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(marker(for: index))
                        .font(.body.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .frame(width: isNumbered ? 28 : 14, alignment: .trailing)

                    MarkdownInlineText(markdown: item, font: .body)
                }
            }
        }
    }

    private func marker(for index: Int) -> String {
        isNumbered ? "\(index + 1)." : "-"
    }
}
