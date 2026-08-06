// Where: mobile/android/app/src/main/java/xyz/kinic/android/ic/IcIdentityStore.kt
// What: App-private storage for Android Internet Identity sessions.
// Why: The first Android port needs durable auth restore before Keystore hardening.

package xyz.kinic.android.ic

import android.content.Context
import xyz.kinic.android.AndroidKeystoreAuthSecretCipher
import xyz.kinic.android.AuthSecretStore
import java.io.File

class IcIdentityStore(
    private val context: Context,
    private val configuration: IcClientConfiguration,
    private val fileName: String = "internet-identity-session.json",
) {
    private val store = AuthSecretStore(
        File(context.filesDir, fileName),
        AndroidKeystoreAuthSecretCipher(),
    )

    fun restore(): IcAuthSession? {
        val stored = try {
            store.read()
        } catch (_: Exception) {
            clear()
            return null
        } ?: return null
        val session = try {
            IcIdentityBridge.decodeSession(stored.value)
        } catch (_: Exception) {
            clear()
            return null
        }
        return try {
            IcIdentityBridge.validateSession(session, configuration)
            if (stored.isLegacyPlaintext) {
                store.write(IcIdentityBridge.encodeSession(session))
            }
            session
        } catch (_: Exception) {
            clear()
            null
        }
    }

    fun save(session: IcAuthSession) {
        IcIdentityBridge.validateSession(session, configuration)
        store.write(IcIdentityBridge.encodeSession(session))
    }

    fun clear() {
        store.clear()
    }
}
