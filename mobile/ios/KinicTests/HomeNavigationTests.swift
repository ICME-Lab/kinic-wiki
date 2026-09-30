import Foundation
import Testing
@testable import Kinic

struct HomeNavigationTests {
    private func record(_ id: String, database: String = "a", time: Int64, status: SourceCaptureHistoryStatus, syncError: String? = nil) -> SourceCaptureHistoryRecord {
        SourceCaptureHistoryRecord(databaseId: database, item: SourceCaptureHistoryItem(requestPath: id, url: "https://example.com/\(id)", status: status, requestedAtMilliseconds: time, updatedAtMilliseconds: time, claimedAt: nil, sourcePath: nil, targetPath: nil, finishedAt: nil, error: nil, syncError: syncError))
    }

    @Test func recentCapturesAreSortedCappedAndScoped() {
        let summary = HomeCaptureSummary(records: [
            record("old", time: 1, status: .completed), record("new", time: 4, status: .queued),
            record("middle", time: 3, status: .generating), record("second", time: 2, status: .failed),
            record("other", database: "b", time: 100, status: .failed)
        ], databaseId: "a")
        #expect(summary.recent.map(\.item.requestPath) == ["new", "middle", "second"])
        #expect(summary.failedCount == 1)
        #expect(summary.failed.first?.item.requestPath == "second")
    }

    @Test func processingAndStaleStatesAreNotFailures() {
        let summary = HomeCaptureSummary(records: [
            record("queued", time: 1, status: .queued), record("fetching", time: 2, status: .fetching),
            record("saved", time: 3, status: .sourceWritten), record("generating", time: 4, status: .generating),
            record("stale", time: 5, status: .completed, syncError: "Offline")
        ], databaseId: "a")
        #expect(summary.failedCount == 0)
        #expect(summary.recent.first?.item.syncError == "Offline")
        #expect(HomeCaptureSummary(records: summary.records, databaseId: "missing").recent.isEmpty)
    }

    @MainActor @Test func draftLocksAreOwnedAndPreventCrossTabSwitching() {
        let model = AppModel.preview()
        model.selectedDatabaseId = "a"
        let editor = UUID(), composer = UUID()
        model.setWorkItemDraftActive(true, owner: editor)
        model.setWorkItemDraftActive(true, owner: composer)
        #expect(model.requestBrowseDatabaseSelection("b") == .unchanged)
        #expect(model.selectedDatabaseId == "a")
        #expect(model.statusMessage == model.databaseSelectionLockReason)
        model.setWorkItemDraftActive(false, owner: editor)
        #expect(model.databaseSelectionLocked)
        model.setWorkItemDraftActive(false, owner: composer)
        #expect(!model.databaseSelectionLocked)
        model.voicePresentationActive = true
        #expect(model.databaseSelectionLockReason == AppModel.databaseSelectionLockMessage)
        #expect(model.databaseSelectionLocked)
    }
}
