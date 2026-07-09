// Where: mobile/android/app/src/main/java/xyz/kinic/android/KinicAuthService.kt
// What: File-backed Android Internet Identity session orchestration.
// Why: Browser native-auth callbacks must bind to the pending Ed25519 session key before IC calls.

package xyz.kinic.android

import org.json.JSONObject
import xyz.kinic.android.ic.IcAuthSession
import xyz.kinic.android.ic.IcClientError
import xyz.kinic.android.ic.IcIdentityBridge
import xyz.kinic.android.ic.IcInternetIdentityAuthenticator
import java.io.File
import java.net.URI
import java.util.Base64

class KinicAuthService(
    private val configuration: AppConfiguration,
    private val sessionFile: File,
    private val pendingFile: File,
) {
    fun restore(): IcAuthSession? {
        if (!sessionFile.exists()) return null
        val session = try {
            IcIdentityBridge.decodeSession(sessionFile.readText(Charsets.UTF_8))
        } catch (_: Exception) {
            signOut()
            return null
        }
        return try {
            IcIdentityBridge.validateSession(session, configuration.icClientConfiguration())
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
        ensureParentDirectory(pendingFile)
        pendingFile.writeText(
            JSONObject()
                .put("state", request.state)
                .put("sessionPrivateKey", base64Url(request.sessionPrivateKey))
                .toString(),
            Charsets.UTF_8,
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
        ensureParentDirectory(sessionFile)
        sessionFile.writeText(IcIdentityBridge.encodeSession(session), Charsets.UTF_8)
        clearPending()
        return session
    }

    fun signOut() {
        sessionFile.delete()
        clearPending()
    }

    fun hasPendingSignIn(): Boolean =
        pendingFile.exists()

    private fun pendingAuth(): PendingAuth {
        val json = try {
            JSONObject(pendingFile.readText(Charsets.UTF_8))
        } catch (_: Exception) {
            throw IcClientError.InvalidPayload
        }
        return PendingAuth(
            state = json.getString("state"),
            sessionPrivateKey = base64UrlDecoded(json.getString("sessionPrivateKey")),
        )
    }

    private fun clearPending() {
        pendingFile.delete()
    }

    private data class PendingAuth(
        val state: String,
        val sessionPrivateKey: ByteArray,
    )
}

fun kinicAuthService(configuration: AppConfiguration, filesDir: File): KinicAuthService =
    KinicAuthService(
        configuration = configuration,
        sessionFile = File(filesDir, "internet-identity-session.json"),
        pendingFile = File(filesDir, "internet-identity-pending.json"),
    )

private fun ensureParentDirectory(file: File) {
    file.parentFile?.mkdirs()
}

private fun base64Url(bytes: ByteArray): String =
    Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

private fun base64UrlDecoded(value: String): ByteArray =
    Base64.getUrlDecoder().decode(value)
