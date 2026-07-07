// Where: mobile/ios/KinicApp/Views/MarkdownBlock.swift
// What: Small Markdown block model for the native wiki reader.
// Why: SwiftUI needs structured blocks to make headings, lists, quotes, and code readable without a third-party renderer.

import Foundation

enum MarkdownBlock: Equatable {
    case heading(level: Int, text: String)
    case paragraph(String)
    case bulletList([String])
    case numberedList([String])
    case codeBlock(language: String?, code: String)
    case quote(String)
    case divider
}
