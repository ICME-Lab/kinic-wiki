package xyz.kinic.android

import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withContext
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import xyz.kinic.android.ic.IcAuthSession
import xyz.kinic.android.ic.IcDelegationChain
import java.io.File
import java.nio.file.Files

@OptIn(ExperimentalCoroutinesApi::class)
class AskAiViewModelTest {
    private val dispatcher = StandardTestDispatcher()

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun createsInitialConversationWhenDatabasesArrive() = runTest(dispatcher) {
        val provider = FakeKnowledgeProvider(KinicAppUiState(isLoadingDatabases = true))
        val fixture = viewModelFixture(provider, ImmediateAskAiClient())
        try {
            runCurrent()
            assertNull(fixture.viewModel.uiState.value.currentConversation)

            provider.state.value = provider.state.value.copy(
                browseDatabases = listOf(databaseEntry("public")),
                selectedBrowseDatabaseId = "public",
            )
            runCurrent()
            assertNull(fixture.viewModel.uiState.value.currentConversation)

            provider.state.value = provider.state.value.copy(isLoadingDatabases = false)
            runCurrent()

            assertEquals("public", fixture.viewModel.uiState.value.currentConversation?.databaseId)
            assertFalse(fixture.viewModel.uiState.value.isLoadingHistory)
        } finally {
            fixture.close()
        }
    }

    @Test
    fun principalSwitchDiscardsInFlightGenerationResult() = runTest(dispatcher) {
        val database = databaseEntry("member")
        val provider = FakeKnowledgeProvider(
            KinicAppUiState(
                session = askAiSession("principal-a"),
                browseDatabases = listOf(database),
                selectedBrowseDatabaseId = "member",
            ),
        )
        val client = DeferredAskAiClient()
        val fixture = viewModelFixture(provider, client)
        try {
            runCurrent()
            fixture.viewModel.setDraft("What is stored?")
            fixture.viewModel.send()
            runCurrent()
            assertNotNull(fixture.viewModel.uiState.value.currentConversation)

            provider.state.value = provider.state.value.copy(
                session = askAiSession("principal-b"),
            )
            runCurrent()
            val principalBConversation = fixture.viewModel.uiState.value.currentConversation
            assertNotNull(principalBConversation)

            client.queryResult.complete("<answer>stored knowledge</answer>")
            runCurrent()

            val state = fixture.viewModel.uiState.value
            assertEquals(principalBConversation?.id, state.currentConversation?.id)
            assertEquals(emptyList<AskAiMessage>(), state.currentConversation?.messages)
            assertFalse(state.isGenerating)
        } finally {
            fixture.close()
        }
    }

    private fun viewModelFixture(
        provider: AskAiKnowledgeProvider,
        client: AskAiCompleting,
    ): ViewModelFixture {
        val directory = Files.createTempDirectory("ask-ai-view-model-test").toFile()
        val viewModelStore = ViewModelStore()
        val factory = AskAiViewModelFactory(client, provider, AskAiConversationStoreFactory(directory))
        val viewModel = ViewModelProvider.create(viewModelStore, factory)[AskAiViewModel::class.java]
        return ViewModelFixture(viewModel, viewModelStore, directory)
    }

    private fun databaseEntry(id: String): BrowseDatabaseEntry =
        BrowseDatabaseEntry(
            summary = DatabaseSummary(
                databaseId = id,
                title = id,
                description = "",
                metadata = null,
                role = DatabaseRole.READER,
                status = DatabaseStatus.ACTIVE,
                logicalSizeBytes = 0uL,
                cyclesBalance = null,
                cyclesSuspendedAtMs = null,
                deletedAtMs = null,
            ),
            origins = setOf(BrowseDatabaseOrigin.PUBLIC),
        )
}

private data class ViewModelFixture(
    val viewModel: AskAiViewModel,
    private val store: ViewModelStore,
    private val directory: File,
) {
    fun close() {
        store.clear()
        directory.deleteRecursively()
    }
}

private class FakeKnowledgeProvider(initial: KinicAppUiState) : AskAiKnowledgeProvider {
    val state = MutableStateFlow(initial)
    override val appState = state

    override suspend fun retrieve(databaseId: String, plan: AskAiQueryPlan): AskAiRetrievalResult =
        AskAiRetrievalResult(plan.queries.map { it.text }, emptyList())

    override fun openSource(databaseId: String, path: String) = Unit
}

private class ImmediateAskAiClient : AskAiCompleting {
    override suspend fun completeContent(message: String, timeoutMilliseconds: Long): String =
        error("not expected")
}

private class DeferredAskAiClient : AskAiCompleting {
    val queryResult = CompletableDeferred<String>()

    override suspend fun completeContent(message: String, timeoutMilliseconds: Long): String =
        withContext(NonCancellable) { queryResult.await() }
}

private fun askAiSession(principal: String): IcAuthSession =
    IcAuthSession(
        principal = principal,
        canisterId = "canister",
        identityProvider = "https://identity.example",
        derivationOrigin = "https://derivation.example",
        sessionPublicKey = byteArrayOf(1),
        sessionPrivateKey = byteArrayOf(2),
        delegation = IcDelegationChain(byteArrayOf(3), emptyList()),
    )
