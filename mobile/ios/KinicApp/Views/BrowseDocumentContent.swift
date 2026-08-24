// Where: mobile/ios/KinicApp/Views/BrowseDocumentContent.swift
// What: Markdown preview/raw renderer for a VFS document.
// Why: The app avoids new Markdown dependencies while keeping source inspection available.

import SwiftUI

struct BrowseDocumentContent: View {
    let node: VFSNode
    let mode: BrowseDocumentMode

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label(node.path, systemImage: node.kind.systemImage)
                .font(.headline)
                .foregroundStyle(.primary)
                .lineLimit(3)

            if mode == .raw {
                Text(node.content)
                    .font(.system(.footnote, design: .monospaced))
                    .foregroundStyle(.primary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else if mode == .preview {
                MarkdownContent(markdown: node.content)
            }
        }
    }
}
