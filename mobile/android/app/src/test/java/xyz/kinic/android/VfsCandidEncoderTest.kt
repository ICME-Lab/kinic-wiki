// Where: mobile/android/app/src/test/java/xyz/kinic/android/VfsCandidEncoderTest.kt
// What: Unit tests for minimal VFS Candid encoding.
// Why: Raw canister calls need stable byte payloads before Android transport is wired.

package xyz.kinic.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.URI
import java.time.Instant
import java.util.UUID

class VfsCandidEncoderTest {
    @Test
    fun encodesEmptyArgs() {
        assertEquals("4449444c0000", VfsCandidEncoder.empty().toHex())
    }

    @Test
    fun encodesReadNodeTextArgs() {
        assertEquals("4449444c00027171026462012f", VfsCandidEncoder.readNode("db", "/").toHex())
    }

    @Test
    fun encodesWriteNodesRequest() {
        val request = SourceCaptureRequestBuilder.request(
            url = URI("https://example.com/page"),
            databaseId = "db_demo",
            requestedBy = "aaaaa-aa",
            now = Instant.ofEpochSecond(1_700_000_000),
            uuid = UUID.fromString("00000000-0000-4000-8000-000000000000"),
        )
        val encoded = VfsCandidEncoder.writeNodes(request)

        assertTrue(encoded.isNotEmpty())
        assertEquals("4449444c", encoded.take(4).toByteArray().toHex())
    }

    private fun ByteArray.toHex(): String =
        joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
}
