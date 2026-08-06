package xyz.kinic.android

import org.json.JSONObject
import java.time.Instant

data class SourceCaptureRetryWrite(
    val status: SourceCaptureHistoryStatus,
    val content: String,
    val metadataJson: String,
)

data class SourceCaptureRequestNode(
    val node: VfsNode,
    val item: SourceCaptureHistoryItem,
    val requestedBy: String,
    val requestedAt: String,
    val outputLanguage: WikiOutputLanguage,
    private val fields: Map<String, FrontmatterValue>,
    private val fieldOrder: List<String>,
    private val body: String,
) {
    fun retryWrite(): SourceCaptureRetryWrite {
        val retryStatus = if (item.sourcePath == null) {
            SourceCaptureHistoryStatus.QUEUED
        } else {
            SourceCaptureHistoryStatus.SOURCE_WRITTEN
        }
        val retryFields = fields.toMutableMap().apply {
            this["status"] = FrontmatterValue.Text(retryStatus.workerValue)
            this["claimed_at"] = FrontmatterValue.Null
            this["source_path"] = item.sourcePath?.let(FrontmatterValue::Text) ?: FrontmatterValue.Null
            this["target_path"] = FrontmatterValue.Null
            this["finished_at"] = FrontmatterValue.Null
            this["error"] = FrontmatterValue.Null
        }
        val metadata = runCatching { JSONObject(node.metadataJson) }.getOrNull()
        val metadataJson = if (metadata == null) {
            node.metadataJson
        } else {
            metadata
                .put("request_type", "source_capture")
                .put("url", item.url)
                .put("status", retryStatus.workerValue)
                .put("output_language", outputLanguage.code)
                .put("source_path", item.sourcePath ?: JSONObject.NULL)
                .put("target_path", JSONObject.NULL)
            metadata.toSortedJson()
        }
        return SourceCaptureRetryWrite(
            status = retryStatus,
            content = renderFrontmatter(retryFields, fieldOrder, body),
            metadataJson = metadataJson,
        )
    }
}

sealed interface FrontmatterValue {
    data object Null : FrontmatterValue
    data class Text(val value: String) : FrontmatterValue
}

object SourceCaptureHistoryParser {
    fun item(node: VfsNode): SourceCaptureHistoryItem =
        request(node).item

    fun request(node: VfsNode): SourceCaptureRequestNode {
        require(node.kind == VfsNodeKind.FILE) { "Source capture request node is not a file." }
        val parsed = parseFrontmatter(node.content)
        require(parsed.text("kind") == "kinic.source_capture_request") { "Source capture request fields are invalid." }
        require(parsed.text("schema_version") == "1") { "Source capture request fields are invalid." }
        val requestedAt = parsed.text("requested_at") ?: throw invalidRequest()
        val requestedAtInstant = runCatching { Instant.parse(requestedAt) }.getOrElse { throw invalidRequest() }
        val status = parsed.text("status")?.let(SourceCaptureHistoryStatus::fromWorkerValue)
            ?: throw IllegalArgumentException("Source capture request status is invalid.")
        val item = SourceCaptureHistoryItem(
            requestPath = node.path,
            url = parsed.text("url") ?: throw invalidRequest(),
            status = status,
            requestedAtMilliseconds = requestedAtInstant.toEpochMilli(),
            updatedAtMilliseconds = node.updatedAt,
            claimedAt = parsed.text("claimed_at"),
            sourcePath = parsed.text("source_path"),
            targetPath = parsed.text("target_path"),
            finishedAt = parsed.text("finished_at"),
            error = parsed.text("error"),
        )
        return SourceCaptureRequestNode(
            node = node,
            item = item,
            requestedBy = parsed.text("requested_by") ?: throw invalidRequest(),
            requestedAt = requestedAt,
            outputLanguage = parsed.text("output_language")
                ?.let(WikiOutputLanguage::fromCode)
                ?: WikiOutputLanguage.ENGLISH,
            fields = parsed.fields,
            fieldOrder = parsed.order,
            body = parsed.body,
        )
    }

    private fun parseFrontmatter(content: String): ParsedFrontmatter {
        require(content.startsWith("---\n")) { "Source capture request frontmatter is invalid." }
        val marker = content.indexOf("\n---", startIndex = 4)
        require(marker >= 0) { "Source capture request frontmatter is invalid." }
        val markerEnd = marker + 4
        require(markerEnd == content.length || content[markerEnd] == '\n') {
            "Source capture request frontmatter is invalid."
        }
        val fields = linkedMapOf<String, FrontmatterValue>()
        content.substring(4, marker).lineSequence().filter(String::isNotBlank).forEach { line ->
            val separator = line.indexOf(':')
            require(separator > 0) { "Source capture request frontmatter is invalid." }
            val key = line.substring(0, separator).trim()
            val raw = line.substring(separator + 1).trim()
            require(key.isNotBlank() && key !in fields) { "Source capture request frontmatter is invalid." }
            fields[key] = when {
                raw == "null" -> FrontmatterValue.Null
                raw.startsWith('"') -> FrontmatterValue.Text(
                    runCatching { JSONObject("{\"value\":$raw}").getString("value") }
                        .getOrElse { throw IllegalArgumentException("Source capture request frontmatter is invalid.") },
                )
                else -> FrontmatterValue.Text(raw)
            }
        }
        return ParsedFrontmatter(
            fields = fields,
            order = fields.keys.toList(),
            body = content.substring(markerEnd),
        )
    }

    private data class ParsedFrontmatter(
        val fields: Map<String, FrontmatterValue>,
        val order: List<String>,
        val body: String,
    ) {
        fun text(key: String): String? = (fields[key] as? FrontmatterValue.Text)?.value
    }

    private fun invalidRequest(): IllegalArgumentException =
        IllegalArgumentException("Source capture request fields are invalid.")
}

private fun renderFrontmatter(
    fields: Map<String, FrontmatterValue>,
    order: List<String>,
    body: String,
): String {
    val required = listOf(
        "kind",
        "schema_version",
        "status",
        "url",
        "requested_by",
        "requested_at",
        "output_language",
        "claimed_at",
        "source_path",
        "target_path",
        "finished_at",
        "error",
    )
    val keys = required + order.filterNot(required::contains)
    val lines = keys.distinct().mapNotNull { key ->
        fields[key]?.let { value ->
            "$key: " + when (value) {
                FrontmatterValue.Null -> "null"
                is FrontmatterValue.Text -> jsonString(value.value)
            }
        }
    }
    return "---\n${lines.joinToString("\n")}\n---\n\n${body.trim()}"
}

private fun JSONObject.toSortedJson(): String {
    val values = keys().asSequence().associateWith { key ->
        if (isNull(key)) null else get(key)
    }
    return values.toSortedMap().entries.joinToString(",", "{", "}") { (key, value) ->
        val encoded = when (value) {
            null -> "null"
            is String -> jsonString(value)
            is Number, is Boolean -> value.toString()
            else -> value.toString()
        }
        "${jsonString(key)}:$encoded"
    }
}
