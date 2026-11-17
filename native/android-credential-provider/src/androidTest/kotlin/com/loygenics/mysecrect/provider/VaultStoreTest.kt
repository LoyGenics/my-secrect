package com.loygenics.mysecrect.provider

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.security.SecureRandom
import javax.crypto.KeyGenerator
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The provider's real read path (SQLCipher + AndroidKeyStore + libsodium)
 * against a contract-shaped vault in a temp dir with test-only aliases.
 */
@RunWith(AndroidJUnit4::class)
class VaultStoreTest {

    private val fixture = TestVault.fixture()
    private val locations = ArrayList<VaultLocation>()

    private fun vault(name: String, wrappedAmk: String? = null, lsk: ByteArray = TestVault.randomLsk()): VaultLocation {
        val location = TestVault.tempLocation(name).also(locations::add)
        TestVault.createLskKey(location.lskAlias)
        TestVault.writeLsk(location, lsk)
        TestVault.createDb(location, lsk, fixture, wrappedAmk)
        return location
    }

    private fun expectError(code: FillError.Code, block: () -> Unit) {
        try {
            block()
            fail("expected FillError $code")
        } catch (e: FillError) {
            assertEquals(code, e.code)
        }
    }

    @After fun cleanUp() = locations.forEach { TestVault.deleteAliases(it); it.dir.deleteRecursively() }

    @Test fun readsIndexKeysAndOneRowThenDecryptsIt() {
        val location = vault("read")
        VaultStore.open(location).use { store ->
            assertEquals(
                listOf("item_login_example", "item_login_nopass", "item_login_other"),
                store.loginIndex().map { it.id }.sorted(),
            )
            assertEquals("example.com", store.indexEntry("item_login_example")?.host)
            assertNull(store.deviceUnlock())
            val keys = VaultCrypto.parseStoredKeys(store.storedKeysJson()!!)
            val secret = FillSession.decryptWithAmk(fixture.amk, keys, store.row("item_login_example")!!)
            assertEquals(fixture.expected("item_login_example"), secret.username to secret.password)
            assertNull(store.row("no_such_item"))
        }
    }

    @Test fun lskIsTheRawSqlcipherKey() {
        val lsk = TestVault.randomLsk()
        val location = vault("lsk", lsk = lsk)
        assertArrayEquals(lsk, VaultStore.readLocalStorageKey(location))
        assertEquals("x'" + lsk.joinToString("") { "%02x".format(it) } + "'", String(VaultStore.rawKeyPragma(lsk)))
    }

    @Test fun wrongLskFailsClosedAndNeverDeletesTheDatabase() {
        val location = vault("wronglsk")
        val before = location.dbFile.readBytes()
        TestVault.writeLsk(location, TestVault.randomLsk()) // lsk.bin now seals a different key
        expectError(FillError.Code.CORRUPT) { VaultStore.open(location) }
        assertTrue(location.dbFile.isFile)
        assertArrayEquals(before, location.dbFile.readBytes())
    }

    @Test fun missingLskKeyOrFileIsCorrupt() {
        val location = vault("nokey")
        TestVault.keyStore().deleteEntry(location.lskAlias)
        expectError(FillError.Code.CORRUPT) { VaultStore.open(location) }
        location.lskFile.delete()
        expectError(FillError.Code.CORRUPT) { VaultStore.open(location) }
    }

    @Test fun noVaultIsNotAvailable() {
        val location = TestVault.tempLocation("empty").also(locations::add)
        expectError(FillError.Code.NOT_AVAILABLE) { VaultStore.open(location) }
    }

    @Test fun missingDeviceUnlockFailsClosed() {
        val location = vault("nounlock")
        expectError(FillError.Code.NOT_ENROLLED) { FillSession.prepare(location, "item_login_example") { true } }
    }

    @Test fun pickNotAllowedForCallerOrNotInIndexIsNotFound() {
        val location = vault("notallowed", wrappedAmk = Base64.encodeToString(ByteArray(60), Base64.NO_WRAP))
        expectError(FillError.Code.NOT_FOUND) { FillSession.prepare(location, "item_login_example") { false } }
        expectError(FillError.Code.NOT_FOUND) { FillSession.prepare(location, "item_note") { true } }
        expectError(FillError.Code.NOT_FOUND) { FillSession.prepare(location, "no_such_item") { true } }
    }

    @Test fun deviceUnlockKeyMissingIsKeyInvalidated() {
        // Row present, Keystore key gone (what the app sees after the key was invalidated and removed).
        val location = vault("nodevicekey", wrappedAmk = Base64.encodeToString(ByteArray(60), Base64.NO_WRAP))
        expectError(FillError.Code.KEY_INVALIDATED) { FillSession.prepare(location, "item_login_example") { true } }
    }

    @Test fun malformedDeviceUnlockBlobIsCorrupt() {
        val location = vault("badblob", wrappedAmk = Base64.encodeToString(ByteArray(20), Base64.NO_WRAP))
        expectError(FillError.Code.CORRUPT) { FillSession.prepare(location, "item_login_example") { true } }
    }

    /**
     * The contract key (user auth for every use, invalidated by enrolment)
     * refuses to open the AMK without a BiometricPrompt-authorised cipher.
     * Needs a secure lock screen + an enrolled fingerprint on the device.
     */
    @Test fun deviceUnlockKeyRefusesUnauthenticatedUse() {
        val location = vault("unauth", wrappedAmk = Base64.encodeToString(ByteArray(60).also { SecureRandom().nextBytes(it) }, Base64.NO_WRAP))
        val generated = try {
            KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
                init(
                    KeyGenParameterSpec.Builder(location.deviceUnlockAlias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                        .setKeySize(256)
                        .setUserAuthenticationRequired(true)
                        .setInvalidatedByBiometricEnrollment(true)
                        .build(),
                )
                generateKey()
            }
            true
        } catch (e: Exception) {
            false
        }
        assumeTrue("device has no enrolled biometric / secure lock screen", generated)
        val prepared = FillSession.prepare(location, "item_login_example") { true }
        expectError(FillError.Code.AUTH_FAILED) { FillSession.complete(prepared, prepared.unlock.cipher) }
    }
}
