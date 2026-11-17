package com.loygenics.mysecrect.provider

import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.os.CancellationSignal
import android.os.OutcomeReceiver
import androidx.annotation.RequiresApi
import androidx.credentials.exceptions.ClearCredentialException
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.CreateCredentialNoCreateOptionException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.GetCredentialUnknownException
import androidx.credentials.provider.BeginCreateCredentialRequest
import androidx.credentials.provider.BeginCreateCredentialResponse
import androidx.credentials.provider.BeginGetCredentialRequest
import androidx.credentials.provider.BeginGetCredentialResponse
import androidx.credentials.provider.BeginGetPasswordOption
import androidx.credentials.provider.CredentialEntry
import androidx.credentials.provider.CredentialProviderService
import androidx.credentials.provider.PasswordCredentialEntry
import androidx.credentials.provider.ProviderClearCredentialStateRequest
import java.util.concurrent.Executors

/**
 * Credential Manager provider (Android 14+, API 34+), passwords only.
 *
 * Begin phase: lists the `autofill_index` logins that match the caller
 * ([CallerMatcher]) as PasswordCredentialEntry — title + username only, no
 * secret is read. Picking one launches [GetPasswordActivity], which does
 * the biometric unlock and returns that single credential.
 *
 * Not offered: passkeys (no signing support yet) and saving/creating
 * credentials (the provider never writes to the vault; see README.md).
 */
@RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
class MySecrectCredentialProviderService : CredentialProviderService() {

    private val worker = Executors.newSingleThreadExecutor()

    override fun onBeginGetCredentialRequest(
        request: BeginGetCredentialRequest,
        cancellationSignal: CancellationSignal,
        callback: OutcomeReceiver<BeginGetCredentialResponse, GetCredentialException>,
    ) {
        val passwordOptions = request.beginGetCredentialOptions.filterIsInstance<BeginGetPasswordOption>()
        if (passwordOptions.isEmpty()) {
            callback.onResult(BeginGetCredentialResponse())
            return
        }
        worker.execute {
            val outcome = try {
                Result.success(entriesFor(request, passwordOptions))
            } catch (e: FillError) {
                Result.failure(e.toGetCredentialException())
            } catch (e: Exception) {
                Result.failure(GetCredentialUnknownException("my-secrect could not read its vault."))
            }
            if (cancellationSignal.isCanceled) return@execute
            outcome.fold(
                onSuccess = { callback.onResult(it) },
                onFailure = { callback.onError(it as GetCredentialException) },
            )
        }
    }

    private fun entriesFor(request: BeginGetCredentialRequest, options: List<BeginGetPasswordOption>): BeginGetCredentialResponse {
        val logins = try {
            VaultStore.open(VaultLocation.forApp(this)).use { it.loginIndex() }
        } catch (e: FillError) {
            if (e.code == FillError.Code.NOT_AVAILABLE) return BeginGetCredentialResponse() // no vault: nothing to offer
            throw e
        }
        val allowed = CallerMatcher.allowedLogins(this, request.callingAppInfo, logins)
        val entries = ArrayList<CredentialEntry>()
        for (option in options) {
            for (login in allowed) {
                if (option.allowedUserIds.isNotEmpty() && login.username !in option.allowedUserIds) continue
                entries += PasswordCredentialEntry.Builder(this, login.username, pendingIntentFor(login.id, entries.size), option)
                    .setDisplayName(login.title)
                    .build()
            }
        }
        return BeginGetCredentialResponse.Builder().setCredentialEntries(entries).build()
    }

    /** Mutable: the framework adds the final request to it. The activity re-validates the item id. */
    private fun pendingIntentFor(itemId: String, requestCode: Int): PendingIntent {
        val intent = Intent(this, GetPasswordActivity::class.java)
            .setIdentifier("my-secrect-item:$itemId")
            .putExtra(GetPasswordActivity.EXTRA_ITEM_ID, itemId)
        return PendingIntent.getActivity(this, requestCode, intent, PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    override fun onBeginCreateCredentialRequest(
        request: BeginCreateCredentialRequest,
        cancellationSignal: CancellationSignal,
        callback: OutcomeReceiver<BeginCreateCredentialResponse, CreateCredentialException>,
    ) {
        callback.onError(
            CreateCredentialNoCreateOptionException("my-secrect does not save credentials from other apps. Add the login in my-secrect."),
        )
    }

    override fun onClearCredentialStateRequest(
        request: ProviderClearCredentialStateRequest,
        cancellationSignal: CancellationSignal,
        callback: OutcomeReceiver<Void?, ClearCredentialException>,
    ) {
        callback.onResult(null) // The provider keeps no per-caller state.
    }

    override fun onDestroy() {
        worker.shutdown()
        super.onDestroy()
    }
}
