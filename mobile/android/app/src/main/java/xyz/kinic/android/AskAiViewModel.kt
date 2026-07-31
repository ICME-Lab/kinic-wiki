package xyz.kinic.android

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.time.Instant

interface AskAiKnowledgeProvider {
    val appState: StateFlow<KinicAppUiState>
    suspend fun retrieve(databaseId: String, plan: AskAiQueryPlan): AskAiRetrievalResult
    fun openSource(databaseId: String, path: String)
}

class AskAiViewModel(
    private val client: AskAiCompleting,
    private val knowledgeProvider: AskAiKnowledgeProvider,
    private val storeFactory: AskAiConversationStoreFactory,
) : ViewModel() {
    private val _uiState = MutableStateFlow(AskAiUiState())
    val uiState: StateFlow<AskAiUiState> = _uiState.asStateFlow()
    private var store = storeFactory.create(knowledgeProvider.appState.value.session?.principal)
    private var generationJob: Job? = null

    init {
        viewModelScope.launch {
            knowledgeProvider.appState.map { it.session?.principal }.distinctUntilChanged().collect {
                store = storeFactory.create(it)
                loadHistory()
            }
        }
    }

    fun setDraft(value: String) {
        _uiState.update { it.copy(draft = value.take(AskAiQueryPlanner.MAXIMUM_QUESTION_CHARACTERS)) }
    }

    fun startNewConversation(databaseId: String? = null) {
        val database = databases().firstOrNull { it.summary.databaseId == databaseId }
            ?: selectedDatabase()
            ?: databases().firstOrNull()
        if (database == null) {
            _uiState.update { it.copy(errorMessage = "Select a readable database first.") }
            return
        }
        val conversation = AskAiConversation(
            databaseId = database.summary.databaseId,
            databaseTitle = database.summary.displayTitle,
        )
        val updated = listOf(conversation) + _uiState.value.conversations
        _uiState.update {
            it.copy(conversations = updated, currentConversation = conversation, draft = "", errorMessage = null)
        }
        persist()
    }

    fun selectConversation(id: String) {
        _uiState.value.conversations.firstOrNull { it.id == id }?.let { conversation ->
            _uiState.update { it.copy(currentConversation = conversation, errorMessage = null) }
        }
    }

    fun requestDatabaseChange(databaseId: String) {
        val database = databases().firstOrNull { it.summary.databaseId == databaseId } ?: return
        val current = _uiState.value.currentConversation
        if (current == null || current.messages.isEmpty()) {
            replaceConversationDatabase(database)
        } else if (current.databaseId != databaseId) {
            _uiState.update {
                it.copy(
                    pendingDatabaseId = databaseId,
                    pendingDatabaseTitle = database.summary.displayTitle,
                )
            }
        }
    }

    fun confirmDatabaseChange() {
        val databaseId = _uiState.value.pendingDatabaseId ?: return
        val database = databases().firstOrNull { it.summary.databaseId == databaseId } ?: return
        startNewConversation(database.summary.databaseId)
        _uiState.update { it.copy(pendingDatabaseId = null, pendingDatabaseTitle = null) }
    }

    fun dismissDatabaseChange() {
        _uiState.update { it.copy(pendingDatabaseId = null, pendingDatabaseTitle = null) }
    }

    fun deleteConversation(id: String) {
        val updated = _uiState.value.conversations.filterNot { it.id == id }
        _uiState.update {
            it.copy(
                conversations = updated,
                currentConversation = if (it.currentConversation?.id == id) updated.firstOrNull() else it.currentConversation,
            )
        }
        persist()
    }

    fun resetHistory() {
        runCatching {
            store.deleteAllStoredData()
            _uiState.value = AskAiUiState(isLoadingHistory = false)
            startNewConversation()
        }.onFailure(::showError)
    }

    fun cancel() {
        generationJob?.cancel()
        generationJob = null
        finalizeFailure("Generation cancelled.")
    }

    fun send() {
        if (generationJob?.isActive == true) return
        val question = _uiState.value.draft.trim()
        if (question.isBlank()) return
        var conversation = _uiState.value.currentConversation
        if (conversation == null) {
            startNewConversation()
            conversation = _uiState.value.currentConversation
        }
        val initial = conversation ?: return
        val history = initial.messages
        val user = AskAiMessage(role = AskAiMessageRole.USER, text = question)
        val assistant = AskAiMessage(
            role = AskAiMessageRole.ASSISTANT,
            text = "",
            state = AskAiMessageState.GENERATING,
            trace = listOf(activeTrace(AskAiTraceStage.SEARCHING, "Planning database search")),
        )
        replaceCurrent(
            initial.copy(
                title = if (history.isEmpty()) question.take(80) else initial.title,
                messages = history + user + assistant,
                updatedAt = Instant.now(),
            ),
        )
        _uiState.update { it.copy(draft = "", isGenerating = true, errorMessage = null) }

        generationJob = viewModelScope.launch {
            runCatching {
                val queryPrompt = AskAiQueryPlanner.buildPrompt(initial.databaseTitle, question, history)
                val queryResponse = client.completeContent(queryPrompt, QUERY_TIMEOUT_MS)
                val plan = AskAiQueryPlanner.parse(queryResponse)
                updateGeneratingTrace(
                    listOf(
                        completedTrace(AskAiTraceStage.SEARCHING, "Search plan", plan.queries.joinToString { it.text }),
                        activeTrace(AskAiTraceStage.READING, "Reading matching documents"),
                    ),
                )
                val retrieval = knowledgeProvider.retrieve(initial.databaseId, plan)
                updateGeneratingSources(retrieval.sources.map(AskAiContextSource::source))
                updateGeneratingTrace(
                    listOf(
                        completedTrace(
                            AskAiTraceStage.FOUND,
                            "Search results",
                            "${retrieval.sources.size} verified sources",
                        ),
                        completedTrace(AskAiTraceStage.VERIFYING, "Exact-token evidence verified"),
                        activeTrace(AskAiTraceStage.GENERATING, "Generating grounded answer"),
                    ),
                )
                val prompt = AskAiPromptBuilder.build(initial.databaseTitle, question, history, retrieval.sources)
                if (prompt.includedContexts.isEmpty()) return@runCatching AskAiResponseOutcome.Insufficient
                val response = client.completeContent(prompt.message, ANSWER_TIMEOUT_MS)
                AskAiResponseDecoder.decode(
                    response,
                    prompt.includedContexts.mapTo(mutableSetOf()) { it.source.id },
                )
            }.onSuccess(::finalizeSuccess)
                .onFailure { error ->
                    if (error !is kotlinx.coroutines.CancellationException) {
                        finalizeFailure(error.message ?: "Ask AI failed.")
                    }
                }
        }
    }

    fun openSource(source: AskAiSource) {
        val conversation = _uiState.value.currentConversation ?: return
        knowledgeProvider.openSource(conversation.databaseId, source.path)
    }

    private fun finalizeSuccess(outcome: AskAiResponseOutcome) {
        val current = _uiState.value.currentConversation ?: return
        val generating = current.messages.lastOrNull() ?: return
        val available = generating.sources
        val final = when (outcome) {
            AskAiResponseOutcome.Insufficient -> generating.copy(
                text = "The selected database does not contain enough evidence to answer.",
                state = AskAiMessageState.INSUFFICIENT,
                trace = generating.trace.map { it.copy(isActive = false) },
            )
            is AskAiResponseOutcome.Supported -> generating.copy(
                text = outcome.answer,
                state = AskAiMessageState.COMPLETE,
                sources = available.filter { it.id in outcome.sourceIds },
                trace = generating.trace.map { it.copy(isActive = false) },
            )
        }
        replaceCurrent(current.copy(messages = current.messages.dropLast(1) + final, updatedAt = Instant.now()))
        _uiState.update { it.copy(isGenerating = false) }
        persist()
    }

    private fun finalizeFailure(message: String) {
        val current = _uiState.value.currentConversation
        if (current != null && current.messages.lastOrNull()?.state == AskAiMessageState.GENERATING) {
            val failed = current.messages.last().copy(
                text = message,
                state = AskAiMessageState.FAILED,
                trace = current.messages.last().trace.map { it.copy(isActive = false) },
            )
            replaceCurrent(current.copy(messages = current.messages.dropLast(1) + failed, updatedAt = Instant.now()))
        }
        _uiState.update { it.copy(isGenerating = false, errorMessage = message) }
        persist()
    }

    private fun updateGeneratingTrace(trace: List<AskAiTraceEvent>) {
        val current = _uiState.value.currentConversation ?: return
        val assistant = current.messages.lastOrNull() ?: return
        replaceCurrent(
            current.copy(
                messages = current.messages.dropLast(1) + assistant.copy(
                    trace = trace,
                ),
            ),
        )
    }

    private fun updateGeneratingSources(sources: List<AskAiSource>) {
        val current = _uiState.value.currentConversation ?: return
        val assistant = current.messages.lastOrNull() ?: return
        replaceCurrent(
            current.copy(
                messages = current.messages.dropLast(1) + assistant.copy(sources = sources),
            ),
        )
    }

    private fun replaceConversationDatabase(database: BrowseDatabaseEntry) {
        val current = _uiState.value.currentConversation
        if (current == null) {
            startNewConversation(database.summary.databaseId)
        } else {
            replaceCurrent(
                current.copy(
                    databaseId = database.summary.databaseId,
                    databaseTitle = database.summary.displayTitle,
                    updatedAt = Instant.now(),
                ),
            )
            persist()
        }
    }

    private fun replaceCurrent(conversation: AskAiConversation) {
        val conversations = _uiState.value.conversations
        val updated = if (conversations.any { it.id == conversation.id }) {
            conversations.map { if (it.id == conversation.id) conversation else it }
        } else {
            listOf(conversation) + conversations
        }.sortedByDescending(AskAiConversation::updatedAt)
        _uiState.update { it.copy(conversations = updated, currentConversation = conversation) }
    }

    private fun loadHistory() {
        _uiState.update { it.copy(isLoadingHistory = true, historyLoadError = null) }
        runCatching { store.load() }
            .onSuccess { conversations ->
                _uiState.update {
                    it.copy(
                        conversations = conversations,
                        currentConversation = conversations.firstOrNull(),
                        isLoadingHistory = false,
                    )
                }
                if (conversations.isEmpty()) startNewConversation()
            }
            .onFailure { error ->
                runCatching { store.resetAfterLoadFailure() }
                _uiState.update {
                    it.copy(
                        conversations = emptyList(),
                        currentConversation = null,
                        isLoadingHistory = false,
                        historyLoadError = error.message ?: "Conversation history is corrupt.",
                    )
                }
            }
    }

    private fun persist() {
        runCatching { store.save(_uiState.value.conversations) }.onFailure(::showError)
    }

    private fun showError(error: Throwable) {
        _uiState.update { it.copy(errorMessage = error.message ?: "Ask AI failed.") }
    }

    private fun selectedDatabase(): BrowseDatabaseEntry? {
        val state = knowledgeProvider.appState.value
        return state.browseDatabases.firstOrNull { it.summary.databaseId == state.selectedBrowseDatabaseId }
    }

    private fun databases(): List<BrowseDatabaseEntry> =
        knowledgeProvider.appState.value.browseDatabases

    private fun activeTrace(stage: AskAiTraceStage, title: String, detail: String? = null) =
        AskAiTraceEvent(stage = stage, title = title, detail = detail, isActive = true)

    private fun completedTrace(stage: AskAiTraceStage, title: String, detail: String? = null) =
        AskAiTraceEvent(stage = stage, title = title, detail = detail)

    companion object {
        private const val QUERY_TIMEOUT_MS = 30_000L
        private const val ANSWER_TIMEOUT_MS = 90_000L
    }
}

class AskAiViewModelFactory(
    private val client: AskAiCompleting,
    private val knowledgeProvider: AskAiKnowledgeProvider,
    private val storeFactory: AskAiConversationStoreFactory,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        require(modelClass.isAssignableFrom(AskAiViewModel::class.java))
        return AskAiViewModel(client, knowledgeProvider, storeFactory) as T
    }
}
