package com.loygenics.mysecrect.provider

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.sun.jna.Native
import com.sun.jna.NativeLong
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The app's real libsodium.so (react-native-libsodium) on a device/emulator against
 * (a) the shared vectors in tests/crypto-vectors/argon2id-vectors.json and
 * (b) a vault produced by the real TS crypto (fixtures/generate-fixture.ts).
 */
@RunWith(AndroidJUnit4::class)
class VaultCryptoTest {

    private val vectors = JSONObject(TestVault.asset("argon2id-vectors.json"))
    private val fixture = TestVault.fixture()

    private fun hex(s: String) = ByteArray(s.length / 2) { s.substring(2 * it, 2 * it + 2).toInt(16).toByte() }

    private fun expectError(code: FillError.Code, block: () -> Unit) {
        try {
            block()
            fail("expected FillError $code")
        } catch (e: FillError) {
            assertEquals(code, e.code)
        }
    }

    @Test fun sharedAeadVectorDecrypts() {
        val list = vectors.getJSONObject("xchacha20poly1305_ietf").getJSONArray("vectors")
        for (i in 0 until list.length()) {
            val v = list.getJSONObject(i)
            val plain = VaultCrypto.aeadDecrypt(hex(v.getString("key_hex")), hex(v.getString("nonce_hex")), hex(v.getString("ciphertext_hex")))
            assertEquals(v.getString("plaintext"), String(plain, Charsets.UTF_8))
        }
    }

    @Test fun sharedAeadVectorRejectsAFlippedTagBit() {
        val v = vectors.getJSONObject("xchacha20poly1305_ietf").getJSONArray("vectors").getJSONObject(0)
        val ct = hex(v.getString("ciphertext_hex")).also { it[it.size - 1] = (it[it.size - 1].toInt() xor 1).toByte() }
        expectError(FillError.Code.CORRUPT) { VaultCrypto.aeadDecrypt(hex(v.getString("key_hex")), hex(v.getString("nonce_hex")), ct) }
    }

    /** Test-only binding: the provider itself never derives a KEK. */
    private object Pwhash {
        init { Native.register(Pwhash::class.java, "sodium") }

        @JvmStatic external fun crypto_pwhash(
            out: ByteArray, outlen: Long, passwd: ByteArray, passwdlen: Long, salt: ByteArray,
            opslimit: Long, memlimit: NativeLong, alg: Int,
        ): Int
    }

    /** Library check: the libsodium the provider loads derives the shared Argon2id KEKs. */
    @Test fun bundledLibsodiumMatchesSharedArgon2idVectors() {
        val a = vectors.getJSONObject("argon2id")
        Libsodium.sodium_init()
        val list = a.getJSONArray("vectors")
        for (i in 0 until list.length()) {
            val v = list.getJSONObject(i)
            val out = ByteArray(a.getInt("output_bytes"))
            val pw = v.getString("passphrase").toByteArray(Charsets.UTF_8)
            val rc = Pwhash.crypto_pwhash(
                out, out.size.toLong(), pw, pw.size.toLong(), hex(v.getString("salt_hex")),
                a.getLong("opslimit"), NativeLong(a.getLong("memlimit")), 2, // crypto_pwhash_ALG_ARGON2ID13
            )
            assertEquals(0, rc)
            assertArrayEquals(hex(v.getString("kek_hex")), out)
        }
    }

    @Test fun tsFixtureLoginsDecryptToTheExpectedCredential() {
        for (id in listOf("item_login_example", "item_login_other")) {
            val secret = FillSession.decryptWithAmk(fixture.amk, fixture.storedKeys, fixture.row(id))
            assertEquals(fixture.expected(id), secret.username to secret.password)
        }
    }

    @Test fun wrongAmkIsRejected() {
        val wrong = fixture.amk.also { it[0] = (it[0].toInt() xor 0x55).toByte() }
        expectError(FillError.Code.CORRUPT) { FillSession.decryptWithAmk(wrong, fixture.storedKeys, fixture.row("item_login_example")) }
    }

    @Test fun tamperedCiphertextIsRejected() {
        val row = fixture.row("item_login_example")
        val bytes = android.util.Base64.decode(row.ciphertext, android.util.Base64.DEFAULT).also { it[3] = (it[3].toInt() xor 1).toByte() }
        val tampered = row.copy(ciphertext = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP))
        expectError(FillError.Code.CORRUPT) { FillSession.decryptWithAmk(fixture.amk, fixture.storedKeys, tampered) }
    }

    @Test fun tamperedWrappedItemKeyIsRejected() {
        val row = fixture.row("item_login_example")
        val bytes = android.util.Base64.decode(row.wrappedItemKey, android.util.Base64.DEFAULT).also { it[0] = (it[0].toInt() xor 1).toByte() }
        val tampered = row.copy(wrappedItemKey = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP))
        expectError(FillError.Code.CORRUPT) { FillSession.decryptWithAmk(fixture.amk, fixture.storedKeys, tampered) }
    }

    @Test fun payloadStoredUnderAnotherIdIsRejected() {
        val swapped = fixture.row("item_login_other").copy(id = "item_login_example")
        expectError(FillError.Code.CORRUPT) { FillSession.decryptWithAmk(fixture.amk, fixture.storedKeys, swapped) }
    }

    @Test fun nonLoginLoginWithoutPasswordAndTrashedRowAreNotReturned() {
        for (id in listOf("item_note", "item_login_nopass", "item_login_trashed")) {
            expectError(FillError.Code.NOT_FOUND) { FillSession.decryptWithAmk(fixture.amk, fixture.storedKeys, fixture.row(id)) }
        }
    }

    @Test fun garbageEncodingsAreCorrupt() {
        val row = fixture.row("item_login_example")
        expectError(FillError.Code.CORRUPT) { FillSession.decryptWithAmk(fixture.amk, fixture.storedKeys, row.copy(nonce = "!!not base64!!")) }
        expectError(FillError.Code.CORRUPT) { FillSession.decryptWithAmk(fixture.amk, fixture.storedKeys, row.copy(nonce = "AAAA")) }
        expectError(FillError.Code.CORRUPT) { VaultCrypto.parseStoredKeys("{\"salt\":\"x\"}") }
    }
}
