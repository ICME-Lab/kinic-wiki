// Where: mobile/ios/KinicTests/BrowseDocumentMutationCoordinatorTests.swift
// What: Regression tests for browse document mutation ownership.
// Why: Stale completions must not clear or apply over a newer operation.

import Testing
@testable import Kinic

struct BrowseDocumentMutationCoordinatorTests {
    @Test
    func staleCompletionDoesNotClearNewMutation() throws {
        var coordinator = BrowseDocumentMutationCoordinator()
        let staleCandidate = coordinator.begin(
            mutation: .publish,
            databaseId: "db_1",
            path: "/Knowledge/Page.md"
        )
        let stale = try #require(staleCandidate)

        coordinator.invalidate()
        let currentCandidate = coordinator.begin(
            mutation: .delete,
            databaseId: "db_2",
            path: "/Knowledge/Current.md"
        )
        let current = try #require(currentCandidate)
        coordinator.finish(stale)

        #expect(coordinator.activeContext == current)
        #expect(coordinator.mutation == .delete)
    }

    @Test
    func staleContextDoesNotOwnNewRequestForSameDocument() throws {
        var coordinator = BrowseDocumentMutationCoordinator()
        let staleCandidate = coordinator.begin(
            mutation: .publish,
            databaseId: "db_1",
            path: "/Knowledge/Page.md"
        )
        let stale = try #require(staleCandidate)

        coordinator.invalidate()
        let currentCandidate = coordinator.begin(
            mutation: .unpublish,
            databaseId: stale.databaseId,
            path: stale.path
        )
        let current = try #require(currentCandidate)

        #expect(!coordinator.owns(stale))
        #expect(coordinator.owns(current))
    }

    @Test
    func rejectsConcurrentMutationAndOnlyOwnerCanFinish() throws {
        var coordinator = BrowseDocumentMutationCoordinator()
        let currentCandidate = coordinator.begin(
            mutation: .save,
            databaseId: "db_1",
            path: "/Knowledge/Page.md"
        )
        let current = try #require(currentCandidate)
        let rejectedSave = coordinator.begin(
            mutation: .save,
            databaseId: "db_1",
            path: "/Knowledge/Page.md"
        )
        let rejectedPublish = coordinator.begin(
            mutation: .publish,
            databaseId: "db_1",
            path: "/Knowledge/Page.md"
        )
        let rejectedDelete = coordinator.begin(
            mutation: .delete,
            databaseId: "db_1",
            path: "/Knowledge/Page.md"
        )

        #expect(rejectedSave == nil)
        #expect(rejectedPublish == nil)
        #expect(rejectedDelete == nil)
        #expect(coordinator.owns(current))

        coordinator.finish(current)
        #expect(coordinator.activeContext == nil)
        #expect(coordinator.mutation == nil)
    }
}
