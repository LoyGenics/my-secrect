package com.loygenics.mysecrect.provider

import android.content.Context
import java.io.File

/** Names fixed by specs/mobile-local-store.md (contract v1). Do not change here. */
object StoreContract {
    const val DIR = "my-secrect"
    const val DB_FILE = "vault.db"
    const val LSK_FILE = "lsk.bin"
    const val LSK_ALIAS = "my-secrect.lsk.v1"
    const val DEVICE_UNLOCK_ALIAS = "my-secrect.device-unlock.v1"
    const val DEVICE_UNLOCK_SCHEME = "android-ks-aesgcm-v1"
    const val SCHEMA_VERSION = "1"
}

/**
 * Where one vault lives. Production always uses [forApp]; instrumented
 * tests pass a temporary directory and their own Keystore aliases so they
 * never touch the real vault.
 */
data class VaultLocation(val dir: File, val lskAlias: String, val deviceUnlockAlias: String) {
    val dbFile: File get() = File(dir, StoreContract.DB_FILE)
    val lskFile: File get() = File(dir, StoreContract.LSK_FILE)

    companion object {
        fun forApp(context: Context) = VaultLocation(
            File(context.filesDir, StoreContract.DIR),
            StoreContract.LSK_ALIAS,
            StoreContract.DEVICE_UNLOCK_ALIAS,
        )
    }
}
