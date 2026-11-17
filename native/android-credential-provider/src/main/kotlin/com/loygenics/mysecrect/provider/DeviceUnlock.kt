package com.loygenics.mysecrect.provider

import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.UserNotAuthenticatedException
import android.util.Base64
import java.security.GeneralSecurityException
import java.security.KeyStore
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Scheme `android-ks-aesgcm-v1` (specs/mobile-local-store.md §4), read side.
 * `wrapped_amk` = iv(12) || ct || tag(16), sealed by the AndroidKeyStore key
 * `my-secrect.device-unlock.v1` (user authentication required for every use,
 * invalidated by biometric enrolment). The app creates the key and the row;
 * the provider only opens the AMK through a BiometricPrompt CryptoObject.
 */
internal object DeviceUnlock {

    private const val IV_BYTES = 12
    private const val TAG_BYTES = 16
    private const val AMK_BYTES = 32

    /** A decrypt Cipher waiting for BiometricPrompt, plus the sealed AMK it will open. */
    class Pending(val cipher: Cipher, internal val sealed: ByteArray)

    fun prepare(location: VaultLocation, row: VaultStore.DeviceUnlockRow): Pending {
        if (row.scheme != StoreContract.DEVICE_UNLOCK_SCHEME) throw FillError.corrupt("its biometric unlock data")
        val blob = try {
            Base64.decode(row.wrappedAmk, Base64.DEFAULT)
        } catch (e: IllegalArgumentException) {
            throw FillError.corrupt("its biometric unlock data")
        }
        if (blob.size != IV_BYTES + AMK_BYTES + TAG_BYTES) throw FillError.corrupt("its biometric unlock data")
        val key = try {
            KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.getKey(location.deviceUnlockAlias, null) as? SecretKey
        } catch (e: Exception) {
            null
        } ?: throw keyInvalidated()
        val cipher = try {
            Cipher.getInstance("AES/GCM/NoPadding").apply {
                init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BYTES * 8, blob, 0, IV_BYTES))
            }
        } catch (e: KeyPermanentlyInvalidatedException) {
            throw keyInvalidated()
        } catch (e: UserNotAuthenticatedException) {
            throw FillError(FillError.Code.AUTH_FAILED, "Biometric authentication did not unlock my-secrect.")
        } catch (e: GeneralSecurityException) {
            throw FillError.corrupt("its biometric unlock data")
        }
        return Pending(cipher, blob.copyOfRange(IV_BYTES, blob.size))
    }

    /** Opens the AMK with the cipher BiometricPrompt authorised. Caller zeroes the result. */
    fun openAmk(authorisedCipher: Cipher, pending: Pending): ByteArray {
        val amk = try {
            authorisedCipher.doFinal(pending.sealed)
        } catch (e: AEADBadTagException) {
            throw FillError.corrupt("its biometric unlock data")
        } catch (e: GeneralSecurityException) {
            // IllegalBlockSizeException / KeyStoreException "Key user not authenticated".
            throw FillError(FillError.Code.AUTH_FAILED, "Biometric authentication did not unlock my-secrect.")
        } finally {
            pending.sealed.fill(0)
        }
        if (amk.size != AMK_BYTES) {
            amk.fill(0)
            throw FillError.corrupt("its biometric unlock data")
        }
        return amk
    }

    private fun keyInvalidated() = FillError(
        FillError.Code.KEY_INVALIDATED,
        "Biometric unlock was turned off because your biometrics changed. Open my-secrect and unlock with your passphrase.",
    )
}
