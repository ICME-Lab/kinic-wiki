// Where: mobile/ios/KinicTests/DatabaseSummaryPresentationTests.swift
// What: Database selection copy regression tests.
// Why: Share Extension rows must distinguish databases with the same title and role.

import Testing
@testable import Kinic

struct DatabaseSummaryPresentationTests {
    @Test
    func shareSelectionDetailContainsRoleAndShortDatabaseId() {
        let database = DatabaseSummary(
            databaseId: "db_internal_identifier",
            title: "Personal Memory",
            description: "",
            metadata: nil,
            role: .owner,
            status: .active,
            logicalSizeBytes: 0,
            cyclesBalance: nil,
            cyclesSuspendedAtMs: nil,
            deletedAtMs: nil
        )

        #expect(database.shareSelectionTitleText == "Personal Memory")
        #expect(database.shareSelectionDetailText == "Owner · db_inter…tifier")
        #expect(!database.shareSelectionTitleText.contains(database.databaseId))
        #expect(!database.shareSelectionDetailText.contains(database.databaseId))
    }

    @Test
    func shareSelectionNeverFallsBackToDatabaseId() {
        let database = DatabaseSummary(
            databaseId: "db_internal_identifier",
            title: "  ",
            description: "",
            metadata: nil,
            role: .writer,
            status: .active,
            logicalSizeBytes: 0,
            cyclesBalance: nil,
            cyclesSuspendedAtMs: nil,
            deletedAtMs: nil
        )

        #expect(database.shareSelectionTitleText == "Untitled database")
        #expect(database.shareSelectionDetailText == "Writer · db_inter…tifier")
    }

    @Test
    func shareSelectionDetailKeepsShortDatabaseIdIntact() {
        let database = DatabaseSummary(
            databaseId: "db_short",
            title: "Personal Memory",
            description: "",
            metadata: nil,
            role: .reader,
            status: .active,
            logicalSizeBytes: 0,
            cyclesBalance: nil,
            cyclesSuspendedAtMs: nil,
            deletedAtMs: nil
        )

        #expect(database.shareSelectionDetailText == "Reader · db_short")
    }
}
