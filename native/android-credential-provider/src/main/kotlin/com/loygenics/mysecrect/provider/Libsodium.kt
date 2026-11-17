package com.loygenics.mysecrect.provider

import com.sun.jna.Native
import com.sun.jna.Pointer

/**
 * JNA direct mapping onto the app's own `libsodium.so` (shipped by
 * react-native-libsodium, which the vault UI already uses), so the APK
 * carries exactly one libsodium. Only the call the provider needs.
 * Loading fails with a LinkageError if the library is missing; callers
 * turn that into a FillError, never a crash or a partial result.
 */
internal object Libsodium {

    init {
        Native.register(Libsodium::class.java, "sodium")
        check(sodium_init() >= 0) { "sodium_init failed" }
    }

    @JvmStatic external fun sodium_init(): Int

    /** int crypto_aead_xchacha20poly1305_ietf_decrypt(m, *mlen_p, nsec, c, clen, ad, adlen, npub, k) */
    @JvmStatic external fun crypto_aead_xchacha20poly1305_ietf_decrypt(
        m: ByteArray,
        mlenP: LongArray,
        nsec: Pointer?,
        c: ByteArray,
        clen: Long,
        ad: Pointer?,
        adlen: Long,
        npub: ByteArray,
        k: ByteArray,
    ): Int
}
