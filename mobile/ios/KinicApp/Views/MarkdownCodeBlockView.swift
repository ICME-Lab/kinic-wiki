// Where: mobile/ios/KinicApp/Views/MarkdownCodeBlockView.swift
// What: Native code block renderer for Markdown previews.
// Why: Wiki notes often contain commands and snippets that need fixed-width, horizontally scrollable display.

import SwiftUI

struct MarkdownCodeBlockView: View {
    let language: String?
    let code: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let language {
                Text(language)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }

            ScrollView(.horizontal) {
                Text(code)
                    .font(.system(.callout, design: .monospaced))
                    .foregroundStyle(.primary)
                    .textSelection(.enabled)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(.black.opacity(0.04))
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        }
    }
}
