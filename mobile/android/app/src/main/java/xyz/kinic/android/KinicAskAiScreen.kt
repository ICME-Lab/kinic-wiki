package xyz.kinic.android

import androidx.compose.foundation.background
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.ArrowDropDown
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
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
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AskAiScreen(
    state: KinicAppUiState,
    viewModel: AskAiViewModel,
    showHistory: Boolean,
    onShowHistoryChange: (Boolean) -> Unit,
    uiStateOverride: AskAiUiState? = null,
) {
    val liveAskState by viewModel.uiState.collectAsStateWithLifecycle()
    val askState = uiStateOverride ?: liveAskState
    Column(modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
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
                        hasConversation = askState.currentConversation != null,
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
        Surface(color = MaterialTheme.colorScheme.surface.copy(alpha = 0.96f)) {
            Column(
                modifier = Modifier.fillMaxWidth().padding(horizontal = KinicDesign.ScreenPadding, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                AskAiComposerField(askState = askState, viewModel = viewModel)
                Text(
                    "${askState.draft.length} / ${AskAiQueryPlanner.MAXIMUM_QUESTION_CHARACTERS} characters",
                    modifier = Modifier.fillMaxWidth(),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.End,
                )
            }
        }
    }
    if (showHistory) {
        ModalBottomSheet(onDismissRequest = { onShowHistoryChange(false) }) {
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
                            onShowHistoryChange(false)
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
private fun AskAiComposerField(askState: AskAiUiState, viewModel: AskAiViewModel) {
    val canSend = askState.draft.isNotBlank() && askState.currentConversation != null
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = KinicDesign.PanelShape,
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.72f),
        border = BorderStroke(0.5.dp, MaterialTheme.colorScheme.outline),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(start = 14.dp, end = 6.dp, top = 6.dp, bottom = 6.dp),
            verticalAlignment = Alignment.Bottom,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Box(modifier = Modifier.weight(1f).padding(vertical = 8.dp)) {
                if (askState.draft.isEmpty()) {
                    Text("Message Kinic AI", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                BasicTextField(
                    value = askState.draft,
                    onValueChange = viewModel::setDraft,
                    enabled = !askState.isGenerating,
                    modifier = Modifier.fillMaxWidth(),
                    textStyle = MaterialTheme.typography.bodyLarge.copy(color = MaterialTheme.colorScheme.onSurface),
                    cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                    maxLines = 5,
                )
            }
            IconButton(
                onClick = if (askState.isGenerating) viewModel::cancel else viewModel::send,
                enabled = askState.isGenerating || canSend,
                modifier = Modifier.size(KinicDesign.MinimumTouchTarget),
            ) {
                Icon(
                    if (askState.isGenerating) Icons.Outlined.Close else Icons.AutoMirrored.Outlined.Send,
                    contentDescription = if (askState.isGenerating) "Stop generating" else "Send",
                    tint = if (askState.isGenerating || canSend) {
                        MaterialTheme.colorScheme.primary
                    } else {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    },
                )
            }
        }
    }
}

@Composable
private fun AskAiEmptyState(hasConversation: Boolean, databaseTitle: String, onSuggestion: (String) -> Unit) {
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
            Text(
                if (hasConversation) "Ask your memory" else "Select a database",
                style = MaterialTheme.typography.headlineLarge,
                fontWeight = FontWeight.Bold,
            )
            Text(
                if (hasConversation) {
                    "Kinic AI can chat normally and searches $databaseTitle when your question needs supporting notes."
                } else {
                    "Choose a database with Select DB above to start chatting."
                },
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (hasConversation) {
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
                if (message.role == AskAiMessageRole.USER) {
                    Icon(
                        Icons.Outlined.Person,
                        contentDescription = null,
                        modifier = Modifier.size(24.dp),
                        tint = MaterialTheme.colorScheme.primary,
                    )
                } else {
                    Image(
                        painter = painterResource(R.drawable.kinic_mark),
                        contentDescription = null,
                        modifier = Modifier.size(24.dp),
                    )
                }
                Text(
                    if (message.role == AskAiMessageRole.USER) "You" else "Kinic AI",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                )
            }
            if (
                message.role == AskAiMessageRole.ASSISTANT &&
                message.trace.isNotEmpty() &&
                (message.state == AskAiMessageState.GENERATING || message.trace.any { it.stage == AskAiTraceStage.FOUND })
            ) {
                AskAiTraceCard(message.trace)
            }
            if (message.role == AskAiMessageRole.ASSISTANT) {
                when (message.state) {
                    AskAiMessageState.COMPLETE,
                    AskAiMessageState.GENERATING,
                    -> KinicMarkdown(message.text.ifBlank { "Working..." })
                    AskAiMessageState.INSUFFICIENT -> Text(
                        message.text,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    AskAiMessageState.FAILED -> Text(message.text, color = MaterialTheme.colorScheme.error)
                }
            } else {
                SelectionContainer { Text(message.text) }
            }
            if (message.sources.isNotEmpty()) {
                AskAiSources(message, viewModel)
            }
        }
    }
}

@Composable
private fun AskAiTraceCard(events: List<AskAiTraceEvent>) {
    val active = events.lastOrNull { it.isActive }
    if (active != null) {
        Text(
            active.title,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        return
    }
    var expanded by remember(events) { mutableStateOf(false) }
    Surface(
        modifier = Modifier.fillMaxWidth().clickable { expanded = !expanded },
        shape = KinicDesign.ControlShape,
        color = KinicDesign.PalePink.copy(alpha = 0.35f),
    ) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "✦  How this answer was found",
                    modifier = Modifier.weight(1f),
                    color = KinicDesign.ElectricIndigo,
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Bold,
                )
                Icon(
                    Icons.Outlined.ArrowDropDown,
                    contentDescription = if (expanded) "Hide search details" else "Show search details",
                    tint = MaterialTheme.colorScheme.primary,
                )
            }
            if (expanded) {
                events.forEach { event ->
                    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(event.title, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold)
                        event.detail?.let {
                            Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun AskAiSources(message: AskAiMessage, viewModel: AskAiViewModel) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(
            if (message.state == AskAiMessageState.INSUFFICIENT) "Possible sources" else "Sources cited by Kinic AI",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            message.sources.forEachIndexed { index, source ->
                Surface(
                    modifier = Modifier.clickable { viewModel.openSource(source) },
                    shape = RoundedCornerShape(50),
                    color = KinicDesign.PalePink.copy(alpha = 0.28f),
                ) {
                    Text(
                        "[${index + 1}] ${source.path.substringAfterLast('/')}",
                        modifier = Modifier.padding(horizontal = 10.dp, vertical = 12.dp),
                        color = KinicDesign.ElectricIndigo,
                        style = MaterialTheme.typography.bodySmall,
                        maxLines = 2,
                    )
                }
            }
        }
    }
}
