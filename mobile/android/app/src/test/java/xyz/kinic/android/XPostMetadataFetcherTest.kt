package xyz.kinic.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.URI
import java.time.Instant

class XPostMetadataFetcherTest {
    @Test
    fun recognizesOnlyXAndTwitterStatusUrls() {
        assertTrue(XPostMetadataFetcher.isSupportedPostUrl(URI("https://x.com/user/status/123?s=46")))
        assertTrue(XPostMetadataFetcher.isSupportedPostUrl(URI("https://twitter.com/user/status/123")))
        assertFalse(XPostMetadataFetcher.isSupportedPostUrl(URI("https://x.com/user")))
        assertFalse(XPostMetadataFetcher.isSupportedPostUrl(URI("https://example.com/user/status/123")))
    }

    @Test
    fun extractsOpenGraphMetadataWithHtmlEntityDecoding() {
        val html = """
            <html><head>
              <meta property="og:title" content="Kinic &amp; Wiki">
              <meta property="og:description" content="A &quot;quoted&quot; post">
              <meta property="og:image" content="https://pbs.twimg.com/card.jpg">
            </head></html>
        """.trimIndent()

        val metadata = XPostMetadataFetcher.metadataFromHtml(
            html,
            Instant.parse("2026-01-01T00:00:00Z"),
        )

        assertEquals("Kinic & Wiki", metadata?.title)
        assertEquals("A \"quoted\" post", metadata?.description)
        assertEquals(URI("https://pbs.twimg.com/card.jpg"), metadata?.imageUrl)
        assertEquals(ShareCaptureMetadata.X_OPEN_GRAPH_SOURCE, metadata?.source)
    }
}
