// Where: mobile/android/app/src/main/java/xyz/kinic/android/KinicAuthService.kt
// What: File-backed Android Internet Identity session orchestration.
// Why: Browser native-auth callbacks must bind to the pending Ed25519 session key before IC calls.

package xyz.kinic.android

import org.json.JSONObject
import xyz.kinic.android.ic.IcAuthSession
import xyz.kinic.android.ic.IcClientError
import xyz.kinic.android.ic.IcIdentityBridge
import xyz.kinic.android.ic.IcInternetIdentityAuthenticator
import android.content.Context
import java.io.File
import java.net.URI
import java.util.Base64

class KinicAuthService internal constructor(
    private val configuration: AppConfiguration,
    sessionFile: File,
    pendingFile: File,
    cipher: AuthSecretCipher,
) {
    private val sessionStore = AuthSecretStore(sessionFile, cipher)
    private val pendingStore = AuthSecretStore(pendingFile, cipher)

    fun restore(): IcAuthSession? {
        val stored = try {
            sessionStore.read()
        } catch (_: Exception) {
            signOut()
            return null
        } ?: return null
        val session = try {
            IcIdentityBridge.decodeSession(stored.value)
        } catch (_: Exception) {
            signOut()
            return null
        }
        return try {
            IcIdentityBridge.validateSession(session, configuration.icClientConfiguration())
            if (stored.isLegacyPlaintext) {
                sessionStore.write(IcIdentityBridge.encodeSession(session))
            }
            session
        } catch (_: Exception) {
            signOut()
            null
        }
    }

    fun startSignIn(): URI {
        val request = IcInternetIdentityAuthenticator.authorizationRequest(
            authOrigin = configuration.authOrigin,
            callbackDomain = configuration.callbackDomain,
            configuration = configuration.icClientConfiguration(),
        )
        pendingStore.write(
            JSONObject()
                .put("state", request.state)
                .put("sessionPrivateKey", base64Url(request.sessionPrivateKey))
                .toString(),
        )
        return request.url
    }

    fun completeSignIn(callbackUri: URI): IcAuthSession {
        val host = callbackUri.host ?: throw IcClientError.InvalidPayload
        if (host.lowercase() != configuration.callbackDomain.lowercase()) {
            throw IcClientError.InvalidPayload
        }
        if (callbackUri.path != IcInternetIdentityAuthenticator.callbackPath) {
            throw IcClientError.InvalidPayload
        }
        val pending = pendingAuth()
        val session = try {
            IcInternetIdentityAuthenticator.sessionFromCallback(
                callbackUrl = callbackUri,
                expectedState = pending.state,
                sessionPrivateKey = pending.sessionPrivateKey,
                configuration = configuration.icClientConfiguration(),
            )
        } catch (error: IcClientError.AuthorizationFailed) {
            clearPending()
            throw error
        }
        IcIdentityBridge.validateSession(session, configuration.icClientConfiguration())
        sessionStore.write(IcIdentityBridge.encodeSession(session))
        clearPending()
        return session
    }

    fun signOut() {
        sessionStore.clear()
        clearPending()
    }

    fun hasPendingSignIn(): Boolean =
        pendingStore.exists()

    private fun pendingAuth(): PendingAuth {
        val stored = try {
            pendingStore.read() ?: throw IcClientError.InvalidPayload
        } catch (_: Exception) {
            throw IcClientError.InvalidPayload
        }
        val json = try {
            JSONObject(stored.value)
        } catch (_: Exception) {
            throw IcClientError.InvalidPayload
        }
        val pending = PendingAuth(
            state = json.getString("state"),
            sessionPrivateKey = base64UrlDecoded(json.getString("sessionPrivateKey")),
        )
        if (stored.isLegacyPlaintext) {
            pendingStore.write(stored.value)
        }
        return pending
    }

    private fun clearPending() {
        pendingStore.clear()
    }

    private data class PendingAuth(
        val state: String,
        val sessionPrivateKey: ByteArray,
    )
}

fun kinicAuthService(configuration: AppConfiguration, context: Context): KinicAuthService =
    KinicAuthService(
        configuration = configuration,
        sessionFile = File(context.filesDir, "internet-identity-session.json"),
        pendingFile = File(context.filesDir, "internet-identity-pending.json"),
        cipher = AndroidKeystoreAuthSecretCipher(),
    )

private fun base64Url(bytes: ByteArray): String =
    Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

private fun base64UrlDecoded(value: String): ByteArray =
    Base64.getUrlDecoder().decode(value)
