// Where: mobile/android/app/src/main/java/xyz/kinic/android/ic/IcClientConfiguration.kt
// What: Network and identity-provider configuration for Android IC calls.
// Why: Auth, query, call, and read_state endpoints must derive from one typed source.

package xyz.kinic.android.ic

import java.net.URI

enum class IcClientApiVersion(val raw: String) {
    V2("v2"),
    V3("v3"),
    V4("v4"),
}

data class IcClientConfiguration(
    val canisterId: String,
    val apiBaseUrl: URI = URI("https://ic0.app"),
    val identityProvider: URI = URI("https://id.ai/#authorize"),
    val derivationOrigin: String,
) {
    fun apiUrl(requestType: String, canisterId: String = this.canisterId, version: IcClientApiVersion? = null): URI {
        val resolved = version ?: defaultApiVersion(requestType)
        val base = apiBaseUrl.toString().trimEnd('/')
        return URI("$base/api/${resolved.raw}/canister/$canisterId/$requestType")
    }

    private fun defaultApiVersion(requestType: String): IcClientApiVersion =
        when (requestType) {
            "query", "read_state" -> IcClientApiVersion.V3
            "call" -> IcClientApiVersion.V4
            else -> IcClientApiVersion.V2
        }
}
