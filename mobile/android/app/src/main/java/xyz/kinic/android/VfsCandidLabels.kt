// Where: mobile/android/app/src/main/java/xyz/kinic/android/VfsCandidLabels.kt
// What: Candid record and variant label hashing.
// Why: Candid encodes field names into numeric hashes on the wire.

package xyz.kinic.android

object VfsCandidLabels {
    fun id(label: String): UInt {
        var hash = 0u
        for (byte in label.encodeToByteArray()) {
            hash = hash * 223u + byte.toUByte().toUInt()
        }
        return hash
    }
}
