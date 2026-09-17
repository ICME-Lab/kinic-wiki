import Foundation
import Testing
@testable import Kinic

struct DatabaseSelectionAndBudgetTests {
    @Test func budgetRoundTripsWithoutRounding() {
        for amount: UInt64 in [0, 1, 999_999, 1_000_000, 999_999_999, 30_000_000_000, 300_000_000_000, 3_999_460_636_530, UInt64(Int64.max)] {
            for unit in CycleBudgetUnit.allCases {
                #expect(unit.cycles(from: unit.text(for: amount)) == amount)
            }
        }
        #expect(CycleBudgetUnit.preferred(for: 300_000_000_000) == .billion)
        #expect(CycleBudgetUnit.billion.text(for: 300_000_000_000) == "300")
        #expect(CycleBudgetUnit.billion.cycles(from: "0.000000001") == 1)
    }
    @Test func budgetRejectsInvalidAndOverflowAmounts() {
        for text in ["", "-1", "1e3", "1.2.3", "NaN", "9223372036854775808"] {
            #expect(CycleBudgetUnit.cycles.cycles(from: text) == nil)
        }
        #expect(CycleBudgetUnit.billion.cycles(from: "0.0000000001") == nil)
        #expect(CycleBudgetUnit.trillion.cycles(from: "9223372.036854775808") == nil)
        #expect(CycleBudgetUnit.cycles.cycles(from: "0.0") == 0)
    }
    @Test func selectionIsSharedButAccountScoped() throws {
        let name = "selection-tests.\(UUID())"
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let app = SharedDefaultsStore(defaults: defaults)
        let share = SharedDefaultsStore(defaults: defaults)
        defaults.set("old", forKey: "kinic.database-id.v1")
        #expect(app.selectedDatabase(configuration: .preview, principal: "alice").isEmpty)
        app.selectDatabase("db-a", configuration: .preview, principal: "alice")
        #expect(share.selectedDatabase(configuration: .preview, principal: "alice") == "db-a")
        #expect(share.selectedDatabase(configuration: .preview, principal: "bob").isEmpty)
        share.selectDatabase("db-b", configuration: .preview, principal: "bob")
        #expect(app.selectedDatabase(configuration: .preview, principal: "alice") == "db-a")
    }
    @MainActor @Test func initialSelectionUsesSavedThenRoleAndStableID() {
        func db(_ id: String, _ role: DatabaseRole, _ status: DatabaseStatus = .active) -> DatabaseSummary {
            DatabaseSummary(databaseId: id, title: id, description: "", metadata: nil, role: role, status: status, logicalSizeBytes: 0, cyclesBalance: 0, cyclesSuspendedAtMs: nil, deletedAtMs: nil)
        }
        let databases = [db("z", .owner), db("b", .reader), db("a", .owner), db("c", .writer), db("0", .owner, .deleted)]
        #expect(AppModel.initialDatabaseID(databases, saved: "b") == "b")
        #expect(AppModel.initialDatabaseID(databases.reversed(), saved: "gone") == "a")
        #expect(AppModel.initialDatabaseID([db("b", .reader), db("c", .writer)], saved: "") == "c")
        #expect(AppModel.initialDatabaseID([], saved: "gone").isEmpty)
    }
    @MainActor @Test func commonSelectionRejectsSwitchDuringVoicePresentation() {
        let model = AppModel.preview()
        model.selectedDatabaseId = "first"
        #expect(model.selectedAskAIDatabaseId == "first")
        model.voicePresentationActive = true
        #expect(model.requestBrowseDatabaseSelection("other") == .unchanged)
        #expect(model.selectedDatabaseId == "first")
        #expect(model.statusMessage == AppModel.databaseSelectionLockMessage)
    }

    @MainActor @Test func writableSelectionSubmitsPendingURL() async throws {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "kinic-database-selection-tests")
            .appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let inbox = try ShareInbox(testQueueDirectory: root.appending(path: "inbox"))
        let history = try SourceCaptureHistoryStore(testHistoryDirectory: root.appending(path: "history"))
        try inbox.enqueue(
            URL(string: "https://example.com/pending")!,
            requestId: "1700000000000-00000000-0000-4000-8000-000000000000"
        )
        let probe = SourceCaptureSaveProbe()
        let database = DatabaseSummary(
            databaseId: "db_write",
            title: "Writable",
            description: "",
            metadata: nil,
            role: .writer,
            status: .active,
            logicalSizeBytes: 0,
            cyclesBalance: nil,
            cyclesSuspendedAtMs: nil,
            deletedAtMs: nil
        )
        let model = AppModel(
            configuration: .preview,
            authService: makeTestAuthService(),
            client: try KinicICClient(configuration: .preview),
            shareInbox: inbox,
            settingsStore: SharedDefaultsStore(defaults: try #require(UserDefaults(suiteName: UUID().uuidString))),
            sourceCaptureHistoryStore: history,
            saveSourceCaptureRemotely: { request, _ in
                await probe.save(request)
            },
            readBrowseNodeRemotely: { _, _, _ in nil },
            listBrowseChildrenRemotely: { _, _, _ in [] },
            initialSession: .testing(principal: "aaaaa-aa")
        )
        model.databases = [database]
        model.readableDatabases = [database]

        #expect(model.pendingURLs.count == 1)
        #expect(await probe.requests().isEmpty)
        #expect(model.requestBrowseDatabaseSelection("db_write") == .applied)
        for _ in 0..<100 where await probe.requests().isEmpty {
            try await Task.sleep(for: .milliseconds(5))
        }

        #expect(await probe.requests().map(\.databaseId) == ["db_write"])
        #expect(inbox.loadPendingURLs().isEmpty)
    }
}

private actor SourceCaptureSaveProbe {
    private var recordedRequests: [SourceCaptureRequest] = []

    func save(_ request: SourceCaptureRequest) -> CaptureSubmission {
        recordedRequests.append(request)
        return CaptureSubmission(
            databaseId: request.databaseId,
            requestPath: request.requestPath,
            requestId: request.requestId,
            url: request.normalizedURL,
            sessionNonce: "test-session"
        )
    }

    func requests() -> [SourceCaptureRequest] {
        recordedRequests
    }
}
