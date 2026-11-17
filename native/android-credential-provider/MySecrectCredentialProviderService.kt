package com.loygenics.mysecrect.provider

import android.os.CancellationSignal
import android.os.OutcomeReceiver
import androidx.credentials.CreateCredentialRequest
import androidx.credentials.CreateCredentialResponse
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetCredentialResponse
import androidx.credentials.GetPasswordOption
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.provider.CredentialProviderService
import org.json.JSONObject

/**
 * Credential Manager provider service (Android 14+, API 34+).
 *
 * Status (Phase F, 17 Nov 2026): SKELETON — NOT WORKING. There is no
 * Android Studio module, no manifest entry, and no vault wiring yet, so
 * this service has never run. What is real: the service shape, the request
 * dispatch (password vs passkey, create vs get), and the `rpId` extraction
 * below. What is not: returning any credential — both entry points fail
 * closed with a protocol-correct "no credential" error until the vault
 * store, the unlock handoff, and the user-selection activity exist.
 *
 * The service NEVER returns a fake credential, NEVER returns the whole
 * vault, and NEVER fills on a mismatched origin. Origin verification is
 * done by the system via Digital Asset Links before the provider is
 * invoked (see assetlinks.json); the provider must additionally re-check
 * the rpId/host against stored item hosts with [DomainMatching] before
 * returning anything, once credential return is implemented.
 *
 * Android < 14 needs the separate Autofill Framework integration
 * (`AutofillService`) — also not implemented; see README.md.
 */
class MySecrectCredentialProviderService : CredentialProviderService() {

    override fun onCreateCredentialRequest(
        request: CreateCredentialRequest,
        cancellationSignal: CancellationSignal,
        outcomeReceiver: OutcomeReceiver<CreateCredentialResponse, CreateCredentialException>,
    ) {
        // Only passkey creation is a create flow; anything else is not
        // something this vault creates through Credential Manager.
        if (request !is CreatePublicKeyCredentialRequest) {
            outcomeReceiver.onError(
                CreateCredentialException(
                    CreateCredentialException.TYPE_NO_CREATE_CREDENTIAL,
                    "my-secrect cannot create this credential type."
                )
            )
            return
        }
        // NOT IMPLEMENTED: passkey creation needs the vault key for the
        // new item, the rpId from request.requestJson, and a user
        // confirmation UI. Fail closed — do not create a keypair the vault
        // cannot store.
        val rpId = extractRpId(request.requestJson)
        outcomeReceiver.onError(
            CreateCredentialException(
                CreateCredentialException.TYPE_NO_CREATE_CREDENTIAL,
                "my-secrect passkey creation is not implemented yet" +
                    (if (rpId != null) " (rpId: $rpId)" else "") +
                    ". See native/android-credential-provider/README.md."
            )
        )
    }

    override fun onGetCredentialRequest(
        request: GetCredentialRequest,
        cancellationSignal: CancellationSignal,
        outcomeReceiver: OutcomeReceiver<GetCredentialResponse, GetCredentialException>,
    ) {
        val wantsPassword = request.credentialOptions.any { it is GetPasswordOption }
        val wantsPasskey = request.credentialOptions.any { it is GetPublicKeyCredentialOption }
        if (!wantsPassword && !wantsPasskey) {
            outcomeReceiver.onError(
                GetCredentialException(
                    GetCredentialException.TYPE_NO_CREDENTIAL,
                    "my-secrect does not provide the requested credential type."
                )
            )
            return
        }
        // NOT IMPLEMENTED: returning a credential needs the decrypted vault
        // (unlocked via the main app), a user-selection activity, and a
        // DomainMatching re-check of the rpId/host. Until then, report that
        // there is no credential — a protocol-correct failure, not a fake.
        val rpIds = request.credentialOptions
            .filterIsInstance<GetPublicKeyCredentialOption>()
            .mapNotNull { extractRpId(it.requestJson) }
        outcomeReceiver.onError(
            GetCredentialException(
                GetCredentialException.TYPE_NO_CREDENTIAL,
                "my-secrect vault is not connected to Credential Manager yet" +
                    (if (rpIds.isNotEmpty()) " (rpIds: ${rpIds.joinToString()})" else "") +
                    ". See native/android-credential-provider/README.md."
            )
        )
    }

    /** Extract the relying-party id from a passkey request JSON, if present.
     *  Real parsing — used for the origin re-check once fills are built. */
    private fun extractRpId(requestJson: String): String? = try {
        JSONObject(requestJson).optString("rpId").takeIf { it.isNotEmpty() }
    } catch (_: Exception) {
        null
    }
}
