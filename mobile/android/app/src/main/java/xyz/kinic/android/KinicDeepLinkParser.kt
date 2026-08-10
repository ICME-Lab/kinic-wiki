package xyz.kinic.android

import java.net.URI
import java.net.URLDecoder

sealed interface KinicDestination {
    data class AuthCallback(val uri: URI) : KinicDestination
    data class Database(val databaseId: String, val nodePath: String) : KinicDestination
    data object Dashboard : KinicDestination
    data object Profile : KinicDestination
    data class Cycles(val databaseId: String?, val status: String?) : KinicDestination
    data object Root : KinicDestination
}

object KinicDeepLinkParser {
    fun parse(uri: URI): KinicDestination? {
        if (uri.scheme != "https" || uri.host != HOST || uri.userInfo != null || uri.port != -1) return null
        val path = uri.path ?: return null
        return when {
            path == "/native-auth-callback" -> KinicDestination.AuthCallback(uri)
            path == "/dashboard" -> KinicDestination.Dashboard
            path == "/profile" -> KinicDestination.Profile
            path == "/cycles" -> KinicDestination.Cycles(
                databaseId = queryValue(uri, "database_id"),
                status = queryValue(uri, "status"),
            )
            path == "/" || path.isEmpty() -> KinicDestination.Root
            path.startsWith("/db/") -> {
                val segments = path.removePrefix("/db/").split('/').filter(String::isNotEmpty)
                val databaseId = segments.firstOrNull()?.trim().orEmpty()
                if (databaseId.isEmpty()) null else KinicDestination.Database(
                    databaseId = databaseId,
                    nodePath = segments.drop(1).joinToString("/", prefix = "/").ifBlank { "/" },
                )
            }
            else -> null
        }
    }

    private fun queryValue(uri: URI, key: String): String? =
        uri.rawQuery?.split('&')?.firstNotNullOfOrNull { pair ->
            val name = pair.substringBefore('=')
            if (decode(name) == key) decode(pair.substringAfter('=', "")) else null
        }?.takeIf(String::isNotBlank)

    private fun decode(value: String): String =
        URLDecoder.decode(value, Charsets.UTF_8.name())

    private const val HOST = "wiki.kinic.xyz"
}
