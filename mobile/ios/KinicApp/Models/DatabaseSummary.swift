// Where: mobile/ios/KinicApp/Models/DatabaseSummary.swift
// What: Compact database summary for native capture target selection.
// Why: The iOS UI does not need the full browser-side database model.

import Foundation

struct DatabaseSummary: Identifiable, Equatable, Sendable {
    let databaseId: String
    let title: String
    let description: String
    let role: DatabaseRole
    let status: DatabaseStatus

    var id: String {
        databaseId
    }

    var canWrite: Bool {
        status == .active && role.canWrite
    }

    var displayTitle: String {
        title.isEmpty ? databaseId : title
    }
}
