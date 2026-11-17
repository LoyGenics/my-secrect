package com.loygenics.mysecrect.provider

import android.content.Context
import java.io.File

/**
 * DEBUG BUILDS ONLY (src/debug source set; the release source set has a
 * version that always returns null). Lets the emulator end-to-end test
 * use a local assetlinks.json for a test host instead of the network,
 * because no real domain lists the test caller's debug certificate.
 * The document still goes through the real [AssetLinks] checks. Files
 * live in app-private storage and are written only by the debug-only
 * instrumentation seeder (src/androidTest).
 */
internal object AssetLinksOverride {
    const val DIR = "my-secrect-debug/assetlinks"

    fun documentFor(context: Context, host: String): String? {
        if (!AssetLinks.isPlainHost(host)) return null
        val file = File(File(context.filesDir, DIR), "$host.json")
        return if (file.isFile) file.readText() else null
    }
}
