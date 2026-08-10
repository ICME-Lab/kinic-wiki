package xyz.kinic.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.URI
import java.nio.file.Files
import java.time.Instant

class SourceCaptureHistoryTest {
    @Test
    fun storePersistsAndPrunesPerDatabase() {
        val directory = Files.createTempDirectory("capture-history").toFile()
        try {
            val store = SourceCaptureHistoryStore(directory)
            repeat(SourceCaptureHistoryStore.MAX_RECORDS_PER_DATABASE + 1) { index ->
                val now = Instant.ofEpochMilli(index.toLong())
                val request = SourceCaptureRequestBuilder.request(
                    url = URI("https://example.com/$index"),
                    databaseId = "db_demo",
                    requestedBy = "aaaaa-aa",
                    requestId = "$index-request",
                    now = now,
                )
                store.save(SourceCaptureHistoryRecord.fromRequest(request, now))
            }

            val records = SourceCaptureHistoryStore(directory).load("db_demo")
            assertEquals(SourceCaptureHistoryStore.MAX_RECORDS_PER_DATABASE, records.size)
            assertEquals("https://example.com/100", records.first().item.url)
            assertFalse(records.any { it.item.url == "https://example.com/0" })
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun parserReadsWorkerStatusesAndRetryRules() {
        val now = Instant.parse("2026-01-01T00:30:00Z")
        val stale = requestNode(
            status = "fetching",
            claimedAt = "2026-01-01T00:00:00Z",
        )
        val completed = requestNode(status = "completed", claimedAt = null)

        assertTrue(SourceCaptureHistoryParser.item(stale).isRetryable(now))
        assertFalse(SourceCaptureHistoryParser.item(completed).isRetryable(now))
        assertThrows(IllegalArgumentException::class.java) {
            SourceCaptureHistoryParser.item(requestNode("unknown", null))
        }
    }

    @Test
    fun failedRequestRetryResetsWorkerFields() {
        val parsed = SourceCaptureHistoryParser.request(
            requestNode(status = "failed", claimedAt = "2026-01-01T00:01:00Z", sourcePath = "/Sources/a.md"),
        )

        val retry = parsed.retryWrite()

        assertEquals(SourceCaptureHistoryStatus.SOURCE_WRITTEN, retry.status)
        assertTrue(retry.content.contains("status: \"source_written\""))
        assertTrue(retry.content.contains("claimed_at: null"))
        assertTrue(retry.metadataJson.contains("\"status\":\"source_written\""))
    }

    private fun requestNode(
        status: String,
        claimedAt: String?,
        sourcePath: String? = null,
    ): VfsNode =
        VfsNode(
            path = "/Sources/source-capture-requests/1-request.md",
            kind = VfsNodeKind.FILE,
            content = """
                ---
                kind: kinic.source_capture_request
                schema_version: 1
                status: "$status"
                url: "https://example.com"
                requested_by: "aaaaa-aa"
                requested_at: "2026-01-01T00:00:00Z"
                output_language: "ja"
                claimed_at: ${claimedAt?.let(::jsonString) ?: "null"}
                source_path: ${sourcePath?.let(::jsonString) ?: "null"}
                target_path: null
                finished_at: null
                error: null
                ---

                # Source Capture Request
            """.trimIndent(),
            metadataJson = """{"request_type":"source_capture","url":"https://example.com","status":"$status"}""",
            etag = "etag",
            createdAt = 1,
            updatedAt = 2,
        )
}
