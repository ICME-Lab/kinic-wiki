// Where: mobile/android/app/src/main/java/xyz/kinic/android/ic/IcInternetIdentityAuthenticator.kt
// What: Direct ICRC-167 Internet Identity URL transport for Android.
// Why: Native authentication must exchange delegation data directly through URL fragments.

package xyz.kinic.android.ic

import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder
import java.util.Base64

data class IcPendingAuthRequest(
    val state: String,
    val requestId: String,
    val sessionPrivateKey: ByteArray,
    val url: URI,
) {
    override fun equals(other: kotlin.Any?): Boolean {
        if (other !is IcPendingAuthRequest) return false
        return state == other.state &&
            requestId == other.requestId &&
            sessionPrivateKey.contentEquals(other.sessionPrivateKey) &&
            url == other.url
    }

    override fun hashCode(): Int =
        31 * (31 * (31 * state.hashCode() + requestId.hashCode()) + sessionPrivateKey.contentHashCode()) + url.hashCode()
}

object IcInternetIdentityAuthenticator {
    const val callbackPath: String = "/native-auth-callback"

    fun authorizationRequest(
        callbackDomain: String,
        configuration: IcClientConfiguration,
        state: String = java.util.UUID.randomUUID().toString(),
        requestId: String = java.util.UUID.randomUUID().toString(),
        sessionPrivateKey: ByteArray = IcIdentitySession.generateSessionPrivateKey(),
    ): IcPendingAuthRequest {
        if (state.isEmpty() || requestId.isEmpty()) throw IcClientError.InvalidPayload
        val provider = configuration.identityProvider
        if (
            provider.scheme?.lowercase() != "https" ||
            provider.host == null ||
            provider.rawUserInfo != null ||
            provider.rawFragment != null
        ) {
            throw IcClientError.InvalidPayload
        }
        val sessionPublicKey = IcIdentitySession.derPublicKey(IcIdentitySession.rawPublicKey(sessionPrivateKey))
        val request = JSONObject()
            .put("jsonrpc", "2.0")
            .put("id", requestId)
            .put("method", "icrc34_delegation")
            .put(
                "params",
                JSONObject()
                    .put("publicKey", Base64.getEncoder().encodeToString(sessionPublicKey))
                    .put("maxTimeToLive", IcIdentitySession.maxTimeToLiveNanos)
                    .put("icrc95DerivationOrigin", configuration.derivationOrigin),
            )
        val fragment = listOf(
            "message" to request.toString(),
            "callback" to callbackUrl(callbackDomain).toString(),
            "state" to state,
        ).joinToString("&") { (key, value) -> "${urlEncode(key)}=${urlEncode(value)}" }
        return IcPendingAuthRequest(
            state = state,
            requestId = requestId,
            sessionPrivateKey = sessionPrivateKey,
            url = URI("${provider}#$fragment"),
        )
    }

    fun callbackUrl(callbackDomain: String): URI {
        val callback = try {
            URI("https://$callbackDomain$callbackPath")
        } catch (_: Exception) {
            throw IcClientError.InvalidPayload
        }
        if (
            callback.scheme != "https" ||
            callback.host != callbackDomain ||
            callback.port != -1 ||
            callback.rawUserInfo != null ||
            callback.path != callbackPath ||
            callback.rawQuery != null ||
            callback.rawFragment != null
        ) {
            throw IcClientError.InvalidPayload
        }
        return callback
    }

    fun sessionFromCallback(
        callbackUrl: URI,
        callbackDomain: String,
        expectedState: String,
        expectedRequestId: String,
        sessionPrivateKey: ByteArray,
        configuration: IcClientConfiguration,
    ): IcAuthSession {
        if (
            callbackUrl.scheme?.lowercase() != "https" ||
            callbackUrl.host?.lowercase() != callbackDomain.lowercase() ||
            callbackUrl.port != -1 ||
            callbackUrl.rawUserInfo != null ||
            callbackUrl.path != callbackPath ||
            callbackUrl.rawQuery != null ||
            callbackUrl.rawFragment == null
        ) {
            throw IcClientError.InvalidPayload
        }
        val values = fragmentValues(callbackUrl.rawFragment)
        if (values.keys != setOf("message", "state") || values["state"] != expectedState) {
            throw IcClientError.InvalidPayload
        }
        val response = jsonObject(values.getValue("message"))
        if (response.stringKeys() !in setOf(setOf("jsonrpc", "id", "result"), setOf("jsonrpc", "id", "error"))) {
            throw IcClientError.InvalidPayload
        }
        if (response.optString("jsonrpc") != "2.0" || response.optString("id") != expectedRequestId) {
            throw IcClientError.InvalidPayload
        }
        response.optJSONObject("error")?.let { error ->
            throw IcClientError.AuthorizationFailed(error.optString("message", "Internet Identity authorization failed."))
        }
        val result = response.optJSONObject("result") ?: throw IcClientError.InvalidPayload
        if (result.stringKeys() != setOf("publicKey", "signerDelegation")) throw IcClientError.InvalidPayload
        val publicKey = standardBase64(result.optString("publicKey"))
        val rawDelegations = result.optJSONArray("signerDelegation") ?: throw IcClientError.InvalidPayload
        if (rawDelegations.length() == 0) throw IcClientError.InvalidPayload
        val delegations = (0 until rawDelegations.length()).map { index ->
            signedDelegation(rawDelegations.optJSONObject(index) ?: throw IcClientError.InvalidPayload)
        }
        return IcIdentitySession.makeSession(
            delegation = IcDelegationChain(publicKey = publicKey, delegations = delegations),
            privateKey = sessionPrivateKey,
            configuration = configuration,
        )
    }

    private fun signedDelegation(item: JSONObject): IcDelegationChain.SignedDelegation {
        if (item.stringKeys() != setOf("delegation", "signature")) throw IcClientError.InvalidPayload
        val delegation = item.optJSONObject("delegation") ?: throw IcClientError.InvalidPayload
        val keys = delegation.stringKeys()
        if (keys != setOf("pubkey", "expiration") && keys != setOf("pubkey", "expiration", "targets")) {
            throw IcClientError.InvalidPayload
        }
        val publicKey = standardBase64(delegation.optString("pubkey"))
        val expiration = delegation.optString("expiration").toULongOrNull() ?: throw IcClientError.InvalidPayload
        val targets = delegation.optJSONArray("targets")?.let(::principalTargets)
        return IcDelegationChain.SignedDelegation(
            delegation = IcDelegationChain.Delegation(publicKey = publicKey, expiration = expiration, targets = targets),
            signature = standardBase64(item.optString("signature")),
        )
    }

    private fun principalTargets(values: JSONArray): List<ByteArray> =
        (0 until values.length()).map { index ->
            val value = values.optString(index, "")
            IcPrincipal.parse(value) ?: throw IcClientError.InvalidPayload
        }

    private fun jsonObject(value: String): JSONObject =
        try {
            JSONObject(value)
        } catch (_: Exception) {
            throw IcClientError.InvalidPayload
        }

    private fun JSONObject.stringKeys(): Set<String> = keys().asSequence().toSet()

    private fun standardBase64(value: String): ByteArray =
        try {
            if (value.isEmpty()) throw IllegalArgumentException()
            Base64.getDecoder().decode(value)
        } catch (_: IllegalArgumentException) {
            throw IcClientError.InvalidPayload
        }

    private fun fragmentValues(rawFragment: String): Map<String, String> {
        if (rawFragment.isBlank()) throw IcClientError.InvalidPayload
        val values = mutableMapOf<String, String>()
        try {
            rawFragment.split("&").forEach { part ->
                val pieces = part.split("=", limit = 2)
                if (pieces.size != 2) throw IcClientError.InvalidPayload
                val key = urlDecode(pieces[0])
                val value = urlDecode(pieces[1])
                if (values.put(key, value) != null) throw IcClientError.InvalidPayload
            }
        } catch (error: IcClientError) {
            throw error
        } catch (_: IllegalArgumentException) {
            throw IcClientError.InvalidPayload
        }
        return values
    }

    private fun urlEncode(value: String): String = URLEncoder.encode(value, Charsets.UTF_8.name())

    private fun urlDecode(value: String): String = URLDecoder.decode(value, Charsets.UTF_8.name())
}
