// Where: mobile/android/app/src/test/java/xyz/kinic/android/KinicAuthServiceTest.kt
// What: JVM tests for Android native-auth pending state and session persistence.
// Why: Browser callbacks must bind to the generated session key before source capture can sign IC calls.

package xyz.kinic.android

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test
import xyz.kinic.android.ic.IcClientError
import xyz.kinic.android.ic.identityPayload
import java.io.File
import java.net.URI
import java.nio.file.Files
import java.util.Base64

class KinicAuthServiceTest {
    @Test
    fun startSignInBuildsNativeAuthUrlAndStoresPendingKey() {
        withTemporaryAuthService { service, _, pendingFile, _ ->
            val url = service.startSignIn()
            val query = queryValues(url)
            val pending = JSONObject(pendingFile.readText(Charsets.UTF_8))

            assertEquals("/#/native-auth", "${url.path}#${url.fragment?.substringBefore("?")}")
            assertEquals("https://wiki.kinic.xyz/android-auth-callback", query.getValue("callback"))
            assertEquals(query.getValue("state"), pending.getString("state"))
            assertTrue(query.containsKey("sessionPublicKey"))
            assertTrue(query.containsKey("maxTimeToLive"))
            assertTrue(pending.getString("sessionPrivateKey").isNotBlank())
        }
    }

    @Test
    fun callbackSuccessPersistsSessionAndClearsPendingAuth() {
        withTemporaryAuthService { service, sessionFile, pendingFile, configuration ->
            val url = service.startSignIn()
            val state = queryValues(url).getValue("state")
            val privateKey = pendingPrivateKey(pendingFile)
            val callback = successCallback(state, privateKey, configuration)

            val session = service.completeSignIn(callback)

            assertEquals(configuration.canisterId, session.canisterId)
            assertTrue(sessionFile.exists())
            assertFalse(pendingFile.exists())
            assertEquals(session, service.restore())
        }
    }

    @Test
    fun callbackRejectsMismatchedStateAndKeepsPendingAuth() {
        withTemporaryAuthService { service, _, pendingFile, configuration ->
            service.startSignIn()
            val privateKey = pendingPrivateKey(pendingFile)
            val callback = successCallback("wrong-state", privateKey, configuration)

            assertThrows(IcClientError::class.java) {
                service.completeSignIn(callback)
            }
            assertTrue(pendingFile.exists())
        }
    }

    @Test
    fun callbackRejectsMalformedResult() {
        withTemporaryAuthService { service, _, pendingFile, _ ->
            service.startSignIn()
            val state = JSONObject(pendingFile.readText(Charsets.UTF_8)).getString("state")
            val callback = URI("https://wiki.kinic.xyz/android-auth-callback?state=$state&result=not-base64")

            assertThrows(Exception::class.java) {
                service.completeSignIn(callback)
            }
        }
    }
}

private fun withTemporaryAuthService(
    block: (KinicAuthService, File, File, AppConfiguration) -> Unit,
) {
    val directory = Files.createTempDirectory("kinic-auth-service-test").toFile()
    try {
        val configuration = testAppConfiguration()
        val sessionFile = File(directory, "session.json")
        val pendingFile = File(directory, "pending.json")
        block(KinicAuthService(configuration, sessionFile, pendingFile), sessionFile, pendingFile, configuration)
    } finally {
        directory.deleteRecursively()
    }
}

internal fun testAppConfiguration(): AppConfiguration =
    AppConfiguration(
        canisterId = "bkyz2-fmaaa-aaaaa-qaaaq-cai",
        apiBaseUrl = URI("https://ic0.app"),
        identityProvider = URI("https://id.ai/#authorize"),
        derivationOrigin = "https://bkyz2-fmaaa-aaaaa-qaaaq-cai.icp0.io",
        authOrigin = URI("https://wiki.kinic.xyz"),
        callbackDomain = "wiki.kinic.xyz",
    )

private fun successCallback(state: String, privateKey: ByteArray, configuration: AppConfiguration): URI {
    val payload = identityPayload(privateKey, configuration.canisterId)
    val result = Base64.getUrlEncoder().withoutPadding().encodeToString(payload.encodeToByteArray())
    return URI("https://wiki.kinic.xyz/android-auth-callback?state=$state&result=$result")
}

private fun pendingPrivateKey(file: File): ByteArray {
    val json = JSONObject(file.readText(Charsets.UTF_8))
    return Base64.getUrlDecoder().decode(json.getString("sessionPrivateKey"))
}

private fun queryValues(url: URI): Map<String, String> {
    val query = url.fragment?.substringAfter("?", missingDelimiterValue = "") ?: url.rawQuery.orEmpty()
    if (query.isBlank()) return emptyMap()
    return query.split("&").associate { part ->
        val pieces = part.split("=", limit = 2)
        java.net.URLDecoder.decode(pieces[0], Charsets.UTF_8.name()) to
            java.net.URLDecoder.decode(pieces.getOrElse(1) { "" }, Charsets.UTF_8.name())
    }
}
