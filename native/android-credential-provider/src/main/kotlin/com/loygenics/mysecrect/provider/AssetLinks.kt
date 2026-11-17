package com.loygenics.mysecrect.provider

import java.net.URI
import java.security.MessageDigest
import org.json.JSONArray
import org.json.JSONObject

/**
 * Digital Asset Links rules for "may this native app receive this site's
 * password?" Pure JSON + string logic, unit-tested on the JVM.
 *
 * Both sides must agree (the association Google documents for sharing
 * sign-in between an app and a website):
 *  1. the app declares the site in its manifest `asset_statements`
 *     meta-data (an `include` of the site's assetlinks.json, or a web
 *     statement with `delegate_permission/common.get_login_creds`), and
 *  2. the site's `https://<host>/.well-known/assetlinks.json` grants
 *     `delegate_permission/common.get_login_creds` to that package AND to
 *     the SHA-256 of the certificate the app is signed with right now.
 * Only sites the calling app itself declares are ever fetched, so a fill
 * request never reveals which other sites are in the vault.
 * `include` statements inside a site's own file are not followed (fail
 * closed: such a site is not matched).
 */
object AssetLinks {

    const val GET_LOGIN_CREDS = "delegate_permission/common.get_login_creds"
    private const val WELL_KNOWN_PATH = "/.well-known/assetlinks.json"
    private val HOST_RE = Regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$")

    /** True for a lower-case DNS name with at least two labels (no IP literal, no port, no path). */
    fun isPlainHost(host: String): Boolean =
        host.length <= 253 && HOST_RE.matches(host) && !DomainMatching.isIpLiteral(host)

    /** Hosts an app's `asset_statements` JSON points at. Malformed input yields no hosts. */
    fun sitesDeclaredByApp(statementsJson: String): List<String> {
        val statements = try {
            JSONArray(statementsJson)
        } catch (e: Exception) {
            return emptyList()
        }
        val hosts = LinkedHashSet<String>()
        for (i in 0 until statements.length()) {
            val s = statements.optJSONObject(i) ?: continue
            val include = s.optString("include", "")
            if (include.isNotEmpty()) {
                httpsHost(include, requireWellKnownPath = true)?.let(hosts::add)
                continue
            }
            if (!hasRelation(s, GET_LOGIN_CREDS)) continue
            val target = s.optJSONObject("target") ?: continue
            if (target.optString("namespace") != "web") continue
            httpsHost(target.optString("site", ""), requireWellKnownPath = false)?.let(hosts::add)
        }
        return hosts.toList()
    }

    /** Does this site's assetlinks.json let [packageName], signed by [certSha256] (current signer), get its logins? */
    fun siteAuthorizesApp(assetLinksJson: String, packageName: String, certSha256: String): Boolean {
        val wanted = normalizeFingerprint(certSha256) ?: return false
        val statements = try {
            JSONArray(assetLinksJson)
        } catch (e: Exception) {
            return false
        }
        for (i in 0 until statements.length()) {
            val s = statements.optJSONObject(i) ?: continue
            if (!hasRelation(s, GET_LOGIN_CREDS)) continue
            val target = s.optJSONObject("target") ?: continue
            if (target.optString("namespace") != "android_app") continue
            if (target.optString("package_name") != packageName) continue
            val prints = target.optJSONArray("sha256_cert_fingerprints") ?: continue
            for (j in 0 until prints.length()) {
                if (normalizeFingerprint(prints.optString(j, "")) == wanted) return true
            }
        }
        return false
    }

    /** `AA:BB:…` upper-case, 32 bytes; null when not a SHA-256 fingerprint. */
    fun normalizeFingerprint(fp: String): String? {
        val hex = fp.trim().replace(":", "").uppercase()
        if (hex.length != 64 || hex.any { it !in "0123456789ABCDEF" }) return null
        return hex.chunked(2).joinToString(":")
    }

    fun sha256Fingerprint(der: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(der).joinToString(":") { "%02X".format(it) }

    fun wellKnownUrl(host: String): String = "https://$host$WELL_KNOWN_PATH"

    private fun hasRelation(statement: JSONObject, relation: String): Boolean {
        val relations = statement.optJSONArray("relation") ?: return false
        for (i in 0 until relations.length()) if (relations.optString(i) == relation) return true
        return false
    }

    private fun httpsHost(url: String, requireWellKnownPath: Boolean): String? {
        val uri = try {
            URI(url)
        } catch (e: Exception) {
            return null
        }
        if (uri.scheme != "https" || uri.port != -1 || uri.userInfo != null) return null
        val path = uri.path ?: ""
        if (requireWellKnownPath && path != WELL_KNOWN_PATH) return null
        if (!requireWellKnownPath && path != "" && path != "/") return null
        val host = uri.host?.lowercase() ?: return null
        return host.takeIf(::isPlainHost)
    }
}
