// Deterministic, isolated data for navigation UI tests and screenshots. No live services.
#if DEBUG
import SwiftUI

@MainActor
enum NavigationFixture {
    static func makeModel() -> AppModel {
        let root = FileManager.default.temporaryDirectory.appending(path: "navigation-fixture")
        let auth = KinicAuthService(authenticateSession: { _ in .testing() }, restoreSession: { nil }, saveSession: { _ in }, clearSession: {})
        let model = try! AppModel(
            configuration: .preview, authService: auth, client: KinicICClient(configuration: .preview),
            shareInbox: ShareInbox(testQueueDirectory: root.appending(path: "inbox")),
            settingsStore: SharedDefaultsStore(defaults: UserDefaults(suiteName: "navigation-fixture.\(UUID())")!),
            readBrowseNodeRemotely: { _, path, _ in
                VFSNode(path: path, kind: .file, content: "# Research notes\n\nA place for sources and ideas.", metadataJson: "{}", etag: "fixture", createdAt: 1, updatedAt: 1)
            },
            listBrowseChildrenRemotely: { _, path, _ in
                path == "/" ? [ChildNode(path: "/Notes.md", name: "Notes.md", kind: .file, updatedAt: 1, etag: "fixture", sizeBytes: 100, hasChildren: false, isVirtual: false)] : []
            }, initialSession: ProcessInfo.processInfo.environment["KINIC_NAV_STATE"] == "signed-out" ? nil : .testing())
        model.readableDatabases = [database("personal", "Personal Memory", .owner), database("team", "Team Research", .writer), database("reference", "Public reference library with a longer database name", .reader), database("pending", "New workspace", .owner, .pending)]
        model.databases = model.readableDatabases.filter(\.canWrite)
        if ProcessInfo.processInfo.environment["KINIC_NAV_STATE"] == "no-database" { model.readableDatabases = []; model.databases = [] }
        model.selectedDatabaseId = model.readableDatabases.first?.databaseId ?? ""
        model.sourceCaptureHistory = history(databaseId: model.selectedDatabaseId)
        return model
    }

    static func makeWorkItemModel(_ app: AppModel) -> WorkItemModel {
        WorkItemModel(runtime: app, repository: WorkItemRepository(vfs: NavigationFixtureVFS()), store: nil)
    }

    static func database(_ id: String, _ title: String, _ role: DatabaseRole, _ status: DatabaseStatus = .active) -> DatabaseSummary {
        DatabaseSummary(databaseId: id, title: title, description: "Sources, notes, and ideas", metadata: nil, role: role, status: status, logicalSizeBytes: 48000, cyclesBalance: 3_000_000_000_000, cyclesSuspendedAtMs: nil, deletedAtMs: nil)
    }

    static func history(databaseId: String) -> [SourceCaptureHistoryRecord] {
        guard databaseId == "personal" else { return [] }
        return [SourceCaptureHistoryStatus.completed, .generating, .failed, .completed].enumerated().map { index, status in
            SourceCaptureHistoryRecord(databaseId: databaseId, item: SourceCaptureHistoryItem(
                requestPath: "/Sources/source-capture-requests/fixture-\(index).md", url: "https://example.com/\(["research-notes", "reading-list", "design-reference", "archive"][index])",
                status: status, requestedAtMilliseconds: 1_790_200_000_000 - Int64(index) * 3_600_000, updatedAtMilliseconds: 1_790_200_000_000,
                claimedAt: nil, sourcePath: nil, targetPath: status == .completed ? "/Notes.md" : nil, finishedAt: nil,
                error: status == .failed ? "The source could not be fetched. Try again when it is available." : nil))
        }
    }
}

private struct NavigationFixtureVFS: WorkItemVFSProviding {
    private var titles: [String] { ["Plan the next research session", "Review notes from this week", "Share the reading list"] }
    func listChildren(databaseId: String, path: String, session: KinicIdentitySession) async throws -> [ChildNode] {
        guard databaseId == "personal", path == WorkItemPaths.root else { return [] }
        if ProcessInfo.processInfo.environment["KINIC_NAV_STATE"] == "offline" { throw URLError(.notConnectedToInternet) }
        if ProcessInfo.processInfo.environment["KINIC_NAV_STATE"] == "empty" { return [] }
        return titles.indices.map { index in
            ChildNode(path: WorkItemPaths.directory("fixture-\(index)"), name: "fixture-\(index)", kind: .folder, updatedAt: 1_790_200_000_000, etag: "fixture", sizeBytes: nil, hasChildren: true, isVirtual: false)
        }
    }
    func readNode(databaseId: String, path: String, session: KinicIdentitySession) async throws -> VFSNode? {
        guard let id = WorkItemPaths.itemId(fromPath: path), let index = Int(id.replacingOccurrences(of: "fixture-", with: "")), titles.indices.contains(index) else { return nil }
        let metadata: String
        if path.hasSuffix("item.md") {
            metadata = try WorkItemDocument.encode(WorkItemDocument.ItemMetadata(version: 1, captureId: id, title: titles[index], state: "open", createdBy: session.principal, createdAt: 1_790_200_000_000, source: nil))
        } else {
            metadata = try WorkItemDocument.encode(WorkItemDocument.ListMetadata(version: 1, title: titles[index], state: "open", commentCount: 0, lastActivityAt: 1_790_200_000_000))
        }
        return VFSNode(path: path, kind: .file, content: "Gather sources and write down the next steps.", metadataJson: metadata, etag: "fixture", createdAt: 1_790_200_000_000, updatedAt: 1_790_200_000_000)
    }
    func mutateNodesBatch(databaseId: String, operations: [VFSNodeMutationOperation], session: KinicIdentitySession) async throws -> [VFSNodeMutationOutcome] { throw URLError(.notConnectedToInternet) }
    func searchNodes(databaseId: String, query: String, prefix: String?, limit: UInt32, session: KinicIdentitySession) async throws -> [SearchNodeHit] {
        guard databaseId == "personal", query.localizedCaseInsensitiveContains("research") else { return [] }
        return [SearchNodeHit(
            path: WorkItemPaths.item("fixture-0"), kind: .file, snippet: nil,
            previewExcerpt: "Plan the next research session", matchReasons: ["title"], score: 1
        )]
    }
}
#endif
