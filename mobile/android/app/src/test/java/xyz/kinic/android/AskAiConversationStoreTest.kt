package xyz.kinic.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class AskAiConversationStoreTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    @Test
    fun storesConversationsAtomicallyPerPrincipalScope() {
        val factory = AskAiConversationStoreFactory(temporaryFolder.root)
        val first = factory.create("aaaaa-aa")
        val second = factory.create("bbbbb-bb")
        val conversation = AskAiConversation(databaseId = "db", databaseTitle = "Database")

        first.save(listOf(conversation))

        assertEquals(listOf(conversation), first.load())
        assertTrue(second.load().isEmpty())
        assertNotEquals(
            first.javaClass.getDeclaredField("file").also { it.isAccessible = true }.get(first),
            second.javaClass.getDeclaredField("file").also { it.isAccessible = true }.get(second),
        )
    }

    @Test
    fun quarantinesCorruptHistoryAndCanResetArchives() {
        val scope = "principal-test"
        val file = File(temporaryFolder.root, "$scope/conversations-v1.json")
        val corrupt = File(temporaryFolder.root, "Corrupt")
        requireNotNull(file.parentFile).mkdirs()
        file.writeText("{broken")
        val store = AskAiConversationStore(file, corrupt)

        assertTrue(runCatching(store::load).isFailure)
        store.resetAfterLoadFailure()

        assertFalse(file.exists())
        assertTrue(corrupt.listFiles().orEmpty().single().name.startsWith("$scope-conversations-v1.corrupt-"))
        assertTrue(store.hasStoredData())
        store.deleteAllStoredData()
        assertFalse(store.hasStoredData())
    }
}
