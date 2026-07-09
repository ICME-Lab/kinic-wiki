// Where: mobile/android/app/src/main/java/xyz/kinic/android/MainActivity.kt
// What: Android app entry point.
// Why: The native app owns capture queue state and future auth callback handling.

package xyz.kinic.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import java.io.File

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val inbox = ShareInbox(File(filesDir, "pending-shared-urls.v2"))
        val message = intent?.data?.let { "Auth callback received" }
        setContent {
            KinicAppView(inbox = inbox, initialMessage = message)
        }
    }
}
