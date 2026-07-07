// Where: mobile/ios/KinicApp/Views/MarkdownQuoteBlockView.swift
// What: Native blockquote renderer for Markdown previews.
// Why: Quoted evidence and notes need a clear visual boundary without changing source content.

import SwiftUI

struct MarkdownQuoteBlockView: View {
    let text: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Rectangle()
                .fill(KinicDesign.hotPink.opacity(0.7))
                .frame(width: 3)

            MarkdownInlineText(markdown: text, font: .body)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
    }
}
