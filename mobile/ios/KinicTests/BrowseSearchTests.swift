// Where: mobile/ios/KinicTests/BrowseSearchTests.swift
// What: Browse-search scheduling, scoping, paging, failure, and presentation tests.
// Why: Search requests must never show stale results or misrepresent request state.

import Foundation
import ICNativeClient
import Testing
@testable import Kinic

struct BrowseSearchTests {
    @MainActor
    @Test
    func debounceCoalescesRapidInputIntoLatestRequest() async throws {
        let probe = BrowseSearchProbe { request in
            [searchHit(path: "/Knowledge/\(request.query).md")]
        }
        let fixture = try BrowseSearchFixture(probe: probe)
        defer { fixture.cleanup() }
        let model = fixture.model

        model.searchQueryDidChange(from: "", to: "s", folderPath: "/Knowledge")
        try await Task.sleep(for: .milliseconds(100))
        model.searchQueryDidChange(from: "s", to: "sw", folderPath: "/Knowledge")
        try await Task.sleep(for: .milliseconds(100))
        model.searchQueryDidChange(from: "sw", to: "swift", folderPath: "/Knowledge")

        await waitUntil { model.browseSearchPhase == .results }
        let requests = await probe.requests()
        #expect(requests.map(\.query) == ["swift"])
        #expect(model.searchResults.first?.path == "/Knowledge/swift.md")
    }

    @MainActor
    @Test
    func submitRunsImmediatelyAndCancelsPendingDebounce() async throws {
        let probe = BrowseSearchProbe { request in
            [searchHit(path: "/Knowledge/\(request.query).md")]
        }
        let fixture = try BrowseSearchFixture(probe: probe)
        defer { fixture.cleanup() }
        let model = fixture.model

        model.searchQueryDidChange(from: "", to: "swift", folderPath: "/Knowledge")
        #expect(model.browseSearchPhase == .debouncing)
        model.startSearch(in: "/Knowledge")

        await waitUntil { model.browseSearchPhase == .results }
        try await Task.sleep(for: .milliseconds(450))
        #expect(await probe.requests().count == 1)
    }

    @MainActor
    @Test
    func staleResponseCannotReplaceCurrentResults() async throws {
        let controlled = ControlledBrowseSearch()
        let fixture = try BrowseSearchFixture { request, _ in
            try await controlled.search(request)
        }
        defer { fixture.cleanup() }
        let model = fixture.model

        model.searchQuery = "old"
        model.startSearch(in: "/Knowledge")
        await waitUntil { await controlled.hasRequest(query: "old") }

        model.searchQuery = "new"
        model.startSearch(in: "/Knowledge")
        await waitUntil { await controlled.hasRequest(query: "new") }

        await controlled.resolve(query: "new", hits: [searchHit(path: "/Knowledge/new.md")])
        await waitUntil { model.searchResults.first?.path == "/Knowledge/new.md" }
        await controlled.resolve(query: "old", hits: [searchHit(path: "/Knowledge/old.md")])
        try await Task.sleep(for: .milliseconds(20))

        #expect(model.searchResults.map(\.path) == ["/Knowledge/new.md"])
    }

    @MainActor
    @Test
    func scopeAndQueryAreNormalizedInRequest() async throws {
        let probe = BrowseSearchProbe { _ in [] }
        let fixture = try BrowseSearchFixture(probe: probe)
        defer { fixture.cleanup() }
        let model = fixture.model

        model.browseSearchScope = .currentFolder
        model.searchQuery = "  swift auth  "
        model.startSearch(in: "Knowledge//Project/")
        await waitUntil { model.browseSearchPhase == .empty }

        #expect(await probe.requests() == [
            BrowseSearchRequest(
                databaseId: "db_search",
                query: "swift auth",
                prefix: "/Knowledge/Project",
                limit: 20
            )
        ])
    }

    @MainActor
    @Test
    func databaseScopeUsesNilPrefix() async throws {
        let probe = BrowseSearchProbe { _ in [] }
        let fixture = try BrowseSearchFixture(probe: probe)
        defer { fixture.cleanup() }
        let model = fixture.model

        model.searchQuery = "swift"
        model.startSearch(in: "/Knowledge")
        await waitUntil { model.browseSearchPhase == .empty }

        #expect(await probe.requests().first?.prefix == nil)
    }

    @MainActor
    @Test
    func scopeChangeSearchesImmediatelyWithCurrentFolderPrefix() async throws {
        let probe = BrowseSearchProbe { _ in [] }
        let fixture = try BrowseSearchFixture(probe: probe)
        defer { fixture.cleanup() }
        let model = fixture.model
        model.searchQuery = "swift"
        model.browseSearchScope = .currentFolder

        model.browseSearchScopeDidChange(folderPath: "Knowledge//Project/")
        await waitUntil { model.browseSearchPhase == .empty }

        #expect(await probe.requests().map(\.prefix) == ["/Knowledge/Project"])
    }

    @MainActor
    @Test
    func activatingAnotherFolderRerunsCurrentFolderSearchAndHidesOldResults() async throws {
        let controlled = ControlledBrowseSearch()
        let fixture = try BrowseSearchFixture { request, _ in
            try await controlled.search(request)
        }
        defer { fixture.cleanup() }
        let model = fixture.model
        model.browseSearchScope = .currentFolder
        model.searchQuery = "swift"

        model.startSearch(in: "/Knowledge/Project")
        await waitUntil { await controlled.hasRequest(prefix: "/Knowledge/Project") }
        await controlled.resolve(
            prefix: "/Knowledge/Project",
            hits: [searchHit(path: "/Knowledge/Project/old.md")]
        )
        await waitUntil { model.browseSearchPhase == .results }
        #expect(model.browseSearchResultsMatch(folderPath: "/Knowledge/Project"))

        model.browseFolderDidBecomeActive("/Knowledge")

        #expect(!model.browseSearchResultsMatch(folderPath: "/Knowledge/Project"))
        #expect(model.searchResults.isEmpty)
        await waitUntil { await controlled.hasRequest(prefix: "/Knowledge") }
        await controlled.resolve(prefix: "/Knowledge", hits: [searchHit(path: "/Knowledge/new.md")])
        await waitUntil { model.browseSearchPhase == .results }
        #expect(model.browseSearchResultsMatch(folderPath: "/Knowledge"))
        #expect(model.searchResults.map(\.path) == ["/Knowledge/new.md"])
    }

    @MainActor
    @Test
    func activatingAnotherFolderDoesNotRerunDatabaseSearch() async throws {
        let probe = BrowseSearchProbe { _ in [] }
        let fixture = try BrowseSearchFixture(probe: probe)
        defer { fixture.cleanup() }
        let model = fixture.model
        model.searchQuery = "swift"

        model.startSearch(in: "/Knowledge/Project")
        await waitUntil { model.browseSearchPhase == .empty }
        model.browseFolderDidBecomeActive("/Knowledge")
        try await Task.sleep(for: .milliseconds(20))

        #expect(await probe.requests().count == 1)
        #expect(model.browseSearchResultsMatch(folderPath: "/Knowledge"))
    }

    @MainActor
    @Test
    func changingDatabaseCancelsSearchAndRestoresDatabaseScope() async throws {
        let controlled = ControlledBrowseSearch()
        let fixture = try BrowseSearchFixture { request, _ in
            try await controlled.search(request)
        }
        defer { fixture.cleanup() }
        let model = fixture.model
        model.browseSearchScope = .currentFolder
        model.searchQuery = "old"
        model.startSearch(in: "/Knowledge")
        await waitUntil { await controlled.hasRequest(query: "old") }

        model.selectBrowseDatabase("db_next")
        #expect(model.browseSearchScope == .database)
        #expect(model.searchQuery.isEmpty)
        #expect(model.browseSearchPhase == .idle)

        await controlled.resolve(query: "old", hits: [searchHit(path: "/Knowledge/old.md")])
        try await Task.sleep(for: .milliseconds(20))
        #expect(model.searchResults.isEmpty)
    }

    @MainActor
    @Test
    func loadMoreProgressesFromTwentyToFiftyToOneHundred() async throws {
        let probe = BrowseSearchProbe { request in
            (0..<Int(request.limit)).map { searchHit(path: "/Knowledge/\($0).md") }
        }
        let fixture = try BrowseSearchFixture(probe: probe)
        defer { fixture.cleanup() }
        let model = fixture.model

        model.searchQuery = "page"
        model.startSearch(in: "/Knowledge")
        await waitUntil { model.searchResults.count == 20 && model.browseSearchPhase == .results }
        #expect(model.canLoadMoreBrowseSearchResults)

        model.loadMoreBrowseSearchResults(folderPath: "/Knowledge")
        await waitUntil { model.searchResults.count == 50 && model.browseSearchPhase == .results }
        #expect(model.canLoadMoreBrowseSearchResults)

        model.loadMoreBrowseSearchResults(folderPath: "/Knowledge")
        await waitUntil { model.searchResults.count == 100 && model.browseSearchPhase == .results }
        #expect(!model.canLoadMoreBrowseSearchResults)
        #expect(await probe.requests().map(\.limit) == [20, 50, 100])
    }

    @MainActor
    @Test
    func failureIsSeparateFromBrowseErrorAndRetryRecovers() async throws {
        let probe = RetryingBrowseSearchProbe()
        let fixture = try BrowseSearchFixture { request, _ in
            try await probe.search(request)
        }
        defer { fixture.cleanup() }
        let model = fixture.model

        model.searchQuery = "swift"
        model.startSearch(in: "/Knowledge")
        await waitUntil {
            if case .failure = model.browseSearchPhase { return true }
            return false
        }
        #expect(model.browseError == nil)

        model.retryBrowseSearch(folderPath: "/Knowledge")
        await waitUntil { model.browseSearchPhase == .results }
        #expect(model.searchResults.map(\.path) == ["/Knowledge/recovered.md"])
    }

    @MainActor
    @Test
    func clearingQueryResetsSearchWithoutChangingScope() throws {
        let fixture = try BrowseSearchFixture { _, _ in [] }
        defer { fixture.cleanup() }
        let model = fixture.model
        model.browseSearchScope = .currentFolder
        model.searchQuery = "swift"
        model.searchResults = [searchHit(path: "/Knowledge/swift.md")]
        model.browseSearchPhase = .results

        model.searchQueryDidChange(from: "swift", to: "   ", folderPath: "/Knowledge")

        #expect(model.searchQuery.isEmpty)
        #expect(model.searchResults.isEmpty)
        #expect(model.browseSearchPhase == .idle)
        #expect(model.browseSearchScope == .currentFolder)
    }

    @Test
    func resultPresentationSeparatesNameParentPreviewAndMatchLocations() {
        let hit = SearchNodeHit(
            path: "/Knowledge/Project/Swift Auth.md",
            kind: .file,
            snippet: "fallback",
            previewExcerpt: "Swift authentication details",
            matchReasons: ["path_substring", "title_fts", "content_fts"],
            score: 1
        )

        #expect(hit.displayName == "Swift Auth.md")
        #expect(hit.displayParentPath == "/Knowledge/Project")
        #expect(hit.displayPreview == "Swift authentication details")
        #expect(hit.matchLocationLabel == "Path · Title · Content")
        #expect(hit.accessibilityDescription.contains("Document"))
    }

    @Test
    func resultHighlightingEmphasizesLatinAndCJKTerms() {
        let latin = BrowseSearchText.highlighted("Swift Authentication", query: "swift auth")
        let cjk = BrowseSearchText.highlighted("検索機能の改善", query: "検索 改善")

        #expect(String(latin.characters) == "Swift Authentication")
        #expect(String(cjk.characters) == "検索機能の改善")
        #expect(latin.runs.filter(isEmphasized).count == 2)
        #expect(cjk.runs.filter(isEmphasized).count == 2)
    }
}

private func isEmphasized(_ run: AttributedString.Runs.Element) -> Bool {
    run.inlinePresentationIntent?.contains(.stronglyEmphasized) == true
}

private func searchHit(path: String) -> SearchNodeHit {
    SearchNodeHit(
        path: path,
        kind: .file,
        snippet: "search preview",
        previewExcerpt: nil,
        matchReasons: ["content_fts"],
        score: 1
    )
}

@MainActor
private func waitUntil(
    attempts: Int = 200,
    condition: @escaping @MainActor () async -> Bool
) async {
    for _ in 0..<attempts {
        if await condition() {
            return
        }
        try? await Task.sleep(for: .milliseconds(10))
    }
}

@MainActor
private final class BrowseSearchFixture {
    let model: AppModel
    private let suiteName: String
    private let queueDirectory: URL

    convenience init(probe: BrowseSearchProbe) throws {
        try self.init { request, _ in
            try await probe.search(request)
        }
    }

    init(
        search: @escaping @Sendable (BrowseSearchRequest, KinicIdentitySession?) async throws -> [SearchNodeHit]
    ) throws {
        suiteName = "kinic.browse-search-tests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        queueDirectory = FileManager.default.temporaryDirectory
            .appending(path: "kinic-browse-search-tests")
            .appending(path: UUID().uuidString)
        model = AppModel(
            configuration: .preview,
            authService: try! KinicAuthService(configuration: .preview),
            client: try! KinicICClient(configuration: .preview),
            shareInbox: try ShareInbox(testQueueDirectory: queueDirectory),
            settingsStore: SharedDefaultsStore(defaults: defaults),
            searchBrowseNodesRemotely: search,
            initialSession: browseSearchSession()
        )
        model.selectedBrowseDatabaseId = "db_search"
        model.readableDatabases = [searchDatabaseSummary()]
        model.memberBrowseDatabaseIds = ["db_search"]
    }

    func cleanup() {
        UserDefaults(suiteName: suiteName)?.removePersistentDomain(forName: suiteName)
        try? FileManager.default.removeItem(at: queueDirectory)
    }
}

private actor BrowseSearchProbe {
    private let response: @Sendable (BrowseSearchRequest) async throws -> [SearchNodeHit]
    private var recordedRequests: [BrowseSearchRequest] = []

    init(response: @escaping @Sendable (BrowseSearchRequest) async throws -> [SearchNodeHit]) {
        self.response = response
    }

    func search(_ request: BrowseSearchRequest) async throws -> [SearchNodeHit] {
        recordedRequests.append(request)
        return try await response(request)
    }

    func requests() -> [BrowseSearchRequest] {
        recordedRequests
    }
}

private actor ControlledBrowseSearch {
    private struct RequestKey: Hashable {
        let query: String
        let prefix: String?
    }

    private var continuations: [RequestKey: CheckedContinuation<[SearchNodeHit], any Error>] = [:]

    func search(_ request: BrowseSearchRequest) async throws -> [SearchNodeHit] {
        try await withCheckedThrowingContinuation { continuation in
            continuations[RequestKey(query: request.query, prefix: request.prefix)] = continuation
        }
    }

    func hasRequest(query: String) -> Bool {
        continuations.keys.contains { $0.query == query }
    }

    func resolve(query: String, hits: [SearchNodeHit]) {
        guard let key = continuations.keys.first(where: { $0.query == query }) else {
            return
        }
        continuations.removeValue(forKey: key)?.resume(returning: hits)
    }

    func hasRequest(prefix: String?) -> Bool {
        continuations.keys.contains { $0.prefix == prefix }
    }

    func resolve(prefix: String?, hits: [SearchNodeHit]) {
        guard let key = continuations.keys.first(where: { $0.prefix == prefix }) else {
            return
        }
        continuations.removeValue(forKey: key)?.resume(returning: hits)
    }
}

private actor RetryingBrowseSearchProbe {
    private var attempt = 0

    func search(_ request: BrowseSearchRequest) throws -> [SearchNodeHit] {
        attempt += 1
        if attempt == 1 {
            throw BrowseSearchTestError.unavailable
        }
        return [searchHit(path: "/Knowledge/recovered.md")]
    }
}

private enum BrowseSearchTestError: LocalizedError {
    case unavailable

    var errorDescription: String? {
        "Search temporarily unavailable."
    }
}

private func searchDatabaseSummary() -> DatabaseSummary {
    DatabaseSummary(
        databaseId: "db_search",
        title: "Search",
        description: "",
        metadata: nil,
        role: .reader,
        status: .active,
        logicalSizeBytes: 0,
        cyclesBalance: nil,
        cyclesSuspendedAtMs: nil,
        deletedAtMs: nil
    )
}

private func browseSearchSession() -> KinicIdentitySession {
    .testing(principal: "aaaaa-aa")
}
