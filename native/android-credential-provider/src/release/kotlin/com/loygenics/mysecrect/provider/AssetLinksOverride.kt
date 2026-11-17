package com.loygenics.mysecrect.provider

import android.content.Context

/** Release builds always fetch https://<host>/.well-known/assetlinks.json; there is no override. */
internal object AssetLinksOverride {
    @Suppress("UNUSED_PARAMETER")
    fun documentFor(context: Context, host: String): String? = null
}
