// Where: mobile/android/app/src/main/java/xyz/kinic/android/ic/IcIdentityStore.kt
// What: App-private storage for Android Internet Identity sessions.
// Why: The first Android port needs durable auth restore before Keystore hardening.

package xyz.kinic.android.ic

import android.content.Context
import java.io.File

class IcIdentityStore(
    private val context: Context,
    private val configuration: IcClientConfiguration,
    private val fileName: String = "internet-identity-session.json",
) {
    fun restore(): IcAuthSession? {
        val file = file()
        if (!file.exists()) return null
        val session = try {
            IcIdentityBridge.decodeSession(file.readText(Charsets.UTF_8))
        } catch (_: Exception) {
            clear()
            return null
        }
        return try {
            IcIdentityBridge.validateSession(session, configuration)
            session
        } catch (_: Exception) {
            clear()
            null
        }
    }

    fun save(session: IcAuthSession) {
        IcIdentityBridge.validateSession(session, configuration)
        file().writeText(IcIdentityBridge.encodeSession(session), Charsets.UTF_8)
    }

    fun clear() {
        file().delete()
    }

    private fun file(): File =
        File(context.filesDir, fileName)
}
