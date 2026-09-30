// Where: mobile/ios/KinicApp/Models/WorkItemPaths.swift
// What: Canonical VFS layout for work items.
// Why: Every reader and writer must agree on the document contract defined in plans/002.

import Foundation

enum WorkItemPaths {
    static let root = "/WorkItems"

    static func directory(_ id: String) -> String { "\(root)/\(id)" }
    static func item(_ id: String) -> String { "\(root)/\(id)/item.md" }
    static func listMetadata(_ id: String) -> String { "\(root)/\(id)/meta.md" }
    static func commentsDirectory(_ id: String) -> String { "\(root)/\(id)/comments" }
    static func comment(itemId: String, commentId: String) -> String {
        "\(commentsDirectory(itemId))/\(commentId).md"
    }

    /// Extracts the item UUID from any path below `/WorkItems/`.
    static func itemId(fromPath path: String) -> String? {
        guard path.hasPrefix("\(root)/") else { return nil }
        let remainder = path.dropFirst(root.count + 1)
        guard let candidate = remainder.split(separator: "/").first, !candidate.isEmpty else { return nil }
        return String(candidate)
    }

    static func isInsideWorkItems(_ path: String) -> Bool {
        path == root || path.hasPrefix("\(root)/")
    }
}
