package com.loygenics.mysecrect.credtest

import android.app.Activity
import android.os.Bundle
import android.os.CancellationSignal
import android.util.Log
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.credentials.CredentialManager
import androidx.credentials.CredentialManagerCallback
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetCredentialResponse
import androidx.credentials.GetPasswordOption
import androidx.credentials.PasswordCredential
import androidx.credentials.exceptions.GetCredentialException
import java.security.MessageDigest

/**
 * TEST CALLER ONLY — never shipped. Calls CredentialManager.getCredential
 * with a password option, like any third-party app signing in, and shows
 * what came back so the my-secrect provider can be checked end to end.
 * Its manifest declares example.com through `asset_statements`.
 */
class MainActivity : Activity() {

    private lateinit var output: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        output = TextView(this).apply { textSize = 18f }
        val button = Button(this).apply {
            text = "Get password (Credential Manager)"
            setOnClickListener { request() }
        }
        setContentView(
            LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(48, 200, 48, 48)
                addView(button)
                addView(output)
            },
        )
        if (intent.getBooleanExtra("auto", false)) request()
    }

    private fun request() {
        output.text = "Requesting…"
        val request = GetCredentialRequest(listOf(GetPasswordOption()))
        CredentialManager.create(this).getCredentialAsync(
            this, request, CancellationSignal(), mainExecutor,
            object : CredentialManagerCallback<GetCredentialResponse, GetCredentialException> {
                override fun onResult(result: GetCredentialResponse) {
                    val c = result.credential
                    if (c is PasswordCredential) {
                        output.text = "RESULT PasswordCredential\nid = ${c.id}\npassword = ${c.password}"
                        Log.i(TAG, "RESULT PasswordCredential id=${c.id} passwordSha256=${sha256(c.password)}")
                    } else {
                        output.text = "RESULT unexpected credential type ${c.type}"
                        Log.i(TAG, "RESULT unexpected type ${c.type}")
                    }
                }

                override fun onError(e: GetCredentialException) {
                    output.text = "ERROR ${e.javaClass.simpleName}\ntype = ${e.type}\n${e.errorMessage}"
                    Log.i(TAG, "ERROR ${e.javaClass.simpleName} type=${e.type} message=${e.errorMessage}")
                }
            },
        )
    }

    private fun sha256(s: String) = MessageDigest.getInstance("SHA-256").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }

    private companion object {
        const val TAG = "MySecrectCredTest"
    }
}
