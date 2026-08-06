// Where: mobile/android/app/src/main/java/xyz/kinic/android/ic/IcInternetIdentityAuthenticator.kt
// What: Android-neutral native-auth URL and callback parser.
// Why: Activities can launch browser auth while the IC session logic stays testable on the JVM.

package xyz.kinic.android.ic

import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder

data class IcPendingAuthRequest(
    val state: String,
    val sessionPrivateKey: ByteArray,
    val url: URI,
) {
    override fun equals(other: kotlin.Any?): Boolean {
        if (other !is IcPendingAuthRequest) return false
        return state == other.state && sessionPrivateKey.contentEquals(other.sessionPrivateKey) && url == other.url
    }

    override fun hashCode(): Int =
        31 * (31 * state.hashCode() + sessionPrivateKey.contentHashCode()) + url.hashCode()
}

object IcInternetIdentityAuthenticator {
    const val callbackPath: String = "/android-auth-callback"

    fun authorizationRequest(
        authOrigin: URI,
        callbackDomain: String,
        configuration: IcClientConfiguration,
        state: String = java.util.UUID.randomUUID().toString(),
        sessionPrivateKey: ByteArray = IcIdentityBridge.generateSessionPrivateKey(),
    ): IcPendingAuthRequest {
        val sessionPublicKey = IcIdentityBridge.derPublicKey(IcIdentityBridge.rawPublicKey(sessionPrivateKey))
        val callback = callbackUrl(callbackDomain)
        val query = listOf(
            "state" to state,
            "callback" to callback.toString(),
            "sessionPublicKey" to sessionPublicKey.base64UrlNoPadding(),
            "maxTimeToLive" to IcIdentityBridge.maxTimeToLiveNanos,
            "identityProvider" to configuration.identityProvider.toString(),
        ).joinToString("&") { (key, value) -> "${urlEncode(key)}=${urlEncode(value)}" }
        val origin = authOrigin.toString().trimEnd('/')
        return IcPendingAuthRequest(
            state = state,
            sessionPrivateKey = sessionPrivateKey,
            url = URI("$origin/#/native-auth?$query"),
        )
    }

    fun callbackUrl(callbackDomain: String): URI =
        URI("https://$callbackDomain$callbackPath")

    fun sessionFromCallback(
        callbackUrl: URI,
        expectedState: String,
        sessionPrivateKey: ByteArray,
        configuration: IcClientConfiguration,
    ): IcAuthSession {
        val values = queryValues(callbackUrl.rawQuery ?: "")
        if (values["state"] != expectedState) throw IcClientError.InvalidPayload
        val encodedError = values["error"]
        if (encodedError != null) {
            val message = encodedError.base64UrlDecoded().toString(Charsets.UTF_8)
            throw IcClientError.AuthorizationFailed(message)
        }
        val encodedResult = values["result"] ?: throw IcClientError.InvalidPayload
        val payload = encodedResult.base64UrlDecoded().toString(Charsets.UTF_8)
        return IcIdentityBridge.makeSession(payload, sessionPrivateKey, configuration)
    }

    private fun queryValues(rawQuery: String): Map<String, String> {
        if (rawQuery.isBlank()) return emptyMap()
        val values = mutableMapOf<String, String>()
        rawQuery.split("&").forEach { part ->
            val pieces = part.split("=", limit = 2)
            val key = urlDecode(pieces[0])
            val value = if (pieces.size == 2) urlDecode(pieces[1]) else ""
            if (values.containsKey(key)) throw IcClientError.InvalidPayload
            values[key] = value
        }
        return values
    }

    private fun urlEncode(value: String): String =
        URLEncoder.encode(value, Charsets.UTF_8.name())

    private fun urlDecode(value: String): String =
        URLDecoder.decode(value, Charsets.UTF_8.name())
}
