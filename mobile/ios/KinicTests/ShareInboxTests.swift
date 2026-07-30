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
        #expect(pendingURLs.first?.outputLanguage == .english)
    }

    @Test
    func enqueuesAndLoadsOutputLanguage() throws {
        let queueDirectory = makeQueueDirectory()
        defer { removeQueueDirectory(queueDirectory) }

        let inbox = try ShareInbox(testQueueDirectory: queueDirectory)
        try inbox.enqueue(
            URL(string: "https://example.com/page")!,
            requestId: "1700000000000-00000000-0000-4000-8000-000000000000",
            outputLanguage: .portuguese
        )

        #expect(try #require(inbox.loadPendingURLs().first).outputLanguage == .portuguese)
    }

    @Test
    func enqueuesAndLoadsDatabaseId() throws {
        let queueDirectory = makeQueueDirectory()
        defer { removeQueueDirectory(queueDirectory) }

        let inbox = try ShareInbox(testQueueDirectory: queueDirectory)
        try inbox.enqueue(
            URL(string: "https://example.com/page")!,
            requestId: "1700000000000-00000000-0000-4000-8000-000000000000",
            databaseId: " db_demo "
        )

        let pendingURL = try #require(inbox.loadPendingURLs().first)
        #expect(pendingURL.databaseId == "db_demo")
    }

    @Test
    func enqueuesAndLoadsCaptureMetadata() throws {
        let queueDirectory = makeQueueDirectory()
        defer { removeQueueDirectory(queueDirectory) }

        let metadata = ShareCaptureMetadata(
            title: "Since AI (@sinceaihq)",
            description: "Building an AI product is one thing.",
            imageURL: URL(string: "https://pbs.twimg.com/media/card.jpg")!,
            source: ShareCaptureMetadata.xOpenGraphSource,
            fetchedAt: Date(timeIntervalSince1970: 1_700_000_000)
        )
        let inbox = try ShareInbox(testQueueDirectory: queueDirectory)
        try inbox.enqueue(
            URL(string: "https://x.com/sinceaihq/status/2074424777675046913")!,
            receivedAt: Date(timeIntervalSince1970: 1_700_000_001),
            requestId: "1700000001000-00000000-0000-4000-8000-000000000000",
            captureMetadata: metadata
        )

        let pendingURL = try #require(inbox.loadPendingURLs().first)
        #expect(pendingURL.captureMetadata == metadata)
    }

    @Test
    func appRetryRebuildsInitialSourceCaptureRequestContent() throws {
        let receivedAt = Date(timeIntervalSince1970: 1_700_000_000)
        let retryAt = Date(timeIntervalSince1970: 1_700_000_999)
        let uuid = try #require(UUID(uuidString: "00000000-0000-4000-8000-000000000000"))
        let url = URL(string: "https://x.com/sinceaihq/status/2074424777675046913?s=46")!
        let metadata = ShareCaptureMetadata(
            title: "Since AI (@sinceaihq)",
            description: "Building an AI product is one thing.",
            imageURL: URL(string: "https://pbs.twimg.com/media/card.jpg")!,
            source: ShareCaptureMetadata.xOpenGraphSource,
            fetchedAt: Date(timeIntervalSince1970: 1_700_000_100)
        )
        let initialRequest = try SourceCaptureRequestBuilder.request(
            url: url,
            databaseId: "db_demo",
            requestedBy: "aaaaa-aa",
            now: receivedAt,
            uuid: uuid,
            outputLanguage: .japanese,
            captureMetadata: metadata
        )
        let pendingURL = PendingSharedURL(
            id: "queued",
            url: url,
            receivedAt: receivedAt,
            requestId: initialRequest.requestId,
            outputLanguage: .japanese,
            captureMetadata: metadata
        )

        let retryRequest = try AppModel.sourceCaptureRequest(
            for: pendingURL,
            databaseId: initialRequest.databaseId,
            requestedBy: "aaaaa-aa"
        )
        let retryTimeRequest = try SourceCaptureRequestBuilder.request(
            url: url,
            databaseId: initialRequest.databaseId,
            requestedBy: "aaaaa-aa",
            requestId: initialRequest.requestId,
            now: retryAt,
            outputLanguage: .japanese,
            captureMetadata: metadata
        )

        #expect(retryRequest.content == initialRequest.content)
        #expect(retryRequest.metadataJson == initialRequest.metadataJson)
        #expect(retryRequest.outputLanguage == .japanese)
        #expect(retryRequest.content.contains(receivedAt.formatted(.iso8601)))
        #expect(!retryRequest.content.contains(retryAt.formatted(.iso8601)))
        #expect(retryRequest.content != retryTimeRequest.content)
    }

    @Test
    func pendingRetryUsesQueuedDatabaseWhenPresent() throws {
        let pendingURL = PendingSharedURL(
            id: "queued",
            url: URL(string: "https://example.com/page")!,
            receivedAt: Date(timeIntervalSince1970: 1_700_000_000),
            requestId: "1700000000000-00000000-0000-4000-8000-000000000000",
            databaseId: "db_original"
        )

        let resolution = AppModel.pendingSubmissionDatabaseId(
            for: pendingURL,
            selectedDatabaseId: "db_current",
            writableDatabaseIds: ["db_original", "db_current"]
        )

        #expect(resolution == .ready("db_original"))
        guard case let .ready(databaseId) = resolution else {
            Issue.record("Expected queued database to resolve")
            return
        }
        let request = try AppModel.sourceCaptureRequest(
            for: pendingURL,
            databaseId: databaseId,
            requestedBy: "aaaaa-aa"
        )
        #expect(request.databaseId == "db_original")
    }

    @Test
    func pendingRetryRejectsQueuedDatabaseWithoutWritableAccess() {
        let pendingURL = PendingSharedURL(
            id: "queued",
            url: URL(string: "https://example.com/page")!,
            receivedAt: Date(timeIntervalSince1970: 1_700_000_000),
            requestId: "1700000000000-00000000-0000-4000-8000-000000000000",
            databaseId: "db_original"
        )

        let resolution = AppModel.pendingSubmissionDatabaseId(
            for: pendingURL,
            selectedDatabaseId: "db_current",
            writableDatabaseIds: ["db_current"]
        )

        #expect(resolution == .unavailable("db_original"))
    }

    @Test
    func publicDatabaseRefreshFailureFallsBackToEmptyList() async {
        let result = await AppModel.publicDatabasesForRefresh(showPublic: true) {
            throw ShareInboxTestError.publicListFailed
        }

        #expect(result.databases.isEmpty)
        #expect(result.errorMessage?.contains("Public database list unavailable") == true)
    }

    @Test
    func loadsLegacyRecordsWithoutCaptureMetadata() throws {
        let queueDirectory = makeQueueDirectory()
        defer { removeQueueDirectory(queueDirectory) }

        try FileManager.default.createDirectory(at: queueDirectory, withIntermediateDirectories: true)
        let legacyJSON = #"""
        {
          "id": "legacy-id",
          "url": "https://example.com/legacy#section",
          "receivedAt": 1700000000,
          "requestId": "1700000000000-00000000-0000-4000-8000-000000000000"
        }
        """#
        try Data(legacyJSON.utf8).write(to: queueDirectory.appending(path: "legacy-id.json"))
        let inbox = try ShareInbox(testQueueDirectory: queueDirectory)

        let pendingURL = try #require(inbox.loadPendingURLs().first)
        #expect(pendingURL.url.absoluteString == "https://example.com/legacy")
        #expect(pendingURL.databaseId == nil)
        #expect(pendingURL.captureMetadata == nil)
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
    func sharedDefaultsStoreCachesOnlyWritableDatabases() throws {
        let suiteName = "kinic.shared-defaults.tests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        defer {
            defaults.removePersistentDomain(forName: suiteName)
        }

        let store = try SharedDefaultsStore(appGroupId: suiteName, strict: true)
        store.writableDatabases = [
            database(databaseId: "db_reader", role: .reader),
            database(databaseId: "db_writer", role: .writer),
            database(databaseId: "db_owner", role: .owner)
        ]

        #expect(store.writableDatabases.map(\.databaseId) == ["db_writer", "db_owner"])
    }

    @Test
    func sharedDefaultsStorePersistsAppearanceMode() throws {
        let suiteName = "kinic.shared-defaults.tests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        defer {
            defaults.removePersistentDomain(forName: suiteName)
        }

        let store = try SharedDefaultsStore(appGroupId: suiteName, strict: true)
        #expect(store.isDarkAppearanceEnabled == false)

        store.isDarkAppearanceEnabled = true
        #expect(try SharedDefaultsStore(appGroupId: suiteName, strict: true).isDarkAppearanceEnabled == true)

        store.isDarkAppearanceEnabled = false
        #expect(try SharedDefaultsStore(appGroupId: suiteName, strict: true).isDarkAppearanceEnabled == false)
    }

    @Test
    func sharedDefaultsStorePersistsOutputLanguageAndDefaultsToEnglish() throws {
        let suiteName = "kinic.shared-defaults.tests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        defer {
            defaults.removePersistentDomain(forName: suiteName)
        }

        let store = try SharedDefaultsStore(appGroupId: suiteName, strict: true)
        #expect(store.wikiOutputLanguage == .english)

        for language in WikiOutputLanguage.allCases {
            store.wikiOutputLanguage = language
            #expect(try SharedDefaultsStore(appGroupId: suiteName, strict: true).wikiOutputLanguage == language)
        }

        defaults.set("unsupported", forKey: "kinic.wiki-output-language.v1")
        #expect(store.wikiOutputLanguage == .english)
    }

    @Test
    func sharedDefaultsStorePersistsBrowseDatabaseVisibilityToggles() throws {
        let suiteName = "kinic.shared-defaults.tests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        defer {
            defaults.removePersistentDomain(forName: suiteName)
        }

        let store = try SharedDefaultsStore(appGroupId: suiteName, strict: true)
        #expect(store.showPublicBrowseDatabases == true)
        #expect(store.showPurchasedBrowseDatabases == false)

        store.showPublicBrowseDatabases = true
        store.showPurchasedBrowseDatabases = true
        #expect(try SharedDefaultsStore(appGroupId: suiteName, strict: true).showPublicBrowseDatabases == true)
        #expect(try SharedDefaultsStore(appGroupId: suiteName, strict: true).showPurchasedBrowseDatabases == true)

        store.showPublicBrowseDatabases = false
        store.showPurchasedBrowseDatabases = false
        #expect(try SharedDefaultsStore(appGroupId: suiteName, strict: true).showPublicBrowseDatabases == false)
        #expect(try SharedDefaultsStore(appGroupId: suiteName, strict: true).showPurchasedBrowseDatabases == false)
    }

    @Test
    func classifiesOnlySupportedUniversalLinkEntrypoints() {
        #expect(AppModel.openURLDestination(
            for: URL(string: "https://wiki.kinic.xyz/ios-share?queued=1")!,
            callbackDomain: "wiki.kinic.xyz"
        ) == .shareHandoff)
        #expect(AppModel.openURLDestination(
            for: URL(string: "https://wiki.kinic.xyz/ios-auth-callback?state=s1")!,
            callbackDomain: "wiki.kinic.xyz"
        ) == .authCallback)
        #expect(AppModel.openURLDestination(
            for: URL(string: "https://wiki.kinic.xyz/db/db_1")!,
            callbackDomain: "wiki.kinic.xyz"
        ) == .browse(databaseId: "db_1", nodePath: "/Knowledge"))
        #expect(AppModel.openURLDestination(
            for: URL(string: "https://wiki.kinic.xyz/db/db_1/Knowledge/Page.md")!,
            callbackDomain: "wiki.kinic.xyz"
        ) == .browse(databaseId: "db_1", nodePath: "/Knowledge/Page.md"))
        #expect(AppModel.openURLDestination(
            for: URL(string: "https://wiki.kinic.xyz/db/db%201/Knowledge/space%20name.md")!,
            callbackDomain: "wiki.kinic.xyz"
        ) == .browse(databaseId: "db 1", nodePath: "/Knowledge/space name.md"))
        #expect(AppModel.openURLDestination(
            for: URL(string: "https://wiki.kinic.xyz/dashboard")!,
            callbackDomain: "wiki.kinic.xyz"
        ) == .manage)
        #expect(AppModel.openURLDestination(
            for: URL(string: "https://wiki.kinic.xyz/profile")!,
            callbackDomain: "wiki.kinic.xyz"
        ) == .manage)
        #expect(AppModel.openURLDestination(
            for: URL(string: "https://wiki.kinic.xyz/marketplace/listing-1")!,
            callbackDomain: "wiki.kinic.xyz"
        ) == .home(nil))
        #expect(AppModel.openURLDestination(
            for: URL(string: "https://wiki.kinic.xyz/")!,
            callbackDomain: "wiki.kinic.xyz"
        ) == .home(nil))
        #expect(AppModel.openURLDestination(
            for: URL(string: "https://evil.example/ios-share")!,
            callbackDomain: "wiki.kinic.xyz"
        ) == .ignore)
        #expect(AppModel.openURLDestination(
            for: URL(string: "kinicwiki://share")!,
            callbackDomain: "wiki.kinic.xyz"
        ) == .ignore)
        #expect(AppModel.openURLDestination(
            for: URL(string: "kinicwiki://other")!,
            callbackDomain: "wiki.kinic.xyz"
        ) == .ignore)
    }

    @MainActor
    @Test
    func appModelPersistsAppearanceMode() throws {
        let suiteName = "kinic.shared-defaults.tests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        defer {
            defaults.removePersistentDomain(forName: suiteName)
        }
        let inboxDirectory = makeQueueDirectory()
        defer {
            removeQueueDirectory(inboxDirectory)
        }
        let store = SharedDefaultsStore(defaults: defaults)
        let model = AppModel(
            configuration: .preview,
            authService: KinicAuthService(configuration: .preview),
            client: KinicICClient(configuration: .preview),
            shareInbox: try ShareInbox(testQueueDirectory: inboxDirectory),
            settingsStore: store
        )

        #expect(model.isDarkAppearanceEnabled == false)
        model.setDarkAppearanceEnabled(true)
        #expect(model.isDarkAppearanceEnabled == true)
        #expect(store.isDarkAppearanceEnabled == true)
    }

    @MainActor
    @Test
    func appModelPersistsBrowseDatabaseVisibilityToggles() throws {
        let suiteName = "kinic.shared-defaults.tests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        defer {
            defaults.removePersistentDomain(forName: suiteName)
        }
        let inboxDirectory = makeQueueDirectory()
        defer {
            removeQueueDirectory(inboxDirectory)
        }
        let store = SharedDefaultsStore(defaults: defaults)
        let model = AppModel(
            configuration: .preview,
            authService: KinicAuthService(configuration: .preview),
            client: KinicICClient(configuration: .preview),
            shareInbox: try ShareInbox(testQueueDirectory: inboxDirectory),
            settingsStore: store
        )

        #expect(model.showPublicBrowseDatabases == true)
        #expect(model.showPurchasedBrowseDatabases == false)
        model.setShowPublicBrowseDatabases(true)
        model.setShowPurchasedBrowseDatabases(true)
        #expect(store.showPublicBrowseDatabases == true)
        #expect(store.showPurchasedBrowseDatabases == true)
    }

    @MainActor
    @Test
    func appModelStartsBrowseWithoutRestoringAStoredDatabaseSelection() throws {
        let suiteName = "kinic.app-model-browse-selection.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        let inboxDirectory = makeQueueDirectory()
        defer {
            defaults.removePersistentDomain(forName: suiteName)
            removeQueueDirectory(inboxDirectory)
        }
        let store = SharedDefaultsStore(defaults: defaults)
        defaults.set("db_first", forKey: "kinic.browse-database-id.v1")
        let model = AppModel(
            configuration: .preview,
            authService: KinicAuthService(configuration: .preview),
            client: KinicICClient(configuration: .preview),
            shareInbox: try ShareInbox(testQueueDirectory: inboxDirectory),
            settingsStore: store
        )

        #expect(model.selectedBrowseDatabaseId.isEmpty)
    }

    @MainActor
    @Test
    func appModelPersistsOutputLanguage() throws {
        let suiteName = "kinic.app-model-output-language.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        let inboxDirectory = makeQueueDirectory()
        defer {
            defaults.removePersistentDomain(forName: suiteName)
            removeQueueDirectory(inboxDirectory)
        }
        let store = SharedDefaultsStore(defaults: defaults)
        let model = AppModel(
            configuration: .preview,
            authService: KinicAuthService(configuration: .preview),
            client: KinicICClient(configuration: .preview),
            shareInbox: try ShareInbox(testQueueDirectory: inboxDirectory),
            settingsStore: store
        )

        #expect(model.wikiOutputLanguage == .english)
        model.wikiOutputLanguage = .korean
        #expect(store.wikiOutputLanguage == .korean)
    }

    @MainActor
    @Test
    func dashboardUniversalLinkRequestsManageTab() {
        let model = AppModel.preview()
        model.selectedBrowseDatabaseId = "db_preview"
        model.currentPath = "/Knowledge/Nested"
        model.currentNode = VFSNode(
            path: "/Knowledge/Nested",
            kind: .folder,
            content: "",
            metadataJson: "{}",
            etag: "folder-etag",
            createdAt: 1,
            updatedAt: 2
        )
        model.childNodes = [
            ChildNode(
                path: "/Knowledge/Nested/Page.md",
                name: "Page.md",
                kind: .file,
                updatedAt: 2,
                etag: "etag",
                sizeBytes: 4,
                hasChildren: false,
                isVirtual: false
            )
        ]
        model.loadedBrowsePath = "/Knowledge/Nested"
        model.selectedBrowseNodePath = "/Knowledge/Nested/Page.md"
        model.documentNode = VFSNode(
            path: "/Knowledge/Nested/Page.md",
            kind: .file,
            content: "Page",
            metadataJson: "{}",
            etag: "etag",
            createdAt: 1,
            updatedAt: 2
        )
        model.searchQuery = "old"
        model.searchResults = [
            SearchNodeHit(
                path: "/Knowledge/Nested/Page.md",
                kind: .file,
                snippet: "Page",
                previewExcerpt: nil,
                matchReasons: [],
                score: 1
            )
        ]
        model.browseError = "old browse error"
        model.documentError = "old document error"
        model.isLoadingDocument = true

        model.handleOpenURL(URL(string: "https://wiki.kinic.xyz/dashboard")!)

        #expect(model.requestedTab == .manage)
        #expect(model.tabSelectionRequestID == 1)
        #expect(model.rootNavigationID == 0)
        #expect(model.currentPath == "/Knowledge/Nested")
        #expect(model.currentNode?.path == "/Knowledge/Nested")
        #expect(model.childNodes.count == 1)
        #expect(model.loadedBrowsePath == "/Knowledge/Nested")
        #expect(model.selectedBrowseNodePath == "/Knowledge/Nested/Page.md")
        #expect(model.documentNode?.path == "/Knowledge/Nested/Page.md")
        #expect(model.isLoadingDocument == true)
        #expect(model.searchQuery == "old")
        #expect(model.searchResults.count == 1)
        #expect(model.browseError == "old browse error")
        #expect(model.documentError == "old document error")
    }

    @MainActor
    @Test
    func browseUniversalLinkSelectsDirectDatabaseAndBrowseTab() {
        let model = AppModel.preview()

        model.handleOpenURL(URL(string: "https://wiki.kinic.xyz/db/db_next/Knowledge/Page.md")!)

        #expect(model.requestedTab == .browse)
        #expect(model.tabSelectionRequestID == 1)
        #expect(model.selectedBrowseDatabaseId == "db_next")
        #expect(model.directBrowseDatabaseIds.contains("db_next"))
        #expect(model.canListBrowseDatabases == true)
        #expect(model.browseListDatabases.map(\.databaseId) == ["db_next"])
        #expect(model.requestedBrowseTarget == .folder("/"))
        #expect(model.browseNavigationRequestID == 1)
        #expect(model.currentPath == "/")
    }

    @MainActor
    @Test
    func browseDatabaseSwitchClearsDocumentLoadState() {
        let model = AppModel.preview()
        model.selectedBrowseDatabaseId = "db_old"
        model.currentPath = "/Knowledge/Nested"
        model.currentNode = VFSNode(
            path: "/Knowledge/Nested",
            kind: .folder,
            content: "",
            metadataJson: "{}",
            etag: "folder-etag",
            createdAt: 1,
            updatedAt: 2
        )
        model.childNodes = [
            ChildNode(
                path: "/Knowledge/Page.md",
                name: "Page.md",
                kind: .file,
                updatedAt: 2,
                etag: "etag",
                sizeBytes: 8,
                hasChildren: false,
                isVirtual: false
            )
        ]
        model.loadedBrowsePath = "/Knowledge/Nested"
        model.selectedBrowseNodePath = "/Knowledge/Page.md"
        model.documentNode = VFSNode(
            path: "/Knowledge/Page.md",
            kind: .file,
            content: "Old page",
            metadataJson: "{}",
            etag: "etag",
            createdAt: 1,
            updatedAt: 2
        )
        model.documentError = "old document error"
        model.isLoadingDocument = true

        model.selectBrowseDatabase("db_next")

        #expect(model.selectedBrowseDatabaseId == "db_next")
        #expect(model.currentPath == "/")
        #expect(model.currentNode == nil)
        #expect(model.childNodes.isEmpty)
        #expect(model.loadedBrowsePath == nil)
        #expect(model.selectedBrowseNodePath == nil)
        #expect(model.documentNode == nil)
        #expect(model.documentError == nil)
        #expect(model.isLoadingDocument == false)
    }

    @MainActor
    @Test
    func signOutClearsLoadedBrowsePath() {
        let model = AppModel.preview()
        model.selectedBrowseDatabaseId = "db_preview"
        model.currentNode = VFSNode(
            path: "/Knowledge",
            kind: .folder,
            content: "",
            metadataJson: "{}",
            etag: "folder-etag",
            createdAt: 1,
            updatedAt: 2
        )
        model.childNodes = [
            ChildNode(
                path: "/Knowledge/Page.md",
                name: "Page.md",
                kind: .file,
                updatedAt: 2,
                etag: "etag",
                sizeBytes: 8,
                hasChildren: false,
                isVirtual: false
            )
        ]
        model.loadedBrowsePath = "/Knowledge"

        model.signOut()

        #expect(model.currentNode == nil)
        #expect(model.childNodes.isEmpty)
        #expect(model.loadedBrowsePath == nil)
    }

    @Test
    func validatesDatabaseNames() {
        #expect(AppModel.databaseNameError("Team skills") == nil)
        #expect(AppModel.databaseNameError("") == "Database name is required.")
        #expect(AppModel.databaseNameError(String(repeating: "a", count: 81)) == "Database name must be 1..80 characters.")
        #expect(AppModel.databaseNameError("Team\u{0001}") == "Database name may not contain control characters.")
    }

    @Test
    func mergesBrowseDatabasesWithVisibilityToggles() {
        let member = database(databaseId: "db_member", role: .owner)
        let purchased = database(databaseId: "db_purchased", role: .reader)
        let purchasedWriter = database(databaseId: "db_purchased_writer", role: .writer)
        let publicOnly = database(databaseId: "db_public", role: .reader)
        let publicDuplicate = database(databaseId: "db_duplicate", title: "Public Duplicate", role: .reader)
        let memberDuplicate = database(databaseId: "db_duplicate", title: "Member Duplicate", role: .writer)

        let hidden = AppModel.mergeBrowseDatabases(
            memberDatabases: [member, purchased, purchasedWriter, memberDuplicate],
            publicDatabases: [publicOnly, publicDuplicate],
            purchasedDatabaseIds: ["db_purchased", "db_purchased_writer"],
            purchasedLookupSucceeded: true,
            showPublic: false,
            showPurchased: false
        )
        #expect(hidden.databases.map(\.databaseId) == ["db_member", "db_purchased_writer", "db_duplicate"])
        #expect(hidden.databases.first { $0.databaseId == "db_duplicate" }?.title == "Member Duplicate")
        #expect(hidden.publicDatabaseIds.isEmpty)
        #expect(hidden.purchasedDatabaseIds == ["db_purchased", "db_purchased_writer"])

        let publicVisible = AppModel.mergeBrowseDatabases(
            memberDatabases: [member, purchased, purchasedWriter, memberDuplicate],
            publicDatabases: [publicOnly, publicDuplicate],
            purchasedDatabaseIds: ["db_purchased", "db_purchased_writer"],
            purchasedLookupSucceeded: true,
            showPublic: true,
            showPurchased: false
        )
        #expect(publicVisible.databases.map(\.databaseId) == ["db_member", "db_public", "db_purchased_writer", "db_duplicate"])
        #expect(publicVisible.databases.first { $0.databaseId == "db_duplicate" }?.title == "Member Duplicate")
        #expect(publicVisible.publicDatabaseIds == ["db_public", "db_duplicate"])

        let purchasedVisible = AppModel.mergeBrowseDatabases(
            memberDatabases: [member, purchased, purchasedWriter, memberDuplicate],
            publicDatabases: [publicOnly, publicDuplicate],
            purchasedDatabaseIds: ["db_purchased", "db_purchased_writer"],
            purchasedLookupSucceeded: true,
            showPublic: false,
            showPurchased: true
        )
        #expect(purchasedVisible.databases.map(\.databaseId) == ["db_member", "db_purchased", "db_purchased_writer", "db_duplicate"])
        #expect(purchasedVisible.purchasedDatabaseIds == ["db_purchased", "db_purchased_writer"])
    }

    @Test
    func mergesBrowseDatabasesFailClosedWhenPurchasedLookupFails() {
        let member = database(databaseId: "db_member", role: .owner)
        let reader = database(databaseId: "db_reader", role: .reader)
        let writer = database(databaseId: "db_writer", role: .writer)
        let publicOnly = database(databaseId: "db_public", role: .reader)

        let purchasedHidden = AppModel.mergeBrowseDatabases(
            memberDatabases: [member, reader, writer],
            publicDatabases: [publicOnly],
            purchasedDatabaseIds: ["db_cached_purchased"],
            purchasedLookupSucceeded: false,
            showPublic: true,
            showPurchased: false
        )
        #expect(purchasedHidden.databases.map(\.databaseId) == ["db_member", "db_public", "db_writer"])
        #expect(purchasedHidden.purchasedDatabaseIds == ["db_cached_purchased"])

        let purchasedVisible = AppModel.mergeBrowseDatabases(
            memberDatabases: [member, reader, writer],
            publicDatabases: [publicOnly],
            purchasedDatabaseIds: ["db_cached_purchased"],
            purchasedLookupSucceeded: false,
            showPublic: false,
            showPurchased: true
        )
        #expect(purchasedVisible.databases.map(\.databaseId) == ["db_member", "db_reader", "db_writer"])
        #expect(purchasedVisible.purchasedDatabaseIds == ["db_cached_purchased"])
    }

    @MainActor
    @Test
    func managementDatabasesExcludesPublicOnlyDatabases() throws {
        let suiteName = "kinic.management.tests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        defer {
            defaults.removePersistentDomain(forName: suiteName)
        }
        let inboxDirectory = makeQueueDirectory()
        defer {
            removeQueueDirectory(inboxDirectory)
        }
        let model = AppModel(
            configuration: .preview,
            authService: KinicAuthService(configuration: .preview),
            client: KinicICClient(configuration: .preview),
            shareInbox: try ShareInbox(testQueueDirectory: inboxDirectory),
            settingsStore: SharedDefaultsStore(defaults: defaults)
        )
        let member = database(databaseId: "db_member", role: .owner)
        let purchased = database(databaseId: "db_purchased", role: .reader)
        let publicOnly = database(databaseId: "db_public", role: .reader)

        model.readableDatabases = [member, purchased, publicOnly]
        model.memberBrowseDatabaseIds = ["db_member", "db_purchased"]
        model.publicBrowseDatabaseIds = ["db_public"]
        model.purchasedBrowseDatabaseIds = ["db_purchased"]

        #expect(model.managementDatabases.map(\.databaseId) == ["db_member", "db_purchased"])
    }

    @Test
    func normalizesBrowsePaths() {
        #expect(AppModel.normalizedBrowsePath("") == "/")
        #expect(AppModel.normalizedBrowsePath("Knowledge/README.md") == "/Knowledge/README.md")
        #expect(AppModel.normalizedBrowsePath("//Knowledge///Design/") == "/Knowledge/Design")
        #expect(AppModel.parentPath("/Knowledge/Design/Page.md") == "/Knowledge/Design")
        #expect(AppModel.parentPath("/Knowledge") == "/")
        #expect(AppModel.parentPath("/") == "/")
        #expect(AppModel.folderRoutes(to: "/Knowledge/Design").map(\.path) == ["/Knowledge", "/Knowledge/Design"])
        #expect(AppModel.folderRoutes(to: "/").isEmpty)
    }

    @Test
    func classifiesBrowseNavigationRoutes() {
        #expect(BrowseFolderRoute(path: "/Knowledge").kind == .folder)
        #expect(BrowseFolderRoute.document(path: "/Knowledge/Page.md").kind == .document)
        #expect(BrowseFolderRoute.document(path: "/Knowledge/Page.md").path == "/Knowledge/Page.md")
    }

    @Test
    func buildsBrowseNavigationRoutesForSizeClass() {
        let documentTarget = BrowseNavigationTarget.document(
            path: "/Knowledge/Design/Page.md",
            parentPath: "/Knowledge/Design"
        )

        #expect(AppModel.browseNavigationRoutes(
            for: documentTarget,
            includeDocument: true
        ) == [
            BrowseFolderRoute(path: "/Knowledge"),
            BrowseFolderRoute(path: "/Knowledge/Design"),
            BrowseFolderRoute.document(path: "/Knowledge/Design/Page.md"),
        ])
        #expect(AppModel.browseNavigationRoutes(
            for: documentTarget,
            includeDocument: false
        ) == [
            BrowseFolderRoute(path: "/Knowledge"),
            BrowseFolderRoute(path: "/Knowledge/Design"),
        ])
        #expect(AppModel.browseNavigationRoutes(
            for: .folder("/Knowledge/Design"),
            includeDocument: true
        ) == [
            BrowseFolderRoute(path: "/Knowledge"),
            BrowseFolderRoute(path: "/Knowledge/Design"),
        ])
        #expect(AppModel.browseNavigationRoutes(
            for: .document(path: "/Page.md", parentPath: "/"),
            includeDocument: true
        ) == [
            BrowseFolderRoute.document(path: "/Page.md"),
        ])
    }

    @MainActor
    @Test
    func emptyBrowseSearchQueryClearsResults() {
        let model = AppModel.preview()
        model.searchResults = [
            SearchNodeHit(
                path: "/Knowledge/Page.md",
                kind: .file,
                snippet: "Page",
                previewExcerpt: nil,
                matchReasons: [],
                score: 1
            )
        ]

        model.searchQueryDidChange(from: "old", to: "   ")

        #expect(model.searchResults.isEmpty)
    }

    @MainActor
    @Test
    func changedBrowseSearchQueryClearsStaleResults() {
        let model = AppModel.preview()
        model.searchQuery = "old"
        model.searchResults = [
            SearchNodeHit(
                path: "/Knowledge/Page.md",
                kind: .file,
                snippet: "Page",
                previewExcerpt: nil,
                matchReasons: [],
                score: 1
            )
        ]

        model.searchQueryDidChange(from: "old", to: "new")

        #expect(model.searchResults.isEmpty)
    }

    @MainActor
    @Test
    func changedBrowseSearchQueryClearsResultsAfterBindingUpdate() {
        let model = AppModel.preview()
        model.searchQuery = "new"
        model.searchResults = [
            SearchNodeHit(
                path: "/Knowledge/Page.md",
                kind: .file,
                snippet: "Page",
                previewExcerpt: nil,
                matchReasons: [],
                score: 1
            )
        ]

        model.searchQueryDidChange(from: "old", to: "new")

        #expect(model.searchResults.isEmpty)
    }

    @Test
    func formatsDatabaseManagementValues() {
        #expect(DatabaseManagementFormat.cycles(nil) == "Unknown")
        #expect(DatabaseManagementFormat.cycles(2_000_000_000_000) == "2T cycles")
        #expect(DatabaseManagementFormat.cycles(3_000_000_000) == "3B cycles")
        #expect(DatabaseManagementFormat.cycles(4_000_000) == "4M cycles")
        #expect(DatabaseManagementFormat.cycles(500) == "500 cycles")
        #expect(DatabaseManagementFormat.signedCycles(-4_000_000) == "-4M cycles")
        #expect(DatabaseManagementFormat.signedCycles(4_000_000) == "4M cycles")
        #expect(!DatabaseManagementFormat.bytes(1_024).isEmpty)
    }

    @Test
    func classifiesDatabaseManagementStatus() {
        let config = CyclesBillingConfig(
            kinicLedgerCanisterId: "ledger",
            billingAuthorityId: "authority",
            cyclesPerKinic: 1,
            minUpdateCycles: 100,
            topUp: CyclesTopUpConfig(enabled: true, launcherPrincipal: "launcher", thresholdCycles: 1_000)
        )

        #expect(DatabaseManagementStatus.status(for: database(cyclesBalance: 2_000, suspendedAt: 10), config: config) == .suspended)
        #expect(DatabaseManagementStatus.status(for: database(cyclesBalance: nil), config: config) == .unknown)
        #expect(DatabaseManagementStatus.status(for: database(cyclesBalance: 50), config: config) == .blocked)
        #expect(DatabaseManagementStatus.status(for: database(cyclesBalance: 500), config: config) == .low)
        #expect(DatabaseManagementStatus.status(for: database(cyclesBalance: 2_000), config: config) == .ok)
        #expect(DatabaseManagementStatus.status(for: database(cyclesBalance: 2_000), config: nil) == .unknown)
    }

    @Test
    func onlyOwnerCanManageDatabaseSettings() {
        #expect(DatabaseRole.owner.canManageDatabase)
        #expect(!DatabaseRole.writer.canManageDatabase)
        #expect(!DatabaseRole.reader.canManageDatabase)
    }

    @Test
    func buildsDatabaseTagsJsonFromCommaSeparatedInput() throws {
        #expect(try AppModel.databaseTagsJson(from: "") == "[]")
        #expect(try AppModel.databaseTagsJson(from: "swift, ios") == "[\"swift\",\"ios\"]")
        #expect(try AppModel.databaseTagsJson(from: " 日本語 , swift ") == "[\"日本語\",\"swift\"]")
    }

    @Test
    func rejectsEmptyDatabaseNameForMetadataEdit() {
        #expect(AppModel.databaseNameError("") == "Database name is required.")
        #expect(AppModel.databaseNameError("Team DB") == nil)
    }
}

private func database(cyclesBalance: UInt64?, suspendedAt: Int64? = nil) -> DatabaseSummary {
    DatabaseSummary(
        databaseId: "db_test",
        title: "Test DB",
        description: "",
        metadata: nil,
        role: .owner,
        status: .active,
        logicalSizeBytes: 1_024,
        cyclesBalance: cyclesBalance,
        cyclesSuspendedAtMs: suspendedAt,
        deletedAtMs: nil
    )
}

private func database(databaseId: String, title: String? = nil, role: DatabaseRole) -> DatabaseSummary {
    DatabaseSummary(
        databaseId: databaseId,
        title: title ?? databaseId,
        description: "",
        metadata: nil,
        role: role,
        status: .active,
        logicalSizeBytes: 0,
        cyclesBalance: nil,
        cyclesSuspendedAtMs: nil,
        deletedAtMs: nil
    )
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

private enum ShareInboxTestError: Error {
    case publicListFailed
}
