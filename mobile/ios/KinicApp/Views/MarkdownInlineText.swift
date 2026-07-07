// Where: mobile/ios/KinicApp/Views/MarkdownInlineText.swift
// What: Inline Markdown text renderer backed by Foundation AttributedString.
// Why: Block parsing stays local while emphasis, links, and inline code use Apple's Markdown parser.

import SwiftUI

struct MarkdownInlineText: View {
    let markdown: String
    let font: Font

    var body: some View {
        if let attributed = try? AttributedString(markdown: markdown) {
            Text(attributed)
                .font(font)
                .foregroundStyle(.primary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            Text(markdown)
                .font(font)
                .foregroundStyle(.primary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
