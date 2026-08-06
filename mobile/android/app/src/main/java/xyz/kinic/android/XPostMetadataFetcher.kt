package xyz.kinic.android

import org.jsoup.Jsoup
import java.net.URI
import java.time.Instant

class XPostMetadataFetcher(
    private val fetchHtml: (URI) -> String = ::liveFetchHtml,
) {
    fun metadata(url: URI, fetchedAt: Instant = Instant.now()): ShareCaptureMetadata? {
        if (!isSupportedPostUrl(url)) return null
        return runCatching {
            metadataFromHtml(fetchHtml(url), fetchedAt)
        }.getOrNull()
    }

    companion object {
        private val supportedHosts = setOf("x.com", "www.x.com", "twitter.com", "www.twitter.com")

        fun isSupportedPostUrl(url: URI): Boolean {
            if (url.scheme?.lowercase() !in setOf("http", "https")) return false
            if (url.host?.lowercase() !in supportedHosts) return false
            val segments = url.path.orEmpty().split('/').filter(String::isNotBlank)
            return segments.size >= 3 &&
                segments[1] == "status" &&
                segments[2].isNotEmpty() &&
                segments[2].all(Char::isDigit)
        }

        fun metadataFromHtml(html: String, fetchedAt: Instant): ShareCaptureMetadata? {
            val document = Jsoup.parse(html)
            fun content(selector: String): String? =
                document.selectFirst(selector)?.attr("content")?.trim()?.takeIf(String::isNotEmpty)

            val imageUrl = content("meta[property=og:image]")
                ?.let { runCatching { URI(it) }.getOrNull() }
                ?.takeIf { it.scheme?.lowercase() in setOf("http", "https") }
            val metadata = ShareCaptureMetadata(
                title = content("meta[property=og:title]"),
                description = content("meta[property=og:description]")
                    ?: content("meta[name=description]"),
                imageUrl = imageUrl,
                source = ShareCaptureMetadata.X_OPEN_GRAPH_SOURCE,
                fetchedAt = fetchedAt,
            ).cleaned()
            return metadata.takeIf(ShareCaptureMetadata::hasContent)
        }

        private fun liveFetchHtml(url: URI): String =
            Jsoup.connect(url.toString())
                .userAgent("Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/131 Mobile Safari/537.36")
                .header("Accept", "text/html,application/xhtml+xml")
                .timeout(2_000)
                .maxBodySize(128 * 1024)
                .followRedirects(true)
                .execute()
                .parse()
                .outerHtml()
    }
}
