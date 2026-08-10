package xyz.kinic.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.URI

class KinicAppViewModelTest {
    @Test
    fun mergeBrowseDatabasesTracksOriginsAndVisibility() {
        val public = database("public", DatabaseRole.READER)
        val purchased = database("purchased", DatabaseRole.READER)
        val writer = database("writer", DatabaseRole.WRITER)

        val hiddenPurchased = KinicAppViewModel.mergeBrowseDatabases(
            memberDatabases = listOf(purchased, writer),
            publicDatabases = listOf(public),
            purchasedDatabaseIds = setOf("purchased"),
            purchasedLookupSucceeded = true,
            showPublic = true,
            showPurchased = false,
            directDatabaseIds = setOf("direct"),
        )

        assertEquals(setOf("direct", "public", "writer"), hiddenPurchased.mapTo(mutableSetOf()) { it.summary.databaseId })
        assertTrue(hiddenPurchased.single { it.summary.databaseId == "public" }.origins.contains(BrowseDatabaseOrigin.PUBLIC))
        assertTrue(hiddenPurchased.single { it.summary.databaseId == "direct" }.origins.contains(BrowseDatabaseOrigin.DIRECT))

        val visiblePurchased = KinicAppViewModel.mergeBrowseDatabases(
            memberDatabases = listOf(purchased, writer),
            publicDatabases = listOf(public),
            purchasedDatabaseIds = setOf("purchased"),
            purchasedLookupSucceeded = true,
            showPublic = false,
            showPurchased = true,
            directDatabaseIds = emptySet(),
        )

        val purchasedEntry = visiblePurchased.single { it.summary.databaseId == "purchased" }
        assertTrue(BrowseDatabaseOrigin.MEMBER in purchasedEntry.origins)
        assertTrue(BrowseDatabaseOrigin.PURCHASED in purchasedEntry.origins)
        assertFalse(visiblePurchased.any { it.summary.databaseId == "public" })
    }

    @Test
    fun validatesDatabaseNamesLikeIos() {
        assertEquals("Database name is required.", KinicAppViewModel.databaseNameError(" "))
        assertEquals("Database name must be 1..80 characters.", KinicAppViewModel.databaseNameError("x".repeat(81)))
        assertEquals(
            "Database name may not contain control characters.",
            KinicAppViewModel.databaseNameError("bad\u0001name"),
        )
        assertNull(KinicAppViewModel.databaseNameError("Team knowledge"))
    }

    @Test
    fun manageIncludesWritablePendingButBrowseDoesNot() {
        val activeWriter = database("active", DatabaseRole.WRITER)
        val pendingOwner = database("pending", DatabaseRole.OWNER, DatabaseStatus.PENDING)
        val pendingReader = database("pending-reader", DatabaseRole.READER, DatabaseStatus.PENDING)
        val deletedOwner = database("deleted", DatabaseRole.OWNER, DatabaseStatus.DELETED)
        val state = KinicAppUiState(
            memberDatabases = listOf(activeWriter, pendingOwner, pendingReader, deletedOwner),
        )

        assertEquals(
            setOf("active", "pending"),
            KinicAppViewModel.manageableDatabases(state).mapTo(mutableSetOf(), DatabaseSummary::databaseId),
        )
        assertFalse(pendingOwner.canRead)
        assertFalse(pendingOwner.canWrite)
        assertTrue(activeWriter.canRead)
        assertTrue(activeWriter.canWrite)
    }

    @Test
    fun pendingFundingUrlCarriesStatusAndEncodesDatabaseId() {
        assertEquals(
            "https://wiki.kinic.xyz/cycles?database_id=db%20pending&status=pending",
            KinicAppViewModel.fundingUri(URI("https://wiki.kinic.xyz"), "db pending", pending = true).toString(),
        )
    }

    private fun database(
        id: String,
        role: DatabaseRole,
        status: DatabaseStatus = DatabaseStatus.ACTIVE,
    ): DatabaseSummary =
        DatabaseSummary(
            databaseId = id,
            title = id,
            description = "",
            metadata = null,
            role = role,
            status = status,
            logicalSizeBytes = 0uL,
            cyclesBalance = null,
            cyclesSuspendedAtMs = null,
            deletedAtMs = null,
        )
}
