// Where: mobile/ios/KinicApp/Views/BrowseDocumentMode.swift
// What: Document rendering modes.
// Why: Detail view needs a small explicit state for preview versus raw Markdown.

import Foundation

enum BrowseDocumentMode: String, CaseIterable, Identifiable {
    case preview = "Preview"
    case raw = "Raw"

    var id: String {
        rawValue
    }
}
