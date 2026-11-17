package com.loygenics.mysecrect.provider

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import android.util.Log
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.testing.EmptyFragmentActivity
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * DEBUG / TEST APK ONLY — seeds the REAL contract locations of the debug
 * app on an emulator for the end-to-end Credential Manager check. Skipped
 * unless run explicitly:
 *
 *   adb shell am instrument -w -e class com.loygenics.mysecrect.provider.E2ESeed \
 *     -e e2eSeed true -e callerCert <SHA-256 of the test caller's cert> \
 *     com.loygenics.mysecrect.test/androidx.test.runner.AndroidJUnitRunner
 *   # then, while the BiometricPrompt is showing: adb emu finger touch 1
 *
 * It does what the app's enrolment does per specs/mobile-local-store.md:
 * LSK key + lsk.bin, vault.db, and the device-unlock key wrapping the AMK
 * through a BiometricPrompt CryptoObject. It also writes the debug-only
 * assetlinks override for example.com naming the test caller.
 */
@RunWith(AndroidJUnit4::class)
class E2ESeed {

    private val args = InstrumentationRegistry.getArguments()

    @Test fun seedContractVaultForEmulatorTest() {
        assumeTrue("run only with -e e2eSeed true", args.getString("e2eSeed") == "true")
        val callerCert = AssetLinks.normalizeFingerprint(args.getString("callerCert") ?: "")
        assertNotNull("-e callerCert <sha256> is required", callerCert)
        val ctx = InstrumentationRegistry.getInstrumentation().targetContext
        val location = VaultLocation.forApp(ctx)
        assertTrue(
            "refusing to overwrite an existing vault.db without -e e2eReplace true",
            !location.dbFile.exists() || args.getString("e2eReplace") == "true",
        )
        location.dir.deleteRecursively()
        TestVault.deleteAliases(location)

        val fixture = TestVault.fixture()
        val lsk = TestVault.randomLsk()
        TestVault.createLskKey(location.lskAlias)
        TestVault.writeLsk(location, lsk)

        val deviceKey = generateDeviceUnlockKey(location.deviceUnlockAlias)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, deviceKey) }
        val authorised = authenticate(cipher)
        val amk = fixture.amk
        val wrapped = authorised.iv + authorised.doFinal(amk)
        amk.fill(0)
        TestVault.createDb(location, lsk, fixture, Base64.encodeToString(wrapped, Base64.NO_WRAP))
        lsk.fill(0)

        val overrideDir = File(ctx.filesDir, AssetLinksOverride.DIR).apply { mkdirs() }
        File(overrideDir, "example.com.json").writeText(
            """[{"relation":["${AssetLinks.GET_LOGIN_CREDS}"],"target":{"namespace":"android_app",""" +
                """"package_name":"com.loygenics.mysecrect.credtest","sha256_cert_fingerprints":["$callerCert"]}}]""",
        )
        Log.i("MySecrectE2ESeed", "E2E_SEED_DONE vault=${location.dbFile} wrapped_amk_bytes=${wrapped.size}")
    }

    /** specs/mobile-local-store.md §4 `android-ks-aesgcm-v1`; StrongBox when available. */
    private fun generateDeviceUnlockKey(alias: String): SecretKey {
        fun spec(strongBox: Boolean) = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(true)
            .setInvalidatedByBiometricEnrollment(true)
            .setIsStrongBoxBacked(strongBox)
            .build()
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        return try {
            generator.init(spec(true))
            generator.generateKey()
        } catch (e: StrongBoxUnavailableException) {
            generator.init(spec(false))
            generator.generateKey()
        }
    }

    private fun authenticate(cipher: Cipher): Cipher {
        val latch = CountDownLatch(1)
        var result: Cipher? = null
        var error: String? = null
        ActivityScenario.launch(EmptyFragmentActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val info = BiometricPrompt.PromptInfo.Builder()
                    .setTitle("Seed my-secrect test vault")
                    .setSubtitle("Touch the sensor to enrol the device-unlock key")
                    .setNegativeButtonText("Cancel")
                    .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
                    .build()
                BiometricPrompt(
                    activity, ContextCompat.getMainExecutor(activity),
                    object : BiometricPrompt.AuthenticationCallback() {
                        override fun onAuthenticationSucceeded(r: BiometricPrompt.AuthenticationResult) {
                            result = r.cryptoObject?.cipher
                            latch.countDown()
                        }

                        override fun onAuthenticationError(code: Int, msg: CharSequence) {
                            error = "$code $msg"
                            latch.countDown()
                        }
                    },
                ).authenticate(info, BiometricPrompt.CryptoObject(cipher))
            }
            Log.i("MySecrectE2ESeed", "E2E_SEED_WAITING_FOR_FINGERPRINT")
            assertTrue("no fingerprint within 120 s", latch.await(120, TimeUnit.SECONDS))
        }
        return result ?: throw AssertionError("biometric enrolment failed: $error")
    }
}
