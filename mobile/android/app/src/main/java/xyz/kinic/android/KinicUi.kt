// Where: mobile/android/app/src/main/java/xyz/kinic/android/KinicUi.kt
// What: Compose shell for Android capture queue operations.
// Why: The first Android port needs a native entry screen before auth and browse are wired.

package xyz.kinic.android

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import xyz.kinic.android.ic.IcAuthSession
import java.net.URI

private val kinicPink = Color(0xFFE9368F)
private val kinicInk = Color(0xFF111116)

@Composable
fun KinicAppView(
    inbox: ShareInbox,
    session: IcAuthSession? = null,
    message: String = "",
    initialSelectedDatabaseId: String = "",
    onSignIn: () -> String = { "Sign in is not available." },
    onSignOut: () -> String = { "Signed out." },
    onSubmitNext: suspend (DatabaseSummary?) -> String = { "Submit is not available." },
    onResolveDatabase: suspend (String) -> DatabaseSummary? = { null },
    onRefreshDatabases: suspend () -> List<DatabaseSummary> = { emptyList() },
    onSelectDatabase: (String) -> Unit = {},
    onListChildren: suspend (String, String) -> List<ChildNode> = { _, _ -> emptyList() },
    onReadNode: suspend (String, String) -> VfsNode? = { _, _ -> null },
) {
    var pending by remember { mutableStateOf(inbox.loadPendingUrls()) }
    var databaseId by remember(initialSelectedDatabaseId) { mutableStateOf(initialSelectedDatabaseId) }
    var urlText by remember { mutableStateOf("") }
    var statusMessage by remember(message) { mutableStateOf(message) }
    var databases by remember { mutableStateOf(emptyList<DatabaseSummary>()) }
    var browsePath by remember { mutableStateOf("/") }
    var childNodes by remember { mutableStateOf(emptyList<ChildNode>()) }
    var document by remember { mutableStateOf<VfsNode?>(null) }
    var browseMessage by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    val selectedDatabase = databases.firstOrNull { it.databaseId == databaseId }

    MaterialTheme(
        colorScheme = MaterialTheme.colorScheme.copy(primary = kinicPink, onPrimary = Color.White),
    ) {
        Surface(modifier = Modifier.fillMaxSize(), color = Color.White, contentColor = kinicInk) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(20.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                Text("KinicWiki", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
                Text(
                    session?.let { "Principal ${it.principal}" } ?: "Signed out",
                    style = MaterialTheme.typography.bodyMedium,
                    color = Color(0xFF66666F),
                )
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Button(
                        onClick = {
                            statusMessage = onSignIn()
                        },
                        enabled = session == null,
                    ) {
                        Text("Sign in")
                    }
                    TextButton(
                        onClick = {
                            statusMessage = onSignOut()
                        },
                        enabled = session != null,
                    ) {
                        Text("Sign out")
                    }
                }
                OutlinedTextField(
                    value = databaseId,
                    onValueChange = { databaseId = it },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("Database ID") },
                    singleLine = true,
                )
                OutlinedTextField(
                    value = urlText,
                    onValueChange = { urlText = it },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("URL") },
                    singleLine = true,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Button(
                        onClick = {
                            runCatching {
                                inbox.enqueue(
                                    url = URI(urlText),
                                    databaseId = databaseId,
                                )
                            }.onSuccess {
                                urlText = ""
                                pending = inbox.loadPendingUrls()
                                statusMessage = "Queued"
                            }.onFailure {
                                statusMessage = it.message ?: "Failed"
                            }
                        },
                    ) {
                        Text("Queue")
                    }
                    TextButton(
                        onClick = {
                            pending = inbox.loadPendingUrls()
                            statusMessage = ""
                        },
                    ) {
                        Text("Refresh")
                    }
                    Button(
                        onClick = {
                            scope.launch {
                                statusMessage = "Submitting..."
                                val resolved = resolveSubmitDatabase(
                                    selectedDatabase = selectedDatabase,
                                    databaseId = databaseId,
                                    onResolveDatabase = onResolveDatabase,
                                )
                                if (resolved == null) {
                                    statusMessage = "Selected database is not readable."
                                } else {
                                    databases = databases.withResolvedDatabase(resolved)
                                    databaseId = resolved.databaseId
                                    onSelectDatabase(resolved.databaseId)
                                    statusMessage = onSubmitNext(resolved)
                                    pending = inbox.loadPendingUrls()
                                }
                            }
                        },
                        enabled = session != null && pending.isNotEmpty(),
                    ) {
                        Text("Submit next")
                    }
                }
                if (statusMessage.isNotBlank()) {
                    Text(statusMessage, color = kinicPink)
                }
                Spacer(Modifier.height(4.dp))
                Text("Pending", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    items(pending, key = { it.id }) { item ->
                        Column(
                            modifier = Modifier.fillMaxWidth(),
                            verticalArrangement = Arrangement.spacedBy(4.dp),
                        ) {
                            Text(item.url.toString(), style = MaterialTheme.typography.bodyMedium)
                            Text(item.requestId, style = MaterialTheme.typography.bodySmall, color = Color(0xFF66666F))
                            TextButton(
                                onClick = {
                                    inbox.remove(item)
                                    pending = inbox.loadPendingUrls()
                                },
                            ) {
                                Text("Remove")
                            }
                        }
                    }
                }
                Spacer(Modifier.height(6.dp))
                Text("Browse", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Button(
                        onClick = {
                            scope.launch {
                                browseMessage = "Loading databases..."
                                val outcome = refreshBrowseRoot(
                                    currentDatabaseId = databaseId,
                                    onRefreshDatabases = onRefreshDatabases,
                                    onListChildren = onListChildren,
                                )
                                outcome.databases?.let { databases = it }
                                val selected = outcome.selectedDatabase
                                if (outcome.clearBrowse) {
                                    databaseId = ""
                                    childNodes = emptyList()
                                    document = null
                                } else if (selected != null && outcome.childNodes != null) {
                                    databaseId = selected.databaseId
                                    onSelectDatabase(selected.databaseId)
                                    browsePath = "/"
                                    document = null
                                    childNodes = outcome.childNodes
                                }
                                browseMessage = outcome.message
                            }
                        },
                        enabled = session != null,
                    ) {
                        Text("Refresh databases")
                    }
                    TextButton(
                        onClick = {
                            val selected = selectedDatabase
                            if (selected != null) {
                                scope.launch {
                                    val parent = parentPath(browsePath)
                                    runCatching {
                                        onListChildren(selected.databaseId, parent)
                                    }.onSuccess { loaded ->
                                        browsePath = parent
                                        document = null
                                        childNodes = loaded
                                    }.onFailure { error ->
                                        browseMessage = browseErrorMessage(error)
                                    }
                                }
                            }
                        },
                        enabled = selectedDatabase != null && browsePath != "/",
                    ) {
                        Text("Back")
                    }
                }
                if (browseMessage.isNotBlank()) {
                    Text(browseMessage, color = Color(0xFF66666F))
                }
                databases.forEach { database ->
                    TextButton(
                        onClick = {
                            scope.launch {
                                runCatching {
                                    onListChildren(database.databaseId, "/")
                                }.onSuccess { loaded ->
                                    databaseId = database.databaseId
                                    onSelectDatabase(database.databaseId)
                                    browsePath = "/"
                                    document = null
                                    childNodes = loaded
                                    browseMessage = database.displayTitle
                                }.onFailure { error ->
                                    browseMessage = browseErrorMessage(error)
                                }
                            }
                        },
                    ) {
                        Text(database.displayTitle + if (database.canWrite) " (write)" else " (read)")
                    }
                }
                if (selectedDatabase != null) {
                    Text("Path $browsePath", style = MaterialTheme.typography.bodySmall, color = Color(0xFF66666F))
                }
                document?.let { node ->
                    Text(node.path, fontWeight = FontWeight.Bold)
                    Text(node.content, style = MaterialTheme.typography.bodyMedium)
                }
                childNodes.forEach { child ->
                    TextButton(
                        onClick = {
                            val selected = selectedDatabase
                            if (selected != null) {
                                scope.launch {
                                    if (child.kind == VfsNodeKind.FOLDER) {
                                        runCatching {
                                            onListChildren(selected.databaseId, child.path)
                                        }.onSuccess { loaded ->
                                            browsePath = child.path
                                            document = null
                                            childNodes = loaded
                                        }.onFailure { error ->
                                            browseMessage = browseErrorMessage(error)
                                        }
                                    } else {
                                        runCatching {
                                            onReadNode(selected.databaseId, child.path)
                                        }.onSuccess { loaded ->
                                            document = loaded
                                        }.onFailure { error ->
                                            browseMessage = browseErrorMessage(error)
                                        }
                                    }
                                }
                            }
                        },
                    ) {
                        Text((if (child.kind == VfsNodeKind.FOLDER) "[Folder] " else "[File] ") + child.name)
                    }
                }
            }
        }
    }
}

private fun parentPath(path: String): String {
    if (path == "/") return "/"
    val trimmed = path.trimEnd('/')
    val parent = trimmed.substringBeforeLast("/", missingDelimiterValue = "")
    return parent.ifBlank { "/" }
}

internal data class BrowseRootRefreshOutcome(
    val databases: List<DatabaseSummary>?,
    val selectedDatabase: DatabaseSummary?,
    val childNodes: List<ChildNode>?,
    val message: String,
    val clearBrowse: Boolean,
)

internal suspend fun refreshBrowseRoot(
    currentDatabaseId: String,
    onRefreshDatabases: suspend () -> List<DatabaseSummary>,
    onListChildren: suspend (String, String) -> List<ChildNode>,
): BrowseRootRefreshOutcome =
    runCatching {
        val loaded = onRefreshDatabases()
        val next = loaded.firstOrNull { it.databaseId == currentDatabaseId } ?: loaded.firstOrNull()
        if (next == null) {
            BrowseRootRefreshOutcome(
                databases = loaded,
                selectedDatabase = null,
                childNodes = emptyList(),
                message = "No readable databases.",
                clearBrowse = true,
            )
        } else {
            BrowseRootRefreshOutcome(
                databases = loaded,
                selectedDatabase = next,
                childNodes = onListChildren(next.databaseId, "/"),
                message = "Loaded ${loaded.size} databases.",
                clearBrowse = false,
            )
        }
    }.getOrElse { error ->
        BrowseRootRefreshOutcome(
            databases = null,
            selectedDatabase = null,
            childNodes = null,
            message = error.message ?: "Failed to load browse data.",
            clearBrowse = false,
        )
    }

internal suspend fun resolveSubmitDatabase(
    selectedDatabase: DatabaseSummary?,
    databaseId: String,
    onResolveDatabase: suspend (String) -> DatabaseSummary?,
): DatabaseSummary? {
    if (selectedDatabase != null) return selectedDatabase
    val trimmed = databaseId.trim()
    if (trimmed.isBlank()) return null
    return onResolveDatabase(trimmed)
}

internal fun List<DatabaseSummary>.withResolvedDatabase(database: DatabaseSummary): List<DatabaseSummary> =
    if (none { it.databaseId == database.databaseId }) {
        this + database
    } else {
        map { existing -> if (existing.databaseId == database.databaseId) database else existing }
    }

private fun browseErrorMessage(error: Throwable): String =
    error.message ?: "Failed to load browse data."
