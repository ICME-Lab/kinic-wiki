// Where: mobile/android/app/src/test/java/xyz/kinic/android/ic/IcClientCoreTest.kt
// What: JVM tests for Android IC principal, CBOR, request id, and identity bridge primitives.
// Why: Signed envelopes must stay deterministic before mainnet smoke testing.

package xyz.kinic.android.ic

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertThrows
import org.junit.Test
import java.net.URI

class IcClientCoreTest {
    @Test
    fun principalRoundTrips() {
        val principal = IcPrincipal.parse("bkyz2-fmaaa-aaaaa-qaaaq-cai")
        assertNotNull(principal)
        assertEquals("bkyz2-fmaaa-aaaaa-qaaaq-cai", IcPrincipal.text(principal ?: ByteArray(0)))
    }

    @Test
    fun cborRoundTripsBasicMap() {
        val value = IcCbor.Value.MapValue(
            listOf(
                IcCbor.Value.Text("status") to IcCbor.Value.Text("replied"),
                IcCbor.Value.Text("reply") to IcCbor.Value.MapValue(
                    listOf(IcCbor.Value.Text("arg") to IcCbor.Value.Bytes("ok".encodeToByteArray())),
                ),
            ),
        )
        val decoded = IcCbor.decode(IcCbor.encode(value))

        assertEquals("replied", IcCbor.textValue(IcCbor.mapValue(decoded, "status")))
        assertArrayEquals("ok".encodeToByteArray(), IcCbor.decodeReplyArg(IcCbor.encode(value)))
    }

    @Test
    fun requestIdHashesTextLikeSha256() {
        assertArrayEquals("hello".encodeToByteArray().sha256(), IcRequestId.hash(IcCbor.Value.Text("hello")))
    }

    @Test
    fun requestIdHashesNaturalNumbersWithUnsignedLeb128() {
        val encoded = byteArrayOf(0xe5.toByte(), 0x8e.toByte(), 0x26.toByte())
        assertArrayEquals(encoded.sha256(), IcRequestId.hash(IcCbor.Value.Unsigned(624_485uL)))
    }

    @Test
    fun identityPayloadBuildsValidatedSession() {
        val configuration = testConfiguration()
        val privateKey = IcIdentityBridge.generateSessionPrivateKey()
        val payload = identityPayload(privateKey, configuration.canisterId)

        val session = IcIdentityBridge.makeSession(payload, privateKey, configuration)

        assertEquals(configuration.canisterId, session.canisterId)
        assertEquals(configuration.identityProvider.toString(), session.identityProvider)
        assertEquals(configuration.derivationOrigin, session.derivationOrigin)
        assertArrayEquals(IcIdentityBridge.derPublicKey(IcIdentityBridge.rawPublicKey(privateKey)), session.sessionPublicKey)
        assertEquals(1, session.delegation.delegations.size)
    }

    @Test
    fun identityPayloadRejectsMismatchedSessionKey() {
        val configuration = testConfiguration()
        val privateKey = IcIdentityBridge.generateSessionPrivateKey()
        val otherKey = IcIdentityBridge.generateSessionPrivateKey()
        val payload = identityPayload(otherKey, configuration.canisterId)

        val error = assertThrows(IcClientError::class.java) {
            IcIdentityBridge.makeSession(payload, privateKey, configuration)
        }
        assertEquals(IcClientError.InvalidPayload, error)
    }

    @Test
    fun identityPayloadRejectsMalformedJson() {
        val error = assertThrows(IcClientError::class.java) {
            IcIdentityBridge.makeSession("{", IcIdentityBridge.generateSessionPrivateKey(), testConfiguration())
        }
        assertEquals(IcClientError.InvalidPayload, error)
    }

    @Test
    fun identityPayloadRejectsExpiredDelegation() {
        val configuration = testConfiguration()
        val privateKey = IcIdentityBridge.generateSessionPrivateKey()
        val payload = identityPayload(privateKey, configuration.canisterId, expiration = 1uL)

        val error = assertThrows(IcClientError::class.java) {
            IcIdentityBridge.makeSession(payload, privateKey, configuration)
        }
        assertEquals(IcClientError.ExpiredDelegation, error)
    }

    @Test
    fun identityPayloadRejectsTargetMismatch() {
        val configuration = testConfiguration()
        val privateKey = IcIdentityBridge.generateSessionPrivateKey()
        val payload = identityPayload(privateKey, "2vxsx-fae")

        val error = assertThrows(IcClientError::class.java) {
            IcIdentityBridge.makeSession(payload, privateKey, configuration)
        }
        assertEquals(IcClientError.InvalidPayload, error)
    }

    @Test
    fun validateSessionRejectsMismatchedStoredPrivateKey() {
        val configuration = testConfiguration()
        val privateKey = IcIdentityBridge.generateSessionPrivateKey()
        val session = IcIdentityBridge.makeSession(identityPayload(privateKey, configuration.canisterId), privateKey, configuration)
        val corrupted = session.copy(sessionPrivateKey = IcIdentityBridge.generateSessionPrivateKey())

        val error = assertThrows(IcClientError::class.java) {
            IcIdentityBridge.validateSession(corrupted, configuration)
        }
        assertEquals(IcClientError.InvalidPayload, error)
    }

    @Test
    fun certificateStatusDoneIsExplicitInvalidResponse() {
        val requestId = ByteArray(32) { 1 }
        val tree = statusTree(requestId, "done".encodeToByteArray())
        val result = IcCbor.certificateStatusArgFromTree(tree, requestId)

        val error = assertThrows(IcClientError.InvalidResponse::class.java) {
            result?.getOrThrow()
        }
        assertEquals("read_state request done without reply", error.detail)
    }

    @Test
    fun signedEnvelopeContainsDelegationFields() {
        val configuration = testConfiguration()
        val privateKey = IcIdentityBridge.generateSessionPrivateKey()
        val session = IcIdentityBridge.makeSession(identityPayload(privateKey, configuration.canisterId), privateKey, configuration)
        val content = IcCbor.Value.MapValue(
            listOf(
                IcCbor.Value.Text("request_type") to IcCbor.Value.Text("query"),
                IcCbor.Value.Text("sender") to IcCbor.Value.Bytes(IcPrincipal.selfAuthenticatingPublicKey(session.delegation.publicKey)),
            ),
        )

        val envelope = IcCbor.decode(IcClient(configuration).signedEnvelope(content, session))

        assertNotNull(IcCbor.mapValue(envelope, "content"))
        assertArrayEquals(session.sessionPublicKey, IcCbor.bytesValue(IcCbor.mapValue(envelope, "sender_pubkey")))
        assertNotNull(IcCbor.mapValue(envelope, "sender_sig"))
        assertNotNull(IcCbor.mapValue(envelope, "sender_delegation"))
    }

    @Test
    fun apiUrlUsesCurrentEndpointVersions() {
        val configuration = testConfiguration()

        assertEquals(
            "https://ic0.app/api/v3/canister/bkyz2-fmaaa-aaaaa-qaaaq-cai/query",
            configuration.apiUrl("query").toString(),
        )
        assertEquals(
            "https://ic0.app/api/v3/canister/bkyz2-fmaaa-aaaaa-qaaaq-cai/read_state",
            configuration.apiUrl("read_state").toString(),
        )
        assertEquals(
            "https://ic0.app/api/v4/canister/bkyz2-fmaaa-aaaaa-qaaaq-cai/call",
            configuration.apiUrl("call").toString(),
        )
        assertEquals(
            "https://ic0.app/api/v2/canister/bkyz2-fmaaa-aaaaa-qaaaq-cai/call",
            configuration.apiUrl("call", version = IcClientApiVersion.V2).toString(),
        )
    }
}

internal fun testConfiguration(): IcClientConfiguration =
    IcClientConfiguration(
        canisterId = "bkyz2-fmaaa-aaaaa-qaaaq-cai",
        apiBaseUrl = URI("https://ic0.app"),
        identityProvider = URI("https://id.ai/#authorize"),
        derivationOrigin = "https://bkyz2-fmaaa-aaaaa-qaaaq-cai.icp0.io",
    )

internal fun identityPayload(
    sessionPrivateKey: ByteArray,
    targetCanisterId: String,
    expiration: ULong = 4_102_444_800_000_000_000uL,
): String {
    val rootPrivateKey = IcIdentityBridge.generateSessionPrivateKey()
    val rootPublicKey = IcIdentityBridge.derPublicKey(IcIdentityBridge.rawPublicKey(rootPrivateKey))
    val sessionPublicKey = IcIdentityBridge.derPublicKey(IcIdentityBridge.rawPublicKey(sessionPrivateKey))
    val target = IcPrincipal.parse(targetCanisterId)?.toHex() ?: "04"
    return JSONObject()
        .put("kind", "authorize-client-success")
        .put("userPublicKey", rootPublicKey.toHex())
        .put(
            "delegations",
            JSONArray().put(
                JSONObject()
                    .put(
                        "delegation",
                        JSONObject()
                            .put("pubkey", sessionPublicKey.toHex())
                            .put("expiration", expiration.toString())
                            .put("targets", JSONArray().put(target)),
                    )
                    .put("signature", ByteArray(64) { 7 }.toHex()),
            ),
        )
        .toString()
}

private fun statusTree(requestId: ByteArray, status: ByteArray): IcCbor.Value =
    IcCbor.Value.ArrayValue(
        listOf(
            IcCbor.Value.Unsigned(2uL),
            IcCbor.Value.Bytes("request_status".encodeToByteArray()),
            IcCbor.Value.ArrayValue(
                listOf(
                    IcCbor.Value.Unsigned(2uL),
                    IcCbor.Value.Bytes(requestId),
                    IcCbor.Value.ArrayValue(
                        listOf(
                            IcCbor.Value.Unsigned(2uL),
                            IcCbor.Value.Bytes("status".encodeToByteArray()),
                            IcCbor.Value.ArrayValue(
                                listOf(
                                    IcCbor.Value.Unsigned(3uL),
                                    IcCbor.Value.Bytes(status),
                                ),
                            ),
                        ),
                    ),
                ),
            ),
        ),
    )
