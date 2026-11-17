package com.loygenics.mysecrect.provider

import javax.crypto.Cipher

/**
 * One fill, specs/mobile-local-store.md §6 steps 1–4, without UI:
 *  [prepare]  reads the picked index entry, re-checks it is allowed for the
 *             caller, requires `device_unlock`, and arms the Keystore cipher;
 *  [complete] opens the AMK with the BiometricPrompt-authorised cipher and
 *             decrypts that single row.
 * Everything read before the prompt is ciphertext; nothing is cached.
 */
internal object FillSession {

    class Prepared(
        val entry: VaultStore.IndexEntry,
        val storedKeys: VaultCrypto.StoredKeys,
        val row: VaultStore.EncryptedRow,
        val unlock: DeviceUnlock.Pending,
    )

    fun prepare(location: VaultLocation, itemId: String, isAllowed: (VaultStore.IndexEntry) -> Boolean): Prepared =
        VaultStore.open(location).use { store ->
            val entry = store.indexEntry(itemId)?.takeIf { it.type == "login" && isAllowed(it) } ?: throw FillError.notFound()
            val unlockRow = store.deviceUnlock()
                ?: throw FillError(FillError.Code.NOT_ENROLLED, "Open my-secrect and enable biometric unlock.")
            val keys = VaultCrypto.parseStoredKeys(store.storedKeysJson() ?: throw FillError.corrupt("its vault keys"))
            val row = store.row(itemId)?.takeIf { it.deletedAt == null } ?: throw FillError.notFound()
            Prepared(entry, keys, row, DeviceUnlock.prepare(location, unlockRow))
        }

    fun complete(prepared: Prepared, authorisedCipher: Cipher): VaultCrypto.LoginSecret {
        val amk = DeviceUnlock.openAmk(authorisedCipher, prepared.unlock)
        try {
            return decryptWithAmk(amk, prepared.storedKeys, prepared.row)
        } finally {
            amk.fill(0)
        }
    }

    fun decryptWithAmk(amk: ByteArray, keys: VaultCrypto.StoredKeys, row: VaultStore.EncryptedRow): VaultCrypto.LoginSecret {
        val vaultKey = VaultCrypto.unwrapVaultKey(amk, keys)
        try {
            return VaultCrypto.decryptLogin(vaultKey, row)
        } finally {
            vaultKey.fill(0)
        }
    }
}
