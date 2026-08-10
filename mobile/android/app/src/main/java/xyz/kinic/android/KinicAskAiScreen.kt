package xyz.kinic.android

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AskAiScreen(state: KinicAppUiState, viewModel: AskAiViewModel) {
    val askState by viewModel.uiState.collectAsStateWithLifecycle()
    var showHistory by remember { mutableStateOf(false) }
    Column(modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = KinicDesign.ScreenPadding, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(modifier = Modifier.weight(1f)) {
                DatabaseDropdown(
                    entries = state.browseDatabases,
                    selectedId = askState.currentConversation?.databaseId.orEmpty(),
                    onSelect = viewModel::requestDatabaseChange,
                    label = "Knowledge database",
                )
            }
            IconButton(onClick = { showHistory = true }) {
                Icon(Icons.Outlined.History, contentDescription = "History")
            }
            IconButton(onClick = viewModel::startNewConversation) {
                Icon(Icons.Outlined.Add, contentDescription = "New conversation")
            }
        }
        askState.historyLoadError?.let { error ->
            Column(modifier = Modifier.padding(horizontal = KinicDesign.ScreenPadding)) {
                Text(error, color = MaterialTheme.colorScheme.error)
                TextButton(onClick = viewModel::resetHistory) { Text("Reset history") }
            }
        }
        LazyColumn(modifier = Modifier.weight(1f).fillMaxWidth()) {
            if (askState.messages.isEmpty()) {
                item {
                    AskAiEmptyState(
                        databaseTitle = askState.currentConversation?.databaseTitle
                            ?: state.browseDatabases.firstOrNull {
                                it.summary.databaseId == state.selectedBrowseDatabaseId
                            }?.summary?.displayTitle
                            ?: "this database",
                        onSuggestion = viewModel::setDraft,
                    )
                }
            }
            items(askState.messages, key = AskAiMessage::id) { message ->
                AskAiMessageRow(message, viewModel)
            }
        }
        askState.errorMessage?.let {
            Text(
                it,
                modifier = Modifier.padding(horizontal = KinicDesign.ScreenPadding, vertical = 6.dp),
                color = MaterialTheme.colorScheme.error,
            )
        }
        Surface(color = MaterialTheme.colorScheme.surfaceVariant) {
            Column(
                modifier = Modifier.fillMaxWidth().padding(horizontal = KinicDesign.ScreenPadding, vertical = 10.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                OutlinedTextField(
                    value = askState.draft,
                    onValueChange = viewModel::setDraft,
                    modifier = Modifier.fillMaxWidth(),
                    placeholder = { Text("Ask a question") },
                    enabled = !askState.isGenerating,
                    maxLines = 5,
                    shape = KinicDesign.ControlShape,
                    trailingIcon = {
                        IconButton(
                            onClick = if (askState.isGenerating) viewModel::cancel else viewModel::send,
                            enabled = askState.isGenerating || (
                                askState.draft.isNotBlank() && askState.currentConversation != null
                                ),
                        ) {
                            Icon(
                                if (askState.isGenerating) Icons.Outlined.Close else Icons.AutoMirrored.Outlined.Send,
                                contentDescription = if (askState.isGenerating) "Stop generating" else "Send",
                                tint = MaterialTheme.colorScheme.primary,
                            )
                        }
                    },
                )
                Text(
                    "${askState.draft.length} / ${AskAiQueryPlanner.MAXIMUM_QUESTION_CHARACTERS} characters",
                    modifier = Modifier.fillMaxWidth(),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.End,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Icon(Icons.Outlined.Lock, contentDescription = null, modifier = Modifier.size(16.dp))
                    Text(
                        "Your question and relevant notes are sent to Kinic AI, then deleted after processing.",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
    if (showHistory) {
        ModalBottomSheet(onDismissRequest = { showHistory = false }) {
            Column(
                modifier = Modifier.fillMaxWidth().padding(horizontal = KinicDesign.ScreenPadding).padding(bottom = 32.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Text("Conversation history", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                if (askState.conversations.isEmpty()) {
                    Text(
                        "No saved conversations.",
                        modifier = Modifier.padding(vertical = 24.dp),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                askState.conversations.forEach { conversation ->
                    Row(
                        modifier = Modifier.fillMaxWidth().clickable {
                            viewModel.selectConversation(conversation.id)
                            showHistory = false
                        }.padding(vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text(conversation.title, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(
                                conversation.databaseTitle,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        IconButton(onClick = { viewModel.deleteConversation(conversation.id) }) {
                            Icon(Icons.Outlined.Delete, contentDescription = "Delete conversation")
                        }
                    }
                    HorizontalDivider()
                }
            }
        }
    }
    if (askState.pendingDatabaseId != null) {
        AlertDialog(
            onDismissRequest = viewModel::dismissDatabaseChange,
            title = { Text("Change database?") },
            text = { Text("A new conversation will use ${askState.pendingDatabaseTitle}.") },
            confirmButton = { Button(onClick = viewModel::confirmDatabaseChange) { Text("New conversation") } },
            dismissButton = { TextButton(onClick = viewModel::dismissDatabaseChange) { Text("Cancel") } },
        )
    }
}

@Composable
private fun AskAiEmptyState(databaseTitle: String, onSuggestion: (String) -> Unit) {
    val suggestions = listOf(
        "Summarize the main ideas in this database",
        "What decisions have been recorded recently?",
        "Find notes that disagree with each other",
    )
    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = KinicDesign.ScreenPadding, vertical = 36.dp),
        verticalArrangement = Arrangement.spacedBy(22.dp),
    ) {
        Box(contentAlignment = Alignment.Center) {
            Surface(modifier = Modifier.size(72.dp), shape = CircleShape, color = MaterialTheme.colorScheme.primaryContainer) {}
            Surface(
                modifier = Modifier.size(44.dp),
                shape = CircleShape,
                color = Color.Transparent,
                border = androidx.compose.foundation.BorderStroke(2.dp, MaterialTheme.colorScheme.primary),
            ) {}
            Surface(modifier = Modifier.size(12.dp), shape = CircleShape, color = MaterialTheme.colorScheme.primary) {}
        }
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Ask your memory", style = MaterialTheme.typography.headlineLarge, fontWeight = FontWeight.Bold)
            Text(
                "Kinic AI searches $databaseTitle and answers only when it finds supporting notes.",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        suggestions.forEach { suggestion ->
            Surface(
                modifier = Modifier.fillMaxWidth().clickable { onSuggestion(suggestion) },
                shape = KinicDesign.ControlShape,
                color = MaterialTheme.colorScheme.surfaceVariant,
            ) {
                Row(modifier = Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(suggestion, modifier = Modifier.weight(1f))
                    Icon(Icons.Outlined.ChevronRight, contentDescription = null)
                }
            }
        }
    }
}

@Composable
private fun AskAiMessageRow(message: AskAiMessage, viewModel: AskAiViewModel) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = if (message.role == AskAiMessageRole.USER) {
            MaterialTheme.colorScheme.surfaceVariant
        } else {
            MaterialTheme.colorScheme.surface
        },
    ) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(horizontal = KinicDesign.ScreenPadding, vertical = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(
                    if (message.role == AskAiMessageRole.USER) Icons.Outlined.Person else Icons.Outlined.AutoAwesome,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary,
                )
                Text(
                    if (message.role == AskAiMessageRole.USER) "You" else "Kinic AI",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                )
            }
            SelectionContainer { Text(message.text.ifBlank { "Working..." }) }
            message.trace.forEach { trace ->
                Text(
                    "${if (trace.isActive) "• " else ""}${trace.title}" + trace.detail?.let { ": $it" }.orEmpty(),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            message.sources.forEach { source ->
                TextButton(onClick = { viewModel.openSource(source) }) { Text("${source.id}  ${source.path}") }
                if (source.excerpt.isNotBlank()) {
                    Text(
                        source.excerpt,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 3,
                    )
                }
            }
        }
    }
}
