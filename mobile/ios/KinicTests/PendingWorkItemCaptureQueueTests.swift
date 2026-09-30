// Where: mobile/ios/KinicTests/PendingWorkItemCaptureQueueTests.swift
// What: Queue contract tests for work items captured by the Share Extension.
// Why: Input that crosses a process boundary must survive, stay account-scoped, and never duplicate.

import Foundation
import Testing
@testable import Kinic

struct PendingWorkItemCaptureQueueTests {
    private func makeQueue() throws -> (queue: PendingWorkItemCaptureQueue, directory: URL) {
        let directory = FileManager.default.temporaryDirectory.appending(path: "work-items-queue-\(UUID().uuidString)")
        return (try PendingWorkItemCaptureQueue(testQueueDirectory: directory), directory)
    }

    private func capture(id: String = "capture-1", principal: String = "2vxsx-fae") -> PendingWorkItemCapture {
        PendingWorkItemCapture(
            version: PendingWorkItemCapture.currentVersion,
            captureId: id,
            principal: principal,
            databaseId: "db-1",
            title: "Shared link",
            body: "https://example.com\n\nCheck this",
            source: WorkItemSource(kind: .share, url: "https://example.com", path: nil, label: "Example"),
            createdAt: 10
        )
    }

    @Test
    func roundTripsAQueuedCapture() throws {
        let (queue, _) = try makeQueue()

        try queue.enqueue(capture())
        let loaded = queue.load()

        #expect(loaded.count == 1)
        #expect(loaded.first?.captureId == "capture-1")
        #expect(loaded.first?.databaseId == "db-1")
        #expect(loaded.first?.source?.kind == .share)
        queue.remove(loaded[0])
        #expect(queue.load().isEmpty)
    }

    @Test
    func keepsOnlyTheNewestRecordForOneCaptureId() throws {
        let (queue, _) = try makeQueue()

        try queue.enqueue(capture())
        var replacement = capture()
        replacement.title = "Replaced"
        try queue.enqueue(replacement)

        let loaded = queue.load()
        #expect(loaded.count == 1)
        #expect(loaded.first?.title == "Replaced")
    }

    @Test
    func ignoresRecordsFromAnotherSchemaVersion() throws {
        let (queue, directory) = try makeQueue()
        var future = capture()
        future.version = PendingWorkItemCapture.currentVersion + 1

        #expect(throws: PendingWorkItemCaptureQueueError.unsupportedVersion(future.version)) {
            try queue.enqueue(future)
        }

        // A file left behind by a newer build is ignored rather than guessed at.
        try JSONEncoder().encode(future).write(to: directory.appending(path: "\(future.captureId).json"))
        #expect(queue.load().isEmpty)
    }

    @Test
    func rejectsAnUnsafeCaptureId() throws {
        let (queue, _) = try makeQueue()
        var unsafe = capture(id: "../escape")

        #expect(throws: PendingWorkItemCaptureQueueError.unsafeCaptureId) {
            try queue.enqueue(unsafe)
        }
        unsafe.captureId = "safe-id"
        try queue.enqueue(unsafe)
        #expect(queue.load().count == 1)
    }

    @Test
    func keepsTheDestinationTheMemberChose() {
        let record = capture().captureRecord()

        #expect(record.state == .local)
        #expect(record.databaseId == "db-1")
        #expect(record.provisionalTitle == "Shared link")
        #expect(record.sourceRefs.first?.kind == .share)
    }

    @Test
    func derivesATitleWithoutFetchingTheArticle() {
        let url = URL(string: "https://example.com/notes/first-post")!

        #expect(PendingWorkItemCapture.derivedTitle(url: url, metadataTitle: "Post title") == "Post title")
        #expect(PendingWorkItemCapture.derivedTitle(url: url, metadataTitle: "  ") == "example.com — first-post")
        #expect(PendingWorkItemCapture.sharedBody(url: url.absoluteString, note: "  ") == url.absoluteString)
        #expect(PendingWorkItemCapture.sharedBody(url: url.absoluteString, note: "Read later") == "\(url.absoluteString)\n\nRead later")
    }
}
