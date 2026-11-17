package com.loygenics.mysecrect.provider

import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.annotation.RequiresApi
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.credentials.GetCredentialResponse
import androidx.credentials.GetPasswordOption
import androidx.credentials.PasswordCredential
import androidx.credentials.provider.PendingIntentHandler
import androidx.fragment.app.FragmentActivity
import com.loygenics.mysecrect.R
import java.util.concurrent.Executors

/**
 * Launched by the system when the user picks a my-secrect login in the
 * Credential Manager sheet. Re-validates the pick for the caller, runs
 * BiometricPrompt with the device-unlock CryptoObject, decrypts that one
 * row and returns a PasswordCredential for it. Every other outcome returns
 * a GetCredentialException. No state survives the activity.
 */
@RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
class GetPasswordActivity : FragmentActivity() {

    private val worker = Executors.newSingleThreadExecutor()
    private var done = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (savedInstanceState != null) {
            // Recreated mid-fill: never resume with state from a previous instance.
            fail(FillError(FillError.Code.USER_CANCEL, "The my-secrect fill was interrupted."))
            return
        }
        val request = PendingIntentHandler.retrieveProviderGetCredentialRequest(intent)
        val itemId = intent.getStringExtra(EXTRA_ITEM_ID)
        if (request == null || itemId == null || request.credentialOptions.none { it is GetPasswordOption }) {
            fail(FillError.notFound())
            return
        }
        val location = VaultLocation.forApp(this)
        worker.execute {
            try {
                val prepared = FillSession.prepare(location, itemId) { entry ->
                    CallerMatcher.allowedLogins(this, request.callingAppInfo, listOf(entry)).isNotEmpty()
                }
                runOnUiThread { prompt(prepared) }
            } catch (e: FillError) {
                runOnUiThread { fail(e) }
            } catch (e: Exception) {
                runOnUiThread { fail(FillError.corrupt("its vault")) }
            }
        }
    }

    private fun prompt(prepared: FillSession.Prepared) {
        if (done) return
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle(getString(R.string.my_secrect_provider_prompt_title))
            .setSubtitle(getString(R.string.my_secrect_provider_prompt_subtitle, prepared.entry.username, prepared.entry.host))
            .setNegativeButtonText(getString(R.string.my_secrect_provider_prompt_cancel))
            .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
            .setConfirmationRequired(false)
            .build()
        val callback = object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                val cipher = result.cryptoObject?.cipher
                if (cipher == null) {
                    fail(FillError(FillError.Code.AUTH_FAILED, "Biometric authentication did not unlock my-secrect."))
                    return
                }
                worker.execute {
                    try {
                        val secret = FillSession.complete(prepared, cipher)
                        runOnUiThread { succeed(PasswordCredential(secret.username, secret.password)) }
                    } catch (e: FillError) {
                        runOnUiThread { fail(e) }
                    } catch (e: Exception) {
                        runOnUiThread { fail(FillError.corrupt("this item")) }
                    }
                }
            }

            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                fail(errorFor(errorCode))
            }
            // onAuthenticationFailed: one rejected finger; the prompt stays open for another try.
        }
        BiometricPrompt(this, mainExecutor, callback).authenticate(info, BiometricPrompt.CryptoObject(prepared.unlock.cipher))
    }

    private fun errorFor(code: Int): FillError = when (code) {
        BiometricPrompt.ERROR_USER_CANCELED, BiometricPrompt.ERROR_NEGATIVE_BUTTON, BiometricPrompt.ERROR_CANCELED ->
            FillError(FillError.Code.USER_CANCEL, "The user cancelled the my-secrect unlock.")
        BiometricPrompt.ERROR_LOCKOUT, BiometricPrompt.ERROR_LOCKOUT_PERMANENT ->
            FillError(FillError.Code.LOCKOUT, "Too many failed attempts. Try again later or open my-secrect.")
        BiometricPrompt.ERROR_NO_BIOMETRICS ->
            FillError(FillError.Code.NOT_ENROLLED, "No biometrics are enrolled on this device.")
        BiometricPrompt.ERROR_HW_NOT_PRESENT, BiometricPrompt.ERROR_HW_UNAVAILABLE, BiometricPrompt.ERROR_NO_DEVICE_CREDENTIAL ->
            FillError(FillError.Code.NOT_AVAILABLE, "Biometric unlock is not available right now.")
        else -> FillError(FillError.Code.AUTH_FAILED, "Biometric authentication did not unlock my-secrect.")
    }

    private fun succeed(credential: PasswordCredential) {
        if (done) return
        done = true
        val result = Intent()
        PendingIntentHandler.setGetCredentialResponse(result, GetCredentialResponse(credential))
        setResult(RESULT_OK, result)
        finish()
    }

    private fun fail(error: FillError) {
        if (done) return
        done = true
        if (error.code != FillError.Code.USER_CANCEL) {
            Toast.makeText(applicationContext, userMessage(error.code), Toast.LENGTH_LONG).show()
        }
        val result = Intent()
        PendingIntentHandler.setGetCredentialException(result, error.toGetCredentialException())
        setResult(RESULT_OK, result)
        finish()
    }

    private fun userMessage(code: FillError.Code): String = getString(
        when (code) {
            FillError.Code.NOT_ENROLLED -> R.string.my_secrect_provider_error_not_enrolled
            FillError.Code.KEY_INVALIDATED -> R.string.my_secrect_provider_error_key_invalidated
            FillError.Code.LOCKOUT -> R.string.my_secrect_provider_error_lockout
            FillError.Code.NOT_FOUND, FillError.Code.NOT_AVAILABLE -> R.string.my_secrect_provider_error_not_found
            FillError.Code.AUTH_FAILED, FillError.Code.CORRUPT, FillError.Code.USER_CANCEL -> R.string.my_secrect_provider_error_failed
        },
    )

    override fun onDestroy() {
        worker.shutdown()
        super.onDestroy()
    }

    companion object {
        const val EXTRA_ITEM_ID = "com.loygenics.mysecrect.provider.ITEM_ID"
    }
}
