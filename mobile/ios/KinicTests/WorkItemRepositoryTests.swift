// Where: mobile/ios/KinicTests/WorkItemRepositoryTests.swift
// What: Repository contract tests against an in-memory VFS stub.
// Why: The item body, the list projection cache, and retry de-duplication must not regress.

import Foundation
import Testing
@testable import Kinic

private enum WorkItemVFSStubError: Error, Equatable {
    case readFailed(String)
    case mutationFailed
}

/// In-memory stand-in for the canister's VFS behaviour, including batch atomicity.
actor WorkItemVFSStub: WorkItemVFSProviding {
    private var nodes: [String: VFSNode] = [:]
    private var workItemsRootExists = false
    private var etagCounter = 0
    private var operationsLog: [[VFSNodeMutationOperation]] = []
    private var conflictingPaths: Set<String> = []
    private var readFailures: Set<String> = []
    private var mutationFails = false
    private var searchHits: [SearchNodeHit] = []
    private var searchFails = false
    private var lastSearchPrefix: String?
    private var readPaths: [String] = []

    func seed(
        path: String,
        kind: VFSNodeKind = .file,
        content: String = "",
        metadataJson: String = "{}",
        updatedAt: Int64 = 1
    ) {
        etagCounter += 1
        nodes[path] = VFSNode(
            path: path,
            kind: kind,
            content: content,
            metadataJson: metadataJson,
            etag: "etag-\(etagCounter)",
            createdAt: updatedAt,
            updatedAt: updatedAt
        )
        if kind == .folder, path == WorkItemPaths.root {
            workItemsRootExists = true
        }
    }

    func seedDirectory(_ path: String, updatedAt: Int64 = 1) {
        if path == WorkItemPaths.root {
            workItemsRootExists = true
        }
        etagCounter += 1
        nodes[path] = VFSNode(
            path: path,
            kind: .folder,
            content: "",
            metadataJson: "{}",
            etag: "etag-\(etagCounter)",
            createdAt: updatedAt,
            updatedAt: updatedAt
        )
    }

    func forceConflict(at path: String) {
        conflictingPaths.insert(path)
    }

    func failRead(at path: String) {
        readFailures.insert(path)
    }

    func failMutations() {
        mutationFails = true
    }

    func resumeMutations() {
        mutationFails = false
    }

    func recordedReadPaths() -> [String] {
        readPaths
    }

    func recordedOperations() -> [[VFSNodeMutationOperation]] {
        operationsLog
    }

    func makeRootExist() {
        seedDirectory(WorkItemPaths.root)
    }

    func setSearchHits(_ hits: [SearchNodeHit]) {
        searchHits = hits
    }

    func failSearch() {
        searchFails = true
    }

    func recordedSearchPrefix() -> String? {
        lastSearchPrefix
    }

    func searchNodes(
        databaseId: String,
        query: String,
        prefix: String?,
        limit: UInt32,
        session: KinicIdentitySession
    ) async throws -> [SearchNodeHit] {
        if searchFails {
            throw WorkItemVFSStubError.readFailed("search")
        }
        lastSearchPrefix = prefix
        return Array(searchHits.prefix(Int(limit)))
    }

    func listChildren(databaseId: String, path: String, session: KinicIdentitySession) async throws -> [ChildNode] {
        if path == WorkItemPaths.root, !workItemsRootExists {
            throw VFSCandidError.canisterRejected("path not found: \(path)")
        }
        return nodes.values
            .filter { $0.path != path && Self.parent(of: $0.path) == path }
            .sorted { $0.path < $1.path }
            .map {
                ChildNode(
                    path: $0.path,
                    name: $0.path.split(separator: "/").last.map(String.init) ?? "",
                    kind: $0.kind,
                    updatedAt: $0.updatedAt,
                    etag: $0.etag,
                    sizeBytes: UInt64($0.content.utf8.count),
                    hasChildren: false,
                    isVirtual: false
                )
            }
    }

    func readNode(databaseId: String, path: String, session: KinicIdentitySession) async throws -> VFSNode? {
        readPaths.append(path)
        if readFailures.contains(path) {
            throw WorkItemVFSStubError.readFailed(path)
        }
        return nodes[path]
    }

    func mutateNodesBatch(
        databaseId: String,
        operations: [VFSNodeMutationOperation],
        session: KinicIdentitySession
    ) async throws -> [VFSNodeMutationOutcome] {
        if mutationFails {
            throw WorkItemVFSStubError.mutationFailed
        }
        operationsLog.append(operations)
        // Validate the whole batch first so a failure leaves no partial state, like the canister.
        for (index, operation) in operations.enumerated() {
            switch operation {
            case .mkdir(let path):
                if let existing = nodes[path], existing.kind != .folder {
                    throw VFSCandidError.nodeMutationRejected(
                        VFSNodeMutationFailure(code: .invalidOperation, message: "not a folder", failedIndex: UInt32(index), conflictPath: path)
                    )
                }
            case .write(let item):
                if let existing = nodes[item.path] {
                    if conflictingPaths.contains(item.path) || existing.etag != (item.expectedEtag ?? "") {
                        throw VFSCandidError.nodeMutationRejected(
                            VFSNodeMutationFailure(code: .etagConflict, message: "etag mismatch", failedIndex: UInt32(index), conflictPath: item.path)
                        )
                    }
                } else if item.expectedEtag != nil {
                    throw VFSCandidError.nodeMutationRejected(
                        VFSNodeMutationFailure(code: .notFound, message: "missing node", failedIndex: UInt32(index), conflictPath: item.path)
                    )
                }
            }
        }
        var outcomes: [VFSNodeMutationOutcome] = []
        for operation in operations {
            switch operation {
            case .mkdir(let path):
                let created = nodes[path] == nil
                if created {
                    seedDirectory(path)
                }
                outcomes.append(.madeDirectory(created: created, path: path))
            case .write(let item):
                let created = nodes[item.path] == nil
                etagCounter += 1
                nodes[item.path] = VFSNode(
                    path: item.path,
                    kind: item.kind,
                    content: item.content,
                    metadataJson: item.metadataJson,
                    etag: "etag-\(etagCounter)",
                    createdAt: nodes[item.path]?.createdAt ?? 1,
                    updatedAt: 2
                )
                outcomes.append(
                    .wrote(
                        created: created,
                        node: VFSNodeMutationAck(path: item.path, kind: item.kind, updatedAt: 2, etag: "etag-\(etagCounter)")
                    )
                )
            }
        }
        return outcomes
    }

    private static func parent(of path: String) -> String {
        let components = path.split(separator: "/")
        guard components.count > 1 else { return "/" }
        return "/" + components.dropLast().joined(separator: "/")
    }
}

struct WorkItemRepositoryTests {
    private let session = KinicIdentitySession.testing()

    private func makeRepository(_ stub: WorkItemVFSStub) -> WorkItemRepository {
        WorkItemRepository(vfs: stub, clock: { 1_000 })
    }

    private func itemMetadata(captureId: String, title: String, state: String = "open") throws -> String {
        try WorkItemDocument.encode(
            WorkItemDocument.ItemMetadata(
                version: 1,
                captureId: captureId,
                title: title,
                state: state,
                createdBy: "2vxsx-fae",
                createdAt: 5,
                source: nil
            )
        )
    }

    private func listMetadata(title: String, state: String = "open", commentCount: Int = 0, lastActivityAt: Int64) throws -> String {
        try WorkItemDocument.encode(
            WorkItemDocument.ListMetadata(
                version: 1,
                title: title,
                state: state,
                commentCount: commentCount,
                lastActivityAt: lastActivityAt
            )
        )
    }

    @Test
    func listIsEmptyWhenTheRootFolderDoesNotExist() async throws {
        let stub = WorkItemVFSStub()
        let snapshot = try await makeRepository(stub).list(databaseId: "db", session: session)
        #expect(snapshot.entries.isEmpty)
        #expect(snapshot.totalCount == 0)
        #expect(!snapshot.isTruncated)
        #expect(snapshot.unreadableCount == 0)
    }

    @Test
    func listReadsMetaAndSortsByMostRecentActivity() async throws {
        let stub = WorkItemVFSStub()
        await stub.makeRootExist()
        await stub.seed(path: WorkItemPaths.directory("b"), kind: .folder)
        await stub.seed(path: WorkItemPaths.directory("a"), kind: .folder)
        await stub.seed(path: WorkItemPaths.listMetadata("a"), metadataJson: try listMetadata(title: "Older", lastActivityAt: 10))
        await stub.seed(path: WorkItemPaths.listMetadata("b"), metadataJson: try listMetadata(title: "Newer", state: "closed", commentCount: 2, lastActivityAt: 20))

        let snapshot = try await makeRepository(stub).list(databaseId: "db", session: session)
        #expect(snapshot.entries.map(\.id) == ["b", "a"])
        #expect(snapshot.totalCount == 2)
        #expect(snapshot.entries.first?.title == "Newer")
        #expect(snapshot.entries.first?.state == .closed)
        #expect(snapshot.entries.first?.commentCount == 2)
    }

    @Test
    func listRebuildsAMissingProjectionFromTheAuthoritativeItem() async throws {
        let stub = WorkItemVFSStub()
        await stub.makeRootExist()
        await stub.seed(path: WorkItemPaths.directory("a"), kind: .folder)
        await stub.seed(
            path: WorkItemPaths.item("a"),
            content: "Body",
            metadataJson: try itemMetadata(captureId: "a", title: "Recovered"),
            updatedAt: 77
        )

        let snapshot = try await makeRepository(stub).list(databaseId: "db", session: session)
        #expect(snapshot.entries.map(\.title) == ["Recovered"])
        #expect(snapshot.entries.first?.updatedAt == 77)

        // The rebuild writes the derived projection back, without touching the body.
        let batches = await stub.recordedOperations()
        #expect(batches.count == 1)
        guard case .write(let item)? = batches.first?.first else {
            Issue.record("expected a projection write, got \(String(describing: batches.first))")
            return
        }
        #expect(item.path == WorkItemPaths.listMetadata("a"))
        #expect(item.expectedEtag == nil)
        let restored = try await stub.readNode(databaseId: "db", path: WorkItemPaths.listMetadata("a"), session: session)
        #expect(restored != nil)
    }

    @Test
    func listRepairsUnreadableProjectionUsingItsCurrentEtag() async throws {
        for unreadableMetadata in [#"{"version":99}"#, "not-json"] {
            let stub = WorkItemVFSStub()
            await stub.makeRootExist()
            await stub.seed(path: WorkItemPaths.directory("a"), kind: .folder)
            await stub.seed(
                path: WorkItemPaths.item("a"),
                content: "Body",
                metadataJson: try itemMetadata(captureId: "a", title: "Recovered"),
                updatedAt: 77
            )
            await stub.seed(path: WorkItemPaths.listMetadata("a"), metadataJson: unreadableMetadata)
            let oldMeta = try #require(await stub.readNode(databaseId: "db", path: WorkItemPaths.listMetadata("a"), session: session))

            let snapshot = try await makeRepository(stub).list(databaseId: "db", session: session)

            #expect(snapshot.entries.map(\.title) == ["Recovered"])
            let batches = await stub.recordedOperations()
            guard case .write(let repair)? = batches.last?.first else {
                Issue.record("expected a projection repair")
                continue
            }
            #expect(repair.expectedEtag == oldMeta.etag)
            let repaired = try #require(await stub.readNode(databaseId: "db", path: WorkItemPaths.listMetadata("a"), session: session))
            #expect(WorkItemDocument.listEntry(from: repaired) == .loaded(snapshot.entries[0]))
        }
    }

    @Test
    func listDoesNotOverwriteAConcurrentProjectionChange() async throws {
        let stub = WorkItemVFSStub()
        await stub.makeRootExist()
        await stub.seed(path: WorkItemPaths.directory("a"), kind: .folder)
        await stub.seed(
            path: WorkItemPaths.item("a"),
            content: "Body",
            metadataJson: try itemMetadata(captureId: "a", title: "Recovered"),
            updatedAt: 77
        )
        let metaPath = WorkItemPaths.listMetadata("a")
        await stub.seed(path: metaPath, metadataJson: #"{"version":99}"#)
        let original = try #require(await stub.readNode(databaseId: "db", path: metaPath, session: session))
        await stub.forceConflict(at: metaPath)

        let snapshot = try await makeRepository(stub).list(databaseId: "db", session: session)

        #expect(snapshot.entries.map(\.title) == ["Recovered"])
        let unchanged = try #require(await stub.readNode(databaseId: "db", path: metaPath, session: session))
        #expect(unchanged.etag == original.etag)
        #expect(unchanged.metadataJson == original.metadataJson)
    }

    @Test
    func listFlagsItemsWrittenByANewerDocumentVersion() async throws {
        let stub = WorkItemVFSStub()
        await stub.makeRootExist()
        await stub.seed(path: WorkItemPaths.directory("a"), kind: .folder)
        await stub.seed(path: WorkItemPaths.item("a"), content: "Body", metadataJson: #"{"version":2}"#)

        let snapshot = try await makeRepository(stub).list(databaseId: "db", session: session)
        #expect(snapshot.entries.count == 1)
        #expect(snapshot.entries.first?.isUnsupportedVersion == true)
    }

    @Test
    func loadReportsUnsupportedVersionsInsteadOfGuessing() async throws {
        let stub = WorkItemVFSStub()
        await stub.seed(path: WorkItemPaths.item("a"), content: "Body", metadataJson: #"{"version":9,"title":"x"}"#)

        let detail = try await makeRepository(stub).load(id: "a", databaseId: "db", session: session)
        #expect(detail.unsupportedVersion == 9)
        #expect(detail.isUnsupportedVersion)
        #expect(detail.item.body == "Body")
    }

    @Test
    func loadDistinguishesMissingNodesFromReadFailures() async throws {
        let missingStub = WorkItemVFSStub()
        do {
            _ = try await makeRepository(missingStub).load(id: "missing", databaseId: "db", session: session)
            Issue.record("expected not found")
        } catch let error as WorkItemRepositoryError {
            #expect(error == .notFound(WorkItemPaths.item("missing")))
        }

        let failingStub = WorkItemVFSStub()
        let itemPath = WorkItemPaths.item("a")
        await failingStub.failRead(at: itemPath)
        do {
            _ = try await makeRepository(failingStub).load(id: "a", databaseId: "db", session: session)
            Issue.record("expected read failure")
        } catch let error as WorkItemVFSStubError {
            #expect(error == .readFailed(itemPath))
        }
    }

    @Test
    func listCountsReadFailuresAsUnreadable() async throws {
        let stub = WorkItemVFSStub()
        await stub.makeRootExist()
        await stub.seed(path: WorkItemPaths.directory("a"), kind: .folder)
        await stub.failRead(at: WorkItemPaths.listMetadata("a"))

        let snapshot = try await makeRepository(stub).list(databaseId: "db", session: session)

        #expect(snapshot.entries.isEmpty)
        #expect(snapshot.unreadableCount == 1)
        #expect(snapshot.totalCount == 1)
    }

    @Test
    func createWritesTheWholeFolderChainInOneBatch() async throws {
        let stub = WorkItemVFSStub()
        let draft = WorkItemCreateDraft(id: "abc", title: "Fix the roof", body: "Body text", author: "2vxsx-fae", source: nil)

        let item = try await makeRepository(stub).create(draft, databaseId: "db", session: session)

        let batches = await stub.recordedOperations()
        #expect(batches.count == 1)
        let operations = try #require(batches.first)
        #expect(operations.count == 5)
        #expect(operations[0] == .mkdir(path: WorkItemPaths.root))
        #expect(operations[1] == .mkdir(path: WorkItemPaths.directory("abc")))
        #expect(operations[2] == .mkdir(path: WorkItemPaths.commentsDirectory("abc")))
        #expect(item.id == "abc")
        #expect(item.title == "Fix the roof")
        #expect(!item.etag.isEmpty)

        // Both documents exist and the projection matches the authoritative item.
        let itemNode = try await stub.readNode(databaseId: "db", path: WorkItemPaths.item("abc"), session: session)
        let listNode = try await stub.readNode(databaseId: "db", path: WorkItemPaths.listMetadata("abc"), session: session)
        #expect(itemNode?.content == "Body text")
        #expect(listNode?.content.isEmpty == true)
        #expect(WorkItemDocument.listEntry(from: try #require(listNode)) == .loaded(
            WorkItemListEntry(id: "abc", title: "Fix the roof", state: .open, commentCount: 0, updatedAt: 1_000, isUnsupportedVersion: false)
        ))
    }

    @Test
    func createIsIdempotentWhenTheResponseWasLost() async throws {
        let stub = WorkItemVFSStub()
        let repository = makeRepository(stub)
        let draft = WorkItemCreateDraft(id: "abc", title: "Fix the roof", body: "Body text", author: "2vxsx-fae", source: nil)

        let first = try await repository.create(draft, databaseId: "db", session: session)
        let second = try await repository.create(draft, databaseId: "db", session: session)

        #expect(second.etag == first.etag)
        #expect(second.id == first.id)
        // The retry collided with this device's own write instead of creating a second item.
        let batches = await stub.recordedOperations()
        #expect(batches.count == 2)
        let children = try await stub.listChildren(databaseId: "db", path: WorkItemPaths.root, session: session)
        #expect(children.count == 1)
    }

    @Test
    func createSurfacesARealConflictForAnotherWritersItem() async throws {
        let stub = WorkItemVFSStub()
        await stub.makeRootExist()
        await stub.seed(path: WorkItemPaths.directory("abc"), kind: .folder)
        await stub.seed(path: WorkItemPaths.item("abc"), content: "Theirs", metadataJson: try itemMetadata(captureId: "someone-else", title: "Theirs"))
        let draft = WorkItemCreateDraft(id: "abc", title: "Mine", body: "Mine", author: "2vxsx-fae", source: nil)

        do {
            _ = try await makeRepository(stub).create(draft, databaseId: "db", session: session)
            Issue.record("expected an etag conflict")
        } catch let error as WorkItemRepositoryError {
            #expect(error == .etagConflict(WorkItemPaths.item("abc")))
        } catch {
            Issue.record("unexpected error: \(error)")
        }
    }

    @Test
    func updateSendsBothEtagsAndReportsConflicts() async throws {
        let stub = WorkItemVFSStub()
        await stub.seed(path: WorkItemPaths.item("abc"), content: "Body", metadataJson: try itemMetadata(captureId: "abc", title: "Title"))
        await stub.seed(path: WorkItemPaths.listMetadata("abc"), content: "", metadataJson: try listMetadata(title: "Title", lastActivityAt: 1))
        let detail = try await makeRepository(stub).load(id: "abc", databaseId: "db", session: session)

        var edited = detail.item
        edited.title = "Renamed"
        edited.body = "New body"
        _ = try await makeRepository(stub).update(
            edited,
            previousItemEtag: detail.itemEtag,
            previousListEtag: detail.listEtag,
            commentCount: detail.commentCount,
            databaseId: "db",
            session: session
        )

        let batches = await stub.recordedOperations()
        let operations = try #require(batches.last)
        #expect(operations.count == 2)
        guard case .write(let itemWrite) = operations[0], case .write(let listWrite) = operations[1] else {
            Issue.record("expected two writes, got \(operations)")
            return
        }
        #expect(itemWrite.expectedEtag == detail.itemEtag)
        #expect(listWrite.expectedEtag == detail.listEtag)
        #expect(itemWrite.content == "New body")

        // A second save with the stale etag must not overwrite the fresh revision.
        do {
            _ = try await makeRepository(stub).update(
                edited,
                previousItemEtag: detail.itemEtag,
                previousListEtag: detail.listEtag,
                commentCount: 0,
                databaseId: "db",
                session: session
            )
            Issue.record("expected an etag conflict")
        } catch let error as WorkItemRepositoryError {
            #expect(error == .etagConflict(WorkItemPaths.item("abc")))
        } catch {
            Issue.record("unexpected error: \(error)")
        }
    }

    @Test
    func aCommentThatLandsMidEditDoesNotFailABodyWrite() async throws {
        let stub = WorkItemVFSStub()
        await stub.seed(path: WorkItemPaths.item("abc"), content: "Body", metadataJson: try itemMetadata(captureId: "abc", title: "Title"), updatedAt: 1)
        await stub.seed(path: WorkItemPaths.listMetadata("abc"), metadataJson: try listMetadata(title: "Title", lastActivityAt: 1))
        let repository = makeRepository(stub)
        let detail = try await repository.load(id: "abc", databaseId: "db", session: session)

        // Another member comments, which rewrites only the derived projection.
        await stub.seed(path: WorkItemPaths.listMetadata("abc"), metadataJson: try listMetadata(title: "Title", commentCount: 1, lastActivityAt: 9))

        var edited = detail.item
        edited.body = "New body"
        _ = try await repository.update(
            edited,
            previousItemEtag: detail.itemEtag,
            previousListEtag: detail.listEtag,
            commentCount: detail.commentCount,
            databaseId: "db",
            session: session
        )

        let itemNode = try await stub.readNode(databaseId: "db", path: WorkItemPaths.item("abc"), session: session)
        #expect(itemNode?.content == "New body")
        let listNode = try await stub.readNode(databaseId: "db", path: WorkItemPaths.listMetadata("abc"), session: session)
        guard case .loaded(let entry) = WorkItemDocument.listEntry(from: try #require(listNode)) else {
            Issue.record("expected a readable projection")
            return
        }
        // The retry keeps the count the comment folder reported.
        #expect(entry.commentCount == 1)
    }

    @Test
    func aChangedBodyStillReportsAConflict() async throws {
        let stub = WorkItemVFSStub()
        await stub.seed(path: WorkItemPaths.item("abc"), content: "Body", metadataJson: try itemMetadata(captureId: "abc", title: "Title"), updatedAt: 1)
        await stub.seed(path: WorkItemPaths.listMetadata("abc"), metadataJson: try listMetadata(title: "Title", lastActivityAt: 1))
        let repository = makeRepository(stub)
        let detail = try await repository.load(id: "abc", databaseId: "db", session: session)

        await stub.seed(path: WorkItemPaths.item("abc"), content: "Theirs", metadataJson: try itemMetadata(captureId: "abc", title: "Theirs"))

        var edited = detail.item
        edited.body = "Mine"
        do {
            _ = try await repository.update(
                edited,
                previousItemEtag: detail.itemEtag,
                previousListEtag: detail.listEtag,
                commentCount: detail.commentCount,
                databaseId: "db",
                session: session
            )
            Issue.record("expected an etag conflict")
        } catch let error as WorkItemRepositoryError {
            #expect(error == .etagConflict(WorkItemPaths.item("abc")))
        }
        let itemNode = try await stub.readNode(databaseId: "db", path: WorkItemPaths.item("abc"), session: session)
        #expect(itemNode?.content == "Theirs")
    }

    @Test
    func rebuildingAMissingProjectionKeepsTheCommentCount() async throws {
        let stub = WorkItemVFSStub()
        await stub.makeRootExist()
        await stub.seed(path: WorkItemPaths.directory("a"), kind: .folder)
        await stub.seed(path: WorkItemPaths.item("a"), content: "Body", metadataJson: try itemMetadata(captureId: "a", title: "Recovered"), updatedAt: 5)
        await stub.seed(path: WorkItemPaths.comment(itemId: "a", commentId: "c1"), content: "One", metadataJson: try commentMetadata(createdAt: 10), updatedAt: 10)
        await stub.seed(path: WorkItemPaths.comment(itemId: "a", commentId: "c2"), content: "Two", metadataJson: try commentMetadata(createdAt: 20), updatedAt: 30)

        let snapshot = try await makeRepository(stub).list(databaseId: "db", session: session)
        #expect(snapshot.entries.first?.commentCount == 2)
        #expect(snapshot.entries.first?.updatedAt == 30)

        let listNode = try await stub.readNode(databaseId: "db", path: WorkItemPaths.listMetadata("a"), session: session)
        guard case .loaded(let entry) = WorkItemDocument.listEntry(from: try #require(listNode)) else {
            Issue.record("expected a readable projection")
            return
        }
        #expect(entry.commentCount == 2)
    }

    @Test
    func listIsCappedAtOneHundredItems() async throws {
        let stub = WorkItemVFSStub()
        await stub.makeRootExist()
        for index in 0..<101 {
            let id = String(format: "item-%03d", index)
            // Directory timestamps do not define list activity; only meta.md does.
            await stub.seedDirectory(WorkItemPaths.directory(id), updatedAt: 1)
            await stub.seed(path: WorkItemPaths.listMetadata(id), metadataJson: try listMetadata(title: id, lastActivityAt: Int64(index)))
        }

        let snapshot = try await makeRepository(stub).list(databaseId: "db", session: session)
        #expect(snapshot.isTruncated)
        #expect(snapshot.totalCount == 101)
        #expect(snapshot.entries.count == 100)
        // The oldest directory is the one dropped, never a randomly chosen UUID.
        #expect(snapshot.entries.first?.id == "item-100")
        #expect(!snapshot.entries.contains { $0.id == "item-000" })
    }
}

extension WorkItemRepositoryTests {

    // MARK: - Phase 2: comments, close/reopen, search

    @MainActor
    private func makeRuntime(role: DatabaseRole = .owner) -> WorkItemRuntimeStub {
        WorkItemRuntimeStub(role: role)
    }

    private func commentMetadata(author: String = "2vxsx-fae", createdAt: Int64) throws -> String {
        try WorkItemDocument.encode(
            WorkItemDocument.CommentMetadata(version: 1, author: author, createdAt: createdAt)
        )
    }

    @Test
    func postingACommentNeverWritesTheItemBody() async throws {
        let stub = WorkItemVFSStub()
        await stub.seed(path: WorkItemPaths.item("abc"), content: "Body", metadataJson: try itemMetadata(captureId: "abc", title: "Title"))
        await stub.seed(path: WorkItemPaths.listMetadata("abc"), metadataJson: try listMetadata(title: "Title", lastActivityAt: 1))

        let comment = try await makeRepository(stub).postComment(
            WorkItemCommentDraft(id: "c1", body: "Looks good", author: "2vxsx-fae", createdAt: 5),
            itemId: "abc",
            databaseId: "db",
            session: session
        )
        #expect(comment.id == "c1")
        #expect(comment.itemId == "abc")

        let operations = try #require(await stub.recordedOperations().first)
        #expect(operations.count == 2)
        #expect(operations[0] == .mkdir(path: WorkItemPaths.commentsDirectory("abc")))
        guard case .write(let written) = operations[1] else {
            Issue.record("expected a comment write, got \(operations)")
            return
        }
        #expect(written.path == WorkItemPaths.comment(itemId: "abc", commentId: "c1"))
        #expect(written.expectedEtag == nil)
        // The body document is untouched, which is what keeps concurrent comments conflict-free.
        let touchesBody = operations.contains { operation in
            if case .write(let item) = operation { return item.path == WorkItemPaths.item("abc") }
            return false
        }
        #expect(!touchesBody)
    }

    @Test
    func repostingTheSameCommentIsTreatedAsAlreadyStored() async throws {
        let stub = WorkItemVFSStub()
        await stub.seed(path: WorkItemPaths.item("abc"), content: "Body", metadataJson: try itemMetadata(captureId: "abc", title: "Title"))
        let repository = makeRepository(stub)
        let draft = WorkItemCommentDraft(id: "c1", body: "Looks good", author: "2vxsx-fae", createdAt: 5)

        _ = try await repository.postComment(draft, itemId: "abc", databaseId: "db", session: session)
        let retried = try await repository.postComment(draft, itemId: "abc", databaseId: "db", session: session)

        #expect(retried.id == "c1")
        let children = try await stub.listChildren(databaseId: "db", path: WorkItemPaths.commentsDirectory("abc"), session: session)
        #expect(children.count == 1)
    }

    @Test
    func commentsLoadOldestFirstHoweverTheyAreStored() async throws {
        let stub = WorkItemVFSStub()
        await stub.seed(path: WorkItemPaths.item("abc"), content: "Body", metadataJson: try itemMetadata(captureId: "abc", title: "Title"))
        // File timestamps put the newer comment first; metadata decides the display order.
        await stub.seed(path: WorkItemPaths.comment(itemId: "abc", commentId: "newer"), content: "Second", metadataJson: try commentMetadata(createdAt: 20), updatedAt: 2)
        await stub.seed(path: WorkItemPaths.comment(itemId: "abc", commentId: "older"), content: "First", metadataJson: try commentMetadata(createdAt: 10), updatedAt: 1)

        let comments = try await makeRepository(stub).loadComments(itemId: "abc", databaseId: "db", session: session)
        #expect(comments.map(\.body) == ["First", "Second"])
    }

    @Test
    func anItemWithoutACommentFolderLoadsNoComments() async throws {
        let stub = WorkItemVFSStub()
        await stub.seed(path: WorkItemPaths.item("abc"), content: "Body", metadataJson: try itemMetadata(captureId: "abc", title: "Title"))
        let comments = try await makeRepository(stub).loadComments(itemId: "abc", databaseId: "db", session: session)
        #expect(comments.isEmpty)
    }

    @Test
    func refreshingTheProjectionCountsTheRealComments() async throws {
        let stub = WorkItemVFSStub()
        await stub.seed(path: WorkItemPaths.item("abc"), content: "Body", metadataJson: try itemMetadata(captureId: "abc", title: "Title"), updatedAt: 1)
        await stub.seed(path: WorkItemPaths.listMetadata("abc"), metadataJson: try listMetadata(title: "Title", lastActivityAt: 1))
        await stub.seed(path: WorkItemPaths.comment(itemId: "abc", commentId: "c1"), content: "One", metadataJson: try commentMetadata(createdAt: 10), updatedAt: 10)
        await stub.seed(path: WorkItemPaths.comment(itemId: "abc", commentId: "c2"), content: "Two", metadataJson: try commentMetadata(createdAt: 20), updatedAt: 30)

        await makeRepository(stub).refreshCommentProjection(itemId: "abc", databaseId: "db", session: session)

        let listNode = try await stub.readNode(databaseId: "db", path: WorkItemPaths.listMetadata("abc"), session: session)
        guard case .loaded(let entry) = WorkItemDocument.listEntry(from: try #require(listNode)) else {
            Issue.record("expected a readable projection")
            return
        }
        #expect(entry.commentCount == 2)
        #expect(entry.updatedAt == 30)
        #expect(entry.title == "Title")
    }

    @Test
    func closingAnItemWritesBothDocumentsUnderBothEtags() async throws {
        let stub = WorkItemVFSStub()
        await stub.seed(path: WorkItemPaths.item("abc"), content: "Body", metadataJson: try itemMetadata(captureId: "abc", title: "Title"))
        await stub.seed(path: WorkItemPaths.listMetadata("abc"), metadataJson: try listMetadata(title: "Title", lastActivityAt: 1))
        let repository = makeRepository(stub)
        let detail = try await repository.load(id: "abc", databaseId: "db", session: session)

        _ = try await repository.setState(detail, state: .closed, databaseId: "db", session: session)

        let operations = try #require(await stub.recordedOperations().last)
        #expect(operations.count == 2)
        guard case .write(let itemWrite) = operations[0], case .write(let listWrite) = operations[1] else {
            Issue.record("expected two writes, got \(operations)")
            return
        }
        #expect(itemWrite.expectedEtag == detail.itemEtag)
        #expect(listWrite.expectedEtag == detail.listEtag)
        let metadata = try #require(
            try? JSONDecoder().decode(WorkItemDocument.ItemMetadata.self, from: Data(itemWrite.metadataJson.utf8))
        )
        #expect(metadata.state == "closed")
    }

    @Test
    func searchGroupsCommentHitsIntoTheirParentItem() async throws {
        let stub = WorkItemVFSStub()
        await stub.seed(path: WorkItemPaths.item("abc"), content: "Body", metadataJson: try itemMetadata(captureId: "abc", title: "Roof"))
        await stub.seed(path: WorkItemPaths.listMetadata("abc"), content: "", metadataJson: try listMetadata(title: "Roof", lastActivityAt: 3))
        await stub.seed(path: WorkItemPaths.item("xyz"), content: "Body", metadataJson: try itemMetadata(captureId: "xyz", title: "Gutter"))
        await stub.seed(path: WorkItemPaths.listMetadata("xyz"), content: "", metadataJson: try listMetadata(title: "Gutter", lastActivityAt: 2))
        await stub.setSearchHits([
            SearchNodeHit(path: WorkItemPaths.item("abc"), kind: .file, snippet: nil, previewExcerpt: "roof leak", matchReasons: ["content_fts"], score: 1),
            SearchNodeHit(path: WorkItemPaths.comment(itemId: "abc", commentId: "c1"), kind: .file, snippet: "the roof again", previewExcerpt: "the roof again", matchReasons: ["content_fts"], score: 0.5),
            SearchNodeHit(path: WorkItemPaths.item("xyz"), kind: .file, snippet: nil, previewExcerpt: "roof gutter", matchReasons: ["content_fts"], score: 0.2)
        ])

        let snapshot = try await makeRepository(stub).search(databaseId: "db", query: "roof", session: session)

        #expect(snapshot.results.map(\.id) == ["abc", "xyz"])
        #expect(snapshot.results.first?.matchedCommentCount == 1)
        #expect(snapshot.results.first?.snippet == "roof leak")
        #expect(snapshot.hitCount == 3)
        #expect(!snapshot.isCapped)
        // The canister rejects a prefix that ends with "/".
        let prefix = await stub.recordedSearchPrefix()
        #expect(prefix == WorkItemPaths.root)
        #expect(prefix?.hasSuffix("/") == false)
    }

    @Test
    func searchReportsWhenTheCanisterHitItsHitLimit() async throws {
        let stub = WorkItemVFSStub()
        await stub.seed(path: WorkItemPaths.item("abc"), content: "Body", metadataJson: try itemMetadata(captureId: "abc", title: "Roof"))
        await stub.seed(path: WorkItemPaths.listMetadata("abc"), content: "", metadataJson: try listMetadata(title: "Roof", lastActivityAt: 1))
        await stub.setSearchHits(
            (0..<WorkItemRepository.maximumItems).map { index in
                SearchNodeHit(path: WorkItemPaths.item("abc"), kind: .file, snippet: nil, previewExcerpt: "roof \(index)", matchReasons: ["content_fts"], score: 1)
            }
        )

        let snapshot = try await makeRepository(stub).search(databaseId: "db", query: "roof", session: session)
        #expect(snapshot.isCapped)
        #expect(snapshot.results.count == 1)
    }

    @Test
    func blankSearchNeverReachesTheCanister() async throws {
        let stub = WorkItemVFSStub()
        let snapshot = try await makeRepository(stub).search(databaseId: "db", query: "   ", session: session)
        #expect(snapshot.results.isEmpty)
        #expect(snapshot.hitCount == 0)
        #expect(await stub.recordedSearchPrefix() == nil)
    }

    // MARK: - Phase 2: kept input

    @Test
    @MainActor
    func aFailedEditIsKeptOnThisDevice() async throws {
        let stub = WorkItemVFSStub()
        await stub.seed(path: WorkItemPaths.item("abc"), content: "Body", metadataJson: try itemMetadata(captureId: "abc", title: "Title"))
        await stub.seed(path: WorkItemPaths.listMetadata("abc"), metadataJson: try listMetadata(title: "Title", lastActivityAt: 1))
        let store = RecordingWorkItemStore()
        let model = WorkItemModel(runtime: makeRuntime(), repository: makeRepository(stub), store: store)
        let detail = try #require(await model.loadDetail("abc"))
        await stub.failMutations()

        let saved = await model.update(detail, title: "Mine", body: "Mine body")

        #expect(!saved)
        #expect(model.pendingMutations.map(\.kind) == [.edit])
        #expect(model.pendingMutations.first?.itemId == "abc")
        #expect(model.pendingMutations.first?.editPayload?.body == "Mine body")
        #expect(model.actionError != nil)
    }

    @Test
    @MainActor
    func aFailedCommentIsKeptOnThisDeviceAndReusesItsDocumentName() async throws {
        let stub = WorkItemVFSStub()
        await stub.seed(path: WorkItemPaths.item("abc"), content: "Body", metadataJson: try itemMetadata(captureId: "abc", title: "Title"))
        let store = RecordingWorkItemStore()
        let model = WorkItemModel(runtime: makeRuntime(), repository: makeRepository(stub), store: store)
        await stub.failMutations()

        let posted = await model.postComment(itemId: "abc", body: "Please review")
        #expect(!posted)
        let pending = try #require(model.pendingMutations.first)
        #expect(pending.kind == .comment)
        #expect(pending.commentPayload?.body == "Please review")
    }

    @Test
    @MainActor
    func aConflictingSaveIsReportedInsteadOfOverwriting() async throws {
        let stub = WorkItemVFSStub()
        await stub.seed(path: WorkItemPaths.item("abc"), content: "Body", metadataJson: try itemMetadata(captureId: "abc", title: "Title"))
        await stub.seed(path: WorkItemPaths.listMetadata("abc"), metadataJson: try listMetadata(title: "Title", lastActivityAt: 1))
        let model = WorkItemModel(runtime: makeRuntime(), repository: makeRepository(stub), store: nil)
        let detail = try #require(await model.loadDetail("abc"))
        await stub.forceConflict(at: WorkItemPaths.item("abc"))

        let saved = await model.update(detail, title: "Mine", body: "Mine body")

        #expect(!saved)
        let conflict = try #require(model.conflict)
        #expect(conflict.itemId == "abc")
        #expect(conflict.mine.title == "Mine")
        #expect(conflict.latest.item.id == "abc")
        #expect(model.actionError == nil)
        model.clearConflict()
        #expect(model.conflict == nil)
    }

    @Test
    @MainActor
    func aReaderCannotComment() async throws {
        let stub = WorkItemVFSStub()
        await stub.seed(path: WorkItemPaths.item("abc"), content: "Body", metadataJson: try itemMetadata(captureId: "abc", title: "Title"))
        let model = WorkItemModel(runtime: makeRuntime(role: .reader), repository: makeRepository(stub), store: nil)

        let posted = await model.postComment(itemId: "abc", body: "Nope")

        #expect(!posted)
        #expect(model.actionError != nil)
        #expect(await stub.recordedOperations().isEmpty)
    }

    @Test
    @MainActor
    func blankSearchClearsPreviousResults() async throws {
        let stub = WorkItemVFSStub()
        await stub.seed(path: WorkItemPaths.item("abc"), content: "Body", metadataJson: try itemMetadata(captureId: "abc", title: "Roof"))
        await stub.seed(path: WorkItemPaths.listMetadata("abc"), content: "", metadataJson: try listMetadata(title: "Roof", lastActivityAt: 1))
        await stub.setSearchHits([
            SearchNodeHit(path: WorkItemPaths.item("abc"), kind: .file, snippet: nil, previewExcerpt: "roof", matchReasons: ["content_fts"], score: 1)
        ])
        let model = WorkItemModel(runtime: makeRuntime(), repository: makeRepository(stub), store: nil)

        await model.search("roof")
        #expect(model.searchPhase == .results)
        #expect(model.isSearching)

        await model.search("   ")
        #expect(model.searchPhase == .idle)
        #expect(model.searchSnapshot.results.isEmpty)
        #expect(!model.isSearching)
    }

    @MainActor
    @Test
    func clearingTheSearchFieldRestoresTheListWithoutRequerying() async throws {
        let stub = WorkItemVFSStub()
        await stub.seed(path: WorkItemPaths.item("abc"), content: "Body", metadataJson: try itemMetadata(captureId: "abc", title: "Roof"))
        await stub.seed(path: WorkItemPaths.listMetadata("abc"), content: "", metadataJson: try listMetadata(title: "Roof", lastActivityAt: 1))
        await stub.setSearchHits([
            SearchNodeHit(path: WorkItemPaths.item("abc"), kind: .file, snippet: nil, previewExcerpt: "roof", matchReasons: ["content_fts"], score: 1)
        ])
        let model = WorkItemModel(runtime: makeRuntime(), repository: makeRepository(stub), store: nil)
        await model.search("roof")
        #expect(model.searchPhase == .results)

        // The text field keeps its value; only the results are dropped.
        model.searchQuery = "roof"
        model.clearSearchResults()

        #expect(model.searchPhase == .idle)
        #expect(model.searchSnapshot.results.isEmpty)
        #expect(model.searchQuery == "roof")
    }
}

extension WorkItemRepositoryTests {

    /// Seeds one item plus its projection and returns a model backed by the recording store.
    @MainActor
    private func makeStaleEditFixture() async throws -> (model: WorkItemModel, stub: WorkItemVFSStub, store: RecordingWorkItemStore, detail: WorkItemDetail) {
        let stub = WorkItemVFSStub()
        await stub.seed(path: WorkItemPaths.item("abc"), content: "Body", metadataJson: try itemMetadata(captureId: "abc", title: "Title"), updatedAt: 1)
        await stub.seed(path: WorkItemPaths.listMetadata("abc"), metadataJson: try listMetadata(title: "Title", lastActivityAt: 1))
        let store = RecordingWorkItemStore()
        let model = WorkItemModel(runtime: makeRuntime(), repository: makeRepository(stub), store: store)
        let detail = try #require(await model.loadDetail("abc"))

        await stub.failMutations()
        let saved = await model.update(detail, title: "Mine", body: "Mine body")
        #expect(!saved)
        return (model, stub, store, detail)
    }

    @MainActor
    @Test
    func retryingAStaleEditReportsAConflictInsteadOfOverwriting() async throws {
        let (model, stub, _, detail) = try await makeStaleEditFixture()
        let pending = try #require(model.pendingMutations.first { $0.kind == .edit })
        #expect(pending.editPayload?.baseEtag == detail.itemEtag)

        await stub.resumeMutations()
        // Another member saves while this input waits on the device.
        await stub.seed(path: WorkItemPaths.item("abc"), content: "Theirs", metadataJson: try itemMetadata(captureId: "abc", title: "Theirs"))

        await model.retryPendingMutation(pending)

        #expect(model.conflict != nil)
        let itemNode = try await stub.readNode(databaseId: "db", path: WorkItemPaths.item("abc"), session: session)
        #expect(itemNode?.content == "Theirs")
        #expect(model.pendingMutations.contains { $0.mutationId == pending.mutationId })
    }

    @MainActor
    @Test
    func retryingAnUnchangedEditSucceedsAndClearsTheKeptInput() async throws {
        let (model, stub, _, _) = try await makeStaleEditFixture()
        let pending = try #require(model.pendingMutations.first { $0.kind == .edit })

        await stub.resumeMutations()
        await model.retryPendingMutation(pending)

        #expect(model.conflict == nil)
        let itemNode = try await stub.readNode(databaseId: "db", path: WorkItemPaths.item("abc"), session: session)
        #expect(itemNode?.content == "Mine body")
        #expect(model.pendingMutations.isEmpty)
    }

    @MainActor
    @Test
    func abandoningAConflictDropsTheKeptEdit() async throws {
        let (model, _, _, _) = try await makeStaleEditFixture()
        #expect(model.pendingMutations.contains { $0.kind == .edit })

        model.abandonPendingEdits(itemId: "abc")

        #expect(model.pendingMutations.filter { $0.kind == .edit }.isEmpty)
    }

    @MainActor
    @Test
    func aRecentFetchIsRenderedFromCacheWithoutReading() async throws {
        let stub = WorkItemVFSStub()
        let store = RecordingWorkItemStore()
        try store.replaceListCache(
            principal: "2vxsx-fae",
            databaseId: "db",
            entries: [WorkItemListCacheRecord(itemId: "cached", title: "Cached", state: .open, commentCount: 1, updatedAt: 50)],
            fetchedAt: WorkItemModel.nowMilliseconds()
        )
        let model = WorkItemModel(runtime: makeRuntime(), repository: makeRepository(stub), store: store)

        await model.refresh()

        #expect(model.entries.map(\.id) == ["cached"])
        #expect(model.entries.first?.commentCount == 1)
        let reads = await stub.recordedReadPaths()
        #expect(reads.isEmpty)
    }

    @MainActor
    @Test
    func aStaleCacheStillRefreshesFromTheDatabase() async throws {
        let stub = WorkItemVFSStub()
        await stub.makeRootExist()
        await stub.seed(path: WorkItemPaths.directory("abc"), kind: .folder)
        await stub.seed(path: WorkItemPaths.item("abc"), content: "Body", metadataJson: try itemMetadata(captureId: "abc", title: "Fresh"), updatedAt: 5)
        await stub.seed(path: WorkItemPaths.listMetadata("abc"), metadataJson: try listMetadata(title: "Fresh", lastActivityAt: 5))
        let store = RecordingWorkItemStore()
        try store.replaceListCache(
            principal: "2vxsx-fae",
            databaseId: "db",
            entries: [WorkItemListCacheRecord(itemId: "abc", title: "Stale", state: .open, commentCount: 0, updatedAt: 1)],
            fetchedAt: WorkItemModel.nowMilliseconds() - WorkItemModel.cacheFreshnessWindowMilliseconds - 1
        )
        let model = WorkItemModel(runtime: makeRuntime(), repository: makeRepository(stub), store: store)

        await model.refresh()

        #expect(model.entries.map(\.title) == ["Fresh"])
        let reads = await stub.recordedReadPaths()
        #expect(!reads.isEmpty)
    }
}

@MainActor
private final class WorkItemRuntimeStub: WorkItemRuntimeProviding {
    let workItemPrincipal = "2vxsx-fae"
    let workItemIsSignedIn = true
    let workItemDatabase: DatabaseSummary?
    let workItemSession: KinicIdentitySession? = .testing()

    init(role: DatabaseRole = .owner) {
        workItemDatabase = DatabaseSummary(
            databaseId: "db",
            title: "Database",
            description: "",
            metadata: nil,
            role: role,
            status: .active,
            logicalSizeBytes: 0,
            cyclesBalance: nil,
            cyclesSuspendedAtMs: nil,
            deletedAtMs: nil
        )
    }
}

/// In-memory `WorkItemStoring` that records what the model kept on the device.
private final class RecordingWorkItemStore: WorkItemStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [WorkItemPendingMutation] = []
    private var listCaches: [String: [WorkItemListCacheRecord]] = [:]
    private var fetchedAtValues: [String: Int64] = [:]

    func upsertCapture(_ record: WorkItemCaptureRecord) throws {}
    func captures(principal: String) throws -> [WorkItemCaptureRecord] { [] }
    func markCaptureSent(id: String, at timestamp: Int64) throws {}
    func deleteCapture(id: String) throws {}
    func replaceListCache(principal: String, databaseId: String, entries: [WorkItemListCacheRecord], fetchedAt: Int64) throws {
        lock.lock()
        defer { lock.unlock() }
        listCaches[scopedKey(principal, databaseId)] = entries
        fetchedAtValues[scopedKey(principal, databaseId)] = fetchedAt
    }

    func listCache(principal: String, databaseId: String) throws -> [WorkItemListCacheRecord] {
        lock.lock()
        defer { lock.unlock() }
        return listCaches[scopedKey(principal, databaseId)] ?? []
    }

    func lastFetchedAt(principal: String, databaseId: String) throws -> Int64? {
        lock.lock()
        defer { lock.unlock() }
        return fetchedAtValues[scopedKey(principal, databaseId)]
    }

    private func scopedKey(_ principal: String, _ databaseId: String) -> String {
        "\(principal)|\(databaseId)"
    }

    func insertPendingMutation(_ mutation: WorkItemPendingMutation, principal: String, databaseId: String) throws {
        lock.lock()
        defer { lock.unlock() }
        stored.append(mutation)
    }
    func pendingMutations(principal: String, databaseId: String) throws -> [WorkItemPendingMutation] {
        lock.lock()
        defer { lock.unlock() }
        return stored
    }
    func deletePendingMutation(id: String) throws {
        lock.lock()
        defer { lock.unlock() }
        stored.removeAll { $0.mutationId == id }
    }
}

struct WorkItemModelTests {
    @Test @MainActor
    func createReturnsFalseAndKeepsAnErrorWhenNoStoragePathSucceeds() async {
        let vfs = WorkItemVFSStub()
        await vfs.failMutations()
        let model = WorkItemModel(
            runtime: WorkItemRuntimeStub(),
            repository: WorkItemRepository(vfs: vfs),
            store: nil
        )

        let saved = await model.create(body: "Keep this input", source: nil)

        #expect(!saved)
        #expect(model.actionError != nil)
    }

    @Test @MainActor
    func createReturnsFalseAndKeepsAnErrorWhenLocalPersistenceFails() async {
        let model = WorkItemModel(
            runtime: WorkItemRuntimeStub(),
            repository: WorkItemRepository(vfs: WorkItemVFSStub()),
            store: FailingWorkItemStore()
        )

        let saved = await model.create(body: "Keep this input", source: nil)

        #expect(!saved)
        #expect(model.actionError != nil)
    }
}

private struct FailingWorkItemStore: WorkItemStoring {
    func upsertCapture(_ record: WorkItemCaptureRecord) throws { throw WorkItemVFSStubError.mutationFailed }
    func captures(principal: String) throws -> [WorkItemCaptureRecord] { [] }
    func markCaptureSent(id: String, at timestamp: Int64) throws {}
    func deleteCapture(id: String) throws {}
    func replaceListCache(principal: String, databaseId: String, entries: [WorkItemListCacheRecord], fetchedAt: Int64) throws {}
    func listCache(principal: String, databaseId: String) throws -> [WorkItemListCacheRecord] { [] }
    func lastFetchedAt(principal: String, databaseId: String) throws -> Int64? { nil }
    func insertPendingMutation(_ mutation: WorkItemPendingMutation, principal: String, databaseId: String) throws {
        throw WorkItemVFSStubError.mutationFailed
    }
    func pendingMutations(principal: String, databaseId: String) throws -> [WorkItemPendingMutation] { [] }
    func deletePendingMutation(id: String) throws {}
}
