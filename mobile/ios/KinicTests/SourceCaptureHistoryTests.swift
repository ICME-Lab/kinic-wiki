import Foundation
import Testing
@testable import Kinic

struct SourceCaptureHistoryTests {
    @Test
    func storePersistsRecordsAcrossReinitialization() throws {
        let directory = FileManager.default.temporaryDirectory
            .appending(path: "source-capture-history-tests-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let record = makeRecord(requestID: "persisted", requestedAtMilliseconds: 10)

        let firstStore = try SourceCaptureHistoryStore(testHistoryDirectory: directory)
        try firstStore.save(record)

        let restartedStore = try SourceCaptureHistoryStore(testHistoryDirectory: directory)
        #expect(restartedStore.load(databaseId: "db_demo") == [record])
    }

    @Test
    func storePrunesOldestRecordsPerDatabase() throws {
        let directory = FileManager.default.temporaryDirectory
            .appending(path: "source-capture-history-prune-tests-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try SourceCaptureHistoryStore(testHistoryDirectory: directory)

        for index in 0...SourceCaptureHistoryStore.maxRecordsPerDatabase {
            try store.save(makeRecord(requestID: "request-\(index)", requestedAtMilliseconds: Int64(index)))
        }

        let records = store.load(databaseId: "db_demo")
        #expect(records.count == SourceCaptureHistoryStore.maxRecordsPerDatabase)
        #expect(records.first?.item.requestPath.hasSuffix("request-100.md") == true)
        #expect(records.contains(where: { $0.item.requestPath.hasSuffix("request-0.md") }) == false)
    }

    @Test
    func parserReadsEveryRemoteStatus() throws {
        let statuses: [(String, SourceCaptureHistoryStatus)] = [
            ("queued", .queued),
            ("fetching", .fetching),
            ("source_written", .sourceWritten),
            ("generating", .generating),
            ("completed", .completed),
            ("failed", .failed),
        ]
        for (rawStatus, expectedStatus) in statuses {
            let node = VFSNode(
                path: "/Sources/source-capture-requests/remote.md",
                kind: .file,
                content: requestContent(status: rawStatus),
                metadataJson: "{}",
                etag: "etag",
                createdAt: 1,
                updatedAt: 2
            )
            #expect(try SourceCaptureHistoryParser.item(from: node).status == expectedStatus)
        }
    }

    @Test
    func parserRejectsMalformedFrontmatterAndUnknownStatus() {
        let malformed = makeNode(content: "not frontmatter")
        #expect(throws: SourceCaptureHistoryParseError.invalidFrontmatter) {
            try SourceCaptureHistoryParser.item(from: malformed)
        }

        let unknownStatus = makeNode(content: requestContent(status: "unknown"))
        #expect(throws: SourceCaptureHistoryParseError.invalidStatus) {
            try SourceCaptureHistoryParser.item(from: unknownStatus)
        }
    }

    @Test
    func retryPlanReusesSourceAndClearsTransientState() throws {
        let node = makeNode(content: """
        ---
        kind: kinic.source_capture_request
        schema_version: 1
        status: failed
        url: "https://example.com/article"
        requested_by: "aaaaa-aa"
        requested_at: "2026-05-14T00:00:01Z"
        output_language: "ja"
        claimed_at: "2026-05-14T00:01:01Z"
        source_path: "/Sources/web/article.md"
        target_path: null
        finished_at: "2026-05-14T00:02:01Z"
        error: "generation failed"
        shared_title: "Example"
        ---

        # Source Capture Request
        """)

        let request = try SourceCaptureHistoryParser.request(from: node)
        #expect(request.requestedBy == "aaaaa-aa")
        #expect(request.outputLanguage == .japanese)
        #expect(request.item.status == .failed)

        let retry = request.retryWrite()
        #expect(retry.status == .sourceWritten)
        let rewritten = try SourceCaptureHistoryParser.request(from: VFSNode(
            path: node.path,
            kind: .file,
            content: retry.content,
            metadataJson: retry.metadataJson,
            etag: node.etag,
            createdAt: node.createdAt,
            updatedAt: node.updatedAt
        ))
        #expect(rewritten.item.status == .sourceWritten)
        #expect(rewritten.item.sourcePath == "/Sources/web/article.md")
        #expect(rewritten.item.claimedAt == nil)
        #expect(rewritten.item.finishedAt == nil)
        #expect(rewritten.item.error == nil)
        #expect(retry.content.contains("shared_title:"))

        let metadata = try #require(JSONSerialization.jsonObject(with: Data(retry.metadataJson.utf8)) as? [String: Any])
        #expect(metadata["status"] as? String == "source_written")
        #expect(metadata["source_path"] as? String == "/Sources/web/article.md")
    }

    @Test
    func retryPlanQueuesFailedRequestWithoutSource() throws {
        let node = makeNode(content: """
        ---
        kind: kinic.source_capture_request
        schema_version: 1
        status: failed
        url: "https://example.com/article"
        requested_by: "aaaaa-aa"
        requested_at: "2026-05-14T00:00:01Z"
        output_language: "en"
        claimed_at: null
        source_path: null
        target_path: null
        finished_at: "2026-05-14T00:02:01Z"
        error: "fetch failed"
        ---

        # Source Capture Request
        """)

        let retry = try SourceCaptureHistoryParser.request(from: node).retryWrite()
        #expect(retry.status == .queued)
        #expect(retry.content.contains("status: \"queued\""))
        #expect(retry.content.contains("source_path: null"))
        #expect(retry.content.contains("target_path: null"))
    }

    @Test
    func retryPlanPreservesMalformedMetadataInsteadOfDroppingIt() throws {
        let node = makeNode(content: """
        ---
        kind: kinic.source_capture_request
        schema_version: 1
        status: failed
        url: "https://example.com/article"
        requested_by: "aaaaa-aa"
        requested_at: "2026-05-14T00:00:01Z"
        output_language: "en"
        source_path: null
        ---
        """)
        let nodeWithMalformedMetadata = VFSNode(
            path: node.path,
            kind: node.kind,
            content: node.content,
            metadataJson: "not-json",
            etag: node.etag,
            createdAt: node.createdAt,
            updatedAt: node.updatedAt
        )

        #expect(try SourceCaptureHistoryParser.request(from: nodeWithMalformedMetadata).retryWrite().metadataJson == "not-json")
    }

    @Test
    func retryabilityMatchesWorkerStaleFetchingPolicy() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let staleClaim = now.addingTimeInterval(-SourceCaptureHistoryStatus.fetchingStaleInterval)
            .formatted(.iso8601)
        let activeClaim = now.addingTimeInterval(-SourceCaptureHistoryStatus.fetchingStaleInterval + 1)
            .formatted(.iso8601)

        #expect(makeItem(status: .queued).isRetryable(at: now))
        #expect(makeItem(status: .sourceWritten).isRetryable(at: now))
        #expect(makeItem(status: .failed).isRetryable(at: now))
        #expect(makeItem(status: .fetching, claimedAt: staleClaim).isRetryable(at: now))
        #expect(!makeItem(status: .fetching, claimedAt: activeClaim).isRetryable(at: now))
        #expect(!makeItem(status: .generating).isRetryable(at: now))
        #expect(!makeItem(status: .completed).isRetryable(at: now))
    }

    private func makeRecord(requestID: String, requestedAtMilliseconds: Int64) -> SourceCaptureHistoryRecord {
        SourceCaptureHistoryRecord(
            databaseId: "db_demo",
            item: SourceCaptureHistoryItem(
                requestPath: "/Sources/source-capture-requests/\(requestID).md",
                url: "https://example.com/\(requestID)",
                status: .queued,
                requestedAtMilliseconds: requestedAtMilliseconds,
                updatedAtMilliseconds: requestedAtMilliseconds,
                claimedAt: nil,
                sourcePath: nil,
                targetPath: nil,
                finishedAt: nil,
                error: nil
            )
        )
    }

    private func makeItem(
        status: SourceCaptureHistoryStatus,
        claimedAt: String? = nil
    ) -> SourceCaptureHistoryItem {
        SourceCaptureHistoryItem(
            requestPath: "/Sources/source-capture-requests/retry.md",
            url: "https://example.com/retry",
            status: status,
            requestedAtMilliseconds: 1_700_000_000_000,
            updatedAtMilliseconds: 1_700_000_000_000,
            claimedAt: claimedAt,
            sourcePath: nil,
            targetPath: nil,
            finishedAt: nil,
            error: nil
        )
    }

    private func makeNode(content: String) -> VFSNode {
        VFSNode(
            path: "/Sources/source-capture-requests/remote.md",
            kind: .file,
            content: content,
            metadataJson: "{}",
            etag: "etag",
            createdAt: 1,
            updatedAt: 2
        )
    }

    private func requestContent(status: String) -> String {
        """
        ---
        kind: kinic.source_capture_request
        schema_version: 1
        url: "https://example.com/article"
        requested_at: "2026-05-14T00:00:01Z"
        status: \(status)
        claimed_at: null
        source_path: null
        target_path: null
        finished_at: null
        error: null
        ---
        """
    }
}
