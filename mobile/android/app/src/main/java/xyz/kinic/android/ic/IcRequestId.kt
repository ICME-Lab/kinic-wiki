// Where: mobile/android/app/src/main/java/xyz/kinic/android/ic/IcRequestId.kt
// What: Representation-independent request id hashing.
// Why: IC signatures and request-status polling are keyed by content hash, not CBOR bytes.

package xyz.kinic.android.ic

object IcRequestId {
    fun hash(value: IcCbor.Value): ByteArray =
        when (value) {
            is IcCbor.Value.Text -> value.value.encodeToByteArray().sha256()
            is IcCbor.Value.Bytes -> value.value.sha256()
            is IcCbor.Value.Unsigned -> value.value.toUleb128().sha256()
            is IcCbor.Value.ArrayValue -> concatBytes(value.values.map(::hash)).sha256()
            is IcCbor.Value.MapValue -> {
                val hashed = value.values.map { (key, item) -> hash(key) to hash(item) }
                    .sortedWith { left, right -> compareBytes(left.first, right.first) }
                concatBytes(hashed.flatMap { listOf(it.first, it.second) }).sha256()
            }
            is IcCbor.Value.Tagged -> hash(value.value)
        }

    private fun compareBytes(left: ByteArray, right: ByteArray): Int {
        val limit = minOf(left.size, right.size)
        for (index in 0 until limit) {
            val diff = (left[index].toInt() and 0xff) - (right[index].toInt() and 0xff)
            if (diff != 0) return diff
        }
        return left.size - right.size
    }
}
