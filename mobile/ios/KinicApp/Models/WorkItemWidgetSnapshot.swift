// Where: mobile/ios/KinicApp/Models/WorkItemWidgetSnapshot.swift
// What: Versioned App Group snapshot that the work item widget renders.
// Why: The widget shows shared items without reading SQLite, the canister, or the Keychain.

import Foundation

enum WorkItemWidgetItemState: String, Codable, Equatable, Sendable {
    case open
    case closed
}

/// A derived cache of the shared item list. Written only by the app process.
struct WorkItemWidgetSnapshot: Codable, Equatable, Sendable {
    static let currentVersion = 1
    static let maximumDatabases = 20
    static let maximumItemsPerDatabase = 5

    struct Database: Codable, Equatable, Sendable {
        var id: String
        var title: String
        var canWrite: Bool
        var isAvailable: Bool
        var updatedAt: Int64
        var items: [Item]

        /// The widget only ever lists open items, newest first.
        func openItems(limit: Int) -> [Item] {
            items
                .filter { $0.state == .open }
                .sorted { left, right in
                    if left.updatedAt != right.updatedAt { return left.updatedAt > right.updatedAt }
                    return left.id < right.id
                }
                .prefix(limit)
                .map { $0 }
        }
    }

    struct Item: Codable, Equatable, Sendable {
        var id: String
        var title: String
        var state: WorkItemWidgetItemState
        var commentCount: Int
        var updatedAt: Int64
    }

    var version: Int
    var writtenAt: Int64
    var principal: String
    var selectedDatabaseId: String?
    var databases: [Database]

    static func empty(principal: String, writtenAt: Int64) -> WorkItemWidgetSnapshot {
        WorkItemWidgetSnapshot(
            version: currentVersion,
            writtenAt: writtenAt,
            principal: principal,
            selectedDatabaseId: nil,
            databases: []
        )
    }

    func database(id: String?) -> Database? {
        guard let id, !id.isEmpty else { return nil }
        return databases.first { $0.id == id }
    }

    /// Bounds what the widget can read. A snapshot with an unknown version is never used.
    func sanitized() -> WorkItemWidgetSnapshot {
        var copy = self
        copy.databases = databases.prefix(Self.maximumDatabases).map { database in
            var database = database
            database.items = database.items
                .sorted { left, right in
                    if left.updatedAt != right.updatedAt { return left.updatedAt > right.updatedAt }
                    return left.id < right.id
                }
                .prefix(Self.maximumItemsPerDatabase)
                .map { $0 }
            return database
        }
        return copy
    }
}
