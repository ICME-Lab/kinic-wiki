// Where: mobile/android/app/src/main/java/xyz/kinic/android/ic/IcBytes.kt
// What: Byte, hash, base64url, and LEB128 helpers for IC wire formats.
// Why: Principal text, request ids, and signatures need deterministic byte encodings.

package xyz.kinic.android.ic

import org.bouncycastle.crypto.digests.SHA224Digest
import java.security.MessageDigest
import java.util.Base64
import java.util.zip.CRC32

internal fun ByteArray.toHex(): String =
    joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }

internal fun String.hexToBytesOrNull(): ByteArray? {
    val text = trim().removePrefix("0x").removePrefix("0X")
    if (text.isEmpty() || text.length % 2 != 0 || !text.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) {
        return null
    }
    return ByteArray(text.length / 2) { index ->
        text.substring(index * 2, index * 2 + 2).toInt(16).toByte()
    }
}

internal fun ByteArray.sha256(): ByteArray =
    MessageDigest.getInstance("SHA-256").digest(this)

internal fun ByteArray.sha224(): ByteArray {
    val digest = SHA224Digest()
    digest.update(this, 0, size)
    val out = ByteArray(digest.digestSize)
    digest.doFinal(out, 0)
    return out
}

internal fun ByteArray.crc32BigEndian(): ByteArray {
    val crc = CRC32()
    crc.update(this)
    val value = crc.value.toInt()
    return byteArrayOf(
        ((value ushr 24) and 0xff).toByte(),
        ((value ushr 16) and 0xff).toByte(),
        ((value ushr 8) and 0xff).toByte(),
        (value and 0xff).toByte(),
    )
}

internal fun ULong.toUleb128(): ByteArray {
    var remaining = this
    val out = mutableListOf<Byte>()
    do {
        var byte = (remaining and 0x7fu).toInt()
        remaining = remaining shr 7
        if (remaining != 0uL) byte = byte or 0x80
        out += byte.toByte()
    } while (remaining != 0uL)
    return out.toByteArray()
}

internal fun ByteArray.base64UrlNoPadding(): String =
    Base64.getUrlEncoder().withoutPadding().encodeToString(this)

internal fun String.base64UrlDecoded(): ByteArray =
    Base64.getUrlDecoder().decode(this)

internal fun concatBytes(parts: Iterable<ByteArray>): ByteArray {
    val size = parts.sumOf { it.size }
    val out = ByteArray(size)
    var offset = 0
    for (part in parts) {
        part.copyInto(out, offset)
        offset += part.size
    }
    return out
}
