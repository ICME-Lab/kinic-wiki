// Where: mobile/ios/KinicApp/Views/VFSNodeKind+Display.swift
// What: UI symbols for VFS node kinds.
// Why: Database browsing rows should use consistent system icons across list, search, and detail.

import Foundation

extension VFSNodeKind {
    var systemImage: String {
        switch self {
        case .folder:
            "folder"
        case .file:
            "doc.text"
        case .source:
            "link"
        }
    }
}
