// Where: mobile/ios/KinicTests/PendingDatabaseActivationTests.swift
// What: Pending database funding presentation regression tests.
// Why: Reserved databases must link to web funding without becoming capture targets early.

import Foundation
import Testing
@testable import Kinic

struct PendingDatabaseActivationTests {
    @Test
    func fundingURLTargetsPendingDatabase() throws {
        let url = AppConfiguration.preview.databaseFundingURL(databaseId: "db needs/funding")
        let components = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false))

        #expect(components.scheme == "https")
        #expect(components.host == "wiki.kinic.xyz")
        #expect(components.path == "/cycles")
        #expect(components.queryItems == [
            URLQueryItem(name: "database_id", value: "db needs/funding"),
            URLQueryItem(name: "status", value: "pending")
        ])
    }

    @Test
    func pendingCreateProducesFundingPresentation() throws {
        let created = CreatedDatabase(
            databaseId: "db_pending",
            name: "Research",
            status: .pending,
            initialFreeGrantApplied: false
        )

        let activation = try #require(AppModel.pendingActivation(for: created, configuration: .preview))

        #expect(activation.databaseId == "db_pending")
        #expect(activation.databaseName == "Research")
        #expect(activation.fundingURL.absoluteString == "https://wiki.kinic.xyz/cycles?database_id=db_pending&status=pending")
    }

    @Test
    func activeOrGrantedCreateDoesNotProduceFundingPresentation() {
        let active = CreatedDatabase(
            databaseId: "db_active",
            name: "Active",
            status: .active,
            initialFreeGrantApplied: false
        )
        let granted = CreatedDatabase(
            databaseId: "db_granted",
            name: "Granted",
            status: .pending,
            initialFreeGrantApplied: true
        )

        #expect(AppModel.pendingActivation(for: active, configuration: .preview) == nil)
        #expect(AppModel.pendingActivation(for: granted, configuration: .preview) == nil)
    }

    @MainActor
    @Test
    func pendingWritableDatabaseIsShownButNotCaptureReady() {
        let model = AppModel.preview()
        let active = database(databaseId: "db_active", status: .active)
        let pending = database(databaseId: "db_pending", status: .pending)
        model.readableDatabases = [active, pending]
        model.memberBrowseDatabaseIds = [active.databaseId, pending.databaseId]
        model.databases = [active]

        #expect(model.captureDatabaseCandidates.map(\.databaseId) == ["db_active", "db_pending"])
        #expect(model.databases.map(\.databaseId) == ["db_active"])
        #expect(active.canWrite)
        #expect(!pending.canWrite)

        model.presentFunding(for: pending)
        #expect(model.pendingDatabaseActivation?.databaseId == "db_pending")
        #expect(model.pendingDatabaseActivation?.databaseName == "Pending")

        model.pendingDatabaseActivation = nil
        model.presentFunding(for: active)
        #expect(model.pendingDatabaseActivation == nil)
    }

    @Test
    func pendingRowCopyExplainsStatusAndFundingAction() {
        let pending = database(databaseId: "db_pending", status: .pending, title: "Research")

        #expect(DatabasePanel.databaseAccessibilityLabel(
            pending,
            isPublicReadable: false,
            isPurchased: false
        ) == "Research, Owner, Pending")
        #expect(DatabasePanel.databaseAccessibilityValue(pending, isSelected: false) == "Pending activation")
        #expect(DatabasePanel.databaseAccessibilityHint(pending) == "Opens the web funding options")
        #expect(pending.status.displayName == "Pending")
    }
}

private func database(databaseId: String, status: DatabaseStatus, title: String? = nil) -> DatabaseSummary {
    DatabaseSummary(
        databaseId: databaseId,
        title: title ?? status.displayName,
        description: "",
        metadata: nil,
        role: .owner,
        status: status,
        logicalSizeBytes: 0,
        cyclesBalance: status == .active ? 1_000 : 0,
        cyclesSuspendedAtMs: nil,
        deletedAtMs: nil
    )
}
