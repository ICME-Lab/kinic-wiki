// Where: mobile/ios/KinicApp/Views/BrowseDocumentMode.swift
// What: Document rendering modes.
// Why: Detail view needs a small explicit state for preview versus raw Markdown.

import Foundation

enum BrowseDocumentMode: String, CaseIterable, Identifiable {
    case preview = "Preview"
    case raw = "Raw"
    case edit = "Edit"

    var id: String {
        rawValue
    }

    static func modeForPathChange(hasMatchingEditSession: Bool) -> BrowseDocumentMode {
        hasMatchingEditSession ? .edit : .preview
    }

    func modeAfterEditSessionRemoval() -> BrowseDocumentMode {
        self == .edit ? .preview : self
    }
}
