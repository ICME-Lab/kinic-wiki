// Where: mobile/ios/KinicTests/SourceCaptureRequestBuilderTests.swift
// What: Unit tests for native source capture request generation.
// Why: The iOS request shape must stay aligned with the web worker contract.

import Foundation
import Testing
@testable import Kinic

struct SourceCaptureRequestBuilderTests {
    @Test
    func normalizesURLAndBuildsRequestNode() throws {
        let request = try SourceCaptureRequestBuilder.request(
            url: URL(string: "https://example.com/page#section")!,
            databaseId: "db_demo",
            requestedBy: "aaaaa-aa",
            now: Date(timeIntervalSince1970: 1_700_000_000),
            uuid: UUID(uuidString: "00000000-0000-4000-8000-000000000000")!
        )

        #expect(request.databaseId == "db_demo")
        #expect(request.normalizedURL.absoluteString == "https://example.com/page")
        #expect(request.requestPath == "/Sources/source-capture-requests/1700000000000-00000000-0000-4000-8000-000000000000.md")
        #expect(request.content.contains("kind: kinic.source_capture_request"))
        #expect(request.content.contains("url: \"https:\\/\\/example.com\\/page\""))
        #expect(request.metadataJson == "{\"request_type\":\"source_capture\",\"url\":\"https:\\/\\/example.com\\/page\"}")
    }

    @Test
    func rejectsNonHTTPURLs() throws {
        #expect(throws: URLNormalizerError.unsupportedURL) {
            try URLNormalizer.normalizedHTTPURL(URL(string: "file:///tmp/a.txt")!)
        }
    }

    @Test
    func rejectsUnsafeRequestId() throws {
        #expect(throws: SourceCaptureRequestError.invalidRequestId) {
            try SourceCaptureRequestBuilder.safeRequestId(timeMs: 1, uuid: "../bad")
        }
    }
}

