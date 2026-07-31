// Where: mobile/android/app/src/main/java/xyz/kinic/android/MainActivity.kt
// What: Android app entry point.
// Why: The native app owns capture queue state and future auth callback handling.

package xyz.kinic.android

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.lifecycle.ViewModelProvider
import java.io.File
import java.net.URI

class MainActivity : ComponentActivity() {
    private lateinit var viewModel: KinicAppViewModel

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val configuration = AppConfiguration.fromResources(this)
        val authService = kinicAuthService(configuration, applicationContext)
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
        viewModel = ViewModelProvider(
            this,
            KinicAppViewModelFactory(
                configuration,
                authService,
                settingsStore,
                inbox,
                submitter,
                vfsClient,
            ),
        )[KinicAppViewModel::class.java]
        handleIntent(intent)
        setContent {
            KinicAppShell(
                viewModel = viewModel,
                onOpenUri = { uri ->
                    startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(uri.toString())))
                },
                onCopyText = { label, value ->
                    val clipboard = getSystemService(ClipboardManager::class.java)
                    clipboard.setPrimaryClip(ClipData.newPlainText(label, value))
                },
            )
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        val callbackUri = intent?.data?.let { URI(it.toString()) } ?: return
        if (callbackUri.path == "/android-auth-callback") {
            viewModel.completeSignIn(callbackUri)
        }
    }
}
