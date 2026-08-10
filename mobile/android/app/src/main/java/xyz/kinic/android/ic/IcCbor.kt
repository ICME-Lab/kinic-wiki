// Where: mobile/android/app/src/main/java/xyz/kinic/android/ic/IcCbor.kt
// What: Minimal CBOR support for IC envelopes and boundary-node replies.
// Why: IC HTTP API envelopes use CBOR while VFS arguments remain Candid bytes.

package xyz.kinic.android.ic

object IcCbor {
    sealed class Value {
        data class Text(val value: String) : Value()
        data class Bytes(val value: ByteArray) : Value() {
            override fun equals(other: kotlin.Any?): Boolean =
                other is Bytes && value.contentEquals(other.value)

            override fun hashCode(): Int = value.contentHashCode()
        }
        data class Unsigned(val value: ULong) : Value()
        data class ArrayValue(val values: List<Value>) : Value()
        data class MapValue(val values: List<Pair<Value, Value>>) : Value()
        data class Tagged(val tag: ULong, val value: Value) : Value()
    }

    fun encode(value: Value): ByteArray {
        val out = mutableListOf<Byte>()
        append(value, out)
        return out.toByteArray()
    }

    fun decode(data: ByteArray): Value? {
        val reader = Reader(data)
        val value = reader.read() ?: return null
        return if (reader.isComplete()) value else null
    }

    fun queryEnvelope(canisterId: ByteArray, method: String, arg: ByteArray, ingressExpiry: ULong): ByteArray {
        val content = Value.MapValue(
            listOf(
                Value.Text("request_type") to Value.Text("query"),
                Value.Text("canister_id") to Value.Bytes(canisterId),
                Value.Text("method_name") to Value.Text(method),
                Value.Text("arg") to Value.Bytes(arg),
                Value.Text("sender") to Value.Bytes(byteArrayOf(0x04)),
                Value.Text("ingress_expiry") to Value.Unsigned(ingressExpiry),
            ),
        )
        return encode(Value.MapValue(listOf(Value.Text("content") to content)))
    }

    fun signedEnvelope(
        content: Value,
        publicKey: ByteArray,
        signature: ByteArray,
        delegation: IcDelegationChain,
    ): ByteArray {
        val cborDelegations = delegation.delegations.map { signed ->
            val delegationFields = mutableListOf<Pair<Value, Value>>(
                Value.Text("pubkey") to Value.Bytes(signed.delegation.publicKey),
                Value.Text("expiration") to Value.Unsigned(signed.delegation.expiration),
            )
            val targets = signed.delegation.targets
            if (targets != null) {
                delegationFields += Value.Text("targets") to Value.ArrayValue(targets.map(Value::Bytes))
            }
            Value.MapValue(
                listOf(
                    Value.Text("delegation") to Value.MapValue(delegationFields),
                    Value.Text("signature") to Value.Bytes(signed.signature),
                ),
            )
        }
        return encode(
            Value.MapValue(
                listOf(
                    Value.Text("content") to content,
                    Value.Text("sender_pubkey") to Value.Bytes(publicKey),
                    Value.Text("sender_sig") to Value.Bytes(signature),
                    Value.Text("sender_delegation") to Value.ArrayValue(cborDelegations),
                ),
            ),
        )
    }

    fun decodeReplyArg(data: ByteArray): ByteArray? {
        val top = unwrapTag(decode(data))
        val reply = mapValue(top, "reply") ?: return null
        val arg = mapValue(reply, "arg")
        return bytesValue(arg)
    }

    fun decodeRejectMessage(data: ByteArray): String? {
        val top = unwrapTag(decode(data))
        if (textValue(mapValue(top, "status")) != "rejected") return null
        return textValue(mapValue(top, "reject_message"))
            ?: bytesValue(mapValue(top, "reject_message"))?.toString(Charsets.UTF_8)
            ?: "IC request rejected."
    }

    fun certificateStatusArg(readStateData: ByteArray, requestId: ByteArray): Result<ByteArray?>? {
        val certificateData = bytesValue(mapValue(decode(readStateData), "certificate")) ?: return null
        val certificate = unwrapTag(decode(certificateData))
        val tree = mapValue(certificate, "tree") ?: return null
        return certificateStatusArgFromTree(tree, requestId)
    }

    fun certificateStatusArgFromTree(tree: Value, requestId: ByteArray): Result<ByteArray?>? {
        val statusPath = listOf("request_status".encodeToByteArray(), requestId, "status".encodeToByteArray())
        val statusData = lookup(statusPath, tree) ?: return Result.success(null)
        val status = statusData.toString(Charsets.UTF_8)
        return when (status) {
            "replied" -> {
                val reply = lookup(listOf("request_status".encodeToByteArray(), requestId, "reply".encodeToByteArray()), tree)
                Result.success(reply)
            }
            "received", "processing", "unknown" -> Result.success(null)
            "rejected" -> {
                val messageData = lookup(listOf("request_status".encodeToByteArray(), requestId, "reject_message".encodeToByteArray()), tree)
                val message = messageData?.toString(Charsets.UTF_8) ?: "IC update rejected."
                Result.failure(IcClientError.Rejected(message))
            }
            "done" -> Result.failure(IcClientError.InvalidResponse("read_state request done without reply"))
            else -> Result.failure(IcClientError.InvalidResponse("read_state request status"))
        }
    }

    fun mapValue(value: Value?, key: String): Value? {
        val map = unwrapTag(value)
        if (map !is Value.MapValue) return null
        return map.values.firstOrNull { (candidate, _) ->
            candidate is Value.Text && candidate.value == key
        }?.second
    }

    fun bytesValue(value: Value?): ByteArray? {
        val unwrapped = unwrapTag(value)
        return if (unwrapped is Value.Bytes) unwrapped.value else null
    }

    fun textValue(value: Value?): String? {
        val unwrapped = unwrapTag(value)
        return if (unwrapped is Value.Text) unwrapped.value else null
    }

    private fun lookup(path: List<ByteArray>, tree: Value): ByteArray? {
        return when (val node = unwrapTag(tree)) {
            is Value.ArrayValue -> {
                val nodeType = node.values.firstOrNull()
                when {
                    nodeType is Value.Unsigned && nodeType.value == 1uL && node.values.size == 3 ->
                        lookup(path, node.values[1]) ?: lookup(path, node.values[2])
                    nodeType is Value.Unsigned && nodeType.value == 2uL && node.values.size == 3 -> {
                        val label = bytesValue(node.values[1])
                        if (path.isNotEmpty() && label != null && label.contentEquals(path.first())) {
                            lookup(path.drop(1), node.values[2])
                        } else {
                            null
                        }
                    }
                    nodeType is Value.Unsigned && nodeType.value == 3uL && node.values.size == 2 && path.isEmpty() ->
                        bytesValue(node.values[1])
                    else -> null
                }
            }
            else -> null
        }
    }

    private fun unwrapTag(value: Value?): Value? =
        if (value is Value.Tagged) unwrapTag(value.value) else value

    private fun append(value: Value, out: MutableList<Byte>) {
        when (value) {
            is Value.Text -> {
                val bytes = value.value.encodeToByteArray()
                appendHeader(3, bytes.size.toULong(), out)
                out += bytes.toList()
            }
            is Value.Bytes -> {
                appendHeader(2, value.value.size.toULong(), out)
                out += value.value.toList()
            }
            is Value.Unsigned -> appendHeader(0, value.value, out)
            is Value.ArrayValue -> {
                appendHeader(4, value.values.size.toULong(), out)
                value.values.forEach { append(it, out) }
            }
            is Value.MapValue -> {
                appendHeader(5, value.values.size.toULong(), out)
                value.values.forEach { (key, item) ->
                    append(key, out)
                    append(item, out)
                }
            }
            is Value.Tagged -> {
                appendHeader(6, value.tag, out)
                append(value.value, out)
            }
        }
    }

    private fun appendHeader(major: Int, count: ULong, out: MutableList<Byte>) {
        val base = major shl 5
        when {
            count < 24uL -> out += (base or count.toInt()).toByte()
            count <= UByte.MAX_VALUE.toULong() -> {
                out += (base or 24).toByte()
                out += count.toByte()
            }
            count <= UShort.MAX_VALUE.toULong() -> {
                out += (base or 25).toByte()
                out += ((count shr 8) and 0xffu).toByte()
                out += (count and 0xffu).toByte()
            }
            count <= UInt.MAX_VALUE.toULong() -> {
                out += (base or 26).toByte()
                repeat(4) { offset ->
                    out += ((count shr ((3 - offset) * 8)) and 0xffu).toByte()
                }
            }
            else -> {
                out += (base or 27).toByte()
                repeat(8) { offset ->
                    out += ((count shr ((7 - offset) * 8)) and 0xffu).toByte()
                }
            }
        }
    }

    private class Reader(private val data: ByteArray) {
        private var index = 0

        fun isComplete(): Boolean = index == data.size

        fun read(): Value? {
            if (index >= data.size) return null
            val first = data[index].toInt() and 0xff
            index += 1
            val major = first ushr 5
            val info = first and 0x1f
            if (info == 31) return readIndefinite(major)
            val count = readCount(info) ?: return null
            return when (major) {
                0 -> Value.Unsigned(count)
                2 -> readBytes(count)?.let(Value::Bytes)
                3 -> readBytes(count)?.toString(Charsets.UTF_8)?.let(Value::Text)
                4 -> {
                    val values = mutableListOf<Value>()
                    repeat(count.toInt()) {
                        values += read() ?: return null
                    }
                    Value.ArrayValue(values)
                }
                5 -> {
                    val values = mutableListOf<Pair<Value, Value>>()
                    repeat(count.toInt()) {
                        val key = read() ?: return null
                        val value = read() ?: return null
                        values += key to value
                    }
                    Value.MapValue(values)
                }
                6 -> {
                    val nested = read() ?: return null
                    Value.Tagged(count, nested)
                }
                else -> null
            }
        }

        private fun readIndefinite(major: Int): Value? {
            return when (major) {
                4 -> {
                    val values = mutableListOf<Value>()
                    while (!isBreak()) values += read() ?: return null
                    index += 1
                    Value.ArrayValue(values)
                }
                5 -> {
                    val values = mutableListOf<Pair<Value, Value>>()
                    while (!isBreak()) {
                        val key = read() ?: return null
                        val value = read() ?: return null
                        values += key to value
                    }
                    index += 1
                    Value.MapValue(values)
                }
                else -> null
            }
        }

        private fun readCount(info: Int): ULong? =
            when (info) {
                in 0..23 -> info.toULong()
                24 -> readInteger(1)
                25 -> readInteger(2)
                26 -> readInteger(4)
                27 -> readInteger(8)
                else -> null
            }

        private fun readInteger(byteCount: Int): ULong? {
            if (index + byteCount > data.size) return null
            var value = 0uL
            repeat(byteCount) {
                value = (value shl 8) or (data[index].toUByte().toULong())
                index += 1
            }
            return value
        }

        private fun readBytes(count: ULong): ByteArray? {
            if (count > Int.MAX_VALUE.toULong()) return null
            val intCount = count.toInt()
            if (index + intCount > data.size) return null
            val out = data.copyOfRange(index, index + intCount)
            index += intCount
            return out
        }

        private fun isBreak(): Boolean =
            index < data.size && (data[index].toInt() and 0xff) == 0xff
    }
}
