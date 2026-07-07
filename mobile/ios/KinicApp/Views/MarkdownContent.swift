// Where: mobile/ios/KinicApp/Views/MarkdownContent.swift
// What: Dependency-free Markdown preview renderer.
// Why: Native wiki browsing needs readable Markdown structure without adding a renderer package.

import SwiftUI

struct MarkdownContent: View {
    let markdown: String
    private let blocks: [MarkdownBlock]

    init(markdown: String) {
        self.markdown = markdown
        blocks = MarkdownBlockParser().parse(markdown)
    }

    var body: some View {
        LazyVStack(alignment: .leading, spacing: 12) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                MarkdownBlockView(block: block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
