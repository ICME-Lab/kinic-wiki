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
        withTemporaryAuthService { service, _, pendingFile, _, cipher ->
            val url = service.startSignIn()
            val query = queryValues(url)
            val pending = JSONObject(readSecret(pendingFile, cipher))

            assertEquals("/#/native-auth", "${url.path}#${url.fragment?.substringBefore("?")}")
            assertEquals("https://wiki.kinic.xyz/android-auth-callback", query.getValue("callback"))
            assertEquals(query.getValue("state"), pending.getString("state"))
            assertTrue(query.containsKey("sessionPublicKey"))
            assertTrue(query.containsKey("maxTimeToLive"))
            assertTrue(pending.getString("sessionPrivateKey").isNotBlank())
            assertEquals(2, JSONObject(pendingFile.readText(Charsets.UTF_8)).getInt("version"))
        }
    }

    @Test
    fun callbackSuccessPersistsSessionAndClearsPendingAuth() {
        withTemporaryAuthService { service, sessionFile, pendingFile, configuration, cipher ->
            val url = service.startSignIn()
            val state = queryValues(url).getValue("state")
            val privateKey = pendingPrivateKey(pendingFile, cipher)
            val callback = successCallback(state, privateKey, configuration)

            val session = service.completeSignIn(callback)

            assertEquals(configuration.canisterId, session.canisterId)
            assertTrue(sessionFile.exists())
            assertFalse(pendingFile.exists())
            assertEquals(session, service.restore())
            assertEquals(2, JSONObject(sessionFile.readText(Charsets.UTF_8)).getInt("version"))
        }
    }

    @Test
    fun callbackRejectsMismatchedStateAndKeepsPendingAuth() {
        withTemporaryAuthService { service, _, pendingFile, configuration, cipher ->
            service.startSignIn()
            val privateKey = pendingPrivateKey(pendingFile, cipher)
            val callback = successCallback("wrong-state", privateKey, configuration)

            assertThrows(IcClientError::class.java) {
                service.completeSignIn(callback)
            }
            assertTrue(pendingFile.exists())
        }
    }

    @Test
    fun callbackRejectsMalformedResult() {
        withTemporaryAuthService { service, _, pendingFile, _, cipher ->
            service.startSignIn()
            val state = JSONObject(readSecret(pendingFile, cipher)).getString("state")
            val callback = URI("https://wiki.kinic.xyz/android-auth-callback?state=$state&result=not-base64")

            assertThrows(Exception::class.java) {
                service.completeSignIn(callback)
            }
        }
    }

    @Test
    fun restoreMigratesValidatedPlaintextSessionToEncryptedV2() {
        withTemporaryAuthService { service, sessionFile, _, configuration, _ ->
            val privateKey = ByteArray(32) { (it + 1).toByte() }
            val session = xyz.kinic.android.ic.IcIdentityBridge.makeSession(
                identityPayload(privateKey, configuration.canisterId),
                privateKey,
                configuration.icClientConfiguration(),
            )
            sessionFile.writeText(
                xyz.kinic.android.ic.IcIdentityBridge.encodeSession(session),
                Charsets.UTF_8,
            )

            assertEquals(session, service.restore())
            assertEquals(2, JSONObject(sessionFile.readText(Charsets.UTF_8)).getInt("version"))
        }
    }
}

private fun withTemporaryAuthService(
    block: (KinicAuthService, File, File, AppConfiguration, AuthSecretCipher) -> Unit,
) {
    val directory = Files.createTempDirectory("kinic-auth-service-test").toFile()
    try {
        val configuration = testAppConfiguration()
        val sessionFile = File(directory, "session.json")
        val pendingFile = File(directory, "pending.json")
        val cipher = TestAuthSecretCipher()
        block(
            KinicAuthService(configuration, sessionFile, pendingFile, cipher),
            sessionFile,
            pendingFile,
            configuration,
            cipher,
        )
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

private fun pendingPrivateKey(file: File, cipher: AuthSecretCipher): ByteArray {
    val json = JSONObject(readSecret(file, cipher))
    return Base64.getUrlDecoder().decode(json.getString("sessionPrivateKey"))
}

private fun readSecret(file: File, cipher: AuthSecretCipher): String =
    requireNotNull(AuthSecretStore(file, cipher).read()).value

private class TestAuthSecretCipher : AuthSecretCipher {
    override fun encrypt(plaintext: ByteArray): EncryptedSecret =
        EncryptedSecret(iv = byteArrayOf(1, 2, 3), ciphertext = plaintext.map { (it.toInt() xor MASK).toByte() }.toByteArray())

    override fun decrypt(secret: EncryptedSecret): ByteArray =
        secret.ciphertext.map { (it.toInt() xor MASK).toByte() }.toByteArray()

    private companion object {
        const val MASK = 0x5a
    }
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
