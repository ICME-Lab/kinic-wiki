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
    fun encodesListChildrenRecord() {
        assertEquals(
            "4449444c016c02a5cbc7d204719f9bbd940a710100012f026462",
            VfsCandidEncoder.listChildren("db", "/").toHex(),
        )
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

    @Test
    fun createDatabaseMatchesIosFixture() {
        assertEquals(
            "4449444c016c01cbe4fdc7047101000b5465616d20736b696c6c73",
            VfsCandidEncoder.createDatabase("Team skills").toHex(),
        )
    }

    @Test
    fun updateMetadataMatchesIosFixture() {
        assertEquals(
            "4449444c026e716c0594d7ab4500cbe4fdc70471fc91f4f805719f9bbd940a718eed9d890f71010100075465616d204442105465616d206465736372697074696f6e0764625f64656d6f155b227377696674222c22e697a5e69cace8aa9e225d",
            VfsCandidEncoder.updateDatabaseMetadata(
                databaseId = "db_demo",
                name = "Team DB",
                description = "Team description",
                llmSummary = null,
                tagsJson = "[\"swift\",\"日本語\"]",
            ).toHex(),
        )
    }

    @Test
    fun encodesSearchManageAndMarketRequests() {
        val search = VfsCandidEncoder.searchNodes("db_demo", "swift auth", null, 20u)
        assertTrue(search.containsUtf8("db_demo"))
        assertTrue(search.containsUtf8("swift auth"))

        val grant = VfsCandidEncoder.grantDatabaseAccess("db_demo", "aaaaa-aa", DatabaseRole.WRITER)
        assertTrue(grant.containsUtf8("db_demo"))
        assertTrue(grant.containsUtf8("aaaaa-aa"))

        val cycleEntries = VfsCandidEncoder.listDatabaseCycleEntries("db_demo", 12uL, 20u)
        assertTrue(cycleEntries.containsUtf8("db_demo"))
        assertEquals("14000000", cycleEntries.takeLast(4).toByteArray().toHex())

        val entitlements = VfsCandidEncoder.marketListEntitlements(null, 100u)
        assertEquals("0064000000", entitlements.takeLast(5).toByteArray().toHex())
    }

    private fun ByteArray.toHex(): String =
        joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }

    private fun ByteArray.containsUtf8(value: String): Boolean {
        val needle = value.encodeToByteArray()
        return indices.any { start ->
            start + needle.size <= size && copyOfRange(start, start + needle.size).contentEquals(needle)
        }
    }
}
