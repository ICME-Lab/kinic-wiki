// Where: mobile/ios/KinicApp/Services/WorkItemStore.swift
// What: App Group SQLite store for captures, the list cache, and sync state.
// Why: Local input must survive offline periods and app termination without being reported as shared.

import Foundation
import SQLite3

private let workItemSQLiteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

protocol WorkItemStoring: Sendable {
    func upsertCapture(_ record: WorkItemCaptureRecord) throws
    func captures(principal: String) throws -> [WorkItemCaptureRecord]
    func markCaptureSent(id: String, at timestamp: Int64) throws
    func deleteCapture(id: String) throws
    func replaceListCache(
        principal: String,
        databaseId: String,
        entries: [WorkItemListCacheRecord],
        fetchedAt: Int64
    ) throws
    func listCache(principal: String, databaseId: String) throws -> [WorkItemListCacheRecord]
    func lastFetchedAt(principal: String, databaseId: String) throws -> Int64?
    func insertPendingMutation(
        _ mutation: WorkItemPendingMutation,
        principal: String,
        databaseId: String
    ) throws
    func pendingMutations(principal: String, databaseId: String) throws -> [WorkItemPendingMutation]
    func deletePendingMutation(id: String) throws
}

final class WorkItemStore: @unchecked Sendable {
    private let handle: OpaquePointer
    private let lock = NSLock()

    private static let liveLock = NSLock()
    nonisolated(unsafe) private static var liveStores: [String: WorkItemStore] = [:]

    /// Opens the shared store, or returns `nil` when no App Group is configured (previews, unit tests).
    /// The instance is reused per path: SwiftUI re-evaluates `State(initialValue:)` on every rebuild.
    static func live(appGroupId: String?) throws -> WorkItemStore? {
        guard let appGroupId,
              !appGroupId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupId) else {
            return nil
        }
        let directory = container.appendingPathComponent("WorkItems", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let path = directory.appendingPathComponent("work-items.sqlite").path
        liveLock.lock()
        defer { liveLock.unlock() }
        if let existing = liveStores[path] {
            return existing
        }
        let store = try WorkItemStore(path: path)
        liveStores[path] = store
        return store
    }

    init(path: String) throws {
        var handle: OpaquePointer?
        let status = sqlite3_open_v2(
            path,
            &handle,
            SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX,
            nil
        )
        guard status == SQLITE_OK, let handle else {
            let message = handle.map { String(cString: sqlite3_errmsg($0)) } ?? "sqlite open failed (\(status))"
            if let handle { sqlite3_close_v2(handle) }
            throw WorkItemStoreError.sqlite(message)
        }
        self.handle = handle
        try execute("PRAGMA journal_mode = WAL")
        try migrate()
    }

    deinit {
        sqlite3_close_v2(handle)
    }

    // MARK: - Captures

    func upsertCapture(_ record: WorkItemCaptureRecord) throws {
        let sourceRefsJson = try Self.encodeSourceRefs(record.sourceRefs)
        try withLock {
            let statement = try prepare(
                """
                INSERT INTO captures (
                    capture_id, principal, database_id, origin, raw_text, provisional_title, transcript,
                    audio_relative_path, audio_duration_ms, source_refs_json, state, base_etag,
                    ai_suggestion_json, created_at, updated_at, sent_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
                ON CONFLICT(capture_id) DO UPDATE SET
                    database_id = excluded.database_id,
                    raw_text = excluded.raw_text,
                    provisional_title = excluded.provisional_title,
                    transcript = excluded.transcript,
                    audio_relative_path = excluded.audio_relative_path,
                    audio_duration_ms = excluded.audio_duration_ms,
                    source_refs_json = excluded.source_refs_json,
                    state = excluded.state,
                    base_etag = excluded.base_etag,
                    ai_suggestion_json = excluded.ai_suggestion_json,
                    updated_at = excluded.updated_at,
                    sent_at = excluded.sent_at
                """
            )
            defer { sqlite3_finalize(statement) }
            bind(statement, 1, record.captureId)
            bind(statement, 2, record.principal)
            bind(statement, 3, record.databaseId)
            bind(statement, 4, record.origin.rawValue)
            bind(statement, 5, record.rawText)
            bind(statement, 6, record.provisionalTitle)
            bind(statement, 7, record.transcript)
            bind(statement, 8, record.audioRelativePath)
            bind(statement, 9, record.audioDurationMs)
            bind(statement, 10, sourceRefsJson)
            bind(statement, 11, record.state.rawValue)
            bind(statement, 12, record.baseEtag)
            bind(statement, 13, record.aiSuggestionJson)
            bind(statement, 14, record.createdAt)
            bind(statement, 15, record.updatedAt)
            bind(statement, 16, record.sentAt)
            try step(statement)
        }
    }

    func capture(id: String) throws -> WorkItemCaptureRecord? {
        try withLock {
            let statement = try prepare("\(Self.captureSelect) WHERE capture_id = ?1")
            defer { sqlite3_finalize(statement) }
            bind(statement, 1, id)
            guard try step(statement) == SQLITE_ROW else { return nil }
            return capture(from: statement)
        }
    }

    func captures(principal: String) throws -> [WorkItemCaptureRecord] {
        try withLock {
            let statement = try prepare("\(Self.captureSelect) WHERE principal = ?1 ORDER BY created_at DESC")
            defer { sqlite3_finalize(statement) }
            bind(statement, 1, principal)
            var records: [WorkItemCaptureRecord] = []
            while try step(statement) == SQLITE_ROW {
                records.append(capture(from: statement))
            }
            return records
        }
    }

    func markCaptureSent(id: String, at timestamp: Int64) throws {
        try withLock {
            let statement = try prepare(
                "UPDATE captures SET state = ?2, sent_at = ?3, updated_at = ?3 WHERE capture_id = ?1"
            )
            defer { sqlite3_finalize(statement) }
            bind(statement, 1, id)
            bind(statement, 2, WorkItemCaptureState.sent.rawValue)
            bind(statement, 3, timestamp)
            try step(statement)
        }
    }

    func deleteCapture(id: String) throws {
        try withLock {
            let statement = try prepare("DELETE FROM captures WHERE capture_id = ?1")
            defer { sqlite3_finalize(statement) }
            bind(statement, 1, id)
            try step(statement)
        }
    }

    // MARK: - List cache

    func replaceListCache(
        principal: String,
        databaseId: String,
        entries: [WorkItemListCacheRecord],
        fetchedAt: Int64
    ) throws {
        try withLock {
            try execute("BEGIN IMMEDIATE")
            do {
                try runStatement("DELETE FROM list_cache WHERE principal = ?1 AND database_id = ?2") { statement in
                    bind(statement, 1, principal)
                    bind(statement, 2, databaseId)
                }

                for entry in entries {
                    try runStatement(
                        """
                        INSERT INTO list_cache (principal, database_id, item_id, title, state, comment_count, updated_at)
                        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                        """
                    ) { statement in
                        bind(statement, 1, principal)
                        bind(statement, 2, databaseId)
                        bind(statement, 3, entry.itemId)
                        bind(statement, 4, entry.title)
                        bind(statement, 5, entry.state.rawValue)
                        bind(statement, 6, Int64(entry.commentCount))
                        bind(statement, 7, entry.updatedAt)
                    }
                }

                try runStatement(
                    """
                    INSERT INTO sync_state (principal, database_id, last_fetched_at) VALUES (?1, ?2, ?3)
                    ON CONFLICT(principal, database_id) DO UPDATE SET last_fetched_at = excluded.last_fetched_at
                    """
                ) { statement in
                    bind(statement, 1, principal)
                    bind(statement, 2, databaseId)
                    bind(statement, 3, fetchedAt)
                }

                try execute("COMMIT")
            } catch {
                // Statements must be finalized first, or SQLite refuses to roll the transaction back.
                try? execute("ROLLBACK")
                throw error
            }
        }
    }

    func listCache(principal: String, databaseId: String) throws -> [WorkItemListCacheRecord] {
        try withLock {
            let statement = try prepare(
                """
                SELECT item_id, title, state, comment_count, updated_at
                FROM list_cache WHERE principal = ?1 AND database_id = ?2
                ORDER BY updated_at DESC, item_id ASC
                """
            )
            defer { sqlite3_finalize(statement) }
            bind(statement, 1, principal)
            bind(statement, 2, databaseId)
            var records: [WorkItemListCacheRecord] = []
            while try step(statement) == SQLITE_ROW {
                records.append(
                    WorkItemListCacheRecord(
                        itemId: columnText(statement, 0) ?? "",
                        title: columnText(statement, 1) ?? "",
                        state: WorkItemState(rawValue: columnText(statement, 2) ?? "") ?? .open,
                        commentCount: Int(columnInt64(statement, 3)),
                        updatedAt: columnInt64(statement, 4)
                    )
                )
            }
            return records
        }
    }

    func lastFetchedAt(principal: String, databaseId: String) throws -> Int64? {
        try withLock {
            let statement = try prepare(
                "SELECT last_fetched_at FROM sync_state WHERE principal = ?1 AND database_id = ?2"
            )
            defer { sqlite3_finalize(statement) }
            bind(statement, 1, principal)
            bind(statement, 2, databaseId)
            guard try step(statement) == SQLITE_ROW else { return nil }
            return columnInt64(statement, 0)
        }
    }

    // MARK: - Pending mutations

    /// Keeps an unconfirmed edit, comment, or state change so it survives app termination.
    func insertPendingMutation(
        _ mutation: WorkItemPendingMutation,
        principal: String,
        databaseId: String
    ) throws {
        try withLock {
            let statement = try prepare(
                """
                INSERT INTO pending_mutations (mutation_id, principal, database_id, item_id, kind, payload_json, created_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                ON CONFLICT(mutation_id) DO UPDATE SET
                    item_id = excluded.item_id,
                    kind = excluded.kind,
                    payload_json = excluded.payload_json,
                    created_at = excluded.created_at
                WHERE pending_mutations.principal = excluded.principal
                  AND pending_mutations.database_id = excluded.database_id
                """
            )
            defer { sqlite3_finalize(statement) }
            bind(statement, 1, mutation.mutationId)
            bind(statement, 2, principal)
            bind(statement, 3, databaseId)
            bind(statement, 4, mutation.itemId)
            bind(statement, 5, mutation.kind.rawValue)
            bind(statement, 6, mutation.payloadJson)
            bind(statement, 7, mutation.createdAt)
            try step(statement)
        }
    }

    func pendingMutations(principal: String, databaseId: String) throws -> [WorkItemPendingMutation] {
        try withLock {
            let statement = try prepare(
                """
                SELECT mutation_id, kind, item_id, payload_json, created_at
                FROM pending_mutations WHERE principal = ?1 AND database_id = ?2
                ORDER BY created_at ASC, mutation_id ASC
                """
            )
            defer { sqlite3_finalize(statement) }
            bind(statement, 1, principal)
            bind(statement, 2, databaseId)
            var mutations: [WorkItemPendingMutation] = []
            while try step(statement) == SQLITE_ROW {
                mutations.append(
                    WorkItemPendingMutation(
                        mutationId: columnText(statement, 0) ?? "",
                        kind: WorkItemPendingMutation.Kind(rawValue: columnText(statement, 1) ?? "") ?? .edit,
                        itemId: columnText(statement, 2) ?? "",
                        createdAt: columnInt64(statement, 4),
                        payloadJson: columnText(statement, 3) ?? "{}"
                    )
                )
            }
            return mutations
        }
    }

    func deletePendingMutation(id: String) throws {
        try withLock {
            let statement = try prepare("DELETE FROM pending_mutations WHERE mutation_id = ?1")
            defer { sqlite3_finalize(statement) }
            bind(statement, 1, id)
            try step(statement)
        }
    }

    // MARK: - Schema

    private static let captureSelect = """
        SELECT capture_id, principal, database_id, origin, raw_text, provisional_title, transcript,
               audio_relative_path, audio_duration_ms, source_refs_json, state, base_etag,
               ai_suggestion_json, created_at, updated_at, sent_at
        FROM captures
        """

    private static let migrations: [(version: Int64, statements: [String])] = [
        (
            1,
            [
                """
                CREATE TABLE captures (
                    capture_id           TEXT PRIMARY KEY,
                    principal            TEXT NOT NULL,
                    database_id          TEXT,
                    origin               TEXT NOT NULL,
                    raw_text             TEXT NOT NULL,
                    provisional_title    TEXT NOT NULL,
                    transcript           TEXT,
                    audio_relative_path  TEXT,
                    audio_duration_ms    INTEGER,
                    source_refs_json     TEXT NOT NULL DEFAULT '[]',
                    state                TEXT NOT NULL,
                    base_etag            TEXT,
                    ai_suggestion_json   TEXT,
                    created_at           INTEGER NOT NULL,
                    updated_at           INTEGER NOT NULL,
                    sent_at              INTEGER
                )
                """,
                "CREATE INDEX captures_pending ON captures (principal, state, created_at)",
                """
                CREATE TABLE list_cache (
                    principal     TEXT NOT NULL,
                    database_id   TEXT NOT NULL,
                    item_id       TEXT NOT NULL,
                    title         TEXT NOT NULL,
                    state         TEXT NOT NULL,
                    comment_count INTEGER NOT NULL,
                    updated_at    INTEGER NOT NULL,
                    PRIMARY KEY (principal, database_id, item_id)
                )
                """,
                """
                CREATE TABLE sync_state (
                    principal       TEXT NOT NULL,
                    database_id     TEXT NOT NULL,
                    last_fetched_at INTEGER NOT NULL,
                    PRIMARY KEY (principal, database_id)
                )
                """,
                """
                CREATE TABLE pending_mutations (
                    mutation_id  TEXT PRIMARY KEY,
                    principal    TEXT NOT NULL,
                    database_id  TEXT NOT NULL,
                    item_id      TEXT NOT NULL,
                    kind         TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    created_at   INTEGER NOT NULL
                )
                """
            ]
        )
    ]

    private func migrate() throws {
        if try !tableExists("schema_migrations") {
            try execute("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)")
        }
        var applied = Set<Int64>()
        let appliedStatement = try prepare("SELECT version FROM schema_migrations")
        defer { sqlite3_finalize(appliedStatement) }
        while try step(appliedStatement) == SQLITE_ROW {
            applied.insert(columnInt64(appliedStatement, 0))
        }
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        for migration in Self.migrations where !applied.contains(migration.version) {
            try execute("BEGIN IMMEDIATE")
            do {
                for statement in migration.statements {
                    try execute(statement)
                }
                let record = try prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?1, ?2)")
                bind(record, 1, migration.version)
                bind(record, 2, now)
                try step(record)
                sqlite3_finalize(record)
                try execute("COMMIT")
            } catch {
                try? execute("ROLLBACK")
                throw error
            }
        }
    }

    private func tableExists(_ name: String) throws -> Bool {
        let statement = try prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1 LIMIT 1")
        defer { sqlite3_finalize(statement) }
        bind(statement, 1, name)
        return try step(statement) == SQLITE_ROW
    }

    // MARK: - SQLite plumbing

    private func withLock<T>(_ body: () throws -> T) throws -> T {
        lock.lock()
        defer { lock.unlock() }
        return try body()
    }

    /// Prepares, binds, runs, and always finalizes one statement.
    private func runStatement(_ sql: String, bindings: (OpaquePointer) -> Void) throws {
        let statement = try prepare(sql)
        defer { sqlite3_finalize(statement) }
        bindings(statement)
        try step(statement)
    }

    private func execute(_ sql: String) throws {
        var errorPointer: UnsafeMutablePointer<CChar>?
        guard sqlite3_exec(handle, sql, nil, nil, &errorPointer) == SQLITE_OK else {
            let message = errorPointer.map { String(cString: $0) } ?? lastErrorMessage
            sqlite3_free(errorPointer)
            throw WorkItemStoreError.sqlite(message)
        }
    }

    private func prepare(_ sql: String) throws -> OpaquePointer {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(handle, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            throw WorkItemStoreError.sqlite(lastErrorMessage)
        }
        return statement
    }

    /// Runs one statement and fails unless it completes or yields a row.
    @discardableResult
    private func step(_ statement: OpaquePointer) throws -> Int32 {
        let status = sqlite3_step(statement)
        guard status == SQLITE_ROW || status == SQLITE_DONE else {
            throw WorkItemStoreError.sqlite(lastErrorMessage)
        }
        return status
    }

    private var lastErrorMessage: String {
        String(cString: sqlite3_errmsg(handle))
    }

    private func bind(_ statement: OpaquePointer, _ index: Int32, _ value: String?) {
        if let value {
            sqlite3_bind_text(statement, index, value, -1, workItemSQLiteTransient)
        } else {
            sqlite3_bind_null(statement, index)
        }
    }

    private func bind(_ statement: OpaquePointer, _ index: Int32, _ value: Int64?) {
        if let value {
            sqlite3_bind_int64(statement, index, value)
        } else {
            sqlite3_bind_null(statement, index)
        }
    }

    private func columnText(_ statement: OpaquePointer, _ index: Int32) -> String? {
        guard let pointer = sqlite3_column_text(statement, index) else { return nil }
        return String(cString: pointer)
    }

    private func columnInt64(_ statement: OpaquePointer, _ index: Int32) -> Int64 {
        sqlite3_column_int64(statement, index)
    }

    private func columnInt64OrNil(_ statement: OpaquePointer, _ index: Int32) -> Int64? {
        sqlite3_column_type(statement, index) == SQLITE_NULL ? nil : sqlite3_column_int64(statement, index)
    }

    private func capture(from statement: OpaquePointer) -> WorkItemCaptureRecord {
        WorkItemCaptureRecord(
            captureId: columnText(statement, 0) ?? "",
            principal: columnText(statement, 1) ?? "",
            databaseId: columnText(statement, 2),
            origin: WorkItemSourceKind(rawValue: columnText(statement, 3) ?? "") ?? .text,
            rawText: columnText(statement, 4) ?? "",
            provisionalTitle: columnText(statement, 5) ?? "",
            transcript: columnText(statement, 6),
            audioRelativePath: columnText(statement, 7),
            audioDurationMs: columnInt64OrNil(statement, 8),
            sourceRefs: Self.decodeSourceRefs(columnText(statement, 9)),
            state: WorkItemCaptureState(rawValue: columnText(statement, 10) ?? "") ?? .local,
            baseEtag: columnText(statement, 11),
            aiSuggestionJson: columnText(statement, 12),
            createdAt: columnInt64(statement, 13),
            updatedAt: columnInt64(statement, 14),
            sentAt: columnInt64OrNil(statement, 15)
        )
    }

    private static func encodeSourceRefs(_ sources: [WorkItemSource]) throws -> String {
        let data = try JSONEncoder().encode(sources)
        return String(data: data, encoding: .utf8) ?? "[]"
    }

    private static func decodeSourceRefs(_ json: String?) -> [WorkItemSource] {
        guard let json, let data = json.data(using: .utf8) else { return [] }
        return (try? JSONDecoder().decode([WorkItemSource].self, from: data)) ?? []
    }
}

extension WorkItemStore: WorkItemStoring {}

enum WorkItemStoreError: Error, LocalizedError, Equatable {
    case sqlite(String)

    var errorDescription: String? {
        switch self {
        case .sqlite(let message): "Local work item store failed: \(message)"
        }
    }
}
