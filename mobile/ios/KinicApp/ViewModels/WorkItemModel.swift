// Where: mobile/ios/KinicApp/ViewModels/WorkItemModel.swift
// What: Main-actor coordination for the Home work item list.
// Why: Local capture state and database state must stay distinguishable in one place.

import Foundation
import Observation

@MainActor
protocol WorkItemRuntimeProviding: AnyObject {
    var workItemPrincipal: String { get }
    var workItemIsSignedIn: Bool { get }
    /// The database currently chosen on Home. Reading needs `canRead`; writing needs `canWrite`.
    var workItemDatabase: DatabaseSummary? { get }
    var workItemSession: KinicIdentitySession? { get }
}

@MainActor
@Observable
final class WorkItemModel {
    enum Phase: Equatable {
        case idle
        case loading
        case ready
        case failed(String)
    }

    enum SearchPhase: Equatable {
        case idle
        case searching
        case results
        case empty
        case failed(String)
    }

    /// Local captures only. Never reported as shared until the canister accepts them.
    private(set) var localCaptures: [WorkItemCaptureRecord] = []
    private(set) var entries: [WorkItemListEntry] = []
    private(set) var phase: Phase = .idle
    private(set) var lastFetchedAt: Int64?
    private(set) var totalCount = 0
    private(set) var isTruncated = false
    private(set) var unreadableCount = 0
    var actionError: String?
    var isSaving = false

    // Comments for the item currently open in the detail view.
    private(set) var comments: [WorkItemComment] = []
    private(set) var isLoadingComments = false
    var isPostingComment = false

    // Search
    var searchQuery = ""
    private(set) var searchPhase: SearchPhase = .idle
    private(set) var searchSnapshot = WorkItemSearchSnapshot(results: [], hitCount: 0, isCapped: false)

    // Input the database did not confirm. Replayed only when the member asks.
    private(set) var pendingMutations: [WorkItemPendingMutation] = []

    /// A save the database rejected because another member wrote first. Never applied silently.
    var conflict: WorkItemConflict?

    private let runtime: any WorkItemRuntimeProviding
    private let repository: WorkItemRepository
    private let store: (any WorkItemStoring)?
    /// The derived cache the home screen widget renders. `nil` in previews and most unit tests.
    private let widgetSnapshot: (any WorkItemWidgetSnapshotWriting)?
    /// Input the Share Extension stored outside this process.
    private let pendingCaptures: PendingWorkItemCaptureQueue?
    private var loadGeneration = 0
    private var searchGeneration = 0
    private var commentsGeneration = 0
    private var renderedDatabaseId: String?
    private var renderedPrincipal: String?

    init(
        runtime: any WorkItemRuntimeProviding,
        repository: WorkItemRepository,
        store: (any WorkItemStoring)?,
        widgetSnapshot: (any WorkItemWidgetSnapshotWriting)? = nil,
        pendingCaptures: PendingWorkItemCaptureQueue? = nil
    ) {
        self.runtime = runtime
        self.repository = repository
        self.store = store
        self.widgetSnapshot = widgetSnapshot
        self.pendingCaptures = pendingCaptures
    }

    convenience init(appModel: AppModel) {
        self.init(
            runtime: appModel,
            repository: appModel.workItemRepository,
            store: appModel.workItemStore,
            widgetSnapshot: appModel,
            pendingCaptures: appModel.workItemPendingCaptureQueue
        )
    }

    var databaseId: String? {
        guard let database = runtime.workItemDatabase, !database.databaseId.isEmpty else {
            return nil
        }
        return database.databaseId
    }

    var canWrite: Bool {
        runtime.workItemDatabase?.canWrite == true
    }

    var canRead: Bool {
        runtime.workItemDatabase != nil && runtime.workItemIsSignedIn
    }

    /// Invalidate old DB/account content synchronously before starting another fetch.
    func resetContext() {
        loadGeneration += 1
        commentsGeneration += 1
        clearSearch()
        entries = []
        comments = []
        phase = .idle
        actionError = nil
        conflict = nil
        isLoadingComments = false
        totalCount = 0
        isTruncated = false
        unreadableCount = 0
        lastFetchedAt = nil
        renderedDatabaseId = nil
        renderedPrincipal = nil
        refreshLocalCaptures()
        refreshPendingMutations()
    }

    /// Renders the cached list first, then refreshes unless the last fetch was recent.
    func refresh(force: Bool = false) async {
        refreshLocalCaptures()
        refreshPendingMutations()
        await refreshRemote(force: force)
    }

    func refreshLocalCaptures() {
        guard let store else {
            localCaptures = []
            return
        }
        let principal = runtime.workItemPrincipal
        // Committed captures belong to the database list, not to the device-only section.
        localCaptures = ((try? store.captures(principal: principal)) ?? []).filter { $0.state == .local }
    }

    func refreshRemote(force: Bool = false) async {
        loadGeneration += 1
        let generation = loadGeneration
        guard let databaseId = databaseId, let session = runtime.workItemSession else {
            entries = []
            phase = .idle
            renderedDatabaseId = nil
            renderedPrincipal = nil
            return
        }
        resetRenderedListIfDatabaseChanged(databaseId)
        applyCachedList(databaseId: databaseId)

        // Re-reading every item document is expensive, so a recent fetch is reused.
        guard force || !isCacheFresh(databaseId: databaseId) else {
            phase = entries.isEmpty ? .idle : .ready
            // The cached rows are what the widget shows; rewriting them also refreshes its database list.
            widgetSnapshot?.workItemListDidLoad(
                databaseId: databaseId,
                entries: entries,
                fetchedAt: lastFetchedAt ?? Self.nowMilliseconds()
            )
            return
        }

        phase = entries.isEmpty ? .loading : .ready
        do {
            let snapshot = try await repository.list(databaseId: databaseId, session: session)
            guard generation == loadGeneration,
                  databaseId == self.databaseId,
                  runtime.workItemPrincipal == session.principal else { return }
            entries = snapshot.entries
            totalCount = snapshot.totalCount
            isTruncated = snapshot.isTruncated
            unreadableCount = snapshot.unreadableCount
            let fetchedAt = Self.nowMilliseconds()
            lastFetchedAt = fetchedAt
            cacheList(snapshot: snapshot, databaseId: databaseId, fetchedAt: fetchedAt)
            widgetSnapshot?.workItemListDidLoad(
                databaseId: databaseId,
                entries: snapshot.entries,
                fetchedAt: fetchedAt
            )
            actionError = nil
            phase = .ready
        } catch {
            guard generation == loadGeneration,
                  databaseId == self.databaseId,
                  runtime.workItemPrincipal == session.principal else { return }
            // Whatever the cache already shows stays visible; the failure is still reported.
            let message = Self.message(for: error)
            actionError = message
            phase = entries.isEmpty ? .failed(message) : .ready
            // The widget must not keep showing titles for a database the app can no longer read.
            if Self.isDefinitiveAccessLoss(error) {
                widgetSnapshot?.workItemListDidLoseAccess(databaseId: databaseId)
            }
        }
    }

    /// Clears the previous database's list so its counters never describe another database.
    private func resetRenderedListIfDatabaseChanged(_ databaseId: String) {
        let principal = runtime.workItemPrincipal
        guard renderedDatabaseId != databaseId || renderedPrincipal != principal else { return }
        renderedDatabaseId = databaseId
        renderedPrincipal = principal
        clearSearch()
        entries = []
        totalCount = 0
        isTruncated = false
        unreadableCount = 0
        lastFetchedAt = nil
    }

    /// Renders the last fetched list for this database. Returns whether anything was shown.
    @discardableResult
    private func applyCachedList(databaseId: String) -> Bool {
        guard let store else { return false }
        let principal = runtime.workItemPrincipal
        let cached = (try? store.listCache(principal: principal, databaseId: databaseId)) ?? []
        guard !cached.isEmpty else { return false }
        entries = cached.map {
            WorkItemListEntry(
                id: $0.itemId,
                title: $0.title,
                state: $0.state,
                commentCount: $0.commentCount,
                updatedAt: $0.updatedAt,
                isUnsupportedVersion: false
            )
        }
        lastFetchedAt = (try? store.lastFetchedAt(principal: principal, databaseId: databaseId)) ?? nil
        return true
    }

    private func isCacheFresh(databaseId: String) -> Bool {
        guard let store,
              let fetchedAt = (try? store.lastFetchedAt(principal: runtime.workItemPrincipal, databaseId: databaseId)) ?? nil else {
            return false
        }
        return Self.nowMilliseconds() - fetchedAt < Self.cacheFreshnessWindowMilliseconds
    }

    /// Saves the input on this device first, then tries to commit it to the database.
    /// - Parameter title: An explicit title from Browse or Ask AI. Empty falls back to the first line.
    /// - Returns: whether the input is safely stored somewhere.
    @discardableResult
    func create(title: String? = nil, body: String, source: WorkItemSource?) async -> Bool {
        let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        let principal = runtime.workItemPrincipal
        let databaseId = databaseId
        let now = Self.nowMilliseconds()
        let captureId = UUID().uuidString.lowercased()
        let sources = source.map { [$0] } ?? []
        let explicitTitle = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let provisionalTitle = explicitTitle.isEmpty
            ? Self.provisionalTitle(from: body)
            : String(explicitTitle.prefix(120))
        let record = WorkItemCaptureRecord(
            captureId: captureId,
            principal: principal,
            databaseId: databaseId,
            origin: source?.kind ?? .text,
            rawText: body,
            provisionalTitle: provisionalTitle,
            transcript: nil,
            audioRelativePath: nil,
            audioDurationMs: nil,
            sourceRefs: sources,
            state: .local,
            baseEtag: nil,
            aiSuggestionJson: nil,
            createdAt: now,
            updatedAt: now,
            sentAt: nil
        )
        if let store {
            do {
                try store.upsertCapture(record)
            } catch {
                actionError = Self.message(for: error)
                return false
            }
            refreshLocalCaptures()
            await send(record)
            return true
        }
        // Without a local store the input only survives if the database accepts it now.
        return await send(record)
    }

    /// Retries one locally stored capture without changing its destination database.
    func retryLocalCapture(_ captureId: String) async {
        guard let record = localCaptures.first(where: { $0.captureId == captureId }) else { return }
        await send(record)
    }

    /// Explicitly choose a destination only for a capture that has never had one.
    func assignDestination(captureId: String, databaseId: String) {
        guard let store, var record = localCaptures.first(where: { $0.captureId == captureId }),
              record.databaseId == nil, !databaseId.isEmpty else { return }
        record.databaseId = databaseId
        do {
            try store.upsertCapture(record)
            refreshLocalCaptures()
        } catch { actionError = Self.message(for: error) }
    }

    func discardLocalCapture(_ captureId: String) {
        guard let store else { return }
        do {
            try store.deleteCapture(id: captureId)
            actionError = nil
        } catch {
            actionError = Self.message(for: error)
        }
        refreshLocalCaptures()
    }

    /// Moves items the Share Extension queued outside this process into the device store,
    /// then sends the ones that target the database Home already has selected.
    func importQueuedCaptures() async {
        guard let store, let pendingCaptures else { return }
        let principal = runtime.workItemPrincipal
        var imported: [WorkItemCaptureRecord] = []
        for capture in pendingCaptures.load() where capture.principal == principal {
            guard runtime.workItemPrincipal == principal,
                  runtime.workItemSession?.principal == principal else { break }
            let record = capture.captureRecord()
            do {
                try store.upsertCapture(record)
            } catch {
                actionError = Self.message(for: error)
                continue
            }
            pendingCaptures.remove(capture)
            imported.append(record)
        }
        guard !imported.isEmpty else { return }
        refreshLocalCaptures()
        for record in imported where canSendFromHome(record) {
            guard runtime.workItemPrincipal == principal,
                  runtime.workItemSession?.principal == principal else { break }
            await send(record)
        }
    }

    /// A queued capture is only sent when Home already targets its frozen database.
    private func canSendFromHome(_ record: WorkItemCaptureRecord) -> Bool {
        guard let database = runtime.workItemDatabase else { return false }
        return database.databaseId == record.databaseId && database.canWrite
            && record.principal == runtime.workItemPrincipal
            && record.principal == runtime.workItemSession?.principal
    }

    func loadDetail(_ itemId: String) async -> WorkItemDetail? {
        guard let databaseId = databaseId, let session = runtime.workItemSession else { return nil }
        do {
            let detail = try await repository.load(id: itemId, databaseId: databaseId, session: session)
            actionError = nil
            return detail
        } catch {
            actionError = Self.message(for: error)
            return nil
        }
    }

    @discardableResult
    func update(_ detail: WorkItemDetail, title: String, body: String) async -> Bool {
        guard let databaseId = databaseId, let session = runtime.workItemSession else { return false }
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedTitle.isEmpty else {
            actionError = "A work item needs a title."
            return false
        }
        var item = detail.item
        item.title = trimmedTitle
        item.body = body
        isSaving = true
        defer { isSaving = false }
        do {
            _ = try await repository.update(
                item,
                previousItemEtag: detail.itemEtag,
                previousListEtag: detail.listEtag,
                commentCount: detail.commentCount,
                databaseId: databaseId,
                session: session
            )
            actionError = nil
            conflict = nil
            discardPendingMutations(itemId: item.id, kinds: [.edit])
            await refreshRemote(force: true)
            return true
        } catch {
            await handleWriteFailure(
                error,
                item: item,
                detail: detail,
                databaseId: databaseId,
                session: session,
                pending: .edit(
                    WorkItemPendingMutation.EditPayload(
                        title: item.title,
                        body: item.body,
                        baseEtag: detail.itemEtag,
                        listEtag: detail.listEtag,
                        commentCount: detail.commentCount
                    )
                )
            )
            return false
        }
    }

    /// Closes or reopens an item. Reopening is the same write with the opposite state.
    @discardableResult
    func changeState(_ detail: WorkItemDetail, to state: WorkItemState) async -> Bool {
        guard let databaseId = databaseId, let session = runtime.workItemSession else { return false }
        guard canWrite else {
            actionError = "You do not have write access to this database."
            return false
        }
        var item = detail.item
        item.state = state
        isSaving = true
        defer { isSaving = false }
        do {
            _ = try await repository.setState(detail, state: state, databaseId: databaseId, session: session)
            actionError = nil
            conflict = nil
            discardPendingMutations(itemId: item.id, kinds: [.close, .reopen])
            await refreshRemote(force: true)
            return true
        } catch {
            await handleWriteFailure(
                error,
                item: item,
                detail: detail,
                databaseId: databaseId,
                session: session,
                pending: .state(state == .closed ? .close : .reopen, baseEtag: detail.itemEtag)
            )
            return false
        }
    }

    // MARK: - Comments

    func loadComments(_ itemId: String) async {
        commentsGeneration += 1
        let generation = commentsGeneration
        guard let databaseId = databaseId, let session = runtime.workItemSession else {
            comments = []
            return
        }
        isLoadingComments = true
        defer { if commentsGeneration == generation { isLoadingComments = false } }
        do {
            let loaded = try await repository.loadComments(itemId: itemId, databaseId: databaseId, session: session)
            guard commentsGeneration == generation, self.databaseId == databaseId, runtime.workItemPrincipal == session.principal else { return }
            comments = loaded
        } catch {
            guard commentsGeneration == generation, self.databaseId == databaseId, runtime.workItemPrincipal == session.principal else { return }
            comments = []
            actionError = Self.message(for: error)
        }
    }

    @discardableResult
    func postComment(itemId: String, body: String) async -> Bool {
        let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        guard let databaseId = databaseId, let session = runtime.workItemSession else { return false }
        guard canWrite else {
            actionError = "You do not have write access to this database."
            return false
        }
        let draft = WorkItemCommentDraft(
            id: UUID().uuidString.lowercased(),
            body: trimmed,
            author: runtime.workItemPrincipal,
            createdAt: Self.nowMilliseconds()
        )
        isPostingComment = true
        defer { isPostingComment = false }
        do {
            _ = try await repository.postComment(draft, itemId: itemId, databaseId: databaseId, session: session)
        } catch {
            let saved = persistPendingMutation(
                kind: .comment,
                itemId: itemId,
                payloadJson: WorkItemPendingMutation.encoded(
                    WorkItemPendingMutation.CommentPayload(body: trimmed, author: draft.author)
                ),
                databaseId: databaseId,
                mutationId: draft.id,
                createdAt: draft.createdAt
            )
            if saved { actionError = Self.message(for: error) }
            return false
        }
        actionError = nil
        await loadComments(itemId)
        // Recompute the derived list row from the comment folder; failure there is not fatal.
        await repository.refreshCommentProjection(itemId: itemId, databaseId: databaseId, session: session)
        await refreshRemote(force: true)
        return true
    }

    // MARK: - Search

    func search(_ query: String) async {
        searchQuery = query
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            clearSearch()
            return
        }
        guard let databaseId = databaseId, let session = runtime.workItemSession else {
            searchPhase = .failed("Select a database before searching.")
            return
        }
        searchGeneration += 1
        let generation = searchGeneration
        searchPhase = .searching
        do {
            let snapshot = try await repository.search(databaseId: databaseId, query: trimmed, session: session)
            guard generation == searchGeneration, databaseId == self.databaseId else { return }
            searchSnapshot = snapshot
            searchPhase = snapshot.results.isEmpty ? .empty : .results
            actionError = nil
        } catch {
            guard generation == searchGeneration, databaseId == self.databaseId else { return }
            searchSnapshot = WorkItemSearchSnapshot(results: [], hitCount: 0, isCapped: false)
            searchPhase = .failed(Self.message(for: error))
        }
    }

    func clearSearch() {
        searchQuery = ""
        clearSearchResults()
    }

    /// Drops the results without touching the field, so clearing the query restores the list.
    func clearSearchResults() {
        searchGeneration += 1
        searchSnapshot = WorkItemSearchSnapshot(results: [], hitCount: 0, isCapped: false)
        searchPhase = .idle
    }

    var isSearching: Bool {
        searchPhase != .idle
    }

    // MARK: - Unconfirmed input

    func refreshPendingMutations() {
        guard let store, let databaseId else {
            pendingMutations = []
            return
        }
        pendingMutations = (try? store.pendingMutations(principal: runtime.workItemPrincipal, databaseId: databaseId)) ?? []
    }

    func discardPendingMutation(_ mutationId: String) {
        guard let store else { return }
        try? store.deletePendingMutation(id: mutationId)
        refreshPendingMutations()
    }

    /// Drops the unconfirmed edits a member gave up by choosing the newest revision instead.
    func abandonPendingEdits(itemId: String) {
        discardPendingMutations(itemId: itemId, kinds: [.edit])
    }

    func retryPendingMutation(_ mutation: WorkItemPendingMutation) async {
        guard let databaseId = databaseId, let session = runtime.workItemSession,
              let store else {
            return
        }
        switch mutation.kind {
        case .comment:
            guard let payload = mutation.commentPayload else {
                discardPendingMutation(mutation.mutationId)
                return
            }
            let draft = WorkItemCommentDraft(
                id: mutation.mutationId,
                body: payload.body,
                author: payload.author,
                createdAt: mutation.createdAt
            )
            do {
                _ = try await repository.postComment(draft, itemId: mutation.itemId, databaseId: databaseId, session: session)
            } catch {
                actionError = Self.message(for: error)
                return
            }
            try? store.deletePendingMutation(id: mutation.mutationId)
            refreshPendingMutations()
            await loadComments(mutation.itemId)
            await repository.refreshCommentProjection(itemId: mutation.itemId, databaseId: databaseId, session: session)
            await refreshRemote(force: true)
        case .edit:
            guard let payload = mutation.editPayload else {
                discardPendingMutation(mutation.mutationId)
                return
            }
            let detail = try? await repository.load(id: mutation.itemId, databaseId: databaseId, session: session)
            guard let detail else {
                actionError = "This work item no longer exists."
                return
            }
            var item = detail.item
            item.title = payload.title
            item.body = payload.body
            do {
                // The pending input was captured against this revision. Writing against the newest
                // revision would silently overwrite whoever saved in between.
                _ = try await repository.update(
                    item,
                    previousItemEtag: payload.baseEtag,
                    previousListEtag: payload.listEtag,
                    commentCount: payload.commentCount,
                    databaseId: databaseId,
                    session: session
                )
            } catch {
                await handleWriteFailure(
                    error,
                    item: item,
                    detail: detail,
                    databaseId: databaseId,
                    session: session,
                    pending: .edit(payload),
                    isAlreadyPending: true
                )
                return
            }
            try? store.deletePendingMutation(id: mutation.mutationId)
            refreshPendingMutations()
            await refreshRemote(force: true)
        case .close, .reopen:
            guard let payload = mutation.statePayload else {
                actionError = "This unsent state change has no revision information. Discard it and review the current item."
                return
            }
            let detail = try? await repository.load(id: mutation.itemId, databaseId: databaseId, session: session)
            guard let detail else {
                actionError = "This work item no longer exists."
                return
            }
            guard detail.itemEtag == payload.baseEtag else {
                actionError = "This item changed after the state change was saved. Review the current item and discard the old change before trying again."
                return
            }
            do {
                _ = try await repository.setState(
                    detail,
                    state: mutation.kind == .close ? .closed : .open,
                    databaseId: databaseId,
                    session: session
                )
            } catch {
                actionError = Self.message(for: error)
                return
            }
            try? store.deletePendingMutation(id: mutation.mutationId)
            refreshPendingMutations()
            await refreshRemote(force: true)
        }
    }

    func clearConflict() {
        conflict = nil
    }

    /// Keeps the member's input and reloads the newest revision, reporting either outcome.
    private func handleWriteFailure(
        _ error: Error,
        item: WorkItem,
        detail: WorkItemDetail,
        databaseId: String,
        session: KinicIdentitySession,
        pending: UnconfirmedWrite,
        isAlreadyPending: Bool = false
    ) async {
        let isConflict: Bool
        if case WorkItemRepositoryError.etagConflict = error {
            isConflict = true
        } else if case VFSCandidError.nodeMutationRejected(let failure) = error, failure.code == .etagConflict {
            isConflict = true
        } else {
            isConflict = false
        }
        if isConflict {
            // Never overwrite: show the newest revision next to the input that was rejected.
            let latest = (try? await repository.load(id: item.id, databaseId: databaseId, session: session)) ?? detail
            conflict = WorkItemConflict(itemId: item.id, mine: item, latest: latest)
            actionError = nil
            return
        }
        // A retry already holds this input on the device, so it must not be stored twice.
        var saved = true
        if !isAlreadyPending {
            switch pending {
            case .edit(let payload):
                saved = persistPendingMutation(
                    kind: .edit,
                    itemId: item.id,
                    payloadJson: WorkItemPendingMutation.encoded(payload),
                    databaseId: databaseId
                )
            case .state(let change, let baseEtag):
                saved = persistPendingMutation(
                    kind: change.kind,
                    itemId: item.id,
                    payloadJson: WorkItemPendingMutation.encoded(
                        WorkItemPendingMutation.StatePayload(baseEtag: baseEtag)
                    ),
                    databaseId: databaseId
                )
            }
        }
        if saved { actionError = Self.message(for: error) }
    }

    /// The unconfirmed inputs the model knows how to re-apply by hand.
    private enum UnconfirmedWrite {
        case edit(WorkItemPendingMutation.EditPayload)
        case state(UnconfirmedStateChange, baseEtag: String)
    }

    private enum UnconfirmedStateChange {
        case close
        case reopen

        var kind: WorkItemPendingMutation.Kind {
            self == .close ? .close : .reopen
        }
    }

    @discardableResult
    private func persistPendingMutation(
        kind: WorkItemPendingMutation.Kind,
        itemId: String,
        payloadJson: String,
        databaseId: String,
        mutationId: String = UUID().uuidString.lowercased(),
        createdAt: Int64 = WorkItemModel.nowMilliseconds()
    ) -> Bool {
        guard let store else {
            actionError = "Local storage is unavailable. Keep this screen open and try again."
            return false
        }
        let mutation = WorkItemPendingMutation(
            mutationId: mutationId,
            kind: kind,
            itemId: itemId,
            createdAt: createdAt,
            payloadJson: payloadJson
        )
        do {
            try store.insertPendingMutation(mutation, principal: runtime.workItemPrincipal, databaseId: databaseId)
        } catch {
            actionError = "The change could not be saved on this device. Keep this screen open and try again."
            return false
        }
        refreshPendingMutations()
        return true
    }

    /// Drops the unconfirmed inputs that a successful write just superseded.
    private func discardPendingMutations(itemId: String, kinds: Set<WorkItemPendingMutation.Kind>) {
        guard let store else { return }
        for mutation in pendingMutations where mutation.itemId == itemId && kinds.contains(mutation.kind) {
            try? store.deletePendingMutation(id: mutation.mutationId)
        }
        refreshPendingMutations()
    }

    @discardableResult
    private func send(_ record: WorkItemCaptureRecord) async -> Bool {
        guard record.principal == runtime.workItemPrincipal,
              record.principal == runtime.workItemSession?.principal else {
            actionError = "This item belongs to another account."
            return false
        }
        guard let databaseId = record.databaseId, let session = runtime.workItemSession else {
            actionError = "Choose a database before sending."
            return false
        }
        guard let database = runtime.workItemDatabase, database.databaseId == databaseId, database.canWrite else {
            actionError = "You do not have write access to this database."
            return false
        }
        guard session.principal == record.principal else {
            actionError = "This item belongs to another account."
            return false
        }
        let draft = WorkItemCreateDraft(
            id: record.captureId,
            title: record.provisionalTitle,
            body: record.rawText,
            author: record.principal,
            source: record.sourceRefs.first
        )
        do {
            _ = try await repository.create(draft, databaseId: databaseId, session: session)
        } catch {
            actionError = Self.message(for: error)
            return false
        }
        if let store {
            try? store.markCaptureSent(id: record.captureId, at: Self.nowMilliseconds())
        }
        actionError = nil
        refreshLocalCaptures()
        await refreshRemote(force: true)
        return true
    }

    private func cacheList(snapshot: WorkItemListSnapshot, databaseId: String, fetchedAt: Int64) {
        guard let store else { return }
        let records = snapshot.entries.map {
            WorkItemListCacheRecord(
                itemId: $0.id,
                title: $0.title,
                state: $0.state,
                commentCount: $0.commentCount,
                updatedAt: $0.updatedAt
            )
        }
        try? store.replaceListCache(
            principal: runtime.workItemPrincipal,
            databaseId: databaseId,
            entries: records,
            fetchedAt: fetchedAt
        )
    }

    /// The first non-empty line becomes the provisional title until AI or a human replaces it.
    static func provisionalTitle(from body: String) -> String {
        let firstLine = body
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .first { !$0.isEmpty } ?? ""
        return String(firstLine.prefix(120))
    }

    static func nowMilliseconds() -> Int64 {
        Int64(Date().timeIntervalSince1970 * 1000)
    }

    /// How long a fetched list is reused before an automatic refresh re-reads every item.
    static let cacheFreshnessWindowMilliseconds: Int64 = 30_000

    static func isDefinitiveAccessLoss(_ error: Error) -> Bool {
        guard case VFSCandidError.canisterRejected(let message) = error else { return false }
        return message.hasPrefix("principal has no access to database:")
            || message.hasPrefix("database not found:")
            || message.hasPrefix("database is deleted:")
    }

    private static func message(for error: Error) -> String {
        if case WorkItemRepositoryError.etagConflict = error {
            return "Another member changed this work item first. Reload it and try again."
        }
        if case VFSCandidError.nodeMutationRejected(let failure) = error {
            switch failure.code {
            case .forbidden: return "You do not have write access to this database."
            case .etagConflict: return "Another member changed this work item first. Reload it and try again."
            case .notFound: return "This work item no longer exists."
            case .writeUnavailable, .invalidOperation: return failure.message
            }
        }
        if let localized = error as? LocalizedError, let description = localized.errorDescription {
            return description
        }
        return "The work item could not be saved."
    }
}
