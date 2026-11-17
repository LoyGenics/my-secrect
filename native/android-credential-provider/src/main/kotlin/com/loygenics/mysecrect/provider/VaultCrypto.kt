package com.loygenics.mysecrect.provider

import android.util.Base64
import android.util.JsonReader
import android.util.JsonToken
import java.io.ByteArrayInputStream
import java.io.InputStreamReader
import org.json.JSONObject

/**
 * The vault key chain of specs/encryption-format.md v1, decrypt side only:
 * AMK --unwrap--> Vault Key --unwrap--> Item Key --decrypt--> VaultItem JSON.
 * XChaCha20-Poly1305 IETF through the app's libsodium ([Libsodium]), AD null,
 * standard base64 with the 24-byte nonce stored separately — the encodings
 * apps/mobile/src/vault.ts writes (StoredKeys, StoredRow).
 *
 * Every intermediate key and plaintext buffer is zeroed before return.
 * Any failure is FillError CORRUPT (or NOT_FOUND when the item is not a
 * login with a password) — never a partial result.
 */
internal object VaultCrypto {

    const val KEY_BYTES = 32
    const val NONCE_BYTES = 24
    const val TAG_BYTES = 16

    /** Username and password of exactly one login. Strings are immutable, so the caller must not keep them. */
    class LoginSecret(val username: String, val password: String)

    class StoredKeys(val wrappedVault: String, val wrappedVaultNonce: String)

    /** `crypto_aead_xchacha20poly1305_ietf_decrypt` with AD null. Throws CORRUPT on any failure. */
    fun aeadDecrypt(key: ByteArray, nonce: ByteArray, ciphertext: ByteArray): ByteArray {
        if (key.size != KEY_BYTES || nonce.size != NONCE_BYTES || ciphertext.size < TAG_BYTES) {
            throw FillError.corrupt("an encrypted value")
        }
        val out = ByteArray(ciphertext.size - TAG_BYTES)
        val outLen = LongArray(1)
        val rc = try {
            Libsodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
                out, outLen, null, ciphertext, ciphertext.size.toLong(), null, 0L, nonce, key,
            )
        } catch (e: LinkageError) {
            throw FillError(FillError.Code.NOT_AVAILABLE, "my-secrect could not load libsodium.")
        }
        if (rc != 0 || outLen[0] != out.size.toLong()) {
            out.fill(0)
            throw FillError.corrupt("an encrypted value")
        }
        return out
    }

    fun parseStoredKeys(json: String): StoredKeys = try {
        val o = JSONObject(json)
        StoredKeys(o.getString("wrapped_vault"), o.getString("wrapped_vault_nonce"))
    } catch (e: Exception) {
        throw FillError.corrupt("its vault keys")
    }

    /** AMK -> Vault Key (`wrapped_vault` / `wrapped_vault_nonce`). Caller zeroes the result. */
    fun unwrapVaultKey(amk: ByteArray, keys: StoredKeys): ByteArray {
        val vaultKey = aeadDecrypt(amk, b64(keys.wrappedVaultNonce), b64(keys.wrappedVault))
        if (vaultKey.size != KEY_BYTES) {
            vaultKey.fill(0)
            throw FillError.corrupt("its vault key")
        }
        return vaultKey
    }

    /** Vault Key -> Item Key -> that one row's VaultItem; returns only username + password of a live login. */
    fun decryptLogin(vaultKey: ByteArray, row: VaultStore.EncryptedRow): LoginSecret {
        if (row.deletedAt != null) throw FillError.notFound()
        val itemKey = aeadDecrypt(vaultKey, b64(row.wrappedNonce), b64(row.wrappedItemKey))
        val plaintext = try {
            if (itemKey.size != KEY_BYTES) throw FillError.corrupt("an item key")
            aeadDecrypt(itemKey, b64(row.nonce), b64(row.ciphertext))
        } finally {
            itemKey.fill(0)
        }
        try {
            return readLogin(plaintext, row.id)
        } finally {
            plaintext.fill(0)
        }
    }

    /**
     * Streams the item JSON so only id/type/schema_version/username/password
     * become Strings; every other field (notes, TOTP secret, …) is skipped.
     */
    private fun readLogin(plaintext: ByteArray, rowId: String): LoginSecret {
        var id: String? = null
        var type: String? = null
        var schemaVersion: Int? = null
        var username: String? = null
        var password: String? = null
        try {
            JsonReader(InputStreamReader(ByteArrayInputStream(plaintext), Charsets.UTF_8)).use { r ->
                r.beginObject()
                while (r.hasNext()) {
                    when (r.nextName()) {
                        "id" -> id = r.nextString()
                        "type" -> type = r.nextString()
                        "schema_version" -> schemaVersion = r.nextInt()
                        "fields" -> {
                            r.beginObject()
                            while (r.hasNext()) {
                                val name = r.nextName()
                                if ((name == "username" || name == "password") && r.peek() == JsonToken.STRING) {
                                    if (name == "username") username = r.nextString() else password = r.nextString()
                                } else {
                                    r.skipValue()
                                }
                            }
                            r.endObject()
                        }
                        else -> r.skipValue()
                    }
                }
                r.endObject()
            }
        } catch (e: Exception) {
            throw FillError.corrupt("this item")
        }
        // Same guard as apps/mobile/src/vault.ts decryptRows(): the payload must be the row it is stored under.
        if (id != rowId || schemaVersion != 1) throw FillError.corrupt("this item")
        if (type != "login") throw FillError.notFound()
        val u = username
        val p = password
        if (u.isNullOrEmpty() || p.isNullOrEmpty()) throw FillError.notFound()
        return LoginSecret(u, p)
    }

    private fun b64(s: String): ByteArray = try {
        Base64.decode(s, Base64.DEFAULT)
    } catch (e: IllegalArgumentException) {
        throw FillError.corrupt("an encrypted value")
    }
}
