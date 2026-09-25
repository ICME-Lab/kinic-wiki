// Where: mobile/ios/KinicTests/WorkItemWidgetSnapshotTests.swift
// What: Snapshot contract tests for the work items widget.
// Why: The widget reads only this file, so its bounds and version handling must be exact.

import Foundation
import Testing
@testable import Kinic

struct WorkItemWidgetSnapshotTests {
    private func makeDirectory() -> URL {
        FileManager.default.temporaryDirectory.appending(path: "work-items-widget-\(UUID().uuidString)")
    }

    private func item(_ id: String, state: WorkItemWidgetItemState = .open, updatedAt: Int64 = 1) -> WorkItemWidgetSnapshot.Item {
        WorkItemWidgetSnapshot.Item(id: id, title: id, state: state, commentCount: 0, updatedAt: updatedAt)
    }

    private func summary(
        _ databaseId: String,
        title: String = "Database",
        role: DatabaseRole = .owner,
        status: DatabaseStatus = .active
    ) -> DatabaseSummary {
        DatabaseSummary(
            databaseId: databaseId,
            title: title,
            description: "",
            metadata: nil,
            role: role,
            status: status,
            logicalSizeBytes: 0,
            cyclesBalance: nil,
            cyclesSuspendedAtMs: nil,
            deletedAtMs: nil
        )
    }

    private func snapshot(items: [WorkItemWidgetSnapshot.Item] = []) -> WorkItemWidgetSnapshot {
        WorkItemWidgetSnapshot(
            version: WorkItemWidgetSnapshot.currentVersion,
            writtenAt: 10,
            principal: "2vxsx-fae",
            selectedDatabaseId: "db-1",
            databases: [
                WorkItemWidgetSnapshot.Database(
                    id: "db-1",
                    title: "Team Wiki",
                    canWrite: true,
                    isAvailable: true,
                    updatedAt: 10,
                    items: items
                )
            ]
        )
    }

    @Test
    func roundTripsThroughTheSnapshotFile() throws {
        let directory = makeDirectory()
        let store = WorkItemWidgetSnapshotStore(directory: directory)

        try store.write(snapshot(items: [item("a")]))

        let read = try #require(store.read())
        #expect(read.principal == "2vxsx-fae")
        #expect(read.selectedDatabaseId == "db-1")
        #expect(read.database(id: "db-1")?.items.map(\.id) == ["a"])
        store.clear()
        #expect(store.read() == nil)
    }

    @Test
    func ignoresASnapshotVersionThisBuildDoesNotUnderstand() throws {
        let directory = makeDirectory()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var future = snapshot()
        future.version = WorkItemWidgetSnapshot.currentVersion + 1
        let data = try JSONEncoder().encode(future)
        try data.write(to: directory.appending(path: WorkItemWidgetSnapshotStore.fileName))

        #expect(WorkItemWidgetSnapshotStore(directory: directory).read() == nil)
    }

    @Test
    func capsAndOrdersTheItemsItWrites() throws {
        let directory = makeDirectory()
        let store = WorkItemWidgetSnapshotStore(directory: directory)
        let items = (1...7).map { item("item-\($0)", updatedAt: Int64($0)) }

        try store.write(snapshot(items: items))

        let read = try #require(store.read())
        // Newest first, capped at five: the widget never needs more than it can render.
        #expect(read.database(id: "db-1")?.items.map(\.id) == ["item-7", "item-6", "item-5", "item-4", "item-3"])
    }

    @Test
    func recentClosedItemsDoNotDisplaceAnOlderOpenItem() throws {
        let store = WorkItemWidgetSnapshotStore(directory: makeDirectory())
        let items = [item("open", updatedAt: 1)] + (2...6).map {
            item("closed-\($0)", state: .closed, updatedAt: Int64($0))
        }
        try store.write(snapshot(items: items))
        #expect(store.read()?.database(id: "db-1")?.items.map(\.id) == ["open"])
    }

    @Test
    func openItemsAreFilteredSortedAndLimited() {
        let database = WorkItemWidgetSnapshot.Database(
            id: "db-1",
            title: "Team Wiki",
            canWrite: true,
            isAvailable: true,
            updatedAt: 10,
            items: [
                item("closed", state: .closed, updatedAt: 100),
                item("newer", updatedAt: 20),
                item("older", updatedAt: 5)
            ]
        )

        #expect(database.openItems(limit: 3).map(\.id) == ["newer", "older"])
        #expect(database.openItems(limit: 1).map(\.id) == ["newer"])
    }

    @Test
    func projectsReadableDatabasesAndKeepsTheirItems() {
        let previous = [
            WorkItemWidgetSnapshot.Database(
                id: "db-1",
                title: "Old title",
                canWrite: true,
                isAvailable: true,
                updatedAt: 5,
                items: [item("a")]
            ),
            WorkItemWidgetSnapshot.Database(
                id: "db-2",
                title: "Removed database",
                canWrite: true,
                isAvailable: true,
                updatedAt: 5,
                items: [item("b")]
            )
        ]

        let projected = WorkItemWidgetProjection.databases(
            readable: [summary("db-1", title: "New title", role: .reader)],
            previous: previous,
            now: 99
        )

        #expect(projected.count == 1)
        #expect(projected.first?.title == "New title")
        #expect(projected.first?.canWrite == false)
        #expect(projected.first?.items.map(\.id) == ["a"])
        #expect(WorkItemWidgetProjection.databases(
            readable: [summary("db-1", status: .deleted)], previous: previous, now: 99
        ).isEmpty)
    }

    @Test
    func projectionMapsTheListStateToTheSnapshotState() {
        let entries = [
            WorkItemListEntry(id: "1", title: "Open", state: .open, commentCount: 1, updatedAt: 5, isUnsupportedVersion: false),
            WorkItemListEntry(id: "2", title: "Closed", state: .closed, commentCount: 0, updatedAt: 6, isUnsupportedVersion: true)
        ]

        let items = WorkItemWidgetProjection.items(from: entries)

        #expect(items.map(\.state) == [.open, .closed])
        #expect(items.map(\.commentCount) == [1, 0])
    }

    @MainActor @Test
    func onlyExplicitCanisterAccessLossClearsWidgetTitles() {
        #expect(WorkItemModel.isDefinitiveAccessLoss(VFSCandidError.canisterRejected("principal has no access to database: db-1")))
        #expect(WorkItemModel.isDefinitiveAccessLoss(VFSCandidError.canisterRejected("database not found: db-1")))
        #expect(WorkItemModel.isDefinitiveAccessLoss(VFSCandidError.canisterRejected("database is deleted: db-1")))
        #expect(!WorkItemModel.isDefinitiveAccessLoss(URLError(.notConnectedToInternet)))
        #expect(!WorkItemModel.isDefinitiveAccessLoss(VFSCandidError.canisterRejected("path not found: /WorkItems")))
    }
}
