// Where: mobile/android/app/src/main/java/xyz/kinic/android/SourceCaptureRequestBuilder.kt
// What: Builds Android source capture request nodes.
// Why: Shared links must preserve the existing worker contract exactly.

package xyz.kinic.android

import java.net.URI
import java.time.Instant
import java.util.UUID

object SourceCaptureRequestBuilder {
    private val safeFirst = Regex("^[A-Za-z0-9]")
    private val safeAll = Regex("^[A-Za-z0-9._-]+$")

    fun request(
        url: URI,
        databaseId: String,
        requestedBy: String,
        requestId: String? = null,
        now: Instant = Instant.now(),
        uuid: UUID = UUID.randomUUID(),
        captureMetadata: ShareCaptureMetadata? = null,
        outputLanguage: WikiOutputLanguage = WikiOutputLanguage.ENGLISH,
    ): SourceCaptureRequest {
        val normalizedUrl = URLNormalizer.normalizedHttpUrl(url)
        val resolvedRequestId = requestId?.let(::validateRequestId) ?: makeRequestId(now, uuid)
        val requestPath = "/Sources/source-capture-requests/$resolvedRequestId.md"
        val urlText = normalizedUrl.toString()
        val cleanedMetadata = captureMetadata?.cleaned()

        val frontmatter = mutableListOf(
            "---",
            "kind: kinic.source_capture_request",
            "schema_version: 1",
            "status: queued",
            "url: ${jsonString(urlText)}",
            "requested_by: ${jsonString(requestedBy)}",
            "requested_at: ${jsonString(now.toString())}",
            "output_language: ${jsonString(outputLanguage.code)}",
            "claimed_at: null",
            "source_path: null",
            "target_path: null",
            "finished_at: null",
            "error: null",
        )
        frontmatter += captureMetadataFrontmatter(cleanedMetadata)
        val body = listOf("---", "", "# Source Capture Request", "") +
            captureMetadataBody(cleanedMetadata)

        val metadataPayload = mutableMapOf(
            "request_type" to "source_capture",
            "url" to urlText,
            "output_language" to outputLanguage.code,
        )
        appendCaptureMetadata(cleanedMetadata, metadataPayload)

        return SourceCaptureRequest(
            databaseId = databaseId,
            requestId = resolvedRequestId,
            requestPath = requestPath,
            content = (frontmatter + body).joinToString("\n"),
            metadataJson = jsonObjectSorted(metadataPayload),
            normalizedUrl = normalizedUrl,
            outputLanguage = outputLanguage,
        )
    }

    fun makeRequestId(now: Instant = Instant.now(), uuid: UUID = UUID.randomUUID()): String =
        safeRequestId(now.toEpochMilli(), uuid.toString().lowercase())

    fun validateRequestId(requestId: String): String {
        if (!isSafeStorageSegment(requestId)) {
            throw SourceCaptureRequestException.InvalidRequestId
        }
        return requestId
    }

    fun safeRequestId(timeMs: Long, uuid: String): String {
        val suffix = uuid.trim()
        if (!isSafeStorageSegment(suffix, maxLength = 96)) {
            throw SourceCaptureRequestException.InvalidRequestId
        }
        val requestId = "$timeMs-$suffix"
        if (!isSafeStorageSegment(requestId)) {
            throw SourceCaptureRequestException.InvalidRequestId
        }
        return requestId
    }

    fun isSafeStorageSegment(value: String, maxLength: Int = 128): Boolean =
        value.length <= maxLength &&
            value != "." &&
            value != ".." &&
            !value.contains("..") &&
            safeFirst.containsMatchIn(value) &&
            safeAll.matches(value)

    private fun captureMetadataFrontmatter(metadata: ShareCaptureMetadata?): List<String> {
        if (metadata?.hasContent != true) return emptyList()
        val lines = mutableListOf(
            "shared_metadata_source: ${jsonString(metadata.source)}",
            "shared_metadata_fetched_at: ${jsonString(metadata.fetchedAt.toString())}",
        )
        metadata.title?.let { lines += "shared_title: ${jsonString(it)}" }
        metadata.description?.let { lines += "shared_description: ${jsonString(it)}" }
        metadata.imageUrl?.let { lines += "shared_image_url: ${jsonString(it.toString())}" }
        return lines
    }

    private fun captureMetadataBody(metadata: ShareCaptureMetadata?): List<String> {
        if (metadata?.hasContent != true) return emptyList()
        val lines = mutableListOf(
            "## Shared Metadata",
            "",
            "Source: ${metadata.source}",
            "Fetched at: ${metadata.fetchedAt}",
        )
        metadata.title?.let { lines += "Title: $it" }
        metadata.imageUrl?.let { lines += "Image: $it" }
        metadata.description?.let {
            lines += ""
            lines += "### Description"
            lines += ""
            lines += it
        }
        lines += ""
        return lines
    }

    private fun appendCaptureMetadata(metadata: ShareCaptureMetadata?, payload: MutableMap<String, String>) {
        if (metadata?.hasContent != true) return
        payload["shared_metadata_source"] = metadata.source
        payload["shared_metadata_fetched_at"] = metadata.fetchedAt.toString()
        metadata.title?.let { payload["shared_title"] = it }
        metadata.description?.let { payload["shared_description"] = it }
        metadata.imageUrl?.let { payload["shared_image_url"] = it.toString() }
    }
}

sealed class SourceCaptureRequestException(message: String) : IllegalArgumentException(message) {
    data object InvalidRequestId : SourceCaptureRequestException("invalid request id")
}
