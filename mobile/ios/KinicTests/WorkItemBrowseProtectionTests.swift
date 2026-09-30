// Where: mobile/ios/KinicTests/WorkItemBrowseProtectionTests.swift
// What: Browse must not edit, publish, or delete work item documents.
// Why: Those files carry a metadata contract and are shared only with database members.

import Foundation
import Testing
@testable import Kinic

struct WorkItemBrowseProtectionTests {
    @MainActor
    @Test
    func workItemPathsAreRecognised() {
        #expect(AppModel.isWorkItemDocumentPath("/WorkItems"))
        #expect(AppModel.isWorkItemDocumentPath("/WorkItems/abc"))
        #expect(AppModel.isWorkItemDocumentPath("/WorkItems/abc/item.md"))
        #expect(AppModel.isWorkItemDocumentPath("/WorkItems/abc/meta.md"))
        #expect(AppModel.isWorkItemDocumentPath("/WorkItems/abc/comments/c1.md"))
        // A sibling path that only shares the prefix must not be treated as a work item.
        #expect(!AppModel.isWorkItemDocumentPath("/WorkItemsOld/abc.md"))
        #expect(!AppModel.isWorkItemDocumentPath("/Knowledge/Page.md"))
    }

    @MainActor
    @Test
    func browseRefusesToMutateWorkItemDocuments() throws {
        let fixture = try BrowseProtectionFixture()
        defer { fixture.cleanup() }
        let model = fixture.model

        configure(model, path: "/WorkItems/abc/item.md", kind: .file)

        #expect(!model.canEditBrowseDocument("/WorkItems/abc/item.md"))
        #expect(!model.canPublishBrowseDocument("/WorkItems/abc/item.md"))
        #expect(!model.canDeleteBrowseDocument("/WorkItems/abc/item.md"))
        #expect(!model.startEditingBrowseDocument("/WorkItems/abc/item.md"))

        // An ordinary page in the same Owner database is still fully editable.
        configure(model, path: "/Knowledge/Page.md", kind: .file)
        #expect(model.canEditBrowseDocument("/Knowledge/Page.md"))
        #expect(model.canPublishBrowseDocument("/Knowledge/Page.md"))
        #expect(model.canDeleteBrowseDocument("/Knowledge/Page.md"))
    }

    @MainActor
    @Test
    func browseOffersItemCreationOnlyForOrdinaryWikiPages() throws {
        let fixture = try BrowseProtectionFixture()
        defer { fixture.cleanup() }
        let model = fixture.model

        configure(model, path: "/Knowledge/Page.md", kind: .file)
        #expect(model.canCreateWorkItemFromBrowseDocument("/Knowledge/Page.md"))
        // A work item document is already part of the item contract, not a source for a new one.
        #expect(!model.canCreateWorkItemFromBrowseDocument("/WorkItems/abc/item.md"))
        // A folder is not a page.
        #expect(!model.canCreateWorkItemFromBrowseDocument("/Knowledge"))

        configure(model, path: "/Knowledge/Page.md", kind: .file, role: .reader)
        #expect(!model.canCreateWorkItemFromBrowseDocument("/Knowledge/Page.md"))
    }

    @MainActor
    private func configure(
        _ model: AppModel,
        path: String,
        kind: VFSNodeKind,
        role: DatabaseRole = .owner
    ) {
        model.selectedBrowseDatabaseId = "db_edit"
        model.readableDatabases = [
            DatabaseSummary(
                databaseId: "db_edit",
                title: "Edit DB",
                description: "",
                metadata: nil,
                role: role,
                status: .active,
                logicalSizeBytes: 0,
                cyclesBalance: nil,
                cyclesSuspendedAtMs: nil,
                deletedAtMs: nil
            )
        ]
        model.selectedBrowseNodePath = path
        model.documentNode = VFSNode(
            path: path,
            kind: kind,
            content: "old",
            metadataJson: "{\"kept\":true}",
            etag: "etag-old",
            createdAt: 50,
            updatedAt: 100
        )
    }
}

@MainActor
private final class BrowseProtectionFixture {
    let model: AppModel
    private let suiteName: String
    private let queueDirectory: URL

    init() throws {
        suiteName = "kinic.work-item-protection-tests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        queueDirectory = FileManager.default.temporaryDirectory
            .appending(path: "kinic-work-item-protection-tests")
            .appending(path: UUID().uuidString)
        model = AppModel(
            configuration: .preview,
            authService: makeTestAuthService(),
            client: try! KinicICClient(configuration: .preview),
            shareInbox: try ShareInbox(testQueueDirectory: queueDirectory),
            settingsStore: SharedDefaultsStore(defaults: defaults),
            initialSession: .testing()
        )
    }

    func cleanup() {
        UserDefaults(suiteName: suiteName)?.removePersistentDomain(forName: suiteName)
        try? FileManager.default.removeItem(at: queueDirectory)
    }
}
