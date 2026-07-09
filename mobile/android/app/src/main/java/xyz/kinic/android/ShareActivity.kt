// Where: mobile/android/app/src/main/java/xyz/kinic/android/ShareActivity.kt
// What: Android share target for URL capture.
// Why: Browser shares should enter the shared pending queue for later app-side capture.

package xyz.kinic.android

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.mutableStateOf
import xyz.kinic.android.ic.IcAuthSession
import java.io.File
import java.net.URI

class ShareActivity : ComponentActivity() {
    private val sessionState = mutableStateOf<IcAuthSession?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val configuration = AppConfiguration.fromResources(this)
        val authService = kinicAuthService(configuration, filesDir)
        val settingsStore = kinicSettingsStore(filesDir)
        val inbox = ShareInbox(File(filesDir, "pending-shared-urls.v2"))
        val vfsClient = KinicVfsClient(configuration)
        val submitter = SourceCaptureSubmitter(
            inbox = inbox,
            gateway = KinicIcClient(configuration),
            resolveDatabase = { databaseId, session ->
                vfsClient.listReadableDatabases(session).firstOrNull { it.databaseId == databaseId }
            },
        )
        sessionState.value = authService.restore()
        val initialMessage = enqueueSharedText(inbox)
        setContent {
            KinicAppView(
                inbox = inbox,
                session = sessionState.value,
                message = initialMessage,
                initialSelectedDatabaseId = settingsStore.selectedBrowseDatabaseId.ifBlank { settingsStore.selectedDatabaseId },
                onSignIn = {
                    val url = authService.startSignIn()
                    startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(url.toString())))
                    "Opening Internet Identity..."
                },
                onSignOut = {
                    authService.signOut()
                    sessionState.value = null
                    "Signed out."
                },
                onSubmitNext = submit@ { database ->
                    val session = sessionState.value ?: return@submit "Sign in before submitting."
                    submitter.submitNextPendingUrl(session = session, selectedDatabase = database)
                },
                onResolveDatabase = resolve@ { databaseId ->
                    val session = sessionState.value ?: return@resolve null
                    vfsClient.listReadableDatabases(session).firstOrNull { it.databaseId == databaseId }
                },
                onRefreshDatabases = refresh@ {
                    val session = sessionState.value ?: return@refresh emptyList()
                    vfsClient.listReadableDatabases(session)
                },
                onSelectDatabase = { databaseId ->
                    settingsStore.selectedDatabaseId = databaseId
                    settingsStore.selectedBrowseDatabaseId = databaseId
                },
                onListChildren = children@ { databaseId, path ->
                    val session = sessionState.value ?: return@children emptyList()
                    vfsClient.listBrowseChildren(databaseId = databaseId, path = path, session = session)
                },
                onReadNode = node@ { databaseId, path ->
                    val session = sessionState.value ?: return@node null
                    vfsClient.readBrowseNode(databaseId = databaseId, path = path, session = session)
                },
            )
        }
    }

    private fun enqueueSharedText(inbox: ShareInbox): String {
        if (intent?.action != Intent.ACTION_SEND) return "No shared URL"
        val text = intent.getStringExtra(Intent.EXTRA_TEXT)?.trim()
        if (text.isNullOrEmpty()) return "No shared URL"
        val candidate = text.lineSequence().firstOrNull { it.startsWith("http://") || it.startsWith("https://") }
            ?: text
        return runCatching {
            inbox.enqueue(URI(candidate))
            "Queued"
        }.getOrElse {
            it.message ?: "Failed"
        }
    }
}
