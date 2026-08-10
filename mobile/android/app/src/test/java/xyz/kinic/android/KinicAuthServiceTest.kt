// Where: mobile/android/app/src/test/java/xyz/kinic/android/KinicAuthServiceTest.kt
// What: JVM tests for Android direct ICRC-167 pending state and session persistence.
// Why: Fragment callbacks must bind state, request id, and the generated session key before IC calls.

package xyz.kinic.android

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test
import xyz.kinic.android.ic.IcClientError
import xyz.kinic.android.ic.IcPrincipal
import xyz.kinic.android.ic.identityDelegation
import java.io.File
import java.net.URI
import java.nio.file.Files
import java.util.Base64

class KinicAuthServiceTest {
    @Test
    fun startSignInBuildsDirectIcrc167UrlAndStoresPendingKey() {
        withTemporaryAuthService { service, _, pendingFile, configuration, cipher ->
            val url = service.startSignIn()
            val query = queryValues(url)
            val pending = JSONObject(readSecret(pendingFile, cipher))

            assertEquals("https", url.scheme)
            assertEquals("id.ai", url.host)
            assertEquals("/authorize", url.path)
            assertEquals("https://wiki.kinic.xyz/native-auth-callback", query.getValue("callback"))
            assertEquals(query.getValue("state"), pending.getString("state"))
            val request = JSONObject(query.getValue("message"))
            val params = request.getJSONObject("params")
            assertEquals("2.0", request.getString("jsonrpc"))
            assertEquals("icrc34_delegation", request.getString("method"))
            assertEquals(request.getString("id"), pending.getString("requestId"))
            assertTrue(Base64.getDecoder().decode(params.getString("publicKey")).isNotEmpty())
            assertEquals("2592000000000000", params.getString("maxTimeToLive"))
            assertEquals(configuration.derivationOrigin, params.getString("icrc95DerivationOrigin"))
            assertTrue(pending.getString("sessionPrivateKey").isNotBlank())
            assertEquals(2, JSONObject(pendingFile.readText(Charsets.UTF_8)).getInt("version"))
        }
    }

    @Test
    fun callbackSuccessPersistsSessionAndClearsPendingAuth() {
        withTemporaryAuthService { service, sessionFile, pendingFile, configuration, cipher ->
            val url = service.startSignIn()
            val state = queryValues(url).getValue("state")
            val requestId = JSONObject(queryValues(url).getValue("message")).getString("id")
            val privateKey = pendingPrivateKey(pendingFile, cipher)
            val callback = successCallback(state, requestId, privateKey, configuration)

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
            val requestId = JSONObject(readSecret(pendingFile, cipher)).getString("requestId")
            val privateKey = pendingPrivateKey(pendingFile, cipher)
            val callback = successCallback("wrong-state", requestId, privateKey, configuration)

            assertThrows(IcClientError::class.java) {
                service.completeSignIn(callback)
            }
            assertTrue(pendingFile.exists())
        }
    }

    @Test
    fun callbackRejectsMismatchedRequestIdAndKeepsPendingAuth() {
        withTemporaryAuthService { service, _, pendingFile, configuration, cipher ->
            val url = service.startSignIn()
            val state = queryValues(url).getValue("state")
            val privateKey = pendingPrivateKey(pendingFile, cipher)
            val callback = successCallback(state, "wrong-request-id", privateKey, configuration)

            assertThrows(IcClientError::class.java) {
                service.completeSignIn(callback)
            }
            assertTrue(pendingFile.exists())
        }
    }

    @Test
    fun callbackRejectsLegacyQueryTransportAndKeepsPendingAuth() {
        withTemporaryAuthService { service, _, pendingFile, _, _ ->
            service.startSignIn()

            assertThrows(IcClientError::class.java) {
                service.completeSignIn(
                    URI("https://wiki.kinic.xyz/native-auth-callback?state=legacy&result=legacy"),
                )
            }
            assertTrue(pendingFile.exists())
        }
    }

    @Test
    fun callbackRejectsMalformedResult() {
        withTemporaryAuthService { service, _, pendingFile, _, cipher ->
            service.startSignIn()
            val pending = JSONObject(readSecret(pendingFile, cipher))
            val callback = directCallback("not-json", pending.getString("state"))

            assertThrows(Exception::class.java) {
                service.completeSignIn(callback)
            }
            assertTrue(pendingFile.exists())
        }
    }

    @Test
    fun callbackConsumesPendingAuthAfterProviderRejection() {
        withTemporaryAuthService { service, _, pendingFile, _, cipher ->
            val url = service.startSignIn()
            val state = queryValues(url).getValue("state")
            val requestId = JSONObject(readSecret(pendingFile, cipher)).getString("requestId")
            val callback = errorCallback(state, requestId, "Authorization was cancelled.")

            assertThrows(IcClientError.AuthorizationFailed::class.java) {
                service.completeSignIn(callback)
            }
            assertFalse(pendingFile.exists())
        }
    }

    @Test
    fun callbackRejectsOldPlatformPathsAndKeepsPendingAuth() {
        withTemporaryAuthService { service, _, pendingFile, _, _ ->
            service.startSignIn()

            for (path in listOf("/ios-auth-callback", "/android-auth-callback")) {
                assertThrows(IcClientError::class.java) {
                    service.completeSignIn(URI("https://wiki.kinic.xyz$path#message=x&state=s"))
                }
            }
            assertTrue(pendingFile.exists())
        }
    }

    @Test
    fun restoreMigratesValidatedPlaintextSessionToEncryptedV2() {
        withTemporaryAuthService { service, sessionFile, _, configuration, _ ->
            val privateKey = ByteArray(32) { (it + 1).toByte() }
            val session = xyz.kinic.android.ic.IcIdentitySession.makeSession(
                identityDelegation(privateKey, configuration.canisterId),
                privateKey,
                configuration.icClientConfiguration(),
            )
            sessionFile.writeText(
                xyz.kinic.android.ic.IcIdentitySession.encodeSession(session),
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
        identityProvider = URI("https://id.ai/authorize"),
        derivationOrigin = "https://bkyz2-fmaaa-aaaaa-qaaaq-cai.icp0.io",
        authOrigin = URI("https://wiki.kinic.xyz"),
        callbackDomain = "wiki.kinic.xyz",
    )

private fun successCallback(
    state: String,
    requestId: String,
    privateKey: ByteArray,
    configuration: AppConfiguration,
): URI {
    val chain = identityDelegation(privateKey, configuration.canisterId)
    val signed = chain.delegations.map { item ->
        val delegation = JSONObject()
            .put("pubkey", Base64.getEncoder().encodeToString(item.delegation.publicKey))
            .put("expiration", item.delegation.expiration.toString())
        item.delegation.targets?.let { targets ->
            delegation.put("targets", targets.map { target -> IcPrincipal.text(target) })
        }
        JSONObject()
            .put("delegation", delegation)
            .put("signature", Base64.getEncoder().encodeToString(item.signature))
    }
    val response = JSONObject()
        .put("jsonrpc", "2.0")
        .put("id", requestId)
        .put(
            "result",
            JSONObject()
                .put("publicKey", Base64.getEncoder().encodeToString(chain.publicKey))
                .put("signerDelegation", signed),
        )
    return directCallback(response.toString(), state)
}

private fun directCallback(message: String, state: String): URI =
    URI(
        "https://wiki.kinic.xyz/native-auth-callback#message=${urlEncode(message)}&state=${urlEncode(state)}",
    )

private fun errorCallback(state: String, requestId: String, message: String): URI {
    val response = JSONObject()
        .put("jsonrpc", "2.0")
        .put("id", requestId)
        .put(
            "error",
            JSONObject()
                .put("code", -32_000)
                .put("message", message),
        )
    return directCallback(response.toString(), state)
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
    val query = url.rawFragment.orEmpty()
    if (query.isBlank()) return emptyMap()
    return query.split("&").associate { part ->
        val pieces = part.split("=", limit = 2)
        java.net.URLDecoder.decode(pieces[0], Charsets.UTF_8.name()) to
            java.net.URLDecoder.decode(pieces.getOrElse(1) { "" }, Charsets.UTF_8.name())
    }
}

private fun urlEncode(value: String): String = java.net.URLEncoder.encode(value, Charsets.UTF_8.name())
