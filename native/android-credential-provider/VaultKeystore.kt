package com.loygenics.mysecrect.provider

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONArray

/**
 * AndroidKeyStore-backed device key + encrypted-row parsing.
 *
 * WHAT IS REAL HERE
 * - `generateDeviceKey` / `wrapWithDeviceKey` / `unwrapWithDeviceKey` are
 *   real AndroidKeyStore code: an AES-256/GCM key, `setUserAuthenticationRequired(true)`
 *   (biometric / device credential gates every use) and
 *   `setInvalidatedByBiometricEnrollment(true)` (a newly enrolled biometric
 *   invalidates the key — the user re-enrols with the passphrase).
 * - `parseVaultRows` really parses the vault's encrypted rows (same shape
 *   as the desktop vault). Rows hold ciphertext only — never plaintext.
 *
 * WHAT IS NOT DONE
 * - Nothing in this file wraps a vault key yet: there is no vault key on
 *   this side to wrap. The enrolment flow (after a passphrase unlock,
 *   wrap a copy of the Account Master Key with the device key, store the
 *   wrap next to `wrapped_recovery`) is still TODO — see README.md and
 *   `apps/mobile/native/keychain-keystore/README.md`.
 * - No credential is ever stored in plaintext. Do not "complete" this by
 *   writing passwords to SharedPreferences or the Keystore as data.
 *
 * All failures return null/false (fail closed). No exceptions escape with
 * key material, and nothing here logs secrets.
 */
object VaultKeystore {

    const val ANDROID_KEYSTORE = "AndroidKeyStore"
    const val DEVICE_KEY_ALIAS = "my-secrect-device-key"
    private const val TRANSFORMATION = "AES/GCM/NoPadding"
    private const val GCM_TAG_BITS = 128

    /** One encrypted vault row — same shape as the desktop/extension stores. */
    data class EncryptedVaultRow(
        val id: String,
        val revision: Int,
        val nonce: String,
        val ciphertext: String,
        val wrappedItemKey: String,
        val wrappedNonce: String,
        val deletedAt: String?,
    )

    /** Parse the encrypted rows JSON (array of [EncryptedVaultRow]). */
    fun parseVaultRows(json: String): List<EncryptedVaultRow> {
        val array = JSONArray(json)
        val rows = ArrayList<EncryptedVaultRow>(array.length())
        for (i in 0 until array.length()) {
            val o = array.getJSONObject(i)
            rows.add(
                EncryptedVaultRow(
                    id = o.getString("id"),
                    revision = o.getInt("revision"),
                    nonce = o.getString("nonce"),
                    ciphertext = o.getString("ciphertext"),
                    wrappedItemKey = o.getString("wrapped_item_key"),
                    wrappedNonce = o.getString("wrapped_nonce"),
                    deletedAt = if (o.isNull("deleted_at")) null else o.optString("deleted_at"),
                )
            )
        }
        return rows
    }

    /** Create the device key if absent. Returns false when the device has
     *  no secure lock screen / StrongBox / biometric hardware to back it. */
    fun generateDeviceKey(): Boolean = try {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        if (keyStore.containsAlias(DEVICE_KEY_ALIAS)) return true
        val spec = KeyGenParameterSpec.Builder(
            DEVICE_KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setUserAuthenticationRequired(true)
            .setInvalidatedByBiometricEnrollment(true)
            .setKeySize(256)
            .build()
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(spec)
        generator.generateKey()
        true
    } catch (_: Exception) {
        false
    }

    private fun getDeviceKey(): SecretKey? = try {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        keyStore.getKey(DEVICE_KEY_ALIAS, null) as? SecretKey
    } catch (_: Exception) {
        null
    }

    /** Encrypt with the device key. Returns (iv, ciphertext) or null.
     *  The caller must zero [plaintext] after use; the IV is not secret. */
    fun wrapWithDeviceKey(plaintext: ByteArray): Pair<ByteArray, ByteArray>? {
        val key = getDeviceKey() ?: return null
        return try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, key)
            Pair(cipher.iv, cipher.doFinal(plaintext))
        } catch (_: Exception) {
            null
        }
    }

    /** Decrypt with the device key (prompts for biometrics). Null on any
     *  failure, including user cancellation and enrolment change. */
    fun unwrapWithDeviceKey(iv: ByteArray, ciphertext: ByteArray): ByteArray? {
        val key = getDeviceKey() ?: return null
        return try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG_BITS, iv))
            cipher.doFinal(ciphertext)
        } catch (_: Exception) {
            null
        }
    }

    /** Revocation: delete the device key ("Disable biometric unlock"). */
    fun deleteDeviceKey(): Boolean = try {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        keyStore.deleteEntry(DEVICE_KEY_ALIAS)
        true
    } catch (_: Exception) {
        false
    }
}
