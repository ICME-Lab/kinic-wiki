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
        #expect(request.requestId == "1700000000000-00000000-0000-4000-8000-000000000000")
        #expect(request.normalizedURL.absoluteString == "https://example.com/page")
        #expect(request.requestPath == "/Sources/source-capture-requests/1700000000000-00000000-0000-4000-8000-000000000000.md")
        #expect(request.content.contains("kind: kinic.source_capture_request"))
        #expect(request.content.contains("url: \"https:\\/\\/example.com\\/page\""))
        #expect(request.content.contains("output_language: \"en\""))
        #expect(request.outputLanguage == .english)
        #expect(request.metadataJson == "{\"output_language\":\"en\",\"request_type\":\"source_capture\",\"url\":\"https:\\/\\/example.com\\/page\"}")
    }

    @Test
    func includesSelectedOutputLanguage() throws {
        let request = try SourceCaptureRequestBuilder.request(
            url: URL(string: "https://example.com/page")!,
            databaseId: "db_demo",
            requestedBy: "aaaaa-aa",
            outputLanguage: .japanese
        )

        #expect(request.outputLanguage == .japanese)
        #expect(request.content.contains("output_language: \"ja\""))
        #expect(request.metadataJson.contains("\"output_language\":\"ja\""))
    }

    @Test
    func englishRequestMatchesLegacyNodeWithoutOutputLanguage() throws {
        let request = try SourceCaptureRequestBuilder.request(
            url: URL(string: "https://example.com/page")!,
            databaseId: "db_demo",
            requestedBy: "aaaaa-aa"
        )
        let legacyContent = request.content.replacingOccurrences(of: "\noutput_language: \"en\"\n", with: "\n")
        let legacyMetadataJson = request.metadataJson.replacingOccurrences(of: "\"output_language\":\"en\",", with: "")
        let existing = VFSNode(
            path: request.requestPath,
            kind: .file,
            content: legacyContent,
            metadataJson: legacyMetadataJson,
            etag: "legacy-etag",
            createdAt: 1,
            updatedAt: 1
        )

        #expect(isSameSourceCaptureRequest(existing, request))
        let japaneseRequest = try SourceCaptureRequestBuilder.request(
            url: request.normalizedURL,
            databaseId: request.databaseId,
            requestedBy: "aaaaa-aa",
            requestId: request.requestId,
            outputLanguage: .japanese
        )
        #expect(!isSameSourceCaptureRequest(existing, japaneseRequest))
    }

    @Test
    func preservesValidExplicitRequestId() throws {
        let request = try SourceCaptureRequestBuilder.request(
            url: URL(string: "https://example.com/page")!,
            databaseId: "db_demo",
            requestedBy: "aaaaa-aa",
            requestId: "1700000000000-00000000-0000-4000-8000-000000000000"
        )

        #expect(request.requestId == "1700000000000-00000000-0000-4000-8000-000000000000")
        #expect(request.requestPath == "/Sources/source-capture-requests/1700000000000-00000000-0000-4000-8000-000000000000.md")
    }

    @Test
    func includesShareMetadataWhenProvided() throws {
        let metadata = ShareCaptureMetadata(
            title: "Since AI (@sinceaihq)",
            description: "Building an AI product is one thing. Turning it into a company is another.",
            imageURL: URL(string: "https://pbs.twimg.com/media/card.jpg")!,
            source: ShareCaptureMetadata.xOpenGraphSource,
            fetchedAt: Date(timeIntervalSince1970: 1_700_000_000)
        )
        let request = try SourceCaptureRequestBuilder.request(
            url: URL(string: "https://x.com/sinceaihq/status/2074424777675046913?s=46")!,
            databaseId: "db_demo",
            requestedBy: "aaaaa-aa",
            requestId: "1700000000000-00000000-0000-4000-8000-000000000000",
            captureMetadata: metadata
        )

        #expect(request.content.contains("shared_metadata_source: \"x_og_metadata\""))
        #expect(request.content.contains("shared_description: \"Building an AI product is one thing. Turning it into a company is another.\""))
        #expect(request.content.contains("### Description"))
        #expect(request.content.contains("Building an AI product is one thing. Turning it into a company is another."))
        #expect(request.metadataJson.contains("\"shared_description\":\"Building an AI product is one thing. Turning it into a company is another.\""))
        #expect(request.metadataJson.contains("\"shared_image_url\":\"https:\\/\\/pbs.twimg.com\\/media\\/card.jpg\""))
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

    @Test
    func rejectsUnsafeExplicitRequestIds() throws {
        let invalidRequestIds = [
            "../x",
            "a/b",
            ".",
            "..",
            "a..b",
            "",
            "aé",
            String(repeating: "a", count: 129)
        ]
        for requestId in invalidRequestIds {
            #expect(throws: SourceCaptureRequestError.invalidRequestId) {
                try SourceCaptureRequestBuilder.request(
                    url: URL(string: "https://example.com/page")!,
                    databaseId: "db_demo",
                    requestedBy: "aaaaa-aa",
                    requestId: requestId
                )
            }
        }
    }
}
