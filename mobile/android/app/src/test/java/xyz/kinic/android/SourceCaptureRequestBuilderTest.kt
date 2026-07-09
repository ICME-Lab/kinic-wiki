// Where: mobile/android/app/src/test/java/xyz/kinic/android/SourceCaptureRequestBuilderTest.kt
// What: Unit tests for Android source capture request generation.
// Why: Android request shape must stay aligned with iOS and the web worker contract.

package xyz.kinic.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.URI
import java.time.Instant
import java.util.UUID

class SourceCaptureRequestBuilderTest {
    @Test
    fun normalizesUrlAndBuildsRequestNode() {
        val request = SourceCaptureRequestBuilder.request(
            url = URI("https://example.com/page#section"),
            databaseId = "db_demo",
            requestedBy = "aaaaa-aa",
            now = Instant.ofEpochSecond(1_700_000_000),
            uuid = UUID.fromString("00000000-0000-4000-8000-000000000000"),
        )

        assertEquals("db_demo", request.databaseId)
        assertEquals("1700000000000-00000000-0000-4000-8000-000000000000", request.requestId)
        assertEquals("https://example.com/page", request.normalizedUrl.toString())
        assertEquals(
            "/Sources/source-capture-requests/1700000000000-00000000-0000-4000-8000-000000000000.md",
            request.requestPath,
        )
        assertTrue(request.content.contains("kind: kinic.source_capture_request"))
        assertTrue(request.content.contains("url: \"https:\\/\\/example.com\\/page\""))
        assertEquals(
            "{\"request_type\":\"source_capture\",\"url\":\"https:\\/\\/example.com\\/page\"}",
            request.metadataJson,
        )
    }

    @Test
    fun includesShareMetadataWhenProvided() {
        val request = SourceCaptureRequestBuilder.request(
            url = URI("https://x.com/sinceaihq/status/2074424777675046913?s=46"),
            databaseId = "db_demo",
            requestedBy = "aaaaa-aa",
            requestId = "1700000000000-00000000-0000-4000-8000-000000000000",
            captureMetadata = ShareCaptureMetadata(
                title = "Since AI (@sinceaihq)",
                description = "Building an AI product is one thing. Turning it into a company is separate.",
                imageUrl = URI("https://pbs.twimg.com/media/card.jpg"),
                source = ShareCaptureMetadata.X_OPEN_GRAPH_SOURCE,
                fetchedAt = Instant.ofEpochSecond(1_700_000_000),
            ),
        )

        assertTrue(request.content.contains("shared_metadata_source: \"x_og_metadata\""))
        assertTrue(request.content.contains("shared_description: \"Building an AI product is one thing. Turning it into a company is separate.\""))
        assertTrue(request.content.contains("### Description"))
        assertTrue(request.metadataJson.contains("\"shared_image_url\":\"https:\\/\\/pbs.twimg.com\\/media\\/card.jpg\""))
    }

    @Test
    fun rejectsNonHttpUrls() {
        assertThrows(URLNormalizerException.UnsupportedUrl::class.java) {
            URLNormalizer.normalizedHttpUrl(URI("file:///tmp/a.txt"))
        }
    }

    @Test
    fun rejectsUnsafeRequestIds() {
        val invalidRequestIds = listOf("../x", "a/b", ".", "..", "a..b", "", "aé", "a".repeat(129))
        invalidRequestIds.forEach { requestId ->
            assertThrows(SourceCaptureRequestException.InvalidRequestId::class.java) {
                SourceCaptureRequestBuilder.request(
                    url = URI("https://example.com/page"),
                    databaseId = "db_demo",
                    requestedBy = "aaaaa-aa",
                    requestId = requestId,
                )
            }
        }
    }
}
