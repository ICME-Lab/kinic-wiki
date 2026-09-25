// Where: mobile/ios/KinicApp/Models/WorkItemComposeRequest.swift
// What: A cross-surface request to open the composer with prefill and provenance.
// Why: Browse and Ask AI must hand their content to Home without owning its navigation.

import Foundation

struct WorkItemComposeRequest: Equatable, Sendable {
    /// Source documents can be longer than one item body should be.
    static let bodyCharacterLimit = 10_000

    let databaseId: String
    var title: String?
    var body: String
    var source: WorkItemSource?
    var isBodyTruncated = false

    static func truncatedBody(_ text: String) -> (body: String, isTruncated: Bool) {
        guard text.count > bodyCharacterLimit else { return (text, false) }
        return (String(text.prefix(bodyCharacterLimit)), true)
    }
}
