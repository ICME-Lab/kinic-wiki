package xyz.kinic.android

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import org.json.JSONObject
import java.io.File
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal data class EncryptedSecret(
    val iv: ByteArray,
    val ciphertext: ByteArray,
)

internal interface AuthSecretCipher {
    fun encrypt(plaintext: ByteArray): EncryptedSecret
    fun decrypt(secret: EncryptedSecret): ByteArray
}

internal data class StoredAuthSecret(
    val value: String,
    val isLegacyPlaintext: Boolean,
)

internal class AuthSecretStore(
    private val file: File,
    private val cipher: AuthSecretCipher,
) {
    fun exists(): Boolean = file.exists()

    fun read(): StoredAuthSecret? {
        if (!file.exists()) return null
        val stored = file.readText(Charsets.UTF_8)
        val envelope = try {
            JSONObject(stored)
        } catch (_: Exception) {
            return StoredAuthSecret(stored, isLegacyPlaintext = true)
        }
        if (envelope.optInt("version") != FORMAT_VERSION) {
            return StoredAuthSecret(stored, isLegacyPlaintext = true)
        }
        val secret = EncryptedSecret(
            iv = base64Decoded(envelope.getString("iv")),
            ciphertext = base64Decoded(envelope.getString("ciphertext")),
        )
        return StoredAuthSecret(
            value = cipher.decrypt(secret).toString(Charsets.UTF_8),
            isLegacyPlaintext = false,
        )
    }

    fun write(value: String) {
        val encrypted = cipher.encrypt(value.toByteArray(Charsets.UTF_8))
        val envelope = JSONObject()
            .put("version", FORMAT_VERSION)
            .put("iv", base64(encrypted.iv))
            .put("ciphertext", base64(encrypted.ciphertext))
            .toString()
        atomicWrite(envelope.toByteArray(Charsets.UTF_8))
    }

    fun clear() {
        file.delete()
        File(file.parentFile, "${file.name}.tmp").delete()
    }

    private fun atomicWrite(bytes: ByteArray) {
        file.parentFile?.mkdirs()
        val temporary = File(file.parentFile, "${file.name}.tmp")
        temporary.writeBytes(bytes)
        try {
            Files.move(
                temporary.toPath(),
                file.toPath(),
                StandardCopyOption.ATOMIC_MOVE,
                StandardCopyOption.REPLACE_EXISTING,
            )
        } catch (_: AtomicMoveNotSupportedException) {
            Files.move(
                temporary.toPath(),
                file.toPath(),
                StandardCopyOption.REPLACE_EXISTING,
            )
        }
    }

    private companion object {
        const val FORMAT_VERSION = 2
    }
}

internal class AndroidKeystoreAuthSecretCipher(
    private val alias: String = "kinic.auth.v2",
) : AuthSecretCipher {
    override fun encrypt(plaintext: ByteArray): EncryptedSecret {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        return EncryptedSecret(
            iv = cipher.iv,
            ciphertext = cipher.doFinal(plaintext),
        )
    }

    override fun decrypt(secret: EncryptedSecret): ByteArray {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(
            Cipher.DECRYPT_MODE,
            getOrCreateKey(),
            GCMParameterSpec(GCM_TAG_BITS, secret.iv),
        )
        return cipher.doFinal(secret.ciphertext)
    }

    private fun getOrCreateKey(): SecretKey {
        val keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER).apply { load(null) }
        (keyStore.getKey(alias, null) as? SecretKey)?.let { return it }
        val keyGenerator = KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_AES,
            KEYSTORE_PROVIDER,
        )
        keyGenerator.init(
            KeyGenParameterSpec.Builder(
                alias,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return keyGenerator.generateKey()
    }

    private companion object {
        const val KEYSTORE_PROVIDER = "AndroidKeyStore"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val GCM_TAG_BITS = 128
    }
}

private fun base64(bytes: ByteArray): String =
    Base64.getEncoder().encodeToString(bytes)

private fun base64Decoded(value: String): ByteArray =
    Base64.getDecoder().decode(value)
