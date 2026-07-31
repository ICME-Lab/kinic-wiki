package xyz.kinic.android

import java.time.Instant
import java.util.UUID

enum class AskAiMessageRole { USER, ASSISTANT }
enum class AskAiMessageState { COMPLETE, GENERATING, INSUFFICIENT, FAILED }
enum class AskAiTraceStage { SEARCHING, FOUND, READING, VERIFYING, GENERATING }

data class AskAiSource(
    val id: String,
    val path: String,
    val excerpt: String,
    val score: Float,
    val matchReasons: List<String>,
)

data class AskAiTraceEvent(
    val id: String = UUID.randomUUID().toString(),
    val stage: AskAiTraceStage,
    val title: String,
    val detail: String? = null,
    val isActive: Boolean = false,
)

data class AskAiMessage(
    val id: String = UUID.randomUUID().toString(),
    val role: AskAiMessageRole,
    val text: String,
    val state: AskAiMessageState = AskAiMessageState.COMPLETE,
    val sources: List<AskAiSource> = emptyList(),
    val trace: List<AskAiTraceEvent> = emptyList(),
    val createdAt: Instant = Instant.now(),
)

data class AskAiConversation(
    val id: String = UUID.randomUUID().toString(),
    val databaseId: String,
    val databaseTitle: String,
    val title: String = "New conversation",
    val messages: List<AskAiMessage> = emptyList(),
    val createdAt: Instant = Instant.now(),
    val updatedAt: Instant = Instant.now(),
)

data class AskAiQueryPlan(val queries: List<Query>) {
    data class Query(val text: String, val terms: List<String>)
}

data class AskAiContextSource(
    val source: AskAiSource,
    val content: String,
)

data class AskAiRetrievalResult(
    val searchQueries: List<String>,
    val sources: List<AskAiContextSource>,
)

sealed interface AskAiResponseOutcome {
    data class Supported(val sourceIds: List<String>, val answer: String) : AskAiResponseOutcome
    data object Insufficient : AskAiResponseOutcome
}

data class AskAiUiState(
    val conversations: List<AskAiConversation> = emptyList(),
    val currentConversation: AskAiConversation? = null,
    val draft: String = "",
    val isGenerating: Boolean = false,
    val isLoadingHistory: Boolean = true,
    val historyLoadError: String? = null,
    val errorMessage: String? = null,
    val pendingDatabaseId: String? = null,
    val pendingDatabaseTitle: String? = null,
) {
    val messages: List<AskAiMessage> get() = currentConversation?.messages.orEmpty()
}
