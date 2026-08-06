// Where: mobile/ios/KinicApp/Views/MarkdownContent.swift
// What: Markdown preview renderer backed by Textual.
// Why: Wiki documents need real GitHub-flavored Markdown support without maintaining a custom parser.

import SwiftUI
import Textual

struct MarkdownContent: View {
    let markdown: String

    init(markdown: String) {
        self.markdown = markdown
    }

    var body: some View {
        StructuredText(markdown: markdown)
            .textual.structuredTextStyle(.gitHub)
            .textual.overflowMode(.wrap)
            .textual.textSelection(.enabled)
            .foregroundStyle(.black)
            .environment(\.colorScheme, .light)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}
