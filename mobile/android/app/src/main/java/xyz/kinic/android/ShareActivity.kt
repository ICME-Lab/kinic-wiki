package xyz.kinic.android

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.net.URI

class ShareActivity : ComponentActivity() {
    private var message by mutableStateOf("Preparing shared URL...")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                Column(
                    modifier = Modifier.fillMaxSize().padding(24.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    Text("KinicWiki", style = MaterialTheme.typography.headlineSmall)
                    Text(message)
                    Button(
                        onClick = {
                            startActivity(
                                Intent(this@ShareActivity, MainActivity::class.java)
                                    .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP),
                            )
                            finish()
                        },
                    ) {
                        Text("Open KinicWiki")
                    }
                }
            }
        }
        if (savedInstanceState == null) {
            submitSharedUrl()
        }
    }

    private fun submitSharedUrl() {
        val sharedUrl = sharedUrl() ?: run {
            message = "No valid shared URL."
            return
        }
        val configuration = AppConfiguration.fromResources(this)
        val authService = kinicAuthService(configuration, applicationContext)
        val settingsStore = kinicSettingsStore(filesDir)
        val inbox = ShareInbox(File(filesDir, "pending-shared-urls.v2"))
        val historyStore = sourceCaptureHistoryStore(filesDir)
        val vfsClient = KinicVfsClient(configuration)
        val submitter = SourceCaptureSubmitter(
            inbox = inbox,
            gateway = KinicIcClient(configuration),
            resolveDatabase = { databaseId, session ->
                vfsClient.listReadableDatabases(session).firstOrNull { it.databaseId == databaseId }
            },
            historyStore = historyStore,
        )
        lifecycleScope.launch {
            val metadata = withContext(Dispatchers.IO) {
                XPostMetadataFetcher().metadata(sharedUrl)
            }
            runCatching {
                inbox.enqueue(
                    url = sharedUrl,
                    databaseId = settingsStore.selectedDatabaseId,
                    captureMetadata = metadata,
                    outputLanguage = settingsStore.generationLanguage,
                )
            }.onFailure {
                message = it.message ?: "Failed to queue the shared URL."
                return@launch
            }
            val session = authService.restore()
            if (session == null || settingsStore.selectedDatabaseId.isBlank()) {
                message = "Queued for submission in KinicWiki."
                return@launch
            }
            message = submitter.submitNextPendingUrl(
                session = session,
                selectedDatabase = null,
            )
        }
    }

    private fun sharedUrl(): URI? {
        if (intent?.action != Intent.ACTION_SEND) return null
        val text = intent.getStringExtra(Intent.EXTRA_TEXT)?.trim().orEmpty()
        val candidate = HTTP_URL.find(text)?.value?.trimEnd('.', ',', ')', ']', '}') ?: return null
        return runCatching { URLNormalizer.normalizedHttpUrl(candidate) }.getOrNull()
    }

    private companion object {
        val HTTP_URL = Regex("""https?://\S+""", RegexOption.IGNORE_CASE)
    }
}
