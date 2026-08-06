// Where: mobile/android/app/src/main/java/xyz/kinic/android/ic/IcClient.kt
// What: Raw Internet Computer HTTP API client for Android.
// Why: Kinic Android needs signed query, call, and read_state operations without Swift ICNativeClient.

package xyz.kinic.android.ic

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import java.net.HttpURLConnection
import java.net.URI

data class IcHttpResponse(
    val statusCode: Int,
    val body: ByteArray,
)

interface IcHttpTransport {
    suspend fun postCbor(url: URI, body: ByteArray, operation: String): IcHttpResponse
}

class HttpUrlConnectionIcTransport : IcHttpTransport {
    override suspend fun postCbor(url: URI, body: ByteArray, operation: String): IcHttpResponse =
        withContext(Dispatchers.IO) {
            val opened = url.toURL().openConnection()
            if (opened !is HttpURLConnection) {
                throw IcClientError.BackendUnavailable("$operation: unsupported connection")
            }
            opened.requestMethod = "POST"
            opened.connectTimeout = 20_000
            opened.readTimeout = 20_000
            opened.doOutput = true
            opened.setRequestProperty("Content-Type", "application/cbor")
            runCatching {
                opened.outputStream.use { it.write(body) }
                val status = opened.responseCode
                val stream = if (status in 200..299) opened.inputStream else opened.errorStream
                val data = stream?.use { it.readBytes() } ?: ByteArray(0)
                IcHttpResponse(statusCode = status, body = data)
            }.getOrElse { error ->
                throw IcClientError.BackendUnavailable("$operation: ${error.message ?: "request failed"}")
            }
        }
}

class IcClient(
    val configuration: IcClientConfiguration,
    private val transport: IcHttpTransport = HttpUrlConnectionIcTransport(),
) {
    fun apiUrl(requestType: String, canisterId: String = configuration.canisterId, version: IcClientApiVersion? = null): URI =
        configuration.apiUrl(requestType, canisterId, version)

    suspend fun queryRaw(
        method: String,
        arg: ByteArray = ByteArray(0),
        canisterId: String = configuration.canisterId,
        identity: IcAuthSession? = null,
    ): ByteArray {
        val canister = IcPrincipal.parse(canisterId) ?: throw IcClientError.InvalidCanisterId
        val envelope = if (identity != null) {
            validateIdentity(identity, canisterId)
            signedEnvelope(content = requestContent("query", canister, method, arg, identity), identity = identity)
        } else {
            IcCbor.queryEnvelope(canisterId = canister, method = method, arg = arg, ingressExpiry = ingressExpiry())
        }
        val response = transport.postCbor(apiUrl("query", canisterId), envelope, "query $method")
        if (response.statusCode != 200) {
            throw IcClientError.BackendUnavailable(httpFailureContext("query $method", response))
        }
        return IcCbor.decodeReplyArg(response.body)
            ?: IcCbor.decodeRejectMessage(response.body)?.let { throw IcClientError.Rejected(it) }
            ?: throw IcClientError.EmptyResponse
    }

    suspend fun callRaw(
        method: String,
        arg: ByteArray = ByteArray(0),
        canisterId: String = configuration.canisterId,
        effectiveCanisterId: String = canisterId,
        identity: IcAuthSession,
    ): ByteArray {
        val targetCanister = IcPrincipal.parse(canisterId) ?: throw IcClientError.InvalidCanisterId
        if (IcPrincipal.parse(effectiveCanisterId) == null) throw IcClientError.InvalidCanisterId
        validateIdentity(identity, effectiveCanisterId)
        val content = requestContent("call", targetCanister, method, arg, identity)
        val requestId = IcRequestId.hash(content)
        val envelope = signedEnvelope(content, identity)
        val v4Response = transport.postCbor(
            apiUrl("call", effectiveCanisterId, IcClientApiVersion.V4),
            envelope,
            "update $method",
        )
        if (v4Response.statusCode == 404) {
            val v2Response = transport.postCbor(
                apiUrl("call", effectiveCanisterId, IcClientApiVersion.V2),
                envelope,
                "update $method",
            )
            return handleCallResponse(v2Response, requestId, method, effectiveCanisterId, identity)
        }
        return handleCallResponse(v4Response, requestId, method, effectiveCanisterId, identity)
    }

    suspend fun poll(
        requestId: ByteArray,
        canisterId: String = configuration.canisterId,
        identity: IcAuthSession,
        attempts: Int = 30,
    ): ByteArray {
        if (IcPrincipal.parse(canisterId) == null) throw IcClientError.InvalidCanisterId
        validateIdentity(identity, canisterId)
        repeat(attempts) {
            delay(1_000)
            val content = IcCbor.Value.MapValue(
                listOf(
                    IcCbor.Value.Text("request_type") to IcCbor.Value.Text("read_state"),
                    IcCbor.Value.Text("paths") to IcCbor.Value.ArrayValue(
                        listOf(
                            IcCbor.Value.ArrayValue(
                                listOf(
                                    IcCbor.Value.Bytes("request_status".encodeToByteArray()),
                                    IcCbor.Value.Bytes(requestId),
                                ),
                            ),
                        ),
                    ),
                    IcCbor.Value.Text("sender") to IcCbor.Value.Bytes(IcPrincipal.selfAuthenticatingPublicKey(identity.delegation.publicKey)),
                    IcCbor.Value.Text("ingress_expiry") to IcCbor.Value.Unsigned(ingressExpiry()),
                ),
            )
            val envelope = signedEnvelope(content, identity)
            val response = transport.postCbor(apiUrl("read_state", canisterId), envelope, "read_state")
            if (response.statusCode != 200) {
                throw IcClientError.BackendUnavailable(httpFailureContext("read_state", response))
            }
            val result = try {
                IcCbor.certificateStatusArg(response.body, requestId)
            } catch (error: IcClientError) {
                throw error
            } catch (_: Exception) {
                throw IcClientError.InvalidResponse("read_state certificate")
            }
            if (result != null) {
                val reply = result.getOrThrow()
                if (reply != null) return reply
            }
        }
        throw IcClientError.PollTimeout
    }

    fun validateIdentity(identity: IcAuthSession, requestCanisterId: String) {
        try {
            IcIdentityBridge.validateSession(identity, configuration, requestCanisterId)
        } catch (error: IcClientError) {
            if (error == IcClientError.InvalidPayload) {
                throw IcClientError.InvalidIdentity("Internet Identity session is not valid for this canister.")
            }
            throw error
        }
    }

    fun signedEnvelope(content: IcCbor.Value, identity: IcAuthSession): ByteArray {
        val requestId = IcRequestId.hash(content)
        val challenge = byteArrayOf(0x0a) + "ic-request".encodeToByteArray() + requestId
        val signature = sign(identity.sessionPrivateKey, challenge)
        return IcCbor.signedEnvelope(
            content = content,
            publicKey = identity.sessionPublicKey,
            signature = signature,
            delegation = identity.delegation,
        )
    }

    private suspend fun handleCallResponse(
        response: IcHttpResponse,
        requestId: ByteArray,
        method: String,
        effectiveCanisterId: String,
        identity: IcAuthSession,
    ): ByteArray {
        if (response.statusCode != 200 && response.statusCode != 202) {
            throw IcClientError.BackendUnavailable(httpFailureContext("update $method", response))
        }
        IcCbor.decodeReplyArg(response.body)?.let { return it }
        IcCbor.decodeRejectMessage(response.body)?.let { throw IcClientError.Rejected(it) }
        if (response.body.isNotEmpty()) {
            val result = try {
                IcCbor.certificateStatusArg(response.body, requestId)
            } catch (error: IcClientError) {
                throw error
            } catch (_: Exception) {
                throw IcClientError.InvalidResponse("read_state certificate")
            }
            if (result == null) throw IcClientError.InvalidResponse("read_state certificate")
            val reply = result.getOrThrow()
            if (reply != null) return reply
        }
        return poll(requestId = requestId, canisterId = effectiveCanisterId, identity = identity)
    }

    private fun requestContent(
        type: String,
        canister: ByteArray,
        method: String,
        arg: ByteArray,
        identity: IcAuthSession,
    ): IcCbor.Value =
        IcCbor.Value.MapValue(
            listOf(
                IcCbor.Value.Text("request_type") to IcCbor.Value.Text(type),
                IcCbor.Value.Text("canister_id") to IcCbor.Value.Bytes(canister),
                IcCbor.Value.Text("method_name") to IcCbor.Value.Text(method),
                IcCbor.Value.Text("arg") to IcCbor.Value.Bytes(arg),
                IcCbor.Value.Text("sender") to IcCbor.Value.Bytes(IcPrincipal.selfAuthenticatingPublicKey(identity.delegation.publicKey)),
                IcCbor.Value.Text("ingress_expiry") to IcCbor.Value.Unsigned(ingressExpiry()),
            ),
        )

    private fun ingressExpiry(): ULong =
        ((System.currentTimeMillis() + 300_000L) * 1_000_000L).toULong()

    private fun sign(privateKey: ByteArray, payload: ByteArray): ByteArray {
        val signer = Ed25519Signer()
        signer.init(true, Ed25519PrivateKeyParameters(privateKey, 0))
        signer.update(payload, 0, payload.size)
        return signer.generateSignature()
    }

    private fun httpFailureContext(operation: String, response: IcHttpResponse): String {
        val body = responseBodyDetail(response.body)
        return if (body == null) "$operation HTTP ${response.statusCode}" else "$operation HTTP ${response.statusCode}: $body"
    }

    private fun responseBodyDetail(data: ByteArray): String? {
        if (data.isEmpty()) return null
        val text = data.take(1_000).toByteArray().toString(Charsets.UTF_8)
            .replace(Regex("\\s+"), " ")
            .trim()
        if (text.isEmpty()) return null
        val lower = text.lowercase()
        if (lower.contains("<!doctype html") || lower.contains("<html") || lower.contains("<head") || lower.contains("<body")) {
            return null
        }
        return text.take(240)
    }
}
