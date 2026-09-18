// Where: mobile/ios/KinicApp/Services/WorkItemWidgetProjection.swift
// What: App-side half of the widget contract: who writes and how list rows are projected.
// Why: The widget must never learn about canister types, so the app owns the mapping.

import Foundation

/// Implemented by `AppModel`; injected into `WorkItemModel` so tests can observe writes.
@MainActor
protocol WorkItemWidgetSnapshotWriting: AnyObject {
    func workItemListDidLoad(databaseId: String, entries: [WorkItemListEntry], fetchedAt: Int64)
    func workItemListDidFail(databaseId: String)
}

enum WorkItemWidgetProjection {
    static func items(from entries: [WorkItemListEntry]) -> [WorkItemWidgetSnapshot.Item] {
        entries.map { entry in
            WorkItemWidgetSnapshot.Item(
                id: entry.id,
                title: entry.title,
                state: entry.state == .closed ? .closed : .open,
                commentCount: entry.commentCount,
                updatedAt: entry.updatedAt
            )
        }
    }

    /// Rebuilds the database list from the databases this account can still read.
    /// Items already written for a database are preserved; a database that disappeared
    /// from the list is dropped, which is what makes the widget stop showing it.
    static func databases(
        readable: [DatabaseSummary],
        previous: [WorkItemWidgetSnapshot.Database],
        now: Int64
    ) -> [WorkItemWidgetSnapshot.Database] {
        readable.map { summary in
            let existing = previous.first { $0.id == summary.databaseId }
            return WorkItemWidgetSnapshot.Database(
                id: summary.databaseId,
                title: summary.displayTitle,
                canWrite: summary.canWrite,
                isAvailable: summary.status != .deleted,
                updatedAt: existing?.updatedAt ?? now,
                items: existing?.items ?? []
            )
        }
    }
}
