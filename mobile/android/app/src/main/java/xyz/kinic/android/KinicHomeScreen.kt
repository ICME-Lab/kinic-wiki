package xyz.kinic.android

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ExitToApp
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Storage
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import androidx.compose.ui.unit.dp

@Composable
internal fun HomeScreen(state: KinicAppUiState, viewModel: KinicAppViewModel) {
    var createDialog by remember { mutableStateOf(false) }
    val writableDatabases = state.memberDatabases.filter { it.canWrite }
    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .padding(horizontal = KinicDesign.ScreenPadding),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(vertical = KinicDesign.ScreenPadding),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        item {
            KinicPanel(
                title = state.session?.principal?.let(::compactPrincipal) ?: "Not signed in",
                icon = Icons.Outlined.Person,
                trailing = if (state.session == null) null else {
                    {
                        IconButton(onClick = viewModel::signOut) {
                            Icon(Icons.AutoMirrored.Outlined.ExitToApp, contentDescription = "Sign out")
                        }
                    }
                },
            ) {
                if (state.session == null) {
                    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text(
                            "Internet Identity unlocks your writable databases.",
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Button(
                            onClick = viewModel::startSignIn,
                            modifier = Modifier.size(52.dp),
                            shape = CircleShape,
                            contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp),
                            colors = ButtonDefaults.buttonColors(
                                containerColor = MaterialTheme.colorScheme.onSurface,
                                contentColor = MaterialTheme.colorScheme.surface,
                            ),
                        ) {
                            Icon(Icons.Outlined.Person, contentDescription = "Sign in with Internet Identity")
                        }
                    }
                } else {
                    TextButton(onClick = viewModel::copyPrincipal) {
                        Icon(Icons.Outlined.ContentCopy, contentDescription = null)
                        Spacer(Modifier.width(8.dp))
                        Text("Copy principal")
                    }
                }
            }
        }
        item {
            KinicPanel(
                title = "Database",
                icon = Icons.Outlined.Storage,
                trailing = {
                    IconButton(onClick = { createDialog = true }, enabled = state.session != null) {
                        Icon(Icons.Outlined.Add, contentDescription = "Create database")
                    }
                    IconButton(onClick = viewModel::refreshDatabases, enabled = !state.isLoadingDatabases) {
                        Icon(Icons.Outlined.Refresh, contentDescription = "Refresh databases")
                    }
                },
            ) {
                if (writableDatabases.isEmpty()) {
                    KinicEmptyState(
                        icon = Icons.Outlined.Storage,
                        title = if (state.session == null) "Sign in to load databases" else "No writable databases",
                        detail = if (state.session == null) {
                            "Internet Identity unlocks your writable databases."
                        } else {
                            "Create a database or refresh your Owner and Writer databases."
                        },
                    )
                } else {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        writableDatabases.forEach { database ->
                            DatabaseSelectionRow(
                                database = database,
                                origins = setOf(BrowseDatabaseOrigin.MEMBER),
                                selected = database.databaseId == state.selectedCaptureDatabaseId,
                                onClick = { viewModel.selectCaptureDatabase(database.databaseId) },
                            )
                        }
                    }
                }
            }
        }
        item {
            KinicPanel(
                title = "Capture history",
                icon = Icons.Outlined.History,
                trailing = {
                    IconButton(onClick = { viewModel.refreshSourceCaptureHistory(refreshAll = true) }) {
                        Icon(Icons.Outlined.Refresh, contentDescription = "Refresh history")
                    }
                },
            ) {
                when {
                    state.pendingUrls.isEmpty() && state.selectedCaptureDatabaseId.isBlank() -> Text(
                        "Select a database to view capture history.",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    state.pendingUrls.isEmpty() && state.sourceCaptureHistory.isEmpty() -> Text(
                        "No captures yet.",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    else -> Column {
                        state.pendingUrls.forEachIndexed { index, item ->
                            PendingCaptureRow(
                                item = item,
                                showRetry = index == 0,
                                isSubmitting = state.isSubmittingCapture,
                                viewModel = viewModel,
                            )
                            if (index != state.pendingUrls.lastIndex || state.sourceCaptureHistory.isNotEmpty()) {
                                HorizontalDivider()
                            }
                        }
                        state.sourceCaptureHistory.take(10).forEachIndexed { index, record ->
                            CaptureHistoryRow(record, state, viewModel)
                            if (index != state.sourceCaptureHistory.take(10).lastIndex) HorizontalDivider()
                        }
                    }
                }
            }
        }
        if (state.message.isNotBlank()) {
            item {
                Surface(
                    shape = KinicDesign.ControlShape,
                    color = MaterialTheme.colorScheme.surface,
                    border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
                ) {
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(16.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Icon(Icons.Outlined.Info, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
                        Text(state.message, modifier = Modifier.weight(1f), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
    }
    if (createDialog) {
        CreateDatabaseDialog(
            onDismiss = { createDialog = false },
            onCreate = {
                createDialog = false
                viewModel.createDatabase(it)
            },
        )
    }
}

@Composable
internal fun IngestSheet(state: KinicAppUiState, viewModel: KinicAppViewModel, onSubmitted: () -> Unit) {
    var url by remember { mutableStateOf("") }
    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = KinicDesign.ScreenPadding).padding(bottom = 32.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text("Ingest", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        KinicPanel(title = "Ingest", icon = Icons.Outlined.Link) {
            OutlinedTextField(
                value = url,
                onValueChange = { url = it },
                modifier = Modifier.fillMaxWidth(),
                placeholder = { Text("https://example.com/article") },
                singleLine = false,
                maxLines = 3,
                shape = KinicDesign.ControlShape,
                trailingIcon = {
                    IconButton(
                        onClick = {
                            if (viewModel.enqueueUrl(url)) onSubmitted()
                        },
                        enabled = url.isNotBlank() && !state.isSubmittingCapture,
                    ) {
                        Icon(Icons.AutoMirrored.Outlined.Send, contentDescription = "Send")
                    }
                },
            )
        }
    }
}

@Composable
private fun PendingCaptureRow(
    item: PendingSharedUrl,
    showRetry: Boolean,
    isSubmitting: Boolean,
    viewModel: KinicAppViewModel,
) {
    Column(modifier = Modifier.padding(vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
        Text(item.url.toString(), style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium, maxLines = 2)
        Row(verticalAlignment = Alignment.CenterVertically) {
            KinicBadge("Waiting on this device")
            Spacer(Modifier.weight(1f))
            if (showRetry) {
                TextButton(onClick = viewModel::submitNextPending, enabled = !isSubmitting) {
                    Icon(Icons.Outlined.Refresh, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(6.dp))
                    Text(if (isSubmitting) "Submitting" else "Retry")
                }
            }
            IconButton(
                onClick = { viewModel.removePending(item) },
                modifier = Modifier.size(36.dp),
                enabled = !isSubmitting,
            ) {
                Icon(Icons.Outlined.Close, contentDescription = "Remove", modifier = Modifier.size(18.dp))
            }
        }
    }
}

@Composable
private fun CaptureHistoryRow(
    record: SourceCaptureHistoryRecord,
    state: KinicAppUiState,
    viewModel: KinicAppViewModel,
) {
    val item = record.item
    val statusColor = when (item.status) {
        SourceCaptureHistoryStatus.COMPLETED -> Color(0xFF238636)
        SourceCaptureHistoryStatus.FAILED -> MaterialTheme.colorScheme.error
        else -> KinicDesign.ElectricIndigo
    }
    Column(modifier = Modifier.padding(vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
        Text(item.url, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium, maxLines = 2)
        Text(
            item.status.workerValue.replace('_', ' ').replaceFirstChar(Char::uppercase),
            color = statusColor,
            style = MaterialTheme.typography.labelMedium,
            fontWeight = FontWeight.SemiBold,
        )
        item.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
        item.syncError?.let { Text("Status may be stale: $it", color = KinicDesign.WarmYellow, style = MaterialTheme.typography.bodySmall) }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (item.isRetryable()) {
                OutlinedButton(
                    onClick = { viewModel.retrySourceCapture(record) },
                    enabled = item.requestPath !in state.sourceCaptureRetryPaths,
                ) { Text("Retry") }
            }
            if (item.targetPath != null) {
                TextButton(onClick = { viewModel.openCaptureDocument(record) }) { Text("Open document") }
            }
        }
    }
}
