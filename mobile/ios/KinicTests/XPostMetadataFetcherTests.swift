// Where: mobile/ios/KinicTests/XPostMetadataFetcherTests.swift
// What: Unit tests for API-free X post metadata extraction.
// Why: The Share Extension relies on Open Graph tags for best-effort post text capture.

import Foundation
import Testing
@testable import Kinic

struct XPostMetadataFetcherTests {
    @Test
    func supportsNormalXAndTwitterStatusURLsOnly() {
        #expect(XPostMetadataFetcher.isSupportedPostURL(URL(string: "https://x.com/sinceaihq/status/2074424777675046913?s=46")!))
        #expect(XPostMetadataFetcher.isSupportedPostURL(URL(string: "https://twitter.com/sinceaihq/status/2074424777675046913")!))
        #expect(!XPostMetadataFetcher.isSupportedPostURL(URL(string: "https://x.com/sinceaihq")!))
        #expect(!XPostMetadataFetcher.isSupportedPostURL(URL(string: "https://example.com/sinceaihq/status/2074424777675046913")!))
    }

    @Test
    func extractsOpenGraphMetadataAndDecodesEntities() throws {
        let html = #"""
        <html>
          <head>
            <meta property="og:title" content="Since AI (@sinceaihq)" />
            <meta property="og:description" content="Building an AI product is one thing. Turning it into a company is another. That&#39;s why we&#x27;re excited &amp; ready." />
            <meta property="og:image" content="https://pbs.twimg.com/media/card.jpg" />
          </head>
        </html>
        """#

        let metadata = try #require(
            XPostMetadataFetcher.metadata(fromHTML: html, fetchedAt: Date(timeIntervalSince1970: 1_700_000_000))
        )

        #expect(metadata.title == "Since AI (@sinceaihq)")
        #expect(metadata.description == "Building an AI product is one thing. Turning it into a company is another. That's why we're excited & ready.")
        #expect(metadata.imageURL?.absoluteString == "https://pbs.twimg.com/media/card.jpg")
        #expect(metadata.source == ShareCaptureMetadata.xOpenGraphSource)
    }

    @Test
    func returnsNilWhenHTMLHasNoUsefulMetadata() {
        let metadata = XPostMetadataFetcher.metadata(
            fromHTML: "<html><head></head><body></body></html>",
            fetchedAt: Date(timeIntervalSince1970: 1_700_000_000)
        )

        #expect(metadata == nil)
    }

    @Test
    func fetcherReturnsNilForUnsupportedURLWithoutFetching() async {
        let fetcher = XPostMetadataFetcher { _ in
            Issue.record("Unsupported URLs must not fetch HTML.")
            return ""
        }

        let metadata = await fetcher.metadata(for: URL(string: "https://example.com/status/2074424777675046913")!)

        #expect(metadata == nil)
    }
}
