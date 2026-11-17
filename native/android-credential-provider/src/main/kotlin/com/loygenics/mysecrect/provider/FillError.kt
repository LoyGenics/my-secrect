package com.loygenics.mysecrect.provider

import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.GetCredentialUnknownException
import androidx.credentials.exceptions.NoCredentialException

/**
 * Every way a fill can fail. Codes match specs/mobile-local-store.md §4
 * (plus NOT_FOUND for "no such login for this app or site"). No code ever
 * unlocks anything; each maps to a GetCredentialException, never to an
 * empty or made-up credential.
 */
class FillError(val code: Code, message: String) : Exception(message) {

    enum class Code { NOT_AVAILABLE, NOT_ENROLLED, KEY_INVALIDATED, USER_CANCEL, LOCKOUT, AUTH_FAILED, CORRUPT, NOT_FOUND }

    fun toGetCredentialException(): GetCredentialException = when (code) {
        Code.USER_CANCEL -> GetCredentialCancellationException(message)
        Code.NOT_FOUND, Code.NOT_AVAILABLE, Code.NOT_ENROLLED, Code.KEY_INVALIDATED -> NoCredentialException(message)
        Code.LOCKOUT, Code.AUTH_FAILED, Code.CORRUPT -> GetCredentialUnknownException(message)
    }

    companion object {
        fun notFound() = FillError(Code.NOT_FOUND, "my-secrect has no matching login for this app or site.")
        fun corrupt(what: String) = FillError(Code.CORRUPT, "my-secrect could not read $what.")
    }
}
