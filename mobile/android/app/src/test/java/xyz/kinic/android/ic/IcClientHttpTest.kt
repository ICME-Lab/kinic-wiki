// Where: mobile/android/app/src/test/java/xyz/kinic/android/ic/IcClientHttpTest.kt
// What: JVM tests for IC HTTP endpoint selection and response handling.
// Why: Android transport must match the iOS ICNativeClient v3/v4 behavior.

package xyz.kinic.android.ic

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.net.URI

class IcClientHttpTest {
    @Test
    fun queryRawUsesV3Endpoint() = runBlocking {
        val transport = RecordingTransport(mutableListOf(IcHttpResponse(200, queryReply("ok".encodeToByteArray()))))
        val client = IcClient(testConfiguration(), transport)

        val response = client.queryRaw(method = "status")

        assertArrayEquals("ok".encodeToByteArray(), response)
        assertEquals("/api/v3/canister/bkyz2-fmaaa-aaaaa-qaaaq-cai/query", transport.requests.single().url.path)
    }

    @Test
    fun callRawUsesV4Endpoint() = runBlocking {
        val transport = RecordingTransport(mutableListOf(IcHttpResponse(200, queryReply("done".encodeToByteArray()))))
        val client = IcClient(testConfiguration(), transport)
        val session = testSession()

        val response = client.callRaw(method = "update", identity = session)

        assertArrayEquals("done".encodeToByteArray(), response)
        assertEquals("/api/v4/canister/bkyz2-fmaaa-aaaaa-qaaaq-cai/call", transport.requests.single().url.path)
    }

    @Test
    fun callRawFallsBackToV2WhenV4IsNotFound() = runBlocking {
        val transport = RecordingTransport(
            mutableListOf(
                IcHttpResponse(404, ByteArray(0)),
                IcHttpResponse(200, queryReply("done".encodeToByteArray())),
            ),
        )
        val client = IcClient(testConfiguration(), transport)

        val response = client.callRaw(method = "update", identity = testSession())

        assertArrayEquals("done".encodeToByteArray(), response)
        assertEquals(
            listOf(
                "/api/v4/canister/bkyz2-fmaaa-aaaaa-qaaaq-cai/call",
                "/api/v2/canister/bkyz2-fmaaa-aaaaa-qaaaq-cai/call",
            ),
            transport.requests.map { it.url.path },
        )
    }

    @Test
    fun callRawSurfacesMalformedV4BodyWithoutPolling() {
        val transport = RecordingTransport(mutableListOf(IcHttpResponse(200, byteArrayOf(0x01))))
        val client = IcClient(testConfiguration(), transport)

        assertThrows(IcClientError.InvalidResponse::class.java) {
            runBlocking { client.callRaw(method = "update", identity = testSession()) }
        }
        assertEquals(1, transport.requests.size)
    }

    @Test
    fun pollTimesOutWhenAttemptsAreZero() {
        val transport = RecordingTransport(mutableListOf())
        val client = IcClient(testConfiguration(), transport)

        val error = assertThrows(IcClientError::class.java) {
            runBlocking { client.poll(requestId = ByteArray(32), identity = testSession(), attempts = 0) }
        }
        assertEquals(IcClientError.PollTimeout, error)
    }
}

private data class RecordedRequest(
    val url: URI,
    val body: ByteArray,
    val operation: String,
)

private class RecordingTransport(
    private val responses: MutableList<IcHttpResponse>,
) : IcHttpTransport {
    val requests = mutableListOf<RecordedRequest>()

    override suspend fun postCbor(url: URI, body: ByteArray, operation: String): IcHttpResponse {
        requests += RecordedRequest(url = url, body = body, operation = operation)
        if (responses.isEmpty()) throw IcClientError.BackendUnavailable("missing fake response")
        return responses.removeAt(0)
    }
}

private fun queryReply(arg: ByteArray): ByteArray =
    IcCbor.encode(
        IcCbor.Value.MapValue(
            listOf(
                IcCbor.Value.Text("status") to IcCbor.Value.Text("replied"),
                IcCbor.Value.Text("reply") to IcCbor.Value.MapValue(
                    listOf(IcCbor.Value.Text("arg") to IcCbor.Value.Bytes(arg)),
                ),
            ),
        ),
    )

private fun testSession(): IcAuthSession {
    val privateKey = IcIdentitySession.generateSessionPrivateKey()
    return IcIdentitySession.makeSession(identityDelegation(privateKey, testConfiguration().canisterId), privateKey, testConfiguration())
}
