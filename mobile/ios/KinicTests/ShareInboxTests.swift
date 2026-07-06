// Where: mobile/ios/KinicTests/ShareInboxTests.swift
// What: Unit tests for URL queue persistence.
// Why: Manual URL entry and Share Extension captures must feed the same app inbox.

import Foundation
import Testing
@testable import Kinic

struct ShareInboxTests {
    @Test
    func enqueuesAndLoadsManualURL() throws {
        let queueDirectory = makeQueueDirectory()
        defer { removeQueueDirectory(queueDirectory) }

        let inbox = try ShareInbox(testQueueDirectory: queueDirectory)
        let receivedAt = Date(timeIntervalSince1970: 1_700_000_000)
        try inbox.enqueue(
            URL(string: "https://example.com/page")!,
            receivedAt: receivedAt,
            requestId: "1700000000000-00000000-0000-4000-8000-000000000000"
        )

        let pendingURLs = inbox.loadPendingURLs()
        #expect(pendingURLs.count == 1)
        #expect(pendingURLs.first?.url.absoluteString == "https://example.com/page")
        #expect(pendingURLs.first?.receivedAt == receivedAt)
        #expect(pendingURLs.first?.requestId == "1700000000000-00000000-0000-4000-8000-000000000000")
    }

    @Test
    func appendsFromTwoWritersWithoutLostUpdate() throws {
        let queueDirectory = makeQueueDirectory()
        defer { removeQueueDirectory(queueDirectory) }

        let extensionInbox = try ShareInbox(testQueueDirectory: queueDirectory)
        let appInbox = try ShareInbox(testQueueDirectory: queueDirectory)
        try extensionInbox.enqueue(URL(string: "https://example.com/a")!)
        try appInbox.enqueue(URL(string: "https://example.com/b")!)

        let urls = appInbox.loadPendingURLs().map(\.url.absoluteString).sorted()
        #expect(urls == ["https://example.com/a", "https://example.com/b"])
    }

    @Test
    func removeDoesNotOverwriteConcurrentAppend() throws {
        let queueDirectory = makeQueueDirectory()
        defer { removeQueueDirectory(queueDirectory) }

        let appInbox = try ShareInbox(testQueueDirectory: queueDirectory)
        let extensionInbox = try ShareInbox(testQueueDirectory: queueDirectory)
        try appInbox.enqueue(URL(string: "https://example.com/old")!)
        let itemToRemove = try #require(appInbox.loadPendingURLs().first)

        try extensionInbox.enqueue(URL(string: "https://example.com/new")!)
        appInbox.remove(itemToRemove)

        #expect(appInbox.loadPendingURLs().map(\.url.absoluteString) == ["https://example.com/new"])
    }

    @Test
    func duplicateURLSharesRemainSeparateItems() throws {
        let queueDirectory = makeQueueDirectory()
        defer { removeQueueDirectory(queueDirectory) }

        let inbox = try ShareInbox(testQueueDirectory: queueDirectory)
        let url = URL(string: "https://example.com/page")!
        try inbox.enqueue(url, receivedAt: Date(timeIntervalSince1970: 1_700_000_000))
        try inbox.enqueue(url, receivedAt: Date(timeIntervalSince1970: 1_700_000_001))

        let pendingURLs = inbox.loadPendingURLs()
        #expect(pendingURLs.count == 2)
        #expect(Set(pendingURLs.map(\.id)).count == 2)
        #expect(pendingURLs.map(\.url.absoluteString) == ["https://example.com/page", "https://example.com/page"])
    }

    @Test
    func rejectsInvalidExplicitRequestIdOnEnqueue() throws {
        let queueDirectory = makeQueueDirectory()
        defer { removeQueueDirectory(queueDirectory) }

        let inbox = try ShareInbox(testQueueDirectory: queueDirectory)
        #expect(throws: SourceCaptureRequestError.invalidRequestId) {
            try inbox.enqueue(URL(string: "https://example.com/page")!, requestId: "../bad")
        }
        #expect(inbox.loadPendingURLs().isEmpty)
    }

    @Test
    func loadPendingURLsSkipsInvalidStoredRecords() throws {
        let queueDirectory = makeQueueDirectory()
        defer { removeQueueDirectory(queueDirectory) }

        let inbox = try ShareInbox(testQueueDirectory: queueDirectory)
        let receivedAt = Date(timeIntervalSince1970: 1_700_000_000)
        try writeJSON(
            SharedURLRecord(
                id: "valid-id",
                url: "https://example.com/valid#section",
                receivedAt: receivedAt,
                requestId: "1700000000000-00000000-0000-4000-8000-000000000000"
            ),
            to: queueDirectory.appending(path: "valid-id.json")
        )
        try writeJSON(
            SharedURLRecord(
                id: "file-url",
                url: "file:///tmp/a",
                receivedAt: receivedAt.addingTimeInterval(-30),
                requestId: "1700000000000-00000000-0000-4000-8000-000000000003"
            ),
            to: queueDirectory.appending(path: "file-url.json")
        )
        try writeJSON(
            SharedURLRecord(
                id: "script-url",
                url: "javascript:alert(1)",
                receivedAt: receivedAt.addingTimeInterval(-20),
                requestId: "1700000000000-00000000-0000-4000-8000-000000000004"
            ),
            to: queueDirectory.appending(path: "script-url.json")
        )
        try writeJSON(
            SharedURLRecord(
                id: "missing-host",
                url: "https:///missing-host",
                receivedAt: receivedAt.addingTimeInterval(-10),
                requestId: "1700000000000-00000000-0000-4000-8000-000000000005"
            ),
            to: queueDirectory.appending(path: "missing-host.json")
        )
        try writeJSON(
            SharedURLRecord(
                id: "mismatched-id",
                url: "https://example.com/mismatched-id",
                receivedAt: receivedAt,
                requestId: "1700000000000-00000000-0000-4000-8000-000000000002"
            ),
            to: queueDirectory.appending(path: "mismatched-filename.json")
        )
        try writeJSON(
            SharedURLRecord(
                id: "../bad",
                url: "https://example.com/bad-id",
                receivedAt: receivedAt,
                requestId: "1700000000000-00000000-0000-4000-8000-000000000001"
            ),
            to: queueDirectory.appending(path: "invalid-id.json")
        )
        try writeJSON(
            SharedURLRecord(
                id: "bad-request",
                url: "https://example.com/bad-request",
                receivedAt: receivedAt,
                requestId: "../bad"
            ),
            to: queueDirectory.appending(path: "invalid-request.json")
        )
        try Data("not json".utf8).write(to: queueDirectory.appending(path: "broken.json"))

        let pendingURLs = inbox.loadPendingURLs()
        #expect(pendingURLs.map(\.url.absoluteString) == ["https://example.com/valid"])
        #expect(pendingURLs.map(\.requestId) == ["1700000000000-00000000-0000-4000-8000-000000000000"])
    }

    @Test
    func sourceCaptureTriggerQueueStoresFailureAndRemovesAcceptedTrigger() throws {
        let queueDirectory = makeQueueDirectory()
        defer { removeQueueDirectory(queueDirectory) }

        let queue = try SourceCaptureTriggerQueue(testQueueDirectory: queueDirectory)
        let request = try SourceCaptureRequestBuilder.request(
            url: URL(string: "https://example.com/page")!,
            databaseId: "db_demo",
            requestedBy: "aaaaa-aa",
            requestId: "1700000000000-00000000-0000-4000-8000-000000000000"
        )
        let createdAt = Date(timeIntervalSince1970: 1_700_000_000)

        try queue.enqueue(request, createdAt: createdAt)
        var pending = try #require(queue.loadPendingTriggers().first)
        #expect(pending.databaseId == "db_demo")
        #expect(pending.requestPath == request.requestPath)
        #expect(pending.requestId == request.requestId)
        #expect(pending.url.absoluteString == "https://example.com/page")
        #expect(pending.createdAt == createdAt)
        #expect(pending.lastError == nil)

        queue.updateFailure(pending, error: "worker unavailable")
        pending = try #require(queue.loadPendingTriggers().first)
        #expect(pending.lastError == "worker unavailable")

        queue.remove(pending)
        #expect(queue.loadPendingTriggers().isEmpty)
    }

    @Test
    func sourceCaptureTriggerQueueSkipsInvalidStoredRecords() throws {
        let queueDirectory = makeQueueDirectory()
        defer { removeQueueDirectory(queueDirectory) }

        let queue = try SourceCaptureTriggerQueue(testQueueDirectory: queueDirectory)
        let createdAt = Date(timeIntervalSince1970: 1_700_000_000)
        let validRequestId = "1700000000000-00000000-0000-4000-8000-000000000000"
        try writeJSON(
            SourceCaptureTriggerRecord(
                databaseId: "db_demo",
                requestPath: "/Sources/source-capture-requests/\(validRequestId).md",
                requestId: validRequestId,
                url: "https://example.com/valid#section",
                createdAt: createdAt,
                lastError: nil
            ),
            to: queueDirectory.appending(path: "\(validRequestId).json")
        )
        let invalidURLRequestId = "1700000000000-00000000-0000-4000-8000-000000000003"
        try writeJSON(
            SourceCaptureTriggerRecord(
                databaseId: "db_demo",
                requestPath: "/Sources/source-capture-requests/\(invalidURLRequestId).md",
                requestId: invalidURLRequestId,
                url: "file:///tmp/a",
                createdAt: createdAt.addingTimeInterval(-10),
                lastError: nil
            ),
            to: queueDirectory.appending(path: "\(invalidURLRequestId).json")
        )
        let mismatchedFilenameRequestId = "1700000000000-00000000-0000-4000-8000-000000000002"
        try writeJSON(
            SourceCaptureTriggerRecord(
                databaseId: "db_demo",
                requestPath: "/Sources/source-capture-requests/\(mismatchedFilenameRequestId).md",
                requestId: mismatchedFilenameRequestId,
                url: "https://example.com/mismatched-filename",
                createdAt: createdAt,
                lastError: nil
            ),
            to: queueDirectory.appending(path: "mismatched-filename.json")
        )
        try writeJSON(
            SourceCaptureTriggerRecord(
                databaseId: "db_demo",
                requestPath: "/Sources/source-capture-requests/invalid.md",
                requestId: "../bad",
                url: "https://example.com/bad-request",
                createdAt: createdAt,
                lastError: nil
            ),
            to: queueDirectory.appending(path: "invalid-request.json")
        )
        try writeJSON(
            SourceCaptureTriggerRecord(
                databaseId: "db_demo",
                requestPath: "/Sources/source-capture-requests/mismatch.md",
                requestId: "1700000000000-00000000-0000-4000-8000-000000000001",
                url: "https://example.com/mismatch",
                createdAt: createdAt,
                lastError: nil
            ),
            to: queueDirectory.appending(path: "mismatch.json")
        )
        try Data("not json".utf8).write(to: queueDirectory.appending(path: "broken.json"))

        let triggers = queue.loadPendingTriggers()
        #expect(triggers.map(\.url.absoluteString) == ["https://example.com/valid"])
        #expect(triggers.map(\.requestId) == [validRequestId])
    }

    @Test
    func sharedDefaultsStoreStrictnessIsExplicit() throws {
        #expect(throws: SharedDefaultsStoreError.missingAppGroupId) {
            try SharedDefaultsStore(appGroupId: nil, strict: true)
        }

        let suiteName = "kinic.shared-defaults.tests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        defer {
            defaults.removePersistentDomain(forName: suiteName)
        }

        let strictStore = try SharedDefaultsStore(appGroupId: suiteName, strict: true)
        strictStore.databaseId = "db_demo"
        #expect(strictStore.databaseId == "db_demo")

        let fallbackStore = try SharedDefaultsStore(appGroupId: nil)
        fallbackStore.databaseId = "db_preview"
        #expect(fallbackStore.databaseId == "db_preview")
        fallbackStore.databaseId = ""
    }

    @Test
    func classifiesOnlySupportedUniversalLinkEntrypoints() {
        #expect(AppModel.openURLAction(
            for: URL(string: "https://wiki.kinic.xyz/ios-share?queued=1")!,
            callbackDomain: "wiki.kinic.xyz"
        ) == .shareHandoff)
        #expect(AppModel.openURLAction(
            for: URL(string: "https://wiki.kinic.xyz/ios-auth-callback?state=s1")!,
            callbackDomain: "wiki.kinic.xyz"
        ) == .authCallback)
        #expect(AppModel.openURLAction(
            for: URL(string: "https://wiki.kinic.xyz/db/demo")!,
            callbackDomain: "wiki.kinic.xyz"
        ) == .ignore)
        #expect(AppModel.openURLAction(
            for: URL(string: "https://evil.example/ios-share")!,
            callbackDomain: "wiki.kinic.xyz"
        ) == .ignore)
        #expect(AppModel.openURLAction(
            for: URL(string: "kinicwiki://share")!,
            callbackDomain: "wiki.kinic.xyz"
        ) == .ignore)
        #expect(AppModel.openURLAction(
            for: URL(string: "kinicwiki://other")!,
            callbackDomain: "wiki.kinic.xyz"
        ) == .ignore)
    }

    @Test
    func validatesDatabaseNames() {
        #expect(AppModel.databaseNameError("Team skills") == nil)
        #expect(AppModel.databaseNameError("") == "Database name is required.")
        #expect(AppModel.databaseNameError(String(repeating: "a", count: 81)) == "Database name must be 1..80 characters.")
        #expect(AppModel.databaseNameError("Team\u{0001}") == "Database name may not contain control characters.")
    }
}

private func makeQueueDirectory() -> URL {
    FileManager.default.temporaryDirectory
        .appending(path: "kinic-share-inbox-tests")
        .appending(path: UUID().uuidString)
}

private func removeQueueDirectory(_ url: URL) {
    try? FileManager.default.removeItem(at: url)
}

private func writeJSON<T: Encodable>(_ value: T, to fileURL: URL) throws {
    let data = try JSONEncoder().encode(value)
    try data.write(to: fileURL)
}
