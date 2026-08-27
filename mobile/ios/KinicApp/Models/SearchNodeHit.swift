// Where: mobile/ios/KinicApp/Models/SearchNodeHit.swift
// What: Native search result row for a VFS node.
// Why: iOS browsing uses the canister search API directly instead of the web browser client.

import Foundation

struct SearchNodeHit: Identifiable, Equatable, Sendable {
    let path: String
    let kind: VFSNodeKind
    let snippet: String?
    let previewExcerpt: String?
    let matchReasons: [String]
    let score: Float

    var id: String {
        path
    }

    var displayPreview: String {
        if let previewExcerpt,
           !previewExcerpt.isEmpty {
            return previewExcerpt
        }
        if let snippet,
           !snippet.isEmpty,
           snippet != path {
            return snippet
        }
        return ""
    }

    var displayName: String {
        path.split(separator: "/").last.map(String.init) ?? path
    }

    var displayParentPath: String {
        let components = path.split(separator: "/").dropLast()
        return components.isEmpty ? "/" : "/\(components.joined(separator: "/"))"
    }

    var matchLocationLabel: String {
        var locations: [String] = []
        if matchReasons.contains(where: { $0.contains("path") }) {
            locations.append("Path")
        }
        if matchReasons.contains(where: { $0.contains("title") || $0.contains("basename") }) {
            locations.append("Title")
        }
        if matchReasons.contains(where: { $0.contains("content") }) {
            locations.append("Content")
        }
        return locations.joined(separator: " · ")
    }

    var accessibilityDescription: String {
        var parts = [kindAccessibilityName, displayName, "in \(displayParentPath)"]
        if !matchLocationLabel.isEmpty {
            parts.append("matched in \(matchLocationLabel)")
        }
        if !displayPreview.isEmpty {
            parts.append(displayPreview)
        }
        return parts.joined(separator: ", ")
    }

    private var kindAccessibilityName: String {
        switch kind {
        case .folder:
            "Folder"
        case .file:
            "Document"
        case .source:
            "Source"
        }
    }
}
