// Where: mobile/android/app/src/main/java/xyz/kinic/android/MainActivity.kt
// What: Android app entry point.
// Why: The native app owns capture queue state and future auth callback handling.

package xyz.kinic.android

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.mutableStateOf
import xyz.kinic.android.ic.IcAuthSession
import java.io.File
import java.net.URI

class MainActivity : ComponentActivity() {
    private lateinit var configuration: AppConfiguration
    private lateinit var authService: KinicAuthService
    private lateinit var settingsStore: KinicSettingsStore
    private lateinit var inbox: ShareInbox
    private lateinit var submitter: SourceCaptureSubmitter
    private lateinit var vfsClient: KinicVfsClient
    private val sessionState = mutableStateOf<IcAuthSession?>(null)
    private val messageState = mutableStateOf("")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        configuration = AppConfiguration.fromResources(this)
        authService = kinicAuthService(configuration, applicationContext)
        settingsStore = kinicSettingsStore(filesDir)
        inbox = ShareInbox(File(filesDir, "pending-shared-urls.v2"))
        vfsClient = KinicVfsClient(configuration)
        submitter = SourceCaptureSubmitter(
            inbox = inbox,
            gateway = KinicIcClient(configuration),
            resolveDatabase = { databaseId, session ->
                vfsClient.listReadableDatabases(session).firstOrNull { it.databaseId == databaseId }
            },
        )
        sessionState.value = authService.restore()
        handleAuthCallback(intent?.data?.let { URI(it.toString()) })
        setContent {
            KinicAppView(
                inbox = inbox,
                session = sessionState.value,
                message = messageState.value,
                initialSelectedDatabaseId = settingsStore.selectedBrowseDatabaseId.ifBlank { settingsStore.selectedDatabaseId },
                onSignIn = ::startSignIn,
                onSignOut = ::signOut,
                onSubmitNext = ::submitNextPendingUrl,
                onResolveDatabase = ::resolveDatabase,
                onRefreshDatabases = ::refreshDatabases,
                onSelectDatabase = ::selectDatabase,
                onListChildren = ::listChildren,
                onReadNode = ::readNode,
            )
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleAuthCallback(intent.data?.let { URI(it.toString()) })
    }

    private fun startSignIn(): String {
        val url = authService.startSignIn()
        startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(url.toString())))
        return "Opening Internet Identity..."
    }

    private fun signOut(): String {
        authService.signOut()
        sessionState.value = null
        return "Signed out."
    }

    private suspend fun submitNextPendingUrl(database: DatabaseSummary?): String {
        val session = sessionState.value ?: return "Sign in before submitting."
        return submitter.submitNextPendingUrl(session = session, selectedDatabase = database)
    }

    private suspend fun refreshDatabases(): List<DatabaseSummary> {
        val session = sessionState.value ?: return emptyList()
        return vfsClient.listReadableDatabases(session)
    }

    private suspend fun resolveDatabase(databaseId: String): DatabaseSummary? {
        val session = sessionState.value ?: return null
        return vfsClient.listReadableDatabases(session).firstOrNull { it.databaseId == databaseId }
    }

    private fun selectDatabase(databaseId: String) {
        settingsStore.selectedDatabaseId = databaseId
        settingsStore.selectedBrowseDatabaseId = databaseId
    }

    private suspend fun listChildren(databaseId: String, path: String): List<ChildNode> {
        val session = sessionState.value ?: return emptyList()
        return vfsClient.listBrowseChildren(databaseId = databaseId, path = path, session = session)
    }

    private suspend fun readNode(databaseId: String, path: String): VfsNode? {
        val session = sessionState.value ?: return null
        return vfsClient.readBrowseNode(databaseId = databaseId, path = path, session = session)
    }

    private fun handleAuthCallback(callbackUri: URI?) {
        if (callbackUri == null) return
        if (callbackUri.path != "/android-auth-callback") return
        runCatching {
            authService.completeSignIn(callbackUri)
        }.onSuccess { session ->
            sessionState.value = session
            messageState.value = "Signed in."
        }.onFailure { error ->
            messageState.value = error.message ?: "Sign in failed."
        }
    }
}
