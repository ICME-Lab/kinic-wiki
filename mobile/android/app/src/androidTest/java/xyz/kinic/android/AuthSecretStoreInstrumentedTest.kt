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
import xyz.kinic.android.ic.IcIdentitySession
import xyz.kinic.android.ic.IcDelegationChain
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
        sessionFile.writeText(IcIdentitySession.encodeSession(session), Charsets.UTF_8)

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
        val requestId = pendingJson.getString("requestId")
        val chain = identityDelegation(privateKey, configuration.canisterId)
        val item = chain.delegations.single()
        val response = JSONObject()
            .put("jsonrpc", "2.0")
            .put("id", requestId)
            .put(
                "result",
                JSONObject()
                    .put("publicKey", Base64.getEncoder().encodeToString(chain.publicKey))
                    .put(
                        "signerDelegation",
                        JSONArray().put(
                            JSONObject()
                                .put(
                                    "delegation",
                                    JSONObject()
                                        .put("pubkey", Base64.getEncoder().encodeToString(item.delegation.publicKey))
                                        .put("expiration", item.delegation.expiration.toString())
                                        .put("targets", JSONArray().put(IcPrincipal.text(item.delegation.targets!!.single()))),
                                )
                                .put("signature", Base64.getEncoder().encodeToString(item.signature)),
                        ),
                    ),
            )
        val callback = URI(
            "https://wiki.kinic.xyz/native-auth-callback#message=${urlEncode(response.toString())}&state=${urlEncode(state)}",
        )

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
        val privateKey = IcIdentitySession.generateSessionPrivateKey()
        return IcIdentitySession.makeSession(
            identityDelegation(privateKey, configuration.canisterId),
            privateKey,
            configuration.icClientConfiguration(),
        )
    }

    private fun identityDelegation(
        sessionPrivateKey: ByteArray,
        targetCanisterId: String,
        expiration: ULong = System.currentTimeMillis().toULong() * 1_000_000uL + 86_400_000_000_000uL,
    ): IcDelegationChain {
        val rootPrivateKey = IcIdentitySession.generateSessionPrivateKey()
        val rootPublicKey = IcIdentitySession.derPublicKey(IcIdentitySession.rawPublicKey(rootPrivateKey))
        val sessionPublicKey = IcIdentitySession.derPublicKey(IcIdentitySession.rawPublicKey(sessionPrivateKey))
        val target = requireNotNull(IcPrincipal.parse(targetCanisterId))
        return IcDelegationChain(
            publicKey = rootPublicKey,
            delegations = listOf(
                IcDelegationChain.SignedDelegation(
                    delegation = IcDelegationChain.Delegation(
                        publicKey = sessionPublicKey,
                        expiration = expiration,
                        targets = listOf(target),
                    ),
                    signature = ByteArray(64) { 7 },
                ),
            ),
        )
    }

    private fun queryValues(url: URI): Map<String, String> {
        val query = url.rawFragment.orEmpty()
        return query.split('&').filter(String::isNotBlank).associate { part ->
            val pieces = part.split("=", limit = 2)
            java.net.URLDecoder.decode(pieces[0], Charsets.UTF_8.name()) to
                java.net.URLDecoder.decode(pieces.getOrElse(1) { "" }, Charsets.UTF_8.name())
        }
    }

    private fun urlEncode(value: String): String = java.net.URLEncoder.encode(value, Charsets.UTF_8.name())

    private fun instrumentedConfiguration(): AppConfiguration =
        AppConfiguration(
            canisterId = "bkyz2-fmaaa-aaaaa-qaaaq-cai",
            apiBaseUrl = URI("https://ic0.app"),
            identityProvider = URI("https://id.ai/authorize"),
            derivationOrigin = "https://bkyz2-fmaaa-aaaaa-qaaaq-cai.icp0.io",
            authOrigin = URI("https://wiki.kinic.xyz"),
            callbackDomain = "wiki.kinic.xyz",
        )
}
