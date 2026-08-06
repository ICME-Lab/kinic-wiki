// Where: mobile/android/app/src/main/java/xyz/kinic/android/ic/IcPrincipal.kt
// What: Principal blob and text conversion helpers.
// Why: IC request content uses principal bytes while UI and config use canonical text.

package xyz.kinic.android.ic

object IcPrincipal {
    private val alphabet = "abcdefghijklmnopqrstuvwxyz234567".toList()

    fun parse(text: String): ByteArray? {
        val cleaned = text.lowercase().filter { it != '-' }
        var buffer = 0
        var bits = 0
        val bytes = mutableListOf<Byte>()
        for (character in cleaned) {
            val value = alphabet.indexOf(character)
            if (value < 0) return null
            buffer = (buffer shl 5) or value
            bits += 5
            if (bits >= 8) {
                bits -= 8
                bytes += ((buffer shr bits) and 0xff).toByte()
                buffer = if (bits == 0) 0 else buffer and ((1 shl bits) - 1)
            }
        }
        if (bits != 0 && buffer and ((1 shl bits) - 1) != 0) return null
        if (bytes.size < 4) return null
        val checksum = bytes.take(4).toByteArray()
        val blob = bytes.drop(4).toByteArray()
        if (blob.size > 29) return null
        if (!checksum.contentEquals(blob.crc32BigEndian())) return null
        return blob
    }

    fun text(blob: ByteArray): String {
        val withChecksum = blob.crc32BigEndian() + blob
        val output = StringBuilder()
        var buffer = 0
        var bits = 0
        for (byte in withChecksum) {
            buffer = (buffer shl 8) or (byte.toInt() and 0xff)
            bits += 8
            while (bits >= 5) {
                bits -= 5
                output.append(alphabet[(buffer shr bits) and 0x1f])
            }
        }
        if (bits > 0) {
            output.append(alphabet[(buffer shl (5 - bits)) and 0x1f])
        }
        return output.chunked(5).joinToString("-")
    }

    fun selfAuthenticatingPublicKey(publicKey: ByteArray): ByteArray =
        publicKey.sha224() + byteArrayOf(0x02)
}
