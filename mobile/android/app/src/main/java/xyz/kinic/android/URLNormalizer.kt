// Where: mobile/android/app/src/main/java/xyz/kinic/android/URLNormalizer.kt
// What: URL normalization shared by manual and Android share captures.
// Why: Android request generation must match iOS by accepting only http(s) and removing fragments.

package xyz.kinic.android

import java.net.URI

object URLNormalizer {
    fun normalizedHttpUrl(raw: String): URI =
        normalizedHttpUrl(URI(raw.trim()))

    fun normalizedHttpUrl(uri: URI): URI {
        val scheme = uri.scheme?.lowercase()
        val host = uri.host
        if ((scheme != "http" && scheme != "https") || host.isNullOrBlank()) {
            throw URLNormalizerException.UnsupportedUrl
        }
        return URI(
            scheme,
            uri.userInfo,
            host,
            uri.port,
            uri.path,
            uri.query,
            null,
        )
    }
}

sealed class URLNormalizerException(message: String) : IllegalArgumentException(message) {
    data object UnsupportedUrl : URLNormalizerException("unsupported URL")
}
