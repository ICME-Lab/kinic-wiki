// Where: mobile/ios/KinicApp/Views/MarkdownBlockView.swift
// What: Visual mapping from parsed Markdown blocks to SwiftUI.
// Why: Wiki notes need native typography instead of one raw-looking text run.

import SwiftUI

struct MarkdownBlockView: View {
    let block: MarkdownBlock

    var body: some View {
        switch block {
        case .heading(let level, let text):
            MarkdownInlineText(markdown: text, font: headingFont(level))
                .padding(.top, headingTopPadding(level))
        case .paragraph(let text):
            MarkdownInlineText(markdown: text, font: .body)
        case .bulletList(let items):
            MarkdownListView(items: items, isNumbered: false)
        case .numberedList(let items):
            MarkdownListView(items: items, isNumbered: true)
        case .codeBlock(let language, let code):
            MarkdownCodeBlockView(language: language, code: code)
        case .quote(let text):
            MarkdownQuoteBlockView(text: text)
        case .divider:
            Divider()
                .padding(.vertical, 6)
        }
    }

    private func headingFont(_ level: Int) -> Font {
        switch level {
        case 1:
            .title2.weight(.semibold)
        case 2:
            .title3.weight(.semibold)
        case 3:
            .headline
        default:
            .subheadline.weight(.semibold)
        }
    }

    private func headingTopPadding(_ level: Int) -> Double {
        level == 1 ? 8 : 4
    }
}
