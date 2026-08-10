// Where: mobile/android/app/src/test/java/xyz/kinic/android/ShareInboxTest.kt
// What: Unit tests for the Android shared URL queue.
// Why: Share intents and app-side retries depend on durable, parseable pending records.

package xyz.kinic.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.URI
import java.nio.file.Files
import java.time.Instant

class ShareInboxTest {
    @Test
    fun enqueuesLoadsAndRemovesPendingUrls() {
        val directory = Files.createTempDirectory("kinic-share-inbox-test").toFile()
        try {
            val inbox = ShareInbox(directory)
            val item = inbox.enqueue(
                url = URI("https://example.com/page#section"),
                receivedAt = Instant.ofEpochSecond(1_700_000_000),
                requestId = "1700000000000-00000000-0000-4000-8000-000000000000",
                databaseId = " db_demo ",
            )

            val loaded = inbox.loadPendingUrls()
            assertEquals(listOf(item.copy(databaseId = "db_demo")), loaded)
            assertEquals("https://example.com/page", loaded.single().url.toString())

            inbox.remove(loaded.single())
            assertTrue(inbox.loadPendingUrls().isEmpty())
        } finally {
            directory.deleteRecursively()
        }
    }
}
