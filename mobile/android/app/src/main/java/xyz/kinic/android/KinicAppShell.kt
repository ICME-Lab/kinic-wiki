package xyz.kinic.android

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Dashboard
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.Home
import androidx.compose.material.icons.outlined.Language
import androidx.compose.material.icons.outlined.OpenInBrowser
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.ExposedDropdownMenuAnchorType
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import org.commonmark.ext.autolink.AutolinkExtension
import org.commonmark.ext.gfm.strikethrough.StrikethroughExtension
import org.commonmark.ext.gfm.tables.TablesExtension
import org.commonmark.node.AbstractVisitor
import org.commonmark.node.Code
import org.commonmark.node.FencedCodeBlock
import org.commonmark.node.HardLineBreak
import org.commonmark.node.Heading
import org.commonmark.node.Link
import org.commonmark.node.ListItem
import org.commonmark.node.Paragraph
import org.commonmark.node.SoftLineBreak
import org.commonmark.node.Text as MarkdownTextNode
import org.commonmark.parser.Parser
import java.net.URI

private val kinicPink = Color(0xFFE9368F)

@Composable
fun KinicAppShell(
    viewModel: KinicAppViewModel,
    askAiViewModel: AskAiViewModel,
    onOpenUri: (URI) -> Unit,
    onCopyText: (String, String) -> Unit,
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    val useDark = when (state.darkMode) {
        DarkMode.SYSTEM -> androidx.compose.foundation.isSystemInDarkTheme()
        DarkMode.LIGHT -> false
        DarkMode.DARK -> true
    }
    val scheme = if (useDark) {
        androidx.compose.material3.darkColorScheme(primary = kinicPink)
    } else {
        androidx.compose.material3.lightColorScheme(primary = kinicPink)
    }
    LaunchedEffect(viewModel) {
        viewModel.events.collect { event ->
            when (event) {
                is KinicAppEvent.OpenUri -> onOpenUri(event.uri)
                is KinicAppEvent.CopyText -> onCopyText(event.label, event.value)
            }
        }
    }
    MaterialTheme(colorScheme = scheme) {
        KinicNavigation(state, viewModel, askAiViewModel)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun KinicNavigation(
    state: KinicAppUiState,
    viewModel: KinicAppViewModel,
    askAiViewModel: AskAiViewModel,
) {
    val navController = rememberNavController()
    val backStack by navController.currentBackStackEntryAsState()
    val route = backStack?.destination?.route ?: KinicTopLevelDestination.HOME.route
    LaunchedEffect(state.navigationRequestId, navController) {
        if (state.navigationRequestId > 0) {
            navController.navigate(state.requestedDestination.route) {
                popUpTo(KinicTopLevelDestination.HOME.route) { saveState = true }
                launchSingleTop = true
                restoreState = true
            }
        }
    }
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(KinicTopLevelDestination.entries.firstOrNull { it.route == route }?.label ?: "KinicWiki") },
                actions = {
                    IconButton(onClick = viewModel::refreshDatabases) {
                        Icon(Icons.Outlined.Refresh, contentDescription = "Refresh")
                    }
                },
            )
        },
        bottomBar = {
            NavigationBar {
                KinicTopLevelDestination.entries.forEach { destination ->
                    NavigationBarItem(
                        selected = route == destination.route,
                        onClick = {
                            navController.navigate(destination.route) {
                                popUpTo(KinicTopLevelDestination.HOME.route) { saveState = true }
                                launchSingleTop = true
                                restoreState = true
                            }
                        },
                        icon = {
                            Icon(
                                when (destination) {
                                    KinicTopLevelDestination.HOME -> Icons.Outlined.Home
                                    KinicTopLevelDestination.BROWSE -> Icons.Outlined.Description
                                    KinicTopLevelDestination.ASK_AI -> Icons.Outlined.AutoAwesome
                                    KinicTopLevelDestination.MANAGE -> Icons.Outlined.Dashboard
                                },
                                contentDescription = null,
                            )
                        },
                        label = { Text(destination.label) },
                    )
                }
            }
        },
    ) { padding ->
        NavHost(
            navController = navController,
            startDestination = KinicTopLevelDestination.HOME.route,
            modifier = Modifier.padding(padding),
        ) {
            composable(KinicTopLevelDestination.HOME.route) { HomeScreen(state, viewModel) }
            composable(KinicTopLevelDestination.BROWSE.route) { BrowseScreen(state, viewModel) }
            composable(KinicTopLevelDestination.ASK_AI.route) { AskAiScreen(state, askAiViewModel) }
            composable(KinicTopLevelDestination.MANAGE.route) { ManageScreen(state, viewModel) }
        }
    }
}

@Composable
private fun HomeScreen(state: KinicAppUiState, viewModel: KinicAppViewModel) {
    var url by remember { mutableStateOf("") }
    LazyColumn(
        modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            SectionTitle("Account")
            Text(state.session?.principal ?: "Signed out", style = MaterialTheme.typography.bodySmall)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (state.session == null) {
                    Button(onClick = viewModel::startSignIn) { Text("Sign in") }
                } else {
                    OutlinedButton(onClick = viewModel::copyPrincipal) {
                        Icon(Icons.Outlined.ContentCopy, contentDescription = null)
                        Text("Copy")
                    }
                    TextButton(onClick = viewModel::signOut) { Text("Sign out") }
                }
            }
        }
        item {
            SectionTitle("Source capture")
            DatabaseDropdown(
                entries = state.memberDatabases
                    .filter { it.canWrite }
                    .map { BrowseDatabaseEntry(it, setOf(BrowseDatabaseOrigin.MEMBER)) },
                selectedId = state.selectedCaptureDatabaseId,
                onSelect = viewModel::selectCaptureDatabase,
                label = "Writable database",
            )
            OutlinedTextField(
                value = url,
                onValueChange = { url = it },
                modifier = Modifier.fillMaxWidth(),
                label = { Text("URL") },
                singleLine = true,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = {
                        viewModel.enqueueUrl(url)
                        url = ""
                    },
                    enabled = url.isNotBlank(),
                ) {
                    Icon(Icons.Outlined.Add, contentDescription = null)
                    Text("Queue")
                }
                Button(
                    onClick = viewModel::submitNextPending,
                    enabled = state.session != null && state.pendingUrls.isNotEmpty(),
                ) {
                    Icon(Icons.AutoMirrored.Outlined.Send, contentDescription = null)
                    Text("Submit next")
                }
            }
        }
        if (state.message.isNotBlank()) {
            item { Text(state.message, color = MaterialTheme.colorScheme.primary) }
        }
        item { SectionTitle("Pending (${state.pendingUrls.size})") }
        items(state.pendingUrls, key = PendingSharedUrl::id) { item ->
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(item.url.toString())
                Text(item.requestId, style = MaterialTheme.typography.bodySmall)
                TextButton(onClick = { viewModel.removePending(item) }) {
                    Icon(Icons.Outlined.Delete, contentDescription = null)
                    Text("Remove")
                }
                HorizontalDivider()
            }
        }
        item {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                SectionTitle("History")
                IconButton(onClick = { viewModel.refreshSourceCaptureHistory(refreshAll = true) }) {
                    Icon(Icons.Outlined.Refresh, contentDescription = "Refresh history")
                }
            }
        }
        items(state.sourceCaptureHistory.take(10), key = SourceCaptureHistoryRecord::id) { record ->
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(record.item.url, maxLines = 2)
                Text(
                    record.item.status.workerValue.replace('_', ' '),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.primary,
                )
                record.item.error?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                record.item.syncError?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (record.item.isRetryable()) {
                        TextButton(
                            onClick = { viewModel.retrySourceCapture(record) },
                            enabled = record.item.requestPath !in state.sourceCaptureRetryPaths,
                        ) { Text("Retry") }
                    }
                    if (record.item.targetPath != null) {
                        TextButton(onClick = { viewModel.openCaptureDocument(record) }) {
                            Text("Open document")
                        }
                    }
                }
                HorizontalDivider()
            }
        }
    }
}

@Composable
private fun BrowseScreen(state: KinicAppUiState, viewModel: KinicAppViewModel) {
    var directDatabaseId by remember { mutableStateOf("") }
    Column(
        modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        DatabaseDropdown(
            entries = state.browseDatabases,
            selectedId = state.selectedBrowseDatabaseId,
            onSelect = viewModel::selectBrowseDatabase,
            label = "Database",
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(
                value = directDatabaseId,
                onValueChange = { directDatabaseId = it },
                modifier = Modifier.weight(1f),
                label = { Text("Database ID") },
                singleLine = true,
            )
            IconButton(onClick = { viewModel.addDirectDatabase(directDatabaseId) }) {
                Icon(Icons.Outlined.OpenInBrowser, contentDescription = "Open database")
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(
                value = state.browseSearchQuery,
                onValueChange = viewModel::setBrowseSearchQuery,
                modifier = Modifier.weight(1f),
                label = { Text("Search") },
                singleLine = true,
            )
            IconButton(onClick = viewModel::searchBrowse) {
                Icon(Icons.Outlined.Search, contentDescription = "Search")
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(
                selected = state.browseSort == BrowseSort.NAME,
                onClick = { viewModel.setBrowseSort(BrowseSort.NAME) },
                label = { Text("Name") },
            )
            FilterChip(
                selected = state.browseSort == BrowseSort.MODIFIED,
                onClick = { viewModel.setBrowseSort(BrowseSort.MODIFIED) },
                label = { Text("Modified") },
            )
            if (state.browsePath != "/" || state.browseDocument != null) {
                IconButton(onClick = viewModel::navigateBrowseBack) {
                    Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "Back")
                }
            }
        }
        Text(state.browseDocument?.path ?: state.browsePath, style = MaterialTheme.typography.bodySmall)
        if (state.browseDocument != null) {
            DocumentView(state, viewModel)
        } else {
            BrowseResults(state, viewModel)
        }
    }
}

@Composable
private fun BrowseResults(state: KinicAppUiState, viewModel: KinicAppViewModel) {
    val searchResults = state.browseSearchResults
    LazyColumn(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (searchResults.isNotEmpty()) {
            items(searchResults, key = SearchNodeHit::path) { hit ->
                BrowseRow(
                    title = hit.path.substringAfterLast('/'),
                    detail = hit.previewExcerpt ?: hit.snippet ?: hit.matchReasons.joinToString(),
                    isFolder = hit.kind == VfsNodeKind.FOLDER,
                    onClick = { viewModel.openBrowseNode(hit.path) },
                )
            }
        } else {
            items(state.browseChildren, key = ChildNode::path) { child ->
                BrowseRow(
                    title = child.name,
                    detail = child.updatedAt?.toString().orEmpty(),
                    isFolder = child.kind == VfsNodeKind.FOLDER,
                    onClick = {
                        if (child.kind == VfsNodeKind.FOLDER) {
                            viewModel.loadBrowsePath(child.path)
                        } else {
                            viewModel.openBrowseNode(child.path)
                        }
                    },
                )
            }
        }
    }
}

@Composable
private fun BrowseRow(title: String, detail: String, isFolder: Boolean, onClick: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Icon(
            if (isFolder) Icons.Outlined.Folder else Icons.Outlined.Description,
            contentDescription = null,
        )
        Column {
            Text(title, fontWeight = FontWeight.Medium)
            if (detail.isNotBlank()) {
                Text(detail, style = MaterialTheme.typography.bodySmall, maxLines = 2)
            }
        }
    }
}

@Composable
private fun DocumentView(state: KinicAppUiState, viewModel: KinicAppViewModel) {
    val document = state.browseDocument ?: return
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(
                selected = !state.showRawDocument,
                onClick = { viewModel.setRawDocument(false) },
                label = { Text("Markdown") },
            )
            FilterChip(
                selected = state.showRawDocument,
                onClick = { viewModel.setRawDocument(true) },
                label = { Text("Raw") },
            )
        }
        Box(modifier = Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            if (state.showRawDocument) {
                SelectionContainer {
                    Text(document.content, fontFamily = FontFamily.Monospace)
                }
            } else {
                SafeMarkdown(document.content, viewModel::openExternalUrl)
            }
        }
    }
}

@Composable
private fun SafeMarkdown(markdown: String, onOpenLink: (String) -> Unit) {
    val rendered = remember(markdown) { parseSafeMarkdown(markdown) }
    SelectionContainer {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(rendered.text)
            rendered.links.forEach { link ->
                AssistChip(
                    onClick = { onOpenLink(link) },
                    label = { Text(link) },
                    leadingIcon = { Icon(Icons.Outlined.Language, contentDescription = null) },
                )
            }
        }
    }
}

private data class SafeMarkdownContent(val text: String, val links: List<String>)

private fun parseSafeMarkdown(markdown: String): SafeMarkdownContent {
    val parser = Parser.builder()
        .extensions(
            listOf(
                TablesExtension.create(),
                StrikethroughExtension.create(),
                AutolinkExtension.create(),
            ),
        )
        .build()
    val text = StringBuilder()
    val links = mutableListOf<String>()
    parser.parse(markdown).accept(object : AbstractVisitor() {
        override fun visit(textNode: MarkdownTextNode) {
            text.append(textNode.literal)
        }

        override fun visit(code: Code) {
            text.append(code.literal)
        }

        override fun visit(codeBlock: FencedCodeBlock) {
            text.append(codeBlock.literal).append('\n')
        }

        override fun visit(softLineBreak: SoftLineBreak) {
            text.append('\n')
        }

        override fun visit(hardLineBreak: HardLineBreak) {
            text.append('\n')
        }

        override fun visit(heading: Heading) {
            visitChildren(heading)
            text.append('\n')
        }

        override fun visit(paragraph: Paragraph) {
            visitChildren(paragraph)
            text.append("\n\n")
        }

        override fun visit(listItem: ListItem) {
            text.append("• ")
            visitChildren(listItem)
            text.append('\n')
        }

        override fun visit(link: Link) {
            visitChildren(link)
            links += link.destination
        }
    })
    return SafeMarkdownContent(text.toString().trim(), links.distinct())
}

@Composable
private fun AskAiScreen(state: KinicAppUiState, viewModel: AskAiViewModel) {
    val askState by viewModel.uiState.collectAsStateWithLifecycle()
    var historyExpanded by remember { mutableStateOf(false) }
    Column(
        modifier = Modifier.fillMaxSize().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        DatabaseDropdown(
            entries = state.browseDatabases,
            selectedId = askState.currentConversation?.databaseId.orEmpty(),
            onSelect = viewModel::requestDatabaseChange,
            label = "Knowledge database",
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = { historyExpanded = !historyExpanded }) {
                Text("History (${askState.conversations.size})")
            }
            IconButton(onClick = { viewModel.startNewConversation() }) {
                Icon(Icons.Outlined.Add, contentDescription = "New conversation")
            }
        }
        if (historyExpanded) {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                askState.conversations.take(8).forEach { conversation ->
                    Row(
                        modifier = Modifier.fillMaxWidth().clickable {
                            viewModel.selectConversation(conversation.id)
                            historyExpanded = false
                        },
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text(conversation.title, maxLines = 1)
                            Text(conversation.databaseTitle, style = MaterialTheme.typography.bodySmall)
                        }
                        IconButton(onClick = { viewModel.deleteConversation(conversation.id) }) {
                            Icon(Icons.Outlined.Delete, contentDescription = "Delete conversation")
                        }
                    }
                }
            }
        }
        askState.historyLoadError?.let { error ->
            Column {
                Text(error, color = MaterialTheme.colorScheme.error)
                TextButton(onClick = viewModel::resetHistory) { Text("Reset history") }
            }
        }
        LazyColumn(
            modifier = Modifier.weight(1f).fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            items(askState.messages, key = AskAiMessage::id) { message ->
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(
                        if (message.role == AskAiMessageRole.USER) "You" else "Ask AI",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.primary,
                    )
                    SelectionContainer {
                        Text(message.text.ifBlank { "Working..." })
                    }
                    message.trace.forEach { trace ->
                        Text(
                            "${if (trace.isActive) "• " else ""}${trace.title}" +
                                trace.detail?.let { ": $it" }.orEmpty(),
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                    message.sources.forEach { source ->
                        TextButton(onClick = { viewModel.openSource(source) }) {
                            Text("${source.id}  ${source.path}")
                        }
                        if (source.excerpt.isNotBlank()) {
                            Text(source.excerpt, style = MaterialTheme.typography.bodySmall, maxLines = 3)
                        }
                    }
                    HorizontalDivider()
                }
            }
        }
        askState.errorMessage?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        OutlinedTextField(
            value = askState.draft,
            onValueChange = viewModel::setDraft,
            modifier = Modifier.fillMaxWidth(),
            label = { Text("Ask a question") },
            enabled = !askState.isGenerating,
            maxLines = 4,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                onClick = viewModel::send,
                enabled = askState.draft.isNotBlank() && !askState.isGenerating &&
                    askState.currentConversation != null,
            ) {
                Icon(Icons.AutoMirrored.Outlined.Send, contentDescription = null)
                Text("Ask")
            }
            if (askState.isGenerating) {
                OutlinedButton(onClick = viewModel::cancel) { Text("Cancel") }
            }
        }
    }
    if (askState.pendingDatabaseId != null) {
        AlertDialog(
            onDismissRequest = viewModel::dismissDatabaseChange,
            title = { Text("Change database?") },
            text = { Text("A new conversation will use ${askState.pendingDatabaseTitle}.") },
            confirmButton = {
                Button(onClick = viewModel::confirmDatabaseChange) { Text("New conversation") }
            },
            dismissButton = {
                TextButton(onClick = viewModel::dismissDatabaseChange) { Text("Cancel") }
            },
        )
    }
}

@Composable
private fun ManageScreen(
    state: KinicAppUiState,
    viewModel: KinicAppViewModel,
) {
    val databases = KinicAppViewModel.manageableDatabases(state)
    val database = databases.firstOrNull { it.databaseId == state.manage.selectedDatabaseId }
    var createDialog by remember { mutableStateOf(false) }
    var settingsVisible by remember { mutableStateOf(false) }
    var deleteDialog by remember { mutableStateOf(false) }
    var metadataDialog by remember { mutableStateOf(false) }
    var grantDialog by remember { mutableStateOf(false) }
    var revokePrincipal by remember { mutableStateOf<String?>(null) }
    val isBusy = state.manage.busyAction != null
    Column(
        modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp).verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { createDialog = true }, enabled = state.session != null && !isBusy) {
                Icon(Icons.Outlined.Add, contentDescription = null)
                Text("Create")
            }
            OutlinedButton(onClick = { settingsVisible = !settingsVisible }) {
                Icon(Icons.Outlined.Settings, contentDescription = null)
                Text("Settings")
            }
        }
        if (settingsVisible) {
            SettingsPanel(state, viewModel)
        }
        DatabaseDropdown(
            entries = databases.map { BrowseDatabaseEntry(it, setOf(BrowseDatabaseOrigin.MEMBER)) },
            selectedId = state.manage.selectedDatabaseId,
            onSelect = viewModel::selectManageDatabase,
            label = "Managed database",
        )
        state.manage.pendingFundingDatabaseId?.let { pendingDatabaseId ->
            Text("Database $pendingDatabaseId is pending funding.")
            Button(onClick = { viewModel.openFunding(pendingDatabaseId) }, enabled = !isBusy) {
                Icon(Icons.Outlined.OpenInBrowser, contentDescription = null)
                Text("Fund database")
            }
        }
        if (database != null) {
            Text(database.status.candidName, style = MaterialTheme.typography.titleMedium)
            Text("${database.logicalSizeBytes} bytes")
            Text(database.cyclesBalance?.let { "$it cycles" } ?: "Cycles unavailable")
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { viewModel.openFunding(database.databaseId) }) {
                    Icon(Icons.Outlined.OpenInBrowser, contentDescription = null)
                    Text("Funding")
                }
                OutlinedButton(onClick = viewModel::refreshManageDetails) {
                    Icon(Icons.Outlined.Refresh, contentDescription = null)
                    Text("Refresh")
                }
                if (database.role == DatabaseRole.OWNER) {
                    TextButton(onClick = { deleteDialog = true }, enabled = !isBusy) {
                        Icon(Icons.Outlined.Delete, contentDescription = null)
                        Text("Delete")
                    }
                }
            }
            Button(onClick = { metadataDialog = true }, enabled = !isBusy) {
                Text("Edit metadata")
            }
            SectionTitle("Members")
            state.manage.members.forEach { member ->
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text(
                        "${member.role.candidName} · ${member.principal}",
                        modifier = Modifier.weight(1f),
                        style = MaterialTheme.typography.bodySmall,
                    )
                    if (database.role == DatabaseRole.OWNER && member.principal != state.session?.principal) {
                        IconButton(onClick = { revokePrincipal = member.principal }, enabled = !isBusy) {
                            Icon(Icons.Outlined.Delete, contentDescription = "Revoke access")
                        }
                    }
                }
            }
            if (database.role == DatabaseRole.OWNER) {
                OutlinedButton(onClick = { grantDialog = true }, enabled = !isBusy) {
                    Icon(Icons.Outlined.Add, contentDescription = null)
                    Text("Grant access")
                }
            }
            SectionTitle("Billing history")
            state.manage.cycleEntries.forEach { entry ->
                Text("${entry.kind} · ${entry.amountCycles}", style = MaterialTheme.typography.bodySmall)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(
                    onClick = viewModel::loadPreviousCycleEntries,
                    enabled = state.manage.previousCursors.isNotEmpty() && !state.manage.isLoading,
                ) { Text("Previous") }
                OutlinedButton(
                    onClick = viewModel::loadNextCycleEntries,
                    enabled = state.manage.nextCursor != null && !state.manage.isLoading,
                ) { Text("Next") }
            }
            if (state.manage.pendingPurchases.isNotEmpty()) {
                SectionTitle("Pending purchases")
                state.manage.pendingPurchases.forEach { purchase ->
                    Text("${purchase.status} · ${purchase.requiredAction}", style = MaterialTheme.typography.bodySmall)
                }
            }
        } else if (databases.isEmpty()) {
            Text(if (state.session == null) "Sign in to manage databases." else "No managed databases.")
        }
        if (state.message.isNotBlank()) {
            Text(state.message, color = MaterialTheme.colorScheme.primary)
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
    if (deleteDialog && database != null) {
        DeleteDatabaseDialog(
            databaseId = database.databaseId,
            onDismiss = { deleteDialog = false },
            onDelete = {
                deleteDialog = false
                viewModel.deleteDatabase(it)
            },
        )
    }
    if (metadataDialog && database != null) {
        MetadataDialog(
            database = database,
            onDismiss = { metadataDialog = false },
            onSave = { name, description, summary, tags ->
                metadataDialog = false
                viewModel.updateDatabaseMetadata(name, description, summary, tags)
            },
        )
    }
    if (grantDialog) {
        GrantAccessDialog(
            onDismiss = { grantDialog = false },
            onGrant = { principal, role ->
                grantDialog = false
                viewModel.grantDatabaseAccess(principal, role)
            },
        )
    }
    revokePrincipal?.let { principal ->
        AlertDialog(
            onDismissRequest = { revokePrincipal = null },
            title = { Text("Revoke access") },
            text = { Text(principal) },
            confirmButton = {
                Button(
                    onClick = {
                        revokePrincipal = null
                        viewModel.revokeDatabaseAccess(principal)
                    },
                ) { Text("Revoke") }
            },
            dismissButton = {
                TextButton(onClick = { revokePrincipal = null }) { Text("Cancel") }
            },
        )
    }
}

@Composable
private fun SettingsPanel(state: KinicAppUiState, viewModel: KinicAppViewModel) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SettingSwitch("Show public databases", state.showPublicDatabases, viewModel::setShowPublicDatabases)
        SettingSwitch("Show purchased databases", state.showPurchasedDatabases, viewModel::setShowPurchasedDatabases)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            DarkMode.entries.forEach { mode ->
                FilterChip(
                    selected = state.darkMode == mode,
                    onClick = { viewModel.setDarkMode(mode) },
                    label = { Text(mode.name.lowercase().replaceFirstChar(Char::uppercase)) },
                )
            }
        }
        LanguageDropdown(state.generationLanguage, viewModel::setGenerationLanguage)
        TextButton(onClick = viewModel::openPrivacyPolicy) { Text("Privacy policy") }
    }
}

@Composable
private fun SettingSwitch(label: String, checked: Boolean, onCheckedChange: (Boolean) -> Unit) {
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label)
        Switch(checked = checked, onCheckedChange = onCheckedChange)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun LanguageDropdown(
    selected: WikiOutputLanguage,
    onSelect: (WikiOutputLanguage) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }) {
        OutlinedTextField(
            value = selected.displayName,
            onValueChange = {},
            readOnly = true,
            modifier = Modifier
                .menuAnchor(ExposedDropdownMenuAnchorType.PrimaryNotEditable)
                .fillMaxWidth(),
            label = { Text("Generation language") },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded) },
        )
        ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            WikiOutputLanguage.entries.forEach { language ->
                DropdownMenuItem(
                    text = { Text(language.displayName) },
                    onClick = {
                        expanded = false
                        onSelect(language)
                    },
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DatabaseDropdown(
    entries: List<BrowseDatabaseEntry>,
    selectedId: String,
    onSelect: (String) -> Unit,
    label: String,
) {
    var expanded by remember { mutableStateOf(false) }
    val selected = entries.firstOrNull { it.summary.databaseId == selectedId }
    ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }) {
        OutlinedTextField(
            value = selected?.summary?.displayTitle ?: "",
            onValueChange = {},
            readOnly = true,
            modifier = Modifier
                .menuAnchor(ExposedDropdownMenuAnchorType.PrimaryNotEditable)
                .fillMaxWidth(),
            label = { Text(label) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded) },
        )
        ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            entries.forEach { entry ->
                DropdownMenuItem(
                    text = {
                        Column {
                            Text(entry.summary.displayTitle)
                            Text(
                                entry.origins.joinToString(" · ") { it.name.lowercase() },
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                    },
                    onClick = {
                        expanded = false
                        onSelect(entry.summary.databaseId)
                    },
                )
            }
        }
    }
}

@Composable
private fun CreateDatabaseDialog(onDismiss: () -> Unit, onCreate: (String) -> Unit) {
    var name by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Create database") },
        text = {
            OutlinedTextField(value = name, onValueChange = { name = it }, label = { Text("Name") })
        },
        confirmButton = { Button(onClick = { onCreate(name) }) { Text("Create") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun DeleteDatabaseDialog(databaseId: String, onDismiss: () -> Unit, onDelete: (String) -> Unit) {
    var confirmation by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Delete database") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(databaseId)
                OutlinedTextField(
                    value = confirmation,
                    onValueChange = { confirmation = it },
                    label = { Text("Database ID") },
                )
            }
        },
        confirmButton = {
            Button(onClick = { onDelete(confirmation) }, enabled = confirmation == databaseId) {
                Text("Delete")
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun MetadataDialog(
    database: DatabaseSummary,
    onDismiss: () -> Unit,
    onSave: (String, String, String?, String) -> Unit,
) {
    var name by remember(database.databaseId) { mutableStateOf(database.metadata?.name ?: database.title) }
    var description by remember(database.databaseId) { mutableStateOf(database.metadata?.description ?: database.description) }
    var summary by remember(database.databaseId) { mutableStateOf(database.metadata?.llmSummary.orEmpty()) }
    var tags by remember(database.databaseId) { mutableStateOf(database.metadata?.tagsJson ?: "[]") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Edit metadata") },
        text = {
            Column(
                modifier = Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                OutlinedTextField(name, { name = it }, label = { Text("Name") })
                OutlinedTextField(description, { description = it }, label = { Text("Description") })
                OutlinedTextField(summary, { summary = it }, label = { Text("LLM summary") })
                OutlinedTextField(tags, { tags = it }, label = { Text("Tags JSON") })
            }
        },
        confirmButton = {
            Button(onClick = { onSave(name, description, summary, tags) }) { Text("Save") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun GrantAccessDialog(
    onDismiss: () -> Unit,
    onGrant: (String, DatabaseRole) -> Unit,
) {
    var principal by remember { mutableStateOf("") }
    var role by remember { mutableStateOf(DatabaseRole.READER) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Grant database access") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = principal,
                    onValueChange = { principal = it },
                    label = { Text("Principal") },
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf(DatabaseRole.WRITER, DatabaseRole.READER).forEach { candidate ->
                        FilterChip(
                            selected = role == candidate,
                            onClick = { role = candidate },
                            label = { Text(candidate.candidName) },
                        )
                    }
                }
            }
        },
        confirmButton = {
            Button(onClick = { onGrant(principal.trim(), role) }, enabled = principal.isNotBlank()) {
                Text("Grant")
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun SectionTitle(text: String) {
    Text(text, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
}
