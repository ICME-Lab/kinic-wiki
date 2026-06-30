// Where: mobile/ios/KinicTests/ShareInboxTests.swift
// What: Unit tests for URL queue persistence.
// Why: Manual URL entry and Share Extension captures must feed the same app inbox.

import Foundation
import Testing
@testable import Kinic

struct ShareInboxTests {
    @Test
    func enqueuesAndLoadsManualURL() throws {
        let suiteName = "kinic.share-inbox.tests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        defer {
            defaults.removePersistentDomain(forName: suiteName)
        }

        let inbox = ShareInbox(appGroupId: suiteName)
        let receivedAt = Date(timeIntervalSince1970: 1_700_000_000)
        try inbox.enqueue(URL(string: "https://example.com/page")!, receivedAt: receivedAt)

        let pendingURLs = inbox.loadPendingURLs()
        #expect(pendingURLs.count == 1)
        #expect(pendingURLs.first?.url.absoluteString == "https://example.com/page")
        #expect(pendingURLs.first?.receivedAt == receivedAt)
    }
}
