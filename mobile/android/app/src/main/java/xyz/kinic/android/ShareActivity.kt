// Where: mobile/android/app/src/main/java/xyz/kinic/android/ShareActivity.kt
// What: Android share target for URL capture.
// Why: Browser shares should enter the shared pending queue for later app-side capture.

package xyz.kinic.android

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import java.io.File
import java.net.URI

class ShareActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val inbox = ShareInbox(File(filesDir, "pending-shared-urls.v2"))
        val message = enqueueSharedText(inbox)
        setContent {
            KinicAppView(inbox = inbox, initialMessage = message)
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
