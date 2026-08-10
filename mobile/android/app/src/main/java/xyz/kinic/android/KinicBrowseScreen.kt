package xyz.kinic.android

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.Sort
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.Language
import androidx.compose.material.icons.outlined.OpenInBrowser
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.AssistChip
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
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

@Composable
internal fun BrowseScreen(state: KinicAppUiState, viewModel: KinicAppViewModel) {
    var directDatabaseId by remember { mutableStateOf("") }
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .padding(horizontal = KinicDesign.ScreenPadding),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Surface(
            modifier = Modifier.fillMaxWidth(),
            shape = KinicDesign.ControlShape,
            color = MaterialTheme.colorScheme.surfaceVariant,
        ) {
            Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                DatabaseDropdown(
                    entries = state.browseDatabases,
                    selectedId = state.selectedBrowseDatabaseId,
                    onSelect = viewModel::selectBrowseDatabase,
                    label = "Database",
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(
                        value = directDatabaseId,
                        onValueChange = { directDatabaseId = it },
                        modifier = Modifier.weight(1f),
                        label = { Text("Database ID") },
                        singleLine = true,
                        shape = KinicDesign.ControlShape,
                    )
                    IconButton(
                        onClick = { viewModel.addDirectDatabase(directDatabaseId) },
                        enabled = directDatabaseId.isNotBlank(),
                    ) {
                        Icon(Icons.Outlined.OpenInBrowser, contentDescription = "Open database")
                    }
                }
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = state.browseSearchQuery,
                onValueChange = viewModel::setBrowseSearchQuery,
                modifier = Modifier.weight(1f),
                placeholder = { Text("Search nodes") },
                singleLine = true,
                shape = KinicDesign.ControlShape,
                leadingIcon = { Icon(Icons.Outlined.Search, contentDescription = null) },
            )
            IconButton(onClick = viewModel::searchBrowse) {
                Icon(Icons.Outlined.Search, contentDescription = "Search")
            }
        }
        Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            if (state.browsePath != "/" || state.browseDocument != null) {
                IconButton(onClick = viewModel::navigateBrowseBack) {
                    Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "Back")
                }
            }
            Text(
                state.browseDocument?.path ?: state.browsePath,
                modifier = Modifier.weight(1f),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.MiddleEllipsis,
            )
            FilterChip(
                selected = state.browseSort == BrowseSort.NAME,
                onClick = { viewModel.setBrowseSort(BrowseSort.NAME) },
                label = { Text("Name") },
                leadingIcon = { Icon(Icons.AutoMirrored.Outlined.Sort, contentDescription = null, modifier = Modifier.size(16.dp)) },
            )
            Spacer(Modifier.width(6.dp))
            FilterChip(
                selected = state.browseSort == BrowseSort.MODIFIED,
                onClick = { viewModel.setBrowseSort(BrowseSort.MODIFIED) },
                label = { Text("Date") },
            )
        }
        if (state.browseDocument != null) DocumentView(state, viewModel) else BrowseResults(state, viewModel)
    }
}

@Composable
private fun BrowseResults(state: KinicAppUiState, viewModel: KinicAppViewModel) {
    val searchResults = state.browseSearchResults
    LazyColumn(modifier = Modifier.fillMaxSize()) {
        if (searchResults.isNotEmpty()) {
            items(searchResults, key = SearchNodeHit::path) { hit ->
                BrowseRow(
                    title = hit.path.substringAfterLast('/'),
                    detail = hit.previewExcerpt ?: hit.snippet ?: hit.matchReasons.joinToString(),
                    isFolder = hit.kind == VfsNodeKind.FOLDER,
                    onClick = { viewModel.openBrowseNode(hit.path) },
                )
                HorizontalDivider()
            }
        } else {
            if (state.browseChildren.isEmpty()) {
                item {
                    KinicEmptyState(
                        icon = Icons.Outlined.Folder,
                        title = if (state.selectedBrowseDatabaseId.isBlank()) "Select a database" else "Empty folder",
                        detail = if (state.selectedBrowseDatabaseId.isBlank()) {
                            "Choose a readable database to browse its notes."
                        } else {
                            "This folder does not contain any visible nodes."
                        },
                    )
                }
            }
            items(state.browseChildren, key = ChildNode::path) { child ->
                BrowseRow(
                    title = child.name,
                    detail = child.updatedAt?.toString().orEmpty(),
                    isFolder = child.kind == VfsNodeKind.FOLDER,
                    onClick = {
                        if (child.kind == VfsNodeKind.FOLDER) viewModel.loadBrowsePath(child.path)
                        else viewModel.openBrowseNode(child.path)
                    },
                )
                HorizontalDivider()
            }
        }
    }
}

@Composable
private fun BrowseRow(title: String, detail: String, isFolder: Boolean, onClick: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 12.dp, horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Surface(shape = CircleShape, color = MaterialTheme.colorScheme.surfaceVariant) {
            Icon(
                if (isFolder) Icons.Outlined.Folder else Icons.Outlined.Description,
                contentDescription = null,
                modifier = Modifier.padding(9.dp).size(20.dp),
                tint = if (isFolder) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Column(modifier = Modifier.weight(1f)) {
            Text(title, fontWeight = FontWeight.Medium, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (detail.isNotBlank()) {
                Text(
                    detail,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        Icon(Icons.Outlined.ChevronRight, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
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
                SelectionContainer { Text(document.content, fontFamily = FontFamily.Monospace) }
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
        .extensions(listOf(TablesExtension.create(), StrikethroughExtension.create(), AutolinkExtension.create()))
        .build()
    val text = StringBuilder()
    val links = mutableListOf<String>()
    parser.parse(markdown).accept(object : AbstractVisitor() {
        override fun visit(textNode: MarkdownTextNode) { text.append(textNode.literal) }
        override fun visit(code: Code) { text.append(code.literal) }
        override fun visit(codeBlock: FencedCodeBlock) { text.append(codeBlock.literal).append('\n') }
        override fun visit(softLineBreak: SoftLineBreak) { text.append('\n') }
        override fun visit(hardLineBreak: HardLineBreak) { text.append('\n') }
        override fun visit(heading: Heading) { visitChildren(heading); text.append('\n') }
        override fun visit(paragraph: Paragraph) { visitChildren(paragraph); text.append("\n\n") }
        override fun visit(listItem: ListItem) { text.append("• "); visitChildren(listItem); text.append('\n') }
        override fun visit(link: Link) { visitChildren(link); links += link.destination }
    })
    return SafeMarkdownContent(text.toString().trim(), links.distinct())
}
