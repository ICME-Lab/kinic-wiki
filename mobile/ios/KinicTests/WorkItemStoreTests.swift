// Where: mobile/ios/KinicTests/WorkItemStoreTests.swift
// What: Migration and round-trip tests for the App Group SQLite store.
// Why: Unsent input must survive relaunch, and the list cache must stay per account and database.

import Foundation
import Testing
@testable import Kinic

struct WorkItemStoreTests {
    private func makeStore() throws -> (store: WorkItemStore, path: String) {
        let path = FileManager.default.temporaryDirectory
            .appending(path: "work-items-\(UUID().uuidString).sqlite")
            .path
        return (try WorkItemStore(path: path), path)
    }

    private func capture(
        id: String = "capture-1",
        principal: String = "2vxsx-fae",
        databaseId: String? = "db-1",
        state: WorkItemCaptureState = .local
    ) -> WorkItemCaptureRecord {
        WorkItemCaptureRecord(
            captureId: id,
            principal: principal,
            databaseId: databaseId,
            origin: .share,
            rawText: "First line\nsecond line",
            provisionalTitle: "First line",
            transcript: nil,
            audioRelativePath: nil,
            audioDurationMs: nil,
            sourceRefs: [WorkItemSource(kind: .share, url: "https://example.com", path: nil, label: "Example")],
            state: state,
            baseEtag: nil,
            aiSuggestionJson: nil,
            createdAt: 10,
            updatedAt: 10,
            sentAt: nil
        )
    }

    @Test
    func migrationsApplyOnceAndReopenCleanly() throws {
        let (store, path) = try makeStore()
        try store.upsertCapture(capture())
        let reopened = try WorkItemStore(path: path)
        #expect(try reopened.captures(principal: "2vxsx-fae").count == 1)
        // The schema version row is written once; a second open must not re-run migration v1.
        #expect(try reopened.captures(principal: "2vxsx-fae").first?.captureId == "capture-1")
    }

    @Test
    func captureRoundTripsIncludingMissingDestination() throws {
        let (store, _) = try makeStore()
        var record = capture()
        record.databaseId = nil
        record.state = .rebaseRequired
        record.baseEtag = "etag-3"
        try store.upsertCapture(record)

        let loaded = try #require(try store.capture(id: record.captureId))
        #expect(loaded == record)
        #expect(loaded.databaseId == nil)
        #expect(loaded.sourceRefs == record.sourceRefs)
    }

    @Test
    func upsertUpdatesTheSameRow() throws {
        let (store, _) = try makeStore()
        try store.upsertCapture(capture())
        var updated = capture()
        updated.rawText = "changed"
        updated.state = .sent
        try store.upsertCapture(updated)

        let all = try store.captures(principal: "2vxsx-fae")
        #expect(all.count == 1)
        #expect(all.first?.rawText == "changed")
    }

    @Test
    func sentCapturesAreMarkedAndRemovable() throws {
        let (store, _) = try makeStore()
        try store.upsertCapture(capture())
        try store.markCaptureSent(id: "capture-1", at: 99)

        let sent = try #require(try store.capture(id: "capture-1"))
        #expect(sent.state == .sent)
        #expect(sent.sentAt == 99)

        try store.deleteCapture(id: "capture-1")
        #expect(try store.captures(principal: "2vxsx-fae").isEmpty)
    }

    @Test
    func capturesAreIsolatedByPrincipal() throws {
        let (store, _) = try makeStore()
        try store.upsertCapture(capture(id: "a", principal: "alice"))
        try store.upsertCapture(capture(id: "b", principal: "bob"))

        #expect(try store.captures(principal: "alice").map(\.captureId) == ["a"])
        #expect(try store.captures(principal: "bob").map(\.captureId) == ["b"])
    }

    @Test
    func listCacheReplacesPerDatabaseAndRecordsFetchTime() throws {
        let (store, _) = try makeStore()
        try store.replaceListCache(
            principal: "alice",
            databaseId: "db-1",
            entries: [
                WorkItemListCacheRecord(itemId: "one", title: "One", state: .open, commentCount: 1, updatedAt: 10),
                WorkItemListCacheRecord(itemId: "two", title: "Two", state: .closed, commentCount: 0, updatedAt: 20)
            ],
            fetchedAt: 500
        )
        try store.replaceListCache(
            principal: "alice",
            databaseId: "db-2",
            entries: [
                WorkItemListCacheRecord(itemId: "three", title: "Three", state: .open, commentCount: 0, updatedAt: 30)
            ],
            fetchedAt: 600
        )

        // Newest first.
        #expect(try store.listCache(principal: "alice", databaseId: "db-1").map(\.itemId) == ["two", "one"])
        #expect(try store.listCache(principal: "alice", databaseId: "db-2").map(\.itemId) == ["three"])
        #expect(try store.lastFetchedAt(principal: "alice", databaseId: "db-1") == 500)
        #expect(try store.lastFetchedAt(principal: "bob", databaseId: "db-1") == nil)

        // Replacing one database must not touch the other.
        try store.replaceListCache(principal: "alice", databaseId: "db-1", entries: [], fetchedAt: 700)
        #expect(try store.listCache(principal: "alice", databaseId: "db-1").isEmpty)
        #expect(try store.listCache(principal: "alice", databaseId: "db-2").count == 1)
        #expect(try store.lastFetchedAt(principal: "alice", databaseId: "db-1") == 700)
    }

    @Test
    func liveStoreReturnsNilWithoutAnAppGroup() throws {
        #expect(try WorkItemStore.live(appGroupId: nil) == nil)
        #expect(try WorkItemStore.live(appGroupId: "  ") == nil)
    }

    @Test
    func pendingMutationsRoundTripPerAccountAndDatabase() throws {
        let (store, _) = try makeStore()
        let edit = WorkItemPendingMutation(
            mutationId: "m1",
            kind: .edit,
            itemId: "abc",
            createdAt: 5,
            payloadJson: WorkItemPendingMutation.encoded(
                WorkItemPendingMutation.EditPayload(title: "T", body: "B", baseEtag: "e1", listEtag: nil, commentCount: 0)
            )
        )
        let comment = WorkItemPendingMutation(
            mutationId: "m2",
            kind: .comment,
            itemId: "abc",
            createdAt: 6,
            payloadJson: WorkItemPendingMutation.encoded(
                WorkItemPendingMutation.CommentPayload(body: "C", author: "p")
            )
        )
        // Ids are per-mutation UUIDs in production, so accounts never share one.
        try store.insertPendingMutation(edit, principal: "alice", databaseId: "db-1")
        try store.insertPendingMutation(comment, principal: "alice", databaseId: "db-1")
        try store.insertPendingMutation(
            WorkItemPendingMutation(mutationId: "m3", kind: .comment, itemId: "abc", createdAt: 7, payloadJson: "{}"),
            principal: "bob",
            databaseId: "db-1"
        )
        try store.insertPendingMutation(
            WorkItemPendingMutation(mutationId: "m4", kind: .comment, itemId: "abc", createdAt: 8, payloadJson: "{}"),
            principal: "alice",
            databaseId: "db-2"
        )

        let alice = try store.pendingMutations(principal: "alice", databaseId: "db-1")
        #expect(alice.map(\.mutationId) == ["m1", "m2"])
        #expect(alice.first?.editPayload?.body == "B")
        #expect(alice.last?.commentPayload?.body == "C")
        #expect(try store.pendingMutations(principal: "bob", databaseId: "db-1").map(\.mutationId) == ["m3"])
        #expect(try store.pendingMutations(principal: "alice", databaseId: "db-2").map(\.mutationId) == ["m4"])

        try store.deletePendingMutation(id: "m1")
        #expect(try store.pendingMutations(principal: "alice", databaseId: "db-1").map(\.mutationId) == ["m2"])
    }

    @Test
    func aCollidingMutationIdNeverRewritesAnotherAccount() throws {
        let (store, _) = try makeStore()
        let aliceMutation = WorkItemPendingMutation(mutationId: "shared", kind: .comment, itemId: "a", createdAt: 5, payloadJson: WorkItemPendingMutation.encoded(WorkItemPendingMutation.CommentPayload(body: "alice", author: "alice")))
        let bobMutation = WorkItemPendingMutation(mutationId: "shared", kind: .comment, itemId: "b", createdAt: 6, payloadJson: WorkItemPendingMutation.encoded(WorkItemPendingMutation.CommentPayload(body: "bob", author: "bob")))

        try store.insertPendingMutation(aliceMutation, principal: "alice", databaseId: "db-1")
        try store.insertPendingMutation(bobMutation, principal: "bob", databaseId: "db-1")

        let alice = try store.pendingMutations(principal: "alice", databaseId: "db-1")
        #expect(alice.count == 1)
        #expect(alice.first?.itemId == "a")
        #expect(alice.first?.commentPayload?.body == "alice")
    }

    @Test
    func reinsertingAPendingMutationUpdatesItInPlace() throws {
        let (store, _) = try makeStore()
        let first = WorkItemPendingMutation(mutationId: "m1", kind: .edit, itemId: "abc", createdAt: 5, payloadJson: "{}")
        let updated = WorkItemPendingMutation(mutationId: "m1", kind: .comment, itemId: "abc", createdAt: 9, payloadJson: "{}")
        try store.insertPendingMutation(first, principal: "alice", databaseId: "db-1")
        try store.insertPendingMutation(updated, principal: "alice", databaseId: "db-1")

        let stored = try store.pendingMutations(principal: "alice", databaseId: "db-1")
        #expect(stored.count == 1)
        #expect(stored.first?.kind == .comment)
        #expect(stored.first?.createdAt == 9)
    }

    @Test
    func aFailedCacheWriteLeavesNoOpenTransaction() throws {
        let (store, _) = try makeStore()
        // The same item twice violates the primary key part-way through the transaction.
        let duplicate = WorkItemListCacheRecord(itemId: "same", title: "One", state: .open, commentCount: 0, updatedAt: 1)

        #expect(throws: WorkItemStoreError.self) {
            try store.replaceListCache(
                principal: "alice",
                databaseId: "db-1",
                entries: [duplicate, duplicate],
                fetchedAt: 5
            )
        }

        // If the rollback did not run, this cannot even begin a new transaction.
        try store.replaceListCache(
            principal: "alice",
            databaseId: "db-1",
            entries: [WorkItemListCacheRecord(itemId: "ok", title: "Ok", state: .open, commentCount: 0, updatedAt: 2)],
            fetchedAt: 6
        )
        #expect(try store.listCache(principal: "alice", databaseId: "db-1").map(\.itemId) == ["ok"])
        #expect(try store.lastFetchedAt(principal: "alice", databaseId: "db-1") == 6)
    }
}
