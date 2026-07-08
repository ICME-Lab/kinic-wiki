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
           !snippet.isEmpty {
            return snippet
        }
        return matchReasons.joined(separator: ", ")
    }
}
