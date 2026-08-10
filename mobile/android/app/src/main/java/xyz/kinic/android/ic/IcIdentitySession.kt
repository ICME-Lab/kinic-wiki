// Where: mobile/android/app/src/main/java/xyz/kinic/android/ic/IcIdentitySession.kt
// What: Internet Identity session construction, persistence, and delegation validation.
// Why: Direct ICRC-167 results must bind to the locally generated Ed25519 session key.

package xyz.kinic.android.ic

import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.json.JSONArray
import org.json.JSONObject
import java.security.SecureRandom
import java.time.Instant

data class IcAuthSession(
    val principal: String,
    val canisterId: String,
    val identityProvider: String,
    val derivationOrigin: String,
    val sessionPublicKey: ByteArray,
    val sessionPrivateKey: ByteArray,
    val delegation: IcDelegationChain,
    val createdAtEpochMs: Long = Instant.now().toEpochMilli(),
) {
    override fun equals(other: kotlin.Any?): Boolean {
        if (other !is IcAuthSession) return false
        return principal == other.principal &&
            canisterId == other.canisterId &&
            identityProvider == other.identityProvider &&
            derivationOrigin == other.derivationOrigin &&
            sessionPublicKey.contentEquals(other.sessionPublicKey) &&
            sessionPrivateKey.contentEquals(other.sessionPrivateKey) &&
            delegation == other.delegation &&
            createdAtEpochMs == other.createdAtEpochMs
    }

    override fun hashCode(): Int {
        var result = principal.hashCode()
        result = 31 * result + canisterId.hashCode()
        result = 31 * result + identityProvider.hashCode()
        result = 31 * result + derivationOrigin.hashCode()
        result = 31 * result + sessionPublicKey.contentHashCode()
        result = 31 * result + sessionPrivateKey.contentHashCode()
        result = 31 * result + delegation.hashCode()
        result = 31 * result + createdAtEpochMs.hashCode()
        return result
    }
}

data class IcDelegationChain(
    val publicKey: ByteArray,
    val delegations: List<SignedDelegation>,
) {
    data class SignedDelegation(
        val delegation: Delegation,
        val signature: ByteArray,
    ) {
        override fun equals(other: kotlin.Any?): Boolean {
            if (other !is SignedDelegation) return false
            return delegation == other.delegation && signature.contentEquals(other.signature)
        }

        override fun hashCode(): Int =
            31 * delegation.hashCode() + signature.contentHashCode()
    }

    data class Delegation(
        val publicKey: ByteArray,
        val expiration: ULong,
        val targets: List<ByteArray>?,
    ) {
        override fun equals(other: kotlin.Any?): Boolean {
            if (other !is Delegation) return false
            return publicKey.contentEquals(other.publicKey) &&
                expiration == other.expiration &&
                byteArrayListEquals(targets, other.targets)
        }

        override fun hashCode(): Int {
            var result = publicKey.contentHashCode()
            result = 31 * result + expiration.hashCode()
            result = 31 * result + (targets?.fold(1) { partial, item -> 31 * partial + item.contentHashCode() } ?: 0)
            return result
        }
    }

    override fun equals(other: kotlin.Any?): Boolean {
        if (other !is IcDelegationChain) return false
        return publicKey.contentEquals(other.publicKey) && delegations == other.delegations
    }

    override fun hashCode(): Int =
        31 * publicKey.contentHashCode() + delegations.hashCode()
}

object IcIdentitySession {
    const val maxTimeToLiveNanos: String = "2592000000000000"
    private val ed25519DerPrefix = byteArrayOf(
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    )

    fun generateSessionPrivateKey(): ByteArray =
        Ed25519PrivateKeyParameters(SecureRandom()).encoded

    fun rawPublicKey(privateKey: ByteArray): ByteArray =
        Ed25519PrivateKeyParameters(privateKey, 0).generatePublicKey().encoded

    fun derPublicKey(rawPublicKey: ByteArray): ByteArray =
        ed25519DerPrefix + rawPublicKey

    fun makeSession(
        delegation: IcDelegationChain,
        privateKey: ByteArray,
        configuration: IcClientConfiguration,
        createdAtEpochMs: Long = Instant.now().toEpochMilli(),
    ): IcAuthSession {
        val sessionPublicKey = derPublicKey(rawPublicKey(privateKey))
        validate(
            delegation,
            expectedSessionPublicKey = sessionPublicKey,
            canisterId = configuration.canisterId,
            createdAtEpochMs = createdAtEpochMs,
        )
        val principal = IcPrincipal.text(IcPrincipal.selfAuthenticatingPublicKey(delegation.publicKey))
        return IcAuthSession(
            principal = principal,
            canisterId = configuration.canisterId,
            identityProvider = configuration.identityProvider.toString(),
            derivationOrigin = configuration.derivationOrigin,
            sessionPublicKey = sessionPublicKey,
            sessionPrivateKey = privateKey,
            delegation = delegation,
            createdAtEpochMs = createdAtEpochMs,
        )
    }

    fun validateSession(
        session: IcAuthSession,
        configuration: IcClientConfiguration,
        requestCanisterId: String = configuration.canisterId,
    ) {
        if (
            session.canisterId != configuration.canisterId ||
            session.identityProvider != configuration.identityProvider.toString() ||
            session.derivationOrigin != configuration.derivationOrigin
        ) {
            throw IcClientError.InvalidPayload
        }
        val derivedSessionPublicKey = try {
            derPublicKey(rawPublicKey(session.sessionPrivateKey))
        } catch (_: Exception) {
            throw IcClientError.InvalidPayload
        }
        if (!derivedSessionPublicKey.contentEquals(session.sessionPublicKey)) {
            throw IcClientError.InvalidPayload
        }
        try {
            validate(
                session.delegation,
                expectedSessionPublicKey = session.sessionPublicKey,
                canisterId = requestCanisterId,
                createdAtEpochMs = session.createdAtEpochMs,
            )
        } catch (error: IcClientError) {
            if (error == IcClientError.InvalidPayload) {
                throw IcClientError.InvalidIdentity("Internet Identity session is not valid for this canister.")
            }
            throw error
        }
    }

    fun validate(
        chain: IcDelegationChain,
        expectedSessionPublicKey: ByteArray?,
        canisterId: String,
        createdAtEpochMs: Long = Instant.now().toEpochMilli(),
    ) {
        if (createdAtEpochMs < 0) throw IcClientError.InvalidPayload
        val canister = IcPrincipal.parse(canisterId) ?: throw IcClientError.InvalidPayload
        val lastPublicKey = chain.delegations.lastOrNull()?.delegation?.publicKey
        if (expectedSessionPublicKey == null || lastPublicKey == null || !lastPublicKey.contentEquals(expectedSessionPublicKey)) {
            throw IcClientError.InvalidPayload
        }
        val now = nowNanos()
        val requestedTtl = maxTimeToLiveNanos.toULong()
        val clockSkew = 5uL * 60uL * 1_000_000_000uL
        val requestedAt = createdAtEpochMs.toULong() * 1_000_000uL
        val earliestExpiration = chain.delegations.minOfOrNull { it.delegation.expiration }
            ?: throw IcClientError.InvalidPayload
        if (earliestExpiration > requestedAt + requestedTtl + clockSkew) throw IcClientError.InvalidPayload
        for (signed in chain.delegations) {
            if (signed.delegation.expiration <= now) {
                throw IcClientError.ExpiredDelegation
            }
            val targets = signed.delegation.targets
            if (targets != null && targets.none { it.contentEquals(canister) }) {
                throw IcClientError.InvalidPayload
            }
        }
    }

    fun encodeSession(session: IcAuthSession): String {
        val json = JSONObject()
            .put("principal", session.principal)
            .put("canisterId", session.canisterId)
            .put("identityProvider", session.identityProvider)
            .put("derivationOrigin", session.derivationOrigin)
            .put("sessionPublicKey", session.sessionPublicKey.base64UrlNoPadding())
            .put("sessionPrivateKey", session.sessionPrivateKey.base64UrlNoPadding())
            .put("delegation", encodeDelegationChain(session.delegation))
            .put("createdAtEpochMs", session.createdAtEpochMs)
        return json.toString()
    }

    fun decodeSession(payload: String): IcAuthSession {
        val json = try {
            JSONObject(payload)
        } catch (_: Exception) {
            throw IcClientError.InvalidPayload
        }
        return IcAuthSession(
            principal = json.getString("principal"),
            canisterId = json.getString("canisterId"),
            identityProvider = json.getString("identityProvider"),
            derivationOrigin = json.getString("derivationOrigin"),
            sessionPublicKey = json.getString("sessionPublicKey").base64UrlDecoded(),
            sessionPrivateKey = json.getString("sessionPrivateKey").base64UrlDecoded(),
            delegation = decodeDelegationChain(json.getJSONObject("delegation")),
            createdAtEpochMs = json.optLong("createdAtEpochMs", Instant.now().toEpochMilli()),
        )
    }

    private fun encodeDelegationChain(chain: IcDelegationChain): JSONObject {
        val json = JSONObject()
            .put("publicKey", chain.publicKey.base64UrlNoPadding())
        val array = JSONArray()
        chain.delegations.forEach { signed ->
            val delegation = JSONObject()
                .put("publicKey", signed.delegation.publicKey.base64UrlNoPadding())
                .put("expiration", signed.delegation.expiration.toString())
            val targets = signed.delegation.targets
            if (targets != null) {
                val targetArray = JSONArray()
                targets.forEach { targetArray.put(it.base64UrlNoPadding()) }
                delegation.put("targets", targetArray)
            }
            array.put(
                JSONObject()
                    .put("delegation", delegation)
                    .put("signature", signed.signature.base64UrlNoPadding()),
            )
        }
        return json.put("delegations", array)
    }

    private fun decodeDelegationChain(json: JSONObject): IcDelegationChain {
        val publicKey = json.getString("publicKey").base64UrlDecoded()
        val delegations = json.getJSONArray("delegations")
        val signed = (0 until delegations.length()).map { index ->
            val item = delegations.getJSONObject(index)
            val delegation = item.getJSONObject("delegation")
            val targets = delegation.optJSONArray("targets")?.let { array ->
                (0 until array.length()).map { targetIndex -> array.getString(targetIndex).base64UrlDecoded() }
            }
            IcDelegationChain.SignedDelegation(
                delegation = IcDelegationChain.Delegation(
                    publicKey = delegation.getString("publicKey").base64UrlDecoded(),
                    expiration = delegation.getString("expiration").toULong(),
                    targets = targets,
                ),
                signature = item.getString("signature").base64UrlDecoded(),
            )
        }
        return IcDelegationChain(publicKey = publicKey, delegations = signed)
    }

    private fun nowNanos(): ULong {
        val now = Instant.now()
        return now.epochSecond.toULong() * 1_000_000_000uL + now.nano.toULong()
    }
}

private fun byteArrayListEquals(left: List<ByteArray>?, right: List<ByteArray>?): Boolean {
    if (left == null || right == null) return left == right
    if (left.size != right.size) return false
    return left.indices.all { index -> left[index].contentEquals(right[index]) }
}
