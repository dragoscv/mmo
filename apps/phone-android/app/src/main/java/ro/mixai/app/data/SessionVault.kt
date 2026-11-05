package ro.mixai.app.data

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Account session token at rest: Android Keystore AES-256-GCM key (non-exportable) + ciphertext in the phone
 * DataStore. One decrypt per process (cached), so there is no per-key EncryptedSharedPreferences cold-start cost
 * (codai Play ANR lesson). The shared core `Settings` only keeps [MARKER] in place of the token.
 */
class SessionVault(private val settings: PhoneSettings) {
    @Volatile private var cached: String? = null

    suspend fun read(): String {
        cached?.let { return it }
        val blob = settings.sessionBlob()
        val token = if (blob.isBlank()) "" else runCatching { decrypt(blob) }.getOrElse {
            Log.w(TAG, "session decrypt failed: ${it.javaClass.simpleName}"); ""
        }
        cached = token
        return token
    }

    suspend fun save(token: String) {
        settings.setSessionBlob(if (token.isBlank()) "" else encrypt(token))
        cached = token
    }

    suspend fun clear() = save("")

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (ks.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    private fun encrypt(plain: String): String {
        val c = Cipher.getInstance(TRANSFORM)
        c.init(Cipher.ENCRYPT_MODE, key())
        val out = c.iv + c.doFinal(plain.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(out, Base64.NO_WRAP)
    }

    private fun decrypt(blob: String): String {
        val raw = Base64.decode(blob, Base64.NO_WRAP)
        val c = Cipher.getInstance(TRANSFORM)
        c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, raw, 0, IV_LEN))
        return String(c.doFinal(raw, IV_LEN, raw.size - IV_LEN), Charsets.UTF_8)
    }

    companion object {
        /** Stored in the core `Settings` session slot instead of the real token. */
        const val MARKER = "vault:v1"
        private const val TAG = "SessionVault"
        private const val KEYSTORE = "AndroidKeyStore"
        private const val ALIAS = "mixai_session_v1"
        private const val TRANSFORM = "AES/GCM/NoPadding"
        private const val IV_LEN = 12
    }
}
