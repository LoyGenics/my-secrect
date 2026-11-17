package com.loygenics.mysecrect.provider

import android.content.ContentValues
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import net.zetetic.database.sqlcipher.SQLiteDatabase
import org.json.JSONObject

/**
 * Test-side WRITER of the specs/mobile-local-store.md layout (the app's
 * storage workstream owns the real writer). Builds vault.db + lsk.bin from
 * the fixture that fixtures/generate-fixture.ts produced with the real TS
 * crypto. Lives in the androidTest APK only.
 */
internal object TestVault {

    /** DDL copied verbatim from specs/mobile-local-store.md §2. */
    private val DDL = listOf(
        "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        "CREATE TABLE IF NOT EXISTS vault_keys (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL)",
        "CREATE TABLE IF NOT EXISTS rows (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, nonce TEXT NOT NULL, " +
            "ciphertext TEXT NOT NULL, wrapped_item_key TEXT NOT NULL, wrapped_nonce TEXT NOT NULL, deleted_at TEXT)",
        "CREATE TABLE IF NOT EXISTS device_unlock (id INTEGER PRIMARY KEY CHECK (id = 1), scheme TEXT NOT NULL, " +
            "wrapped_amk TEXT NOT NULL, created_at TEXT NOT NULL)",
        "CREATE TABLE IF NOT EXISTS autofill_index (id TEXT PRIMARY KEY, title TEXT NOT NULL, username TEXT NOT NULL, " +
            "host TEXT NOT NULL, type TEXT NOT NULL)",
    )

    class Fixture(val json: JSONObject) {
        val amk: ByteArray get() = android.util.Base64.decode(json.getString("amk_b64"), android.util.Base64.DEFAULT)
        val storedKeysJson: String get() = json.getString("stored_keys_json")
        val storedKeys: VaultCrypto.StoredKeys get() = VaultCrypto.parseStoredKeys(storedKeysJson)

        fun row(id: String): VaultStore.EncryptedRow {
            val rows = json.getJSONArray("rows")
            for (i in 0 until rows.length()) {
                val r = rows.getJSONObject(i)
                if (r.getString("id") == id) {
                    return VaultStore.EncryptedRow(
                        r.getString("id"), r.getString("nonce"), r.getString("ciphertext"),
                        r.getString("wrapped_item_key"), r.getString("wrapped_nonce"),
                        if (r.isNull("deleted_at")) null else r.getString("deleted_at"),
                    )
                }
            }
            error("fixture has no row $id")
        }

        fun expected(id: String): Pair<String, String> =
            json.getJSONObject("expected").getJSONObject(id).let { it.getString("username") to it.getString("password") }
    }

    fun asset(name: String): String =
        InstrumentationRegistry.getInstrumentation().context.assets.open(name).use { String(it.readBytes(), Charsets.UTF_8) }

    fun fixture() = Fixture(JSONObject(asset("vault-fixture.json")))

    fun keyStore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    /** LSK wrapping key: AES-256-GCM, no user-auth requirement (contract §3). */
    fun createLskKey(alias: String): SecretKey = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
        init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        generateKey()
    }

    /** lsk.bin = iv(12) || ct+tag. */
    fun writeLsk(location: VaultLocation, lsk: ByteArray) {
        val key = keyStore().getKey(location.lskAlias, null) as SecretKey
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key) }
        val sealed = cipher.doFinal(lsk)
        location.dir.mkdirs()
        location.lskFile.writeBytes(cipher.iv + sealed)
    }

    fun randomLsk() = ByteArray(32).also { SecureRandom().nextBytes(it) }

    /** Creates vault.db with the fixture's keys, rows and index. device_unlock only when [wrappedAmkB64] is given. */
    fun createDb(location: VaultLocation, lsk: ByteArray, fixture: Fixture, wrappedAmkB64: String?) {
        System.loadLibrary("sqlcipher")
        location.dir.mkdirs()
        val db = SQLiteDatabase.openDatabase(
            location.dbFile.path, VaultStore.rawKeyPragma(lsk), null,
            SQLiteDatabase.OPEN_READWRITE or SQLiteDatabase.CREATE_IF_NECESSARY, null, null,
        )
        db.use {
            DDL.forEach(it::execSQL)
            it.insert("meta", null, ContentValues().apply { put("key", "schema_version"); put("value", "1") })
            it.insert("vault_keys", null, ContentValues().apply { put("id", 1); put("json", fixture.storedKeysJson) })
            val rows = fixture.json.getJSONArray("rows")
            for (i in 0 until rows.length()) {
                val r = rows.getJSONObject(i)
                it.insert("rows", null, ContentValues().apply {
                    for (col in listOf("id", "nonce", "ciphertext", "wrapped_item_key", "wrapped_nonce")) put(col, r.getString(col))
                    put("revision", r.getInt("revision"))
                    if (r.isNull("deleted_at")) putNull("deleted_at") else put("deleted_at", r.getString("deleted_at"))
                })
            }
            val index = fixture.json.getJSONArray("autofill_index")
            for (i in 0 until index.length()) {
                val e = index.getJSONObject(i)
                it.insert("autofill_index", null, ContentValues().apply {
                    for (col in listOf("id", "title", "username", "host", "type")) put(col, e.getString(col))
                })
            }
            if (wrappedAmkB64 != null) {
                it.insert("device_unlock", null, ContentValues().apply {
                    put("id", 1)
                    put("scheme", StoreContract.DEVICE_UNLOCK_SCHEME)
                    put("wrapped_amk", wrappedAmkB64)
                    put("created_at", "2026-11-17T00:00:00Z")
                })
            }
        }
    }

    /** A throwaway location under the target app's cache dir with its own aliases. */
    fun tempLocation(name: String): VaultLocation {
        val ctx = InstrumentationRegistry.getInstrumentation().targetContext
        val dir = File(ctx.cacheDir, "provider-test-$name").apply { deleteRecursively(); mkdirs() }
        return VaultLocation(dir, "my-secrect.test.lsk.$name", "my-secrect.test.device-unlock.$name")
    }

    fun deleteAliases(location: VaultLocation) {
        keyStore().run {
            deleteEntry(location.lskAlias)
            deleteEntry(location.deviceUnlockAlias)
        }
    }
}
