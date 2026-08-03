package xyz.kinic.android

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import xyz.kinic.android.ic.IcIdentityBridge
import xyz.kinic.android.ic.IcPrincipal
import java.io.File
import java.net.URI
import java.security.KeyStore
import java.util.Base64
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class AuthSecretStoreInstrumentedTest {
    private lateinit var directory: File
    private lateinit var keyAlias: String

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        directory = File(context.cacheDir, "auth-secret-${UUID.randomUUID()}").apply { mkdirs() }
        keyAlias = "kinic.auth.instrumented.${UUID.randomUUID()}"
    }

    @After
    fun tearDown() {
        directory.deleteRecursively()
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        if (keyStore.containsAlias(keyAlias)) keyStore.deleteEntry(keyAlias)
    }

    @Test
    fun androidKeystoreCipherRoundTripsAndRejectsTampering() {
        val cipher = AndroidKeystoreAuthSecretCipher(keyAlias)
        val plaintext = "delegated session secret".encodeToByteArray()
        val encrypted = cipher.encrypt(plaintext)

        assertArrayEquals(plaintext, cipher.decrypt(encrypted))

        val tampered = encrypted.ciphertext.copyOf().also { bytes ->
            bytes[bytes.lastIndex] = (bytes.last().toInt() xor 1).toByte()
        }
        var rejected = false
        try {
            cipher.decrypt(encrypted.copy(ciphertext = tampered))
        } catch (_: Exception) {
            rejected = true
        }
        assertTrue("AES-GCM must reject modified ciphertext.", rejected)
    }

    @Test
    fun plaintextSessionMigratesAndRestoresWithARecreatedService() {
        val configuration = instrumentedConfiguration()
        val sessionFile = File(directory, "session.json")
        val pendingFile = File(directory, "pending.json")
        val session = validSession(configuration)
        sessionFile.writeText(IcIdentityBridge.encodeSession(session), Charsets.UTF_8)

        val first = authService(configuration, sessionFile, pendingFile)
        assertEquals(session, first.restore())
        assertEquals(2, JSONObject(sessionFile.readText(Charsets.UTF_8)).getInt("version"))

        val recreated = authService(configuration, sessionFile, pendingFile)
        assertEquals(session, recreated.restore())
    }

    @Test
    fun pendingAuthSurvivesServiceRecreationAndPersistsCompletedSession() {
        val configuration = instrumentedConfiguration()
        val sessionFile = File(directory, "session.json")
        val pendingFile = File(directory, "pending.json")
        val first = authService(configuration, sessionFile, pendingFile)
        val authorizationUrl = first.startSignIn()
        val state = queryValues(authorizationUrl).getValue("state")
        val pendingJson = JSONObject(
            requireNotNull(
                AuthSecretStore(pendingFile, AndroidKeystoreAuthSecretCipher(keyAlias)).read(),
            ).value,
        )
        val privateKey = Base64.getUrlDecoder().decode(pendingJson.getString("sessionPrivateKey"))
        val payload = identityPayload(privateKey, configuration.canisterId)
        val result = Base64.getUrlEncoder().withoutPadding().encodeToString(payload.encodeToByteArray())
        val callback = URI("https://wiki.kinic.xyz/android-auth-callback?state=$state&result=$result")

        val recreated = authService(configuration, sessionFile, pendingFile)
        val session = recreated.completeSignIn(callback)

        assertFalse(pendingFile.exists())
        assertEquals(session, authService(configuration, sessionFile, pendingFile).restore())
    }

    private fun authService(configuration: AppConfiguration, sessionFile: File, pendingFile: File): KinicAuthService =
        KinicAuthService(
            configuration = configuration,
            sessionFile = sessionFile,
            pendingFile = pendingFile,
            cipher = AndroidKeystoreAuthSecretCipher(keyAlias),
        )

    private fun validSession(configuration: AppConfiguration): xyz.kinic.android.ic.IcAuthSession {
        val privateKey = IcIdentityBridge.generateSessionPrivateKey()
        return IcIdentityBridge.makeSession(
            identityPayload(privateKey, configuration.canisterId),
            privateKey,
            configuration.icClientConfiguration(),
        )
    }

    private fun identityPayload(
        sessionPrivateKey: ByteArray,
        targetCanisterId: String,
        expiration: ULong = 4_102_444_800_000_000_000uL,
    ): String {
        val rootPrivateKey = IcIdentityBridge.generateSessionPrivateKey()
        val rootPublicKey = IcIdentityBridge.derPublicKey(IcIdentityBridge.rawPublicKey(rootPrivateKey))
        val sessionPublicKey = IcIdentityBridge.derPublicKey(IcIdentityBridge.rawPublicKey(sessionPrivateKey))
        val target = requireNotNull(IcPrincipal.parse(targetCanisterId)).toHexString()
        return JSONObject()
            .put("kind", "authorize-client-success")
            .put("userPublicKey", rootPublicKey.toHexString())
            .put(
                "delegations",
                JSONArray().put(
                    JSONObject()
                        .put(
                            "delegation",
                            JSONObject()
                                .put("pubkey", sessionPublicKey.toHexString())
                                .put("expiration", expiration.toString())
                                .put("targets", JSONArray().put(target)),
                        )
                        .put("signature", ByteArray(64) { 7 }.toHexString()),
                ),
            )
            .toString()
    }

    private fun queryValues(url: URI): Map<String, String> {
        val query = url.fragment?.substringAfter("?", missingDelimiterValue = "") ?: url.rawQuery.orEmpty()
        return query.split('&').filter(String::isNotBlank).associate { part ->
            val pieces = part.split("=", limit = 2)
            java.net.URLDecoder.decode(pieces[0], Charsets.UTF_8.name()) to
                java.net.URLDecoder.decode(pieces.getOrElse(1) { "" }, Charsets.UTF_8.name())
        }
    }

    private fun ByteArray.toHexString(): String =
        joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }

    private fun instrumentedConfiguration(): AppConfiguration =
        AppConfiguration(
            canisterId = "bkyz2-fmaaa-aaaaa-qaaaq-cai",
            apiBaseUrl = URI("https://ic0.app"),
            identityProvider = URI("https://id.ai/#authorize"),
            derivationOrigin = "https://bkyz2-fmaaa-aaaaa-qaaaq-cai.icp0.io",
            authOrigin = URI("https://wiki.kinic.xyz"),
            callbackDomain = "wiki.kinic.xyz",
        )
}
