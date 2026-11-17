package com.loygenics.mysecrect.provider

import java.io.Closeable
import java.security.GeneralSecurityException
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import net.zetetic.database.DatabaseErrorHandler
import net.zetetic.database.sqlcipher.SQLiteDatabase

/**
 * Read-only access to `vault.db` (SQLCipher 4, raw-key LSK) exactly as laid
 * out in specs/mobile-local-store.md §2–3. The provider never writes to the
 * database: no row, no key, no index entry, no device_unlock change.
 */
internal class VaultStore private constructor(private val db: SQLiteDatabase) : Closeable {

    data class IndexEntry(val id: String, val title: String, val username: String, val host: String, val type: String)
    data class DeviceUnlockRow(val scheme: String, val wrappedAmk: String)
    data class EncryptedRow(
        val id: String,
        val nonce: String,
        val ciphertext: String,
        val wrappedItemKey: String,
        val wrappedNonce: String,
        val deletedAt: String?,
    )

    /** Login entries of `autofill_index` (passkey entries are not served: no passkey support yet). */
    fun loginIndex(): List<IndexEntry> = query(
        "SELECT id, title, username, host, type FROM autofill_index WHERE type = 'login'", emptyArray(),
    ) { c -> IndexEntry(c.getString(0), c.getString(1), c.getString(2), c.getString(3), c.getString(4)) }

    fun indexEntry(id: String): IndexEntry? = query(
        "SELECT id, title, username, host, type FROM autofill_index WHERE id = ?", arrayOf(id),
    ) { c -> IndexEntry(c.getString(0), c.getString(1), c.getString(2), c.getString(3), c.getString(4)) }.firstOrNull()

    fun deviceUnlock(): DeviceUnlockRow? = query(
        "SELECT scheme, wrapped_amk FROM device_unlock WHERE id = 1", emptyArray(),
    ) { c -> DeviceUnlockRow(c.getString(0), c.getString(1)) }.firstOrNull()

    fun storedKeysJson(): String? = query("SELECT json FROM vault_keys WHERE id = 1", emptyArray()) { c -> c.getString(0) }
        .firstOrNull()

    fun row(id: String): EncryptedRow? = query(
        "SELECT id, nonce, ciphertext, wrapped_item_key, wrapped_nonce, deleted_at FROM rows WHERE id = ?", arrayOf(id),
    ) { c ->
        EncryptedRow(c.getString(0), c.getString(1), c.getString(2), c.getString(3), c.getString(4), if (c.isNull(5)) null else c.getString(5))
    }.firstOrNull()

    override fun close() = db.close()

    private fun <T> query(sql: String, args: Array<String>, map: (android.database.Cursor) -> T): List<T> = try {
        db.rawQuery(sql, args).use { c ->
            val out = ArrayList<T>()
            while (c.moveToNext()) out.add(map(c))
            out
        }
    } catch (e: Exception) {
        throw FillError.corrupt("its vault database")
    }

    companion object {
        private const val GCM_IV_BYTES = 12
        private const val GCM_TAG_BITS = 128
        private const val LSK_BYTES = 32

        /** Never let SQLCipher's default handler delete a database it cannot open (wrong key = "corrupt"). */
        private val keepFileOnError = DatabaseErrorHandler { _ -> }

        /**
         * Opens the vault read-only. NOT_AVAILABLE when there is no vault on
         * this device; CORRUPT when the LSK or the database does not open.
         */
        fun open(location: VaultLocation): VaultStore {
            if (!location.dbFile.isFile) throw FillError(FillError.Code.NOT_AVAILABLE, "my-secrect has no vault on this device yet.")
            try {
                System.loadLibrary("sqlcipher")
            } catch (e: LinkageError) {
                throw FillError(FillError.Code.NOT_AVAILABLE, "my-secrect could not load SQLCipher.")
            }
            val lsk = readLocalStorageKey(location)
            val keyPragma = rawKeyPragma(lsk)
            lsk.fill(0)
            val db = try {
                SQLiteDatabase.openDatabase(location.dbFile.path, keyPragma, null, SQLiteDatabase.OPEN_READONLY, keepFileOnError, null)
            } catch (e: Exception) {
                throw FillError.corrupt("its vault database")
            } finally {
                keyPragma.fill(0)
            }
            val store = VaultStore(db)
            val version = try {
                store.query("SELECT value FROM meta WHERE key = 'schema_version'", emptyArray()) { c -> c.getString(0) }.firstOrNull()
            } catch (e: FillError) {
                store.close()
                throw e
            }
            if (version != StoreContract.SCHEMA_VERSION) {
                store.close()
                throw FillError.corrupt("its vault database (unsupported schema)")
            }
            return store
        }

        /** `lsk.bin` = iv(12) || ct+tag, sealed by the AndroidKeyStore key [VaultLocation.lskAlias]. */
        internal fun readLocalStorageKey(location: VaultLocation): ByteArray {
            val blob = try {
                location.lskFile.readBytes()
            } catch (e: Exception) {
                throw FillError.corrupt("its storage key")
            }
            if (blob.size != GCM_IV_BYTES + LSK_BYTES + GCM_TAG_BITS / 8) throw FillError.corrupt("its storage key")
            val key = try {
                KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.getKey(location.lskAlias, null) as? SecretKey
            } catch (e: Exception) {
                null
            } ?: throw FillError.corrupt("its storage key")
            val lsk = try {
                Cipher.getInstance("AES/GCM/NoPadding").run {
                    init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG_BITS, blob, 0, GCM_IV_BYTES))
                    doFinal(blob, GCM_IV_BYTES, blob.size - GCM_IV_BYTES)
                }
            } catch (e: GeneralSecurityException) {
                throw FillError.corrupt("its storage key")
            }
            if (lsk.size != LSK_BYTES) {
                lsk.fill(0)
                throw FillError.corrupt("its storage key")
            }
            return lsk
        }

        /** ASCII bytes of `x'<64 hex>'` — SQLCipher's raw-key form, as in `PRAGMA key = "x'…'"`. */
        internal fun rawKeyPragma(key: ByteArray): ByteArray {
            val hex = "0123456789abcdef".toByteArray()
            val out = ByteArray(3 + key.size * 2)
            out[0] = 'x'.code.toByte()
            out[1] = '\''.code.toByte()
            for (i in key.indices) {
                val b = key[i].toInt() and 0xff
                out[2 + 2 * i] = hex[b ushr 4]
                out[3 + 2 * i] = hex[b and 0x0f]
            }
            out[out.size - 1] = '\''.code.toByte()
            return out
        }
    }
}
