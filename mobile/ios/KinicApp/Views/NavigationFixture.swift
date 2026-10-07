// Deterministic, isolated data for navigation UI tests and screenshots. No live services.
#if DEBUG
import SwiftUI
import WidgetKit

@MainActor
enum NavigationFixture {
    private static let finalDemoVFS = DemoWorkItemVFS(finalDemo: true)
    private static let storyDemoVFS = DemoWorkItemVFS(finalDemo: true, storyDemo: true)
    static let researchAnswer = "Offline research fixture: review the sources and record the next steps."
    static var researchResult: AskAIWorkerResult {
        AskAIWorkerResult(kind: "grounded_answer", answer: researchAnswer, sources: [], trace: nil, insufficient: true)
    }
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
        if ["demo-final", "demo-story"].contains(ProcessInfo.processInfo.environment["KINIC_NAV_STATE"] ?? "") {
            model.readableDatabases = [database("team", "Team Wiki", .writer)]
            model.databases = model.readableDatabases
            model.selectedDatabaseId = "team"
            model.sourceCaptureHistory = []
        }
        return model
    }

    static func makeWorkItemModel(_ app: AppModel) -> WorkItemModel {
        let name = ProcessInfo.processInfo.environment["KINIC_NAV_DRAFT_STORE"]
        let path = name.map { FileManager.default.temporaryDirectory.appending(path: "navigation-draft-\($0).sqlite").path } ?? ":memory:"
        let finalDemo = ProcessInfo.processInfo.environment["KINIC_NAV_STATE"] == "demo-final"
        let storyDemo = ProcessInfo.processInfo.environment["KINIC_NAV_STATE"] == "demo-story"
        let demo = storyDemo || finalDemo || ProcessInfo.processInfo.environment["KINIC_NAV_STATE"] == "demo"
        let vfs: any WorkItemVFSProviding
        if storyDemo { vfs = storyDemoVFS }
        else if finalDemo { vfs = finalDemoVFS }
        else if demo { vfs = DemoWorkItemVFS() }
        else { vfs = NavigationFixtureVFS() }
        return WorkItemModel(runtime: app, repository: WorkItemRepository(vfs: vfs), store: try! WorkItemStore(path: path), widgetSnapshot: demo ? DemoWidgetWriter() : nil)
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
    private let commentId = "11111111-1111-4111-8111-111111111111"
    private var showsComment: Bool { ProcessInfo.processInfo.environment["KINIC_NAV_STATE"] == "comment-author" }
    private var titles: [String] { ["Plan the next research session", "Review notes from this week", "Share the reading list"] }
    func listChildren(databaseId: String, path: String, session: KinicIdentitySession) async throws -> [ChildNode] {
        guard databaseId == "personal" else { return [] }
        if showsComment, path == WorkItemPaths.commentsDirectory("fixture-0") {
            return [ChildNode(path: WorkItemPaths.comment(itemId: "fixture-0", commentId: commentId), name: "\(commentId).md", kind: .file, updatedAt: 1_790_200_000_000, etag: "fixture", sizeBytes: nil, hasChildren: false, isVirtual: false)]
        }
        guard path == WorkItemPaths.root else { return [] }
        if ProcessInfo.processInfo.environment["KINIC_NAV_STATE"] == "offline" { throw URLError(.notConnectedToInternet) }
        if ProcessInfo.processInfo.environment["KINIC_NAV_STATE"] == "empty" { return [] }
        return titles.indices.map { index in
            ChildNode(path: WorkItemPaths.directory("fixture-\(index)"), name: "fixture-\(index)", kind: .folder, updatedAt: 1_790_200_000_000, etag: "fixture", sizeBytes: nil, hasChildren: true, isVirtual: false)
        }
    }
    func readNode(databaseId: String, path: String, session: KinicIdentitySession) async throws -> VFSNode? {
        if showsComment, databaseId == "personal", path == WorkItemPaths.comment(itemId: "fixture-0", commentId: commentId) {
            let metadata = try WorkItemDocument.encode(WorkItemDocument.CommentMetadata(version: 1, author: "eyluy-bu6z2-q5dwg-4sved-2jenz-2r54a-t65kq-y6cz3-kkdrx-ta472-gae", createdAt: 1_790_200_000_000))
            return VFSNode(path: path, kind: .file, content: "I found useful sources. Let's review them in the next session.", metadataJson: metadata, etag: "fixture", createdAt: 1_790_200_000_000, updatedAt: 1_790_200_000_000)
        }
        guard let id = WorkItemPaths.itemId(fromPath: path), let index = Int(id.replacingOccurrences(of: "fixture-", with: "")), titles.indices.contains(index) else { return nil }
        let metadata: String
        if path.hasSuffix("item.md") {
            metadata = try WorkItemDocument.encode(WorkItemDocument.ItemMetadata(version: 1, captureId: id, title: titles[index], state: "open", createdBy: session.principal, createdAt: 1_790_200_000_000, source: nil))
        } else {
            metadata = try WorkItemDocument.encode(WorkItemDocument.ListMetadata(version: 1, title: titles[index], state: "open", commentCount: showsComment && index == 0 ? 1 : 0, lastActivityAt: 1_790_200_000_000))
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

// Opt-in filming backend. Real app views and repository operations, isolated in memory.
private actor DemoWorkItemVFS: WorkItemVFSProviding {
    private let finalDemo: Bool
    private let storyDemo: Bool
    init(finalDemo: Bool = false, storyDemo: Bool = false) { self.finalDemo = finalDemo; self.storyDemo = storyDemo }
    private var nodes: [String: VFSNode] = [:]
    private var seeded = false
    private func seed(_ session: KinicIdentitySession) async throws {
        guard !seeded else { return }
        seeded = true
        if finalDemo {
            let now = Int64(Date().timeIntervalSince1970 * 1000) - 120_000
            let member = "eyluy-bu6z2-q5dwg-4sved-2jenz-2r54a-t65kq-y6cz3-kkdrx-ta472-gae"
            if storyDemo {
                let id = "fixture-other"
                let item = try WorkItemDocument.encode(WorkItemDocument.ItemMetadata(version: 1, captureId: id, title: "Plan the next release", state: "open", createdBy: member, createdAt: now, source: nil))
                let list = try WorkItemDocument.encode(WorkItemDocument.ListMetadata(version: 1, title: "Plan the next release", state: "open", commentCount: 0, lastActivityAt: now))
                nodes[WorkItemPaths.item(id)] = VFSNode(path: WorkItemPaths.item(id), kind: .file, content: "Collect ideas for the next release.", metadataJson: item, etag: "demo", createdAt: now, updatedAt: now)
                nodes[WorkItemPaths.listMetadata(id)] = VFSNode(path: WorkItemPaths.listMetadata(id), kind: .file, content: "", metadataJson: list, etag: "demo", createdAt: now, updatedAt: now)
                return
            }
            for (index, title) in ["Review launch copy", "Plan the next release"].enumerated() {
                let id = "fixture-\(index)"
                let item = try WorkItemDocument.encode(WorkItemDocument.ItemMetadata(version: 1, captureId: id, title: title, state: "open", createdBy: member, createdAt: now, source: nil))
                let list = try WorkItemDocument.encode(WorkItemDocument.ListMetadata(version: 1, title: title, state: "open", commentCount: index == 0 ? 1 : 0, lastActivityAt: now))
                nodes[WorkItemPaths.item(id)] = VFSNode(path: WorkItemPaths.item(id), kind: .file, content: index == 0 ? "Keep the launch message clear." : "Collect ideas for the next release.", metadataJson: item, etag: "demo", createdAt: now, updatedAt: now)
                nodes[WorkItemPaths.listMetadata(id)] = VFSNode(path: WorkItemPaths.listMetadata(id), kind: .file, content: "", metadataJson: list, etag: "demo", createdAt: now, updatedAt: now)
            }
            let commentPath = WorkItemPaths.comment(itemId: "fixture-0", commentId: "11111111-1111-4111-8111-111111111111")
            let comment = try WorkItemDocument.encode(WorkItemDocument.CommentMetadata(version: 1, author: member, createdAt: now + 1000))
            nodes[commentPath] = VFSNode(path: commentPath, kind: .file, content: "The draft is ready. Can you review it?", metadataJson: comment, etag: "demo", createdAt: now + 1000, updatedAt: now + 1000)
            return
        }
        let original = NavigationFixtureVFS()
        let children = try await original.listChildren(databaseId: "personal", path: WorkItemPaths.root, session: session)
        for child in children {
            let id = WorkItemPaths.itemId(fromPath: child.path)!
            for path in [WorkItemPaths.item(id), WorkItemPaths.listMetadata(id)] {
                nodes[path] = try await original.readNode(databaseId: "personal", path: path, session: session)
            }
        }
    }
    func listChildren(databaseId: String, path: String, session: KinicIdentitySession) async throws -> [ChildNode] {
        try await seed(session)
        let prefix = path + "/"
        var children: [String: ChildNode] = [:]
        for node in nodes.values where node.path.hasPrefix(prefix) {
            let tail = String(node.path.dropFirst(prefix.count))
            let name = String(tail.split(separator: "/").first!)
            let folder = tail.contains("/")
            children[name] = ChildNode(path: prefix + name, name: name, kind: folder ? .folder : node.kind, updatedAt: node.updatedAt, etag: node.etag, sizeBytes: nil, hasChildren: folder, isVirtual: false)
        }
        return children.values.sorted { $0.name < $1.name }
    }
    func readNode(databaseId: String, path: String, session: KinicIdentitySession) async throws -> VFSNode? {
        try await seed(session)
        return nodes[path]
    }
    func mutateNodesBatch(databaseId: String, operations: [VFSNodeMutationOperation], session: KinicIdentitySession) async throws -> [VFSNodeMutationOutcome] {
        try await seed(session)
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        var staged = nodes
        var outcomes: [VFSNodeMutationOutcome] = []
        for operation in operations {
            switch operation {
            case .mkdir(let path): outcomes.append(.madeDirectory(created: true, path: path))
            case .write(let item):
                let existing = staged[item.path]
                if let expected = item.expectedEtag, existing?.etag != expected { throw WorkItemRepositoryError.etagConflict(item.path) }
                let etag = UUID().uuidString
                staged[item.path] = VFSNode(path: item.path, kind: item.kind, content: item.content, metadataJson: item.metadataJson, etag: etag, createdAt: existing?.createdAt ?? now, updatedAt: now)
                outcomes.append(.wrote(created: existing == nil, node: VFSNodeMutationAck(path: item.path, kind: item.kind, updatedAt: now, etag: etag)))
            }
        }
        // Local filming fixture only: seed a teammate's response on the newly
        // created item. This illustrates discussion, not live synchronization.
        if storyDemo {
            for node in Array(staged.values) where node.path.hasSuffix("/item.md") && nodes[node.path] == nil {
                guard case .loaded(let item) = WorkItemDocument.decode(WorkItemDocument.ItemMetadata.self, from: node.metadataJson),
                      item.title == "Write launch notes", let id = WorkItemPaths.itemId(fromPath: node.path) else { continue }
                let commentPath = WorkItemPaths.comment(itemId: id, commentId: "11111111-1111-4111-8111-111111111111")
                let comment = try WorkItemDocument.encode(WorkItemDocument.CommentMetadata(version: 1, author: "eyluy-bu6z2-q5dwg-4sved-2jenz-2r54a-t65kq-y6cz3-kkdrx-ta472-gae", createdAt: now))
                staged[commentPath] = VFSNode(path: commentPath, kind: .file, content: "Can you review these launch notes?", metadataJson: comment, etag: UUID().uuidString, createdAt: now, updatedAt: now)
                let path = WorkItemPaths.listMetadata(id)
                let list = try WorkItemDocument.encode(WorkItemDocument.ListMetadata(version: 1, title: item.title, state: item.state, commentCount: 1, lastActivityAt: now))
                staged[path] = VFSNode(path: path, kind: .file, content: "", metadataJson: list, etag: UUID().uuidString, createdAt: now, updatedAt: now)
            }
        }
        nodes = staged
        return outcomes
    }
    func searchNodes(databaseId: String, query: String, prefix: String?, limit: UInt32, session: KinicIdentitySession) async throws -> [SearchNodeHit] { [] }
}

@MainActor private final class DemoWidgetWriter: WorkItemWidgetSnapshotWriting {
    func workItemListDidLoad(databaseId: String, entries: [WorkItemListEntry], fetchedAt: Int64) {
        let store = WorkItemWidgetSnapshotStore(appGroupId: Bundle.main.optionalString("APP_GROUP_ID"))
        let database = WorkItemWidgetSnapshot.Database(id: databaseId, title: databaseId == "team" ? "Team Wiki" : "Personal Memory", canWrite: true, isAvailable: true, updatedAt: fetchedAt, items: WorkItemWidgetProjection.items(from: entries))
        try? store.write(WorkItemWidgetSnapshot(version: 1, writtenAt: fetchedAt, principal: "demo", selectedDatabaseId: databaseId, databases: [database]))
        WidgetCenter.shared.reloadAllTimelines()
    }
    func workItemListDidLoseAccess(databaseId: String) {}
}
#endif
