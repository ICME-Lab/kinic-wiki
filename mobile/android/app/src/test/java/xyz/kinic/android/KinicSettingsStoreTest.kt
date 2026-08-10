// Where: mobile/android/app/src/test/java/xyz/kinic/android/KinicSettingsStoreTest.kt
// What: JVM tests for app-private Android settings persistence.
// Why: Browse and source capture share the selected database across app launches.

package xyz.kinic.android

import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File
import java.nio.file.Files

class KinicSettingsStoreTest {
    @Test
    fun selectedDatabasesDefaultToEmptyAndPersistTrimmedValues() {
        val directory = Files.createTempDirectory("kinic-settings-test").toFile()
        try {
            val file = File(directory, "settings.json")
            val store = KinicSettingsStore(file)

            assertEquals("", store.selectedDatabaseId)
            assertEquals("", store.selectedBrowseDatabaseId)

            store.selectedDatabaseId = " db_capture "
            store.selectedBrowseDatabaseId = " db_browse "
            val restored = KinicSettingsStore(file)

            assertEquals("db_capture", restored.selectedDatabaseId)
            assertEquals("db_browse", restored.selectedBrowseDatabaseId)
        } finally {
            directory.deleteRecursively()
        }
    }
}
