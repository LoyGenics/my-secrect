package com.loygenics.mysecrect.provider

import android.content.Context
import android.content.pm.PackageManager
import android.os.SystemClock
import androidx.credentials.provider.CallingAppInfo
import com.loygenics.mysecrect.R
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import javax.net.ssl.HttpsURLConnection

/**
 * Decides which `autofill_index` logins a caller may be offered.
 *
 *  - A privileged browser (allowlisted package + signing certificate, see
 *    res/raw/my_secrect_privileged_browsers.json) passes the web origin it
 *    is filling for; that origin goes through [DomainMatching].
 *  - Any other app is matched through Digital Asset Links ([AssetLinks]):
 *    the sites it declares, each confirmed by that site's assetlinks.json
 *    over HTTPS, then [DomainMatching] against the item host.
 * Only [DomainMatching.FillDecision.Allowed] passes. Punycode hosts and
 * anything ambiguous are not offered (the provider has no confirmation UI).
 */
internal object CallerMatcher {

    private const val MAX_DECLARED_SITES = 8
    private const val TIMEOUT_MS = 2_000
    private const val MAX_ASSETLINKS_BYTES = 128 * 1024
    private const val CACHE_TTL_MS = 5 * 60 * 1000L

    private class CacheEntry(val sites: List<String>, val expiresAt: Long)
    private val cache = HashMap<String, CacheEntry>()

    fun allowedLogins(context: Context, caller: CallingAppInfo?, logins: List<VaultStore.IndexEntry>): List<VaultStore.IndexEntry> {
        if (caller == null) return emptyList()
        val pages = pagesFor(context, caller)
        if (pages.isEmpty()) return emptyList()
        return logins.filter { e ->
            e.type == "login" && AssetLinks.isPlainHost(e.host) && pages.any { page ->
                DomainMatching.checkFillAllowed(page, "https://${e.host}/", e.type) == DomainMatching.FillDecision.Allowed
            }
        }
    }

    /** Web pages (https URLs) the caller is entitled to fill for. */
    private fun pagesFor(context: Context, caller: CallingAppInfo): List<String> {
        if (caller.isOriginPopulated()) {
            val allowlist = context.resources.openRawResource(R.raw.my_secrect_privileged_browsers).use { String(it.readBytes()) }
            val origin = try {
                caller.getOrigin(allowlist)
            } catch (e: Exception) {
                null // origin set by an app that is not an allowlisted browser: refuse.
            }
            return listOfNotNull(origin)
        }
        return verifiedSites(context, caller).map { "https://$it/" }
    }

    private fun verifiedSites(context: Context, caller: CallingAppInfo): List<String> {
        val cert = currentSignerFingerprint(caller) ?: return emptyList()
        val key = "${caller.packageName}|$cert"
        synchronized(cache) {
            cache[key]?.takeIf { it.expiresAt > SystemClock.elapsedRealtime() }?.let { return it.sites }
        }
        val sites = declaredSites(context, caller.packageName)
            .take(MAX_DECLARED_SITES)
            .filter { host -> assetLinksFor(context, host)?.let { AssetLinks.siteAuthorizesApp(it, caller.packageName, cert) } == true }
        synchronized(cache) { cache[key] = CacheEntry(sites, SystemClock.elapsedRealtime() + CACHE_TTL_MS) }
        return sites
    }

    /** SHA-256 of the certificate the caller is signed with now. Multi-signer apps are not matched. */
    private fun currentSignerFingerprint(caller: CallingAppInfo): String? {
        val info = caller.signingInfo
        if (info.hasMultipleSigners()) return null
        val current = info.signingCertificateHistory?.lastOrNull() ?: return null
        return AssetLinks.sha256Fingerprint(current.toByteArray())
    }

    /** Hosts from the caller's `asset_statements` manifest meta-data (needs the launcher `<queries>` entry). */
    private fun declaredSites(context: Context, packageName: String): List<String> = try {
        val pm = context.packageManager
        val app = pm.getApplicationInfo(packageName, PackageManager.ApplicationInfoFlags.of(PackageManager.GET_META_DATA.toLong()))
        val json = when (val v = app.metaData?.get("asset_statements")) {
            is Int -> pm.getResourcesForApplication(app).getString(v)
            is String -> v
            else -> null
        }
        json?.let(AssetLinks::sitesDeclaredByApp) ?: emptyList()
    } catch (e: Exception) {
        emptyList()
    }

    private fun assetLinksFor(context: Context, host: String): String? {
        AssetLinksOverride.documentFor(context, host)?.let { return it }
        return fetch(AssetLinks.wellKnownUrl(host))
    }

    /** HTTPS GET, no redirects, short timeouts, size-capped. Any failure = no document = no match. */
    private fun fetch(url: String): String? {
        val conn = (URL(url).openConnection() as? HttpsURLConnection) ?: return null
        return try {
            conn.instanceFollowRedirects = false
            conn.connectTimeout = TIMEOUT_MS
            conn.readTimeout = TIMEOUT_MS
            conn.useCaches = false
            if (conn.responseCode != HttpURLConnection.HTTP_OK) return null
            conn.inputStream.use { input ->
                val out = ByteArrayOutputStream()
                val buf = ByteArray(8192)
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    out.write(buf, 0, n)
                    if (out.size() > MAX_ASSETLINKS_BYTES) return null
                }
                out.toString(Charsets.UTF_8.name())
            }
        } catch (e: Exception) {
            null
        } finally {
            conn.disconnect()
        }
    }
}
