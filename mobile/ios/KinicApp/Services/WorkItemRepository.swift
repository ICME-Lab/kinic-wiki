// Where: mobile/ios/KinicApp/Services/WorkItemRepository.swift
// What: Reads and writes work items through the existing VFS document API.
// Why: The list projection, the authoritative body, and their etags must be handled in one place.

import Foundation

/// The subset of VFS operations work items need. Kept narrow so tests can fake the canister.
protocol WorkItemVFSProviding: Sendable {
    func listChildren(databaseId: String, path: String, session: KinicIdentitySession) async throws -> [ChildNode]
    func readNode(databaseId: String, path: String, session: KinicIdentitySession) async throws -> VFSNode?
    func mutateNodesBatch(
        databaseId: String,
        operations: [VFSNodeMutationOperation],
        session: KinicIdentitySession
    ) async throws -> [VFSNodeMutationOutcome]
    func searchNodes(
        databaseId: String,
        query: String,
        prefix: String?,
        limit: UInt32,
        session: KinicIdentitySession
    ) async throws -> [SearchNodeHit]
}

struct LiveWorkItemVFS: WorkItemVFSProviding {
    let client: KinicICClient

    func listChildren(databaseId: String, path: String, session: KinicIdentitySession) async throws -> [ChildNode] {
        try await client.listChildren(databaseId: databaseId, path: path, session: session)
    }

    func readNode(databaseId: String, path: String, session: KinicIdentitySession) async throws -> VFSNode? {
        try await client.readBrowseNode(databaseId: databaseId, path: path, session: session)
    }

    func mutateNodesBatch(
        databaseId: String,
        operations: [VFSNodeMutationOperation],
        session: KinicIdentitySession
    ) async throws -> [VFSNodeMutationOutcome] {
        try await client.mutateNodesBatch(databaseId: databaseId, operations: operations, session: session)
    }

    func searchNodes(
        databaseId: String,
        query: String,
        prefix: String?,
        limit: UInt32,
        session: KinicIdentitySession
    ) async throws -> [SearchNodeHit] {
        try await client.searchBrowseNodes(
            databaseId: databaseId,
            query: query,
            prefix: prefix,
            limit: limit,
            session: session
        )
    }
}

struct WorkItemCreateDraft: Equatable, Sendable {
    /// Client-generated UUID. Doubles as the capture identity for retry de-duplication.
    let id: String
    var title: String
    var body: String
    var author: String
    var source: WorkItemSource?
}

struct WorkItemRepository: Sendable {
    /// The UI displays the latest items after every candidate has been ranked by its metadata.
    static let maximumItems = 100
    /// The canister has no search cursor, so the same limit bounds how many comments are read.
    static let maximumComments = 100
    private static let maximumConcurrentReads = 6

    let vfs: any WorkItemVFSProviding
    private let clock: @Sendable () -> Int64

    init(vfs: any WorkItemVFSProviding, clock: @escaping @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        self.vfs = vfs
        self.clock = clock
    }

    func list(databaseId: String, session: KinicIdentitySession) async throws -> WorkItemListSnapshot {
        let children: [ChildNode]
        do {
            children = try await vfs.listChildren(databaseId: databaseId, path: WorkItemPaths.root, session: session)
        } catch {
            if Self.isMissingPath(error) {
                return WorkItemListSnapshot(entries: [], totalCount: 0, isTruncated: false, unreadableCount: 0)
            }
            throw error
        }
        let ids = children
            .filter { $0.kind == .folder }
            .compactMap { WorkItemPaths.itemId(fromPath: $0.path) }
            .sorted()
        let entries = await loadEntries(
            ids: ids,
            databaseId: databaseId,
            session: session
        )
        let sortedEntries = entries.entries.sorted { left, right in
            if left.sortKey != right.sortKey { return left.sortKey > right.sortKey }
            return left.id < right.id
        }
        return WorkItemListSnapshot(
            entries: Array(sortedEntries.prefix(Self.maximumItems)),
            totalCount: ids.count,
            isTruncated: sortedEntries.count > Self.maximumItems,
            unreadableCount: entries.unreadableCount
        )
    }

    func load(id: String, databaseId: String, session: KinicIdentitySession) async throws -> WorkItemDetail {
        guard let node = try await vfs.readNode(databaseId: databaseId, path: WorkItemPaths.item(id), session: session) else {
            throw WorkItemRepositoryError.notFound(WorkItemPaths.item(id))
        }
        let listNode = try await vfs.readNode(databaseId: databaseId, path: WorkItemPaths.listMetadata(id), session: session)
        let cached = listNode.flatMap(Self.listEntry(from:))
        switch WorkItemDocument.item(from: node) {
        case .loaded(let item):
            return WorkItemDetail(
                item: item,
                itemEtag: node.etag,
                listEtag: listNode?.etag,
                commentCount: cached?.commentCount ?? 0,
                unsupportedVersion: nil
            )
        case .unsupportedVersion(let version):
            return WorkItemDetail(
                item: WorkItem(
                    id: id,
                    captureId: "",
                    title: "",
                    state: .open,
                    body: node.content,
                    createdBy: "",
                    createdAt: node.createdAt,
                    updatedAt: node.updatedAt,
                    etag: node.etag,
                    source: nil
                ),
                itemEtag: node.etag,
                listEtag: listNode?.etag,
                commentCount: cached?.commentCount ?? 0,
                unsupportedVersion: version
            )
        case .malformed:
            throw WorkItemRepositoryError.malformedMetadata(WorkItemPaths.item(id))
        }
    }

    func create(_ draft: WorkItemCreateDraft, databaseId: String, session: KinicIdentitySession) async throws -> WorkItem {
        let now = clock()
        let itemMetadata = WorkItemDocument.ItemMetadata(
            version: WorkItemDocument.currentVersion,
            captureId: draft.id,
            title: draft.title,
            state: WorkItemState.open.rawValue,
            createdBy: draft.author,
            createdAt: now,
            source: draft.source
        )
        let projected = WorkItem(
            id: draft.id,
            captureId: draft.id,
            title: draft.title,
            state: .open,
            body: draft.body,
            createdBy: draft.author,
            createdAt: now,
            updatedAt: now,
            etag: "",
            source: draft.source
        )
        let listMetadata = WorkItemDocument.listMetadata(for: projected, commentCount: 0, lastActivityAt: now)
        let itemPath = WorkItemPaths.item(draft.id)
        let operations: [VFSNodeMutationOperation] = [
            .mkdir(path: WorkItemPaths.root),
            .mkdir(path: WorkItemPaths.directory(draft.id)),
            .mkdir(path: WorkItemPaths.commentsDirectory(draft.id)),
            .write(VFSWriteNodeItem(content: draft.body, kind: .file, path: itemPath, expectedEtag: nil, metadataJson: try WorkItemDocument.encode(itemMetadata))),
            .write(VFSWriteNodeItem(content: "", kind: .file, path: WorkItemPaths.listMetadata(draft.id), expectedEtag: nil, metadataJson: try WorkItemDocument.encode(listMetadata)))
        ]
        do {
            let outcomes = try await vfs.mutateNodesBatch(databaseId: databaseId, operations: operations, session: session)
            guard let ack = Self.writeAck(in: outcomes, path: itemPath) else {
                throw WorkItemRepositoryError.invalidResponse("work item write acknowledgement was missing")
            }
            return WorkItem(
                id: projected.id,
                captureId: projected.captureId,
                title: projected.title,
                state: projected.state,
                body: projected.body,
                createdBy: projected.createdBy,
                createdAt: projected.createdAt,
                updatedAt: ack.updatedAt,
                etag: ack.etag,
                source: projected.source
            )
        } catch let VFSCandidError.nodeMutationRejected(failure) where failure.code == .etagConflict {
            // A lost response turns a retry into an etag conflict with this device's own write.
            if let existing = try await vfs.readNode(databaseId: databaseId, path: itemPath, session: session),
               case .loaded(let item) = WorkItemDocument.item(from: existing),
               item.captureId == draft.id {
                return item
            }
            throw WorkItemRepositoryError.etagConflict(failure.conflictPath ?? itemPath)
        }
    }

    func update(
        _ item: WorkItem,
        previousItemEtag: String,
        previousListEtag: String?,
        commentCount: Int,
        databaseId: String,
        session: KinicIdentitySession
    ) async throws -> WorkItem {
        let itemPath = WorkItemPaths.item(item.id)
        do {
            return try await writeItemAndProjection(
                item,
                itemEtag: previousItemEtag,
                listEtag: previousListEtag,
                commentCount: commentCount,
                databaseId: databaseId,
                session: session
            )
        } catch let VFSCandidError.nodeMutationRejected(failure) where failure.code == .etagConflict {
            // Only the body document decides a conflict. Comments rewrite the derived projection, so a
            // comment that landed mid-edit must not fail a body write.
            guard await itemStillMatches(itemPath, expectedEtag: previousItemEtag, databaseId: databaseId, session: session) else {
                throw WorkItemRepositoryError.etagConflict(failure.conflictPath ?? itemPath)
            }
            let listNode = (try? await vfs.readNode(databaseId: databaseId, path: WorkItemPaths.listMetadata(item.id), session: session)) ?? nil
            // The projection moved, so its count is the newer one.
            let currentCount = listNode.flatMap(Self.listEntry(from:))?.commentCount ?? commentCount
            do {
                return try await writeItemAndProjection(
                    item,
                    itemEtag: previousItemEtag,
                    listEtag: listNode?.etag,
                    commentCount: currentCount,
                    databaseId: databaseId,
                    session: session
                )
            } catch let VFSCandidError.nodeMutationRejected(retryFailure) where retryFailure.code == .etagConflict {
                throw WorkItemRepositoryError.etagConflict(retryFailure.conflictPath ?? itemPath)
            }
        }
    }

    /// Writes the authoritative body and the derived projection in one transaction.
    private func writeItemAndProjection(
        _ item: WorkItem,
        itemEtag: String,
        listEtag: String?,
        commentCount: Int,
        databaseId: String,
        session: KinicIdentitySession
    ) async throws -> WorkItem {
        let now = clock()
        let itemMetadata = WorkItemDocument.ItemMetadata(
            version: WorkItemDocument.currentVersion,
            captureId: item.captureId,
            title: item.title,
            state: item.state.rawValue,
            createdBy: item.createdBy,
            createdAt: item.createdAt,
            source: item.source
        )
        let listMetadata = WorkItemDocument.listMetadata(
            for: item,
            commentCount: commentCount,
            lastActivityAt: now
        )
        let itemPath = WorkItemPaths.item(item.id)
        let operations: [VFSNodeMutationOperation] = [
            .write(VFSWriteNodeItem(content: item.body, kind: .file, path: itemPath, expectedEtag: itemEtag, metadataJson: try WorkItemDocument.encode(itemMetadata))),
            .write(VFSWriteNodeItem(content: "", kind: .file, path: WorkItemPaths.listMetadata(item.id), expectedEtag: listEtag, metadataJson: try WorkItemDocument.encode(listMetadata)))
        ]
        let outcomes = try await vfs.mutateNodesBatch(databaseId: databaseId, operations: operations, session: session)
        guard let ack = Self.writeAck(in: outcomes, path: itemPath) else {
            throw WorkItemRepositoryError.invalidResponse("work item write acknowledgement was missing")
        }
        return WorkItem(
            id: item.id,
            captureId: item.captureId,
            title: item.title,
            state: item.state,
            body: item.body,
            createdBy: item.createdBy,
            createdAt: item.createdAt,
            updatedAt: ack.updatedAt,
            etag: ack.etag,
            source: item.source
        )
    }

    private func itemStillMatches(
        _ path: String,
        expectedEtag: String,
        databaseId: String,
        session: KinicIdentitySession
    ) async -> Bool {
        let node = (try? await vfs.readNode(databaseId: databaseId, path: path, session: session)) ?? nil
        return node?.etag == expectedEtag
    }

    func setState(
        _ detail: WorkItemDetail,
        state: WorkItemState,
        databaseId: String,
        session: KinicIdentitySession
    ) async throws -> WorkItem {
        var item = detail.item
        item.state = state
        return try await update(
            item,
            previousItemEtag: detail.itemEtag,
            previousListEtag: detail.listEtag,
            commentCount: detail.commentCount,
            databaseId: databaseId,
            session: session
        )
    }

    // MARK: - Comments

    /// Reads the comment documents for one item. Comments are append-only, so this never writes.
    func loadComments(
        itemId: String,
        databaseId: String,
        session: KinicIdentitySession
    ) async throws -> [WorkItemComment] {
        let children = try await commentChildren(itemId: itemId, databaseId: databaseId, session: session)
        let ids = children.prefix(Self.maximumComments).map(\.id)
        return await loadCommentBodies(ids: ids, itemId: itemId, databaseId: databaseId, session: session)
    }

    /// Recomputes the derived list document from the authoritative item and the comment folder.
    /// Retries because the projection has no lock: a concurrent comment may hold a newer etag.
    func refreshCommentProjection(
        itemId: String,
        databaseId: String,
        session: KinicIdentitySession
    ) async {
        for _ in 0..<3 {
            do {
                // Read the projection first. Any item edit after this point also changes its etag,
                // so the write below conflicts instead of restoring stale title or state values.
                let listNode = try await vfs.readNode(
                    databaseId: databaseId,
                    path: WorkItemPaths.listMetadata(itemId),
                    session: session
                )
                guard let itemNode = try await vfs.readNode(
                    databaseId: databaseId,
                    path: WorkItemPaths.item(itemId),
                    session: session
                ), case .loaded(let item) = WorkItemDocument.item(from: itemNode) else {
                    return
                }
                let children = try await commentChildren(itemId: itemId, databaseId: databaseId, session: session)
                try await rewriteListMetadata(
                    itemId: itemId,
                    title: item.title,
                    state: item.state,
                    commentCount: children.count,
                    lastActivityAt: max(children.first?.updatedAt ?? 0, item.updatedAt),
                    previousListEtag: listNode?.etag,
                    databaseId: databaseId,
                    session: session
                )
                return
            } catch let VFSCandidError.nodeMutationRejected(failure) where failure.code == .etagConflict {
                // Another writer touched the projection. Re-read every source and try again.
                continue
            } catch {
                return
            }
        }
    }

    /// Comment document names with their file timestamps, newest first.
    private func commentChildren(
        itemId: String,
        databaseId: String,
        session: KinicIdentitySession
    ) async throws -> [(id: String, updatedAt: Int64)] {
        let directory = WorkItemPaths.commentsDirectory(itemId)
        let children: [ChildNode]
        do {
            children = try await vfs.listChildren(databaseId: databaseId, path: directory, session: session)
        } catch {
            if Self.isMissingPath(error) { return [] }
            throw error
        }
        // Newest first before trimming: a read limit must drop the oldest comments, not random ones.
        return children
            .compactMap { child -> (id: String, updatedAt: Int64)? in
                guard let name = child.path.split(separator: "/").last.map(String.init), name.hasSuffix(".md") else {
                    return nil
                }
                return (String(name.dropLast(3)), child.updatedAt ?? 0)
            }
            .sorted { left, right in
                if left.updatedAt != right.updatedAt { return left.updatedAt > right.updatedAt }
                return left.id < right.id
            }
    }

    /// Appends one comment. The body document is never touched, so concurrent comments cannot conflict.
    func postComment(
        _ draft: WorkItemCommentDraft,
        itemId: String,
        databaseId: String,
        session: KinicIdentitySession
    ) async throws -> WorkItemComment {
        let trimmed = draft.body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw WorkItemRepositoryError.invalidResponse("a comment needs a body")
        }
        let path = WorkItemPaths.comment(itemId: itemId, commentId: draft.id)
        let metadata = WorkItemDocument.CommentMetadata(
            version: WorkItemDocument.currentVersion,
            author: draft.author,
            createdAt: draft.createdAt
        )
        let operations: [VFSNodeMutationOperation] = [
            // Idempotent: recreates the folder if it is missing and costs nothing when it exists.
            .mkdir(path: WorkItemPaths.commentsDirectory(itemId)),
            .write(VFSWriteNodeItem(content: draft.body, kind: .file, path: path, expectedEtag: nil, metadataJson: try WorkItemDocument.encode(metadata)))
        ]
        do {
            _ = try await vfs.mutateNodesBatch(databaseId: databaseId, operations: operations, session: session)
        } catch let VFSCandidError.nodeMutationRejected(failure) where failure.code == .etagConflict {
            // A lost response makes a retry collide with this device's own comment.
            let existing = (try? await vfs.readNode(databaseId: databaseId, path: path, session: session)) ?? nil
            if existing?.content == draft.body {
                return WorkItemComment(id: draft.id, itemId: itemId, body: draft.body, author: draft.author, createdAt: draft.createdAt)
            }
            throw WorkItemRepositoryError.etagConflict(failure.conflictPath ?? path)
        }
        return WorkItemComment(id: draft.id, itemId: itemId, body: draft.body, author: draft.author, createdAt: draft.createdAt)
    }

    /// Rewrites only the derived list document. Never touches the authoritative body.
    @discardableResult
    func rewriteListMetadata(
        itemId: String,
        title: String,
        state: WorkItemState,
        commentCount: Int,
        lastActivityAt: Int64,
        previousListEtag: String?,
        databaseId: String,
        session: KinicIdentitySession
    ) async throws -> String? {
        let metadata = WorkItemDocument.ListMetadata(
            version: WorkItemDocument.currentVersion,
            title: title,
            state: state.rawValue,
            commentCount: commentCount,
            lastActivityAt: lastActivityAt
        )
        let path = WorkItemPaths.listMetadata(itemId)
        let outcomes = try await vfs.mutateNodesBatch(
            databaseId: databaseId,
            operations: [
                .write(VFSWriteNodeItem(content: "", kind: .file, path: path, expectedEtag: previousListEtag, metadataJson: try WorkItemDocument.encode(metadata)))
            ],
            session: session
        )
        return Self.writeAck(in: outcomes, path: path)?.etag
    }

    // MARK: - Search

    /// Searches below `/WorkItems` only and folds comment matches into their parent item.
    /// The canister exposes no search cursor, so at most `maximumItems` hits are ever visible.
    func search(
        databaseId: String,
        query: String,
        session: KinicIdentitySession
    ) async throws -> WorkItemSearchSnapshot {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return WorkItemSearchSnapshot(results: [], hitCount: 0, isCapped: false)
        }
        let hits = try await vfs.searchNodes(
            databaseId: databaseId,
            query: trimmed,
            // The canister rejects a prefix that ends with "/".
            prefix: WorkItemPaths.root,
            limit: UInt32(Self.maximumItems),
            session: session
        )
        var seen = Set<String>()
        var ranked: [String] = []
        var snippets: [String: String] = [:]
        var commentHits: [String: Int] = [:]
        for hit in hits {
            guard let itemId = WorkItemPaths.itemId(fromPath: hit.path) else { continue }
            if seen.insert(itemId).inserted {
                ranked.append(itemId)
            }
            if hit.path.hasPrefix("\(WorkItemPaths.commentsDirectory(itemId))/") {
                commentHits[itemId, default: 0] += 1
            } else if snippets[itemId] == nil, !hit.displayPreview.isEmpty {
                snippets[itemId] = hit.displayPreview
            }
        }
        let resolved = await resolveSearchResults(
            itemIds: ranked,
            snippets: snippets,
            commentHits: commentHits,
            databaseId: databaseId,
            session: session
        )
        return WorkItemSearchSnapshot(
            results: resolved,
            hitCount: hits.count,
            isCapped: hits.count >= Self.maximumItems
        )
    }

    private func resolveSearchResults(
        itemIds: [String],
        snippets: [String: String],
        commentHits: [String: Int],
        databaseId: String,
        session: KinicIdentitySession
    ) async -> [WorkItemSearchResult] {
        guard !itemIds.isEmpty else { return [] }
        var resolved: [String: WorkItemSearchResult] = [:]
        await withTaskGroup(of: (String, WorkItemSearchResult?).self) { group in
            var pending = itemIds.makeIterator()
            var active = 0
            while active < Self.maximumConcurrentReads, let id = pending.next() {
                group.addTask { (id, await self.loadSearchResult(id: id, databaseId: databaseId, session: session)) }
                active += 1
            }
            while let (id, result) = await group.next() {
                if let result {
                    resolved[id] = result
                }
                if let id = pending.next() {
                    group.addTask { (id, await self.loadSearchResult(id: id, databaseId: databaseId, session: session)) }
                }
            }
        }
        // Rank order from the canister is preserved; unresolved items are dropped.
        return itemIds.compactMap { itemId in
            guard var result = resolved[itemId] else { return nil }
            result.snippet = snippets[itemId]
            result.matchedCommentCount = commentHits[itemId] ?? 0
            return result
        }
    }

    private func loadSearchResult(
        id: String,
        databaseId: String,
        session: KinicIdentitySession
    ) async -> WorkItemSearchResult? {
        let listNode = (try? await vfs.readNode(databaseId: databaseId, path: WorkItemPaths.listMetadata(id), session: session)) ?? nil
        if let listNode, case .loaded(let entry) = WorkItemDocument.listEntry(from: listNode) {
            return WorkItemSearchResult(
                id: id,
                title: entry.title,
                state: entry.state,
                snippet: nil,
                matchedCommentCount: 0,
                isUnsupportedVersion: false
            )
        }
        guard let itemNode = (try? await vfs.readNode(databaseId: databaseId, path: WorkItemPaths.item(id), session: session)) ?? nil else {
            return nil
        }
        switch WorkItemDocument.item(from: itemNode) {
        case .loaded(let item):
            return WorkItemSearchResult(
                id: id,
                title: item.title,
                state: item.state,
                snippet: nil,
                matchedCommentCount: 0,
                isUnsupportedVersion: false
            )
        case .unsupportedVersion:
            return WorkItemSearchResult(
                id: id,
                title: "",
                state: nil,
                snippet: nil,
                matchedCommentCount: 0,
                isUnsupportedVersion: true
            )
        case .malformed:
            return nil
        }
    }

    private func loadCommentBodies(
        ids: [String],
        itemId: String,
        databaseId: String,
        session: KinicIdentitySession
    ) async -> [WorkItemComment] {
        guard !ids.isEmpty else { return [] }
        var comments: [WorkItemComment] = []
        await withTaskGroup(of: WorkItemComment?.self) { group in
            var pending = ids.makeIterator()
            var active = 0
            while active < Self.maximumConcurrentReads, let id = pending.next() {
                group.addTask { await self.loadComment(id: id, itemId: itemId, databaseId: databaseId, session: session) }
                active += 1
            }
            while let result = await group.next() {
                if let result {
                    comments.append(result)
                }
                if let id = pending.next() {
                    group.addTask { await self.loadComment(id: id, itemId: itemId, databaseId: databaseId, session: session) }
                }
            }
        }
        // Displayed oldest first, regardless of the order they were read in.
        return comments.sorted { left, right in
            if left.createdAt != right.createdAt { return left.createdAt < right.createdAt }
            return left.id < right.id
        }
    }

    private func loadComment(
        id: String,
        itemId: String,
        databaseId: String,
        session: KinicIdentitySession
    ) async -> WorkItemComment? {
        let path = WorkItemPaths.comment(itemId: itemId, commentId: id)
        guard let node = (try? await vfs.readNode(databaseId: databaseId, path: path, session: session)) ?? nil else {
            return nil
        }
        switch WorkItemDocument.comment(from: node) {
        case .loaded(let document):
            return WorkItemComment(
                id: id,
                itemId: itemId,
                body: document.body,
                author: document.metadata.author,
                createdAt: document.metadata.createdAt
            )
        case .unsupportedVersion, .malformed:
            return nil
        }
    }

    private func loadEntries(
        ids: [String],
        databaseId: String,
        session: KinicIdentitySession
    ) async -> (entries: [WorkItemListEntry], unreadableCount: Int) {
        guard !ids.isEmpty else { return ([], 0) }
        var entries: [WorkItemListEntry] = []
        var unreadableCount = 0
        await withTaskGroup(of: WorkItemListEntry?.self) { group in
            var pending = ids.makeIterator()
            var active = 0
            while active < Self.maximumConcurrentReads, let id = pending.next() {
                group.addTask { try? await self.loadEntry(id: id, databaseId: databaseId, session: session) }
                active += 1
            }
            while let result = await group.next() {
                if let result {
                    entries.append(result)
                } else {
                    unreadableCount += 1
                }
                if let id = pending.next() {
                    group.addTask { try? await self.loadEntry(id: id, databaseId: databaseId, session: session) }
                }
            }
        }
        return (entries, unreadableCount)
    }

    private func loadEntry(id: String, databaseId: String, session: KinicIdentitySession) async throws -> WorkItemListEntry? {
        let listNode = try await vfs.readNode(databaseId: databaseId, path: WorkItemPaths.listMetadata(id), session: session)
        if let listNode,
           let entry = Self.listEntry(from: listNode) {
            return entry
        }
        guard let itemNode = try await vfs.readNode(databaseId: databaseId, path: WorkItemPaths.item(id), session: session) else {
            return nil
        }
        switch WorkItemDocument.item(from: itemNode) {
        case .loaded(let item):
            // The projection is gone, so recover the activity from the comment folder it summarizes.
            let comments = (try? await commentChildren(itemId: id, databaseId: databaseId, session: session)) ?? []
            let entry = WorkItemDocument.entry(
                from: item,
                commentCount: comments.count,
                lastActivityAt: max(comments.first?.updatedAt ?? 0, item.updatedAt)
            )
            await rebuildListMetadata(entry: entry, expectedEtag: listNode?.etag, databaseId: databaseId, session: session)
            return entry
        case .unsupportedVersion:
            return WorkItemListEntry(
                id: id,
                title: "",
                state: .open,
                commentCount: 0,
                updatedAt: itemNode.updatedAt,
                isUnsupportedVersion: true
            )
        case .malformed:
            return nil
        }
    }

    /// Restores a missing or unreadable `meta.md` from the authoritative `item.md`.
    private func rebuildListMetadata(entry: WorkItemListEntry, expectedEtag: String?, databaseId: String, session: KinicIdentitySession) async {
        guard let metadata = try? WorkItemDocument.encode(
            WorkItemDocument.ListMetadata(
                version: WorkItemDocument.currentVersion,
                title: entry.title,
                state: entry.state.rawValue,
                commentCount: entry.commentCount,
                lastActivityAt: entry.updatedAt
            )
        ) else {
            return
        }
        _ = try? await vfs.mutateNodesBatch(
            databaseId: databaseId,
            operations: [
                .write(VFSWriteNodeItem(content: "", kind: .file, path: WorkItemPaths.listMetadata(entry.id), expectedEtag: expectedEtag, metadataJson: metadata))
            ],
            session: session
        )
    }

    private static func listEntry(from node: VFSNode) -> WorkItemListEntry? {
        guard case .loaded(let entry) = WorkItemDocument.listEntry(from: node) else { return nil }
        return entry
    }

    private static func writeAck(in outcomes: [VFSNodeMutationOutcome], path: String) -> VFSNodeMutationAck? {
        for outcome in outcomes {
            if case .wrote(_, let node) = outcome, node.path == path {
                return node
            }
        }
        return nil
    }

    private static func isMissingPath(_ error: Error) -> Bool {
        guard case VFSCandidError.canisterRejected(let message) = error else { return false }
        return message.hasPrefix("path not found")
    }
}

enum WorkItemRepositoryError: Error, LocalizedError, Equatable {
    case notFound(String)
    case malformedMetadata(String)
    case etagConflict(String)
    case invalidResponse(String)

    var errorDescription: String? {
        switch self {
        case .notFound(let path): "Work item not found: \(path)"
        case .malformedMetadata(let path): "Work item metadata is not readable: \(path)"
        case .etagConflict(let path): "Work item changed since it was loaded: \(path)"
        case .invalidResponse(let message): message
        }
    }
}
