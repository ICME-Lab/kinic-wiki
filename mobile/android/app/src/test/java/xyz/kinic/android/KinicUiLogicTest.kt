// Where: mobile/android/app/src/test/java/xyz/kinic/android/KinicUiLogicTest.kt
// What: JVM tests for non-Compose Kinic UI decision helpers.
// Why: Browse and submit flows should handle restored selections and async failures deterministically.

package xyz.kinic.android

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class KinicUiLogicTest {
    @Test
    fun resolvesManualDatabaseWhenSelectedDatabaseIsMissing() = runBlocking {
        val writer = database("db_writer", DatabaseRole.WRITER)

        val resolved = resolveSubmitDatabase(
            selectedDatabase = null,
            databaseId = " db_writer ",
            onResolveDatabase = { databaseId ->
                assertEquals("db_writer", databaseId)
                writer
            },
        )

        assertEquals(writer, resolved)
    }

    @Test
    fun keepsSelectedDatabaseWithoutCallingResolver() = runBlocking {
        val selected = database("db_selected", DatabaseRole.OWNER)
        var resolverCalled = false

        val resolved = resolveSubmitDatabase(
            selectedDatabase = selected,
            databaseId = "db_other",
            onResolveDatabase = {
                resolverCalled = true
                null
            },
        )

        assertEquals(selected, resolved)
        assertFalse(resolverCalled)
    }

    @Test
    fun unresolvedManualDatabaseReturnsNull() = runBlocking {
        val resolved = resolveSubmitDatabase(
            selectedDatabase = null,
            databaseId = "db_missing",
            onResolveDatabase = { null },
        )

        assertNull(resolved)
    }

    @Test
    fun rootChildrenFailureReturnsMessageWithoutClearingExistingBrowseState() = runBlocking {
        val outcome = refreshBrowseRoot(
            currentDatabaseId = "db_writer",
            onRefreshDatabases = { listOf(database("db_writer", DatabaseRole.WRITER)) },
            onListChildren = { _, _ -> throw IllegalStateException("root failed") },
        )

        assertNull(outcome.databases)
        assertNull(outcome.childNodes)
        assertEquals("root failed", outcome.message)
        assertFalse(outcome.clearBrowse)
    }

    @Test
    fun emptyDatabaseRefreshClearsBrowseState() = runBlocking {
        val outcome = refreshBrowseRoot(
            currentDatabaseId = "db_writer",
            onRefreshDatabases = { emptyList() },
            onListChildren = { _, _ -> error("should not load children") },
        )

        assertEquals(emptyList<DatabaseSummary>(), outcome.databases)
        assertNull(outcome.selectedDatabase)
        assertEquals(emptyList<ChildNode>(), outcome.childNodes)
        assertEquals("No readable databases.", outcome.message)
        assertEquals(true, outcome.clearBrowse)
    }
}

private fun database(databaseId: String, role: DatabaseRole): DatabaseSummary =
    DatabaseSummary(
        databaseId = databaseId,
        title = databaseId,
        description = "",
        metadata = null,
        role = role,
        status = DatabaseStatus.ACTIVE,
        logicalSizeBytes = 0uL,
        cyclesBalance = null,
        cyclesSuspendedAtMs = null,
        deletedAtMs = null,
    )
