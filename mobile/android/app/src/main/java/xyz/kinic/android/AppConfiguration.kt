// Where: mobile/android/app/src/main/java/xyz/kinic/android/AppConfiguration.kt
// What: Typed runtime configuration loaded from Android resources.
// Why: Native auth, IC calls, and worker triggers must share exact production endpoints.

package xyz.kinic.android

import android.content.Context
import xyz.kinic.android.ic.IcClientConfiguration
import java.net.URI

data class AppConfiguration(
    val canisterId: String,
    val apiBaseUrl: URI,
    val identityProvider: URI,
    val derivationOrigin: String,
    val authOrigin: URI,
    val callbackDomain: String,
    val askAiUrl: URI = URI("https://api.kinic.io/chat"),
) {
    val sourceCaptureTriggerUrl: URI =
        authOrigin.resolve("/api/source-capture/trigger")

    fun icClientConfiguration(): IcClientConfiguration =
        IcClientConfiguration(
            canisterId = canisterId,
            apiBaseUrl = apiBaseUrl,
            identityProvider = identityProvider,
            derivationOrigin = derivationOrigin,
        )

    companion object {
        fun fromResources(context: Context): AppConfiguration =
            AppConfiguration(
                canisterId = context.getString(R.string.kinic_canister_id),
                apiBaseUrl = URI(context.getString(R.string.kinic_api_base_url)),
                identityProvider = URI(context.getString(R.string.kinic_identity_provider)),
                derivationOrigin = context.getString(R.string.kinic_derivation_origin),
                authOrigin = URI(context.getString(R.string.kinic_auth_origin)),
                callbackDomain = context.getString(R.string.kinic_callback_domain),
                askAiUrl = URI(context.getString(R.string.kinic_ask_ai_url)),
            )
    }
}
