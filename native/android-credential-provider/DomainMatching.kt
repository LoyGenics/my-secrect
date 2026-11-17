package com.loygenics.mysecrect.provider

import java.net.URI

/**
 * Origin / domain matching for Credential Manager / Autofill — the
 * anti-phishing gate.
 *
 * Mirrors `apps/extension/src/lib/domain.ts` exactly. This file is REAL,
 * fully implemented, pure Kotlin with no Android dependencies, and safe to
 * unit test on the JVM:
 *   1. The page must be https (no localhost exception here — Credential
 *      Manager never fills on a local dev server).
 *   2. The page host must not be an IP literal (IPv4 or IPv6).
 *   3. The item's stored host must match the page host exactly, or one
 *      must be a subdomain of the other.
 *   4. A punycode (`xn--`) label in ANY position needs explicit user
 *      confirmation (homograph risk).
 *   5. Bank / card items need explicit user confirmation.
 * Never fill on a mismatched or suspicious origin.
 */
object DomainMatching {

    sealed class FillDecision {
        object Allowed : FillDecision()
        data class NeedsConfirmation(val reason: String) : FillDecision()
        data class Denied(val reason: String) : FillDecision()
    }

    fun normalizeHost(host: String): String {
        val h = host.trim().lowercase()
        return if (h.startsWith("www.")) h.removePrefix("www.") else h
    }

    fun hostOf(url: String): String? = try {
        URI(url).host?.let(::normalizeHost)
    } catch (_: Exception) {
        null
    }

    /** IPv4 (`1.2.3.4`) or IPv6 (any colon — hosts arrive bare, no brackets). */
    fun isIpLiteral(host: String): Boolean {
        if (':' in host) return true
        val parts = host.split(".")
        if (parts.size != 4) return false
        return parts.all { part ->
            val n = part.toIntOrNull() ?: return@all false
            // Reject leading zeros ("01") and out-of-range octets.
            part == n.toString() && n in 0..255
        }
    }

    fun domainsMatch(pageHost: String, itemHost: String): Boolean {
        val p = normalizeHost(pageHost)
        val i = normalizeHost(itemHost)
        if (p.isEmpty() || i.isEmpty()) return false
        if (p == i) return true
        return p.endsWith(".$i") || i.endsWith(".$p")
    }

    fun containsPunycodeLabel(host: String): Boolean =
        normalizeHost(host).split(".").any { it.startsWith("xn--") }

    fun checkFillAllowed(
        pageUrl: String,
        itemUrl: String,
        itemType: String,
        requireConfirmForPunycode: Boolean = true,
        requireConfirmForBank: Boolean = true,
    ): FillDecision {
        val pageHost: String
        val itemHost: String
        try {
            val page = URI(pageUrl)
            val item = URI(itemUrl)
            if (page.scheme != "https") {
                return FillDecision.Denied("Refusing to fill on a non-HTTPS page.")
            }
            pageHost = normalizeHost(page.host ?: return FillDecision.Denied("Could not parse the page or item URL."))
            itemHost = normalizeHost(item.host ?: return FillDecision.Denied("Could not parse the page or item URL."))
        } catch (_: Exception) {
            return FillDecision.Denied("Could not parse the page or item URL.")
        }
        if (isIpLiteral(pageHost)) {
            return FillDecision.Denied("Refusing to fill on a raw IP address.")
        }
        if (!domainsMatch(pageHost, itemHost)) {
            return FillDecision.Denied("This login is for $itemHost, but the page is $pageHost.")
        }
        if (containsPunycodeLabel(pageHost) && requireConfirmForPunycode) {
            return FillDecision.NeedsConfirmation(
                "This site uses a punycode (xn--) domain, which can hide look-alike characters. Fill only if you trust it."
            )
        }
        if ((itemType == "bank_account" || itemType == "card") && requireConfirmForBank) {
            return FillDecision.NeedsConfirmation("This is a bank / card item. Confirm before filling it.")
        }
        return FillDecision.Allowed
    }
}
