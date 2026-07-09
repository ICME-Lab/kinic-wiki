// Where: mobile/android/app/src/main/java/xyz/kinic/android/ShareInbox.kt
// What: File-backed queue for URLs captured by Android share intents or manual entry.
// Why: Pending captures must survive process death without overwriting concurrent writes.

package xyz.kinic.android

import org.json.JSONObject
import java.io.File
import java.net.URI
import java.time.Instant
import java.util.UUID

class ShareInbox(private val queueDirectory: File) {
    init {
        queueDirectory.mkdirs()
    }

    fun loadPendingUrls(): List<PendingSharedUrl> =
        queueDirectory.listFiles { file -> file.extension == "json" }
            ?.mapNotNull(::decodeFile)
            ?.sortedWith(compareBy<PendingSharedUrl> { it.receivedAt }.thenBy { it.id })
            ?: emptyList()

    fun enqueue(
        url: URI,
        receivedAt: Instant = Instant.now(),
        requestId: String? = null,
        databaseId: String? = null,
        captureMetadata: ShareCaptureMetadata? = null,
    ): PendingSharedUrl {
        val normalizedUrl = URLNormalizer.normalizedHttpUrl(url)
        val id = UUID.randomUUID().toString().lowercase()
        val resolvedRequestId = requestId?.let(SourceCaptureRequestBuilder::validateRequestId)
            ?: SourceCaptureRequestBuilder.makeRequestId(receivedAt)
        val item = PendingSharedUrl(
            id = id,
            url = normalizedUrl,
            receivedAt = receivedAt,
            requestId = resolvedRequestId,
            databaseId = databaseId?.trim()?.takeIf(String::isNotEmpty),
            captureMetadata = captureMetadata?.cleaned(),
        )
        val temporary = File(queueDirectory, "$id.tmp")
        val final = File(queueDirectory, "$id.json")
        temporary.writeText(encode(item).toString(), Charsets.UTF_8)
        if (!temporary.renameTo(final)) {
            temporary.delete()
            throw IllegalStateException("failed to enqueue shared URL")
        }
        return item
    }

    fun remove(item: PendingSharedUrl) {
        if (!SourceCaptureRequestBuilder.isSafeStorageSegment(item.id)) return
        File(queueDirectory, "${item.id}.json").delete()
    }

    private fun decodeFile(file: File): PendingSharedUrl? =
        runCatching {
            val json = JSONObject(file.readText(Charsets.UTF_8))
            val id = json.getString("id")
            if (!SourceCaptureRequestBuilder.isSafeStorageSegment(id)) return null
            if (file.nameWithoutExtension != id) return null
            val requestId = SourceCaptureRequestBuilder.validateRequestId(json.getString("requestId"))
            PendingSharedUrl(
                id = id,
                url = URLNormalizer.normalizedHttpUrl(json.getString("url")),
                receivedAt = Instant.parse(json.getString("receivedAt")),
                requestId = requestId,
                databaseId = json.optString("databaseId").trim().takeIf(String::isNotEmpty),
                captureMetadata = decodeMetadata(json.optJSONObject("captureMetadata")),
            )
        }.getOrNull()

    private fun encode(item: PendingSharedUrl): JSONObject {
        val json = JSONObject()
            .put("id", item.id)
            .put("url", item.url.toString())
            .put("receivedAt", item.receivedAt.toString())
            .put("requestId", item.requestId)
        item.databaseId?.let { json.put("databaseId", it) }
        item.captureMetadata?.let { json.put("captureMetadata", encodeMetadata(it)) }
        return json
    }

    private fun encodeMetadata(metadata: ShareCaptureMetadata): JSONObject {
        val json = JSONObject()
            .put("source", metadata.source)
            .put("fetchedAt", metadata.fetchedAt.toString())
        metadata.title?.let { json.put("title", it) }
        metadata.description?.let { json.put("description", it) }
        metadata.imageUrl?.let { json.put("imageUrl", it.toString()) }
        return json
    }

    private fun decodeMetadata(json: JSONObject?): ShareCaptureMetadata? {
        if (json == null) return null
        return ShareCaptureMetadata(
            title = json.optString("title").trim().takeIf(String::isNotEmpty),
            description = json.optString("description").trim().takeIf(String::isNotEmpty),
            imageUrl = json.optString("imageUrl").trim().takeIf(String::isNotEmpty)?.let(::URI),
            source = json.getString("source"),
            fetchedAt = Instant.parse(json.getString("fetchedAt")),
        ).cleaned()
    }
}
