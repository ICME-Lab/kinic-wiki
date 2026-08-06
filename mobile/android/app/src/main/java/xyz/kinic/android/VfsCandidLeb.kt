// Where: mobile/android/app/src/main/java/xyz/kinic/android/VfsCandidLeb.kt
// What: LEB128 primitives required by the VFS Candid codec.
// Why: Candid uses LEB128 for type IDs, field IDs, lengths, and integers.

package xyz.kinic.android

object VfsCandidLeb {
    fun appendUnsigned(value: ULong, out: MutableList<Byte>) {
        var remaining = value
        do {
            var byte = (remaining and 0x7fu).toInt()
            remaining = remaining shr 7
            if (remaining != 0uL) byte = byte or 0x80
            out += byte.toByte()
        } while (remaining != 0uL)
    }

    fun appendSigned(value: Long, out: MutableList<Byte>) {
        var remaining = value
        var more = true
        while (more) {
            var byte = (remaining.toInt() and 0x7f)
            remaining = remaining shr 7
            val signBitSet = (byte and 0x40) != 0
            if ((remaining == 0L && !signBitSet) || (remaining == -1L && signBitSet)) {
                more = false
            } else {
                byte = byte or 0x80
            }
            out += byte.toByte()
        }
    }
}
