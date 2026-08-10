// Where: mobile/android/app/src/test/java/xyz/kinic/android/ic/IcClientCoreTest.kt
// What: JVM tests for Android IC principal, CBOR, request id, and delegated identity primitives.
// Why: Signed envelopes must stay deterministic before mainnet smoke testing.

package xyz.kinic.android.ic

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
        val vectors = listOf(
            0uL to byteArrayOf(0x00),
            63uL to byteArrayOf(0x3f),
            64uL to byteArrayOf(0x40),
            127uL to byteArrayOf(0x7f),
            128uL to byteArrayOf(0x80.toByte(), 0x01),
            624_485uL to byteArrayOf(0xe5.toByte(), 0x8e.toByte(), 0x26),
        )

        vectors.forEach { (value, encoded) ->
            assertArrayEquals(
                "unsigned LEB128 request-id hash for $value",
                encoded.sha256(),
                IcRequestId.hash(IcCbor.Value.Unsigned(value)),
            )
        }
    }

    @Test
    fun identityDelegationBuildsValidatedSession() {
        val configuration = testConfiguration()
        val privateKey = IcIdentitySession.generateSessionPrivateKey()
        val delegation = identityDelegation(privateKey, configuration.canisterId)

        val session = IcIdentitySession.makeSession(delegation, privateKey, configuration)

        assertEquals(configuration.canisterId, session.canisterId)
        assertEquals(configuration.identityProvider.toString(), session.identityProvider)
        assertEquals(configuration.derivationOrigin, session.derivationOrigin)
        assertArrayEquals(IcIdentitySession.derPublicKey(IcIdentitySession.rawPublicKey(privateKey)), session.sessionPublicKey)
        assertEquals(1, session.delegation.delegations.size)
    }

    @Test
    fun identityDelegationRejectsMismatchedSessionKey() {
        val configuration = testConfiguration()
        val privateKey = IcIdentitySession.generateSessionPrivateKey()
        val otherKey = IcIdentitySession.generateSessionPrivateKey()
        val delegation = identityDelegation(otherKey, configuration.canisterId)

        val error = assertThrows(IcClientError::class.java) {
            IcIdentitySession.makeSession(delegation, privateKey, configuration)
        }
        assertEquals(IcClientError.InvalidPayload, error)
    }

    @Test
    fun identityDelegationRejectsExpiredDelegation() {
        val configuration = testConfiguration()
        val privateKey = IcIdentitySession.generateSessionPrivateKey()
        val delegation = identityDelegation(privateKey, configuration.canisterId, expiration = 1uL)

        val error = assertThrows(IcClientError::class.java) {
            IcIdentitySession.makeSession(delegation, privateKey, configuration)
        }
        assertEquals(IcClientError.ExpiredDelegation, error)
    }

    @Test
    fun identityDelegationRejectsTargetMismatch() {
        val configuration = testConfiguration()
        val privateKey = IcIdentitySession.generateSessionPrivateKey()
        val delegation = identityDelegation(privateKey, "2vxsx-fae")

        val error = assertThrows(IcClientError::class.java) {
            IcIdentitySession.makeSession(delegation, privateKey, configuration)
        }
        assertEquals(IcClientError.InvalidPayload, error)
    }

    @Test
    fun validateSessionRejectsMismatchedStoredPrivateKey() {
        val configuration = testConfiguration()
        val privateKey = IcIdentitySession.generateSessionPrivateKey()
        val session = IcIdentitySession.makeSession(identityDelegation(privateKey, configuration.canisterId), privateKey, configuration)
        val corrupted = session.copy(sessionPrivateKey = IcIdentitySession.generateSessionPrivateKey())

        val error = assertThrows(IcClientError::class.java) {
            IcIdentitySession.validateSession(corrupted, configuration)
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
        val privateKey = IcIdentitySession.generateSessionPrivateKey()
        val session = IcIdentitySession.makeSession(identityDelegation(privateKey, configuration.canisterId), privateKey, configuration)
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
        identityProvider = URI("https://id.ai/authorize"),
        derivationOrigin = "https://bkyz2-fmaaa-aaaaa-qaaaq-cai.icp0.io",
    )

internal fun identityDelegation(
    sessionPrivateKey: ByteArray,
    targetCanisterId: String,
    expiration: ULong = System.currentTimeMillis().toULong() * 1_000_000uL + 86_400_000_000_000uL,
): IcDelegationChain {
    val rootPrivateKey = IcIdentitySession.generateSessionPrivateKey()
    val rootPublicKey = IcIdentitySession.derPublicKey(IcIdentitySession.rawPublicKey(rootPrivateKey))
    val sessionPublicKey = IcIdentitySession.derPublicKey(IcIdentitySession.rawPublicKey(sessionPrivateKey))
    val target = IcPrincipal.parse(targetCanisterId) ?: byteArrayOf(4)
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
        )
    )
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
