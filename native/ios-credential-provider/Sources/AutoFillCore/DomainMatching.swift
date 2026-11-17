import Foundation

/// Origin / domain matching for AutoFill — the anti-phishing gate.
///
/// Mirrors `apps/extension/src/lib/domain.ts` exactly. This file is REAL,
/// fully implemented, pure Swift with no dependencies, and safe to unit
/// test without Xcode project wiring:
///   1. The page must be https (no localhost exception here — AutoFill never
///      fills on a local dev server).
///   2. The page host must not be an IP literal (IPv4 or IPv6).
///   3. The item's stored host must match the page host exactly, or one
///      must be a subdomain of the other.
///   4. A punycode (`xn--`) label in ANY position needs explicit user
///      confirmation (homograph risk).
///   5. Bank / card items need explicit user confirmation.
/// Never fill on a mismatched or suspicious origin.

public enum FillDecision: Equatable {
    case allowed
    case needsConfirmation(String)
    case denied(String)
}

public enum DomainMatching {

    public static func normalizeHost(_ host: String) -> String {
        var h = host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if h.hasPrefix("www.") { h = String(h.dropFirst(4)) }
        return h
    }

    public static func host(of urlString: String) -> String? {
        guard let url = URL(string: urlString), let host = url.host else { return nil }
        return normalizeHost(host)
    }

    /// IPv4 (`1.2.3.4`) or IPv6 (any colon — `URL.host` strips the brackets
    /// from literals, so `::1` / `2001:db8::1` arrive bare).
    public static func isIPLiteral(_ host: String) -> Bool {
        if host.contains(":") { return true }
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return false }
        return parts.allSatisfy { part in
            guard let n = Int(part), String(n) == part, (0...255).contains(n) else { return false }
            return true
        }
    }

    public static func domainsMatch(_ pageHost: String, _ itemHost: String) -> Bool {
        let p = normalizeHost(pageHost)
        let i = normalizeHost(itemHost)
        guard !p.isEmpty, !i.isEmpty else { return false }
        if p == i { return true }
        return p.hasSuffix("." + i) || i.hasSuffix("." + p)
    }

    public static func containsPunycodeLabel(_ host: String) -> Bool {
        normalizeHost(host).split(separator: ".").contains { $0.hasPrefix("xn--") }
    }

    public static func checkFillAllowed(
        pageURLString: String,
        itemURLString: String,
        itemType: String,
        requireConfirmForPunycode: Bool = true,
        requireConfirmForBank: Bool = true
    ) -> FillDecision {
        guard let pageURL = URL(string: pageURLString),
              let itemURL = URL(string: itemURLString),
              let pageHostRaw = pageURL.host,
              let itemHostRaw = itemURL.host else {
            return .denied("Could not parse the page or item URL.")
        }
        guard pageURL.scheme == "https" else {
            return .denied("Refusing to fill on a non-HTTPS page.")
        }
        let pageHost = normalizeHost(pageHostRaw)
        if isIPLiteral(pageHost) {
            return .denied("Refusing to fill on a raw IP address.")
        }
        let itemHost = normalizeHost(itemHostRaw)
        guard domainsMatch(pageHost, itemHost) else {
            return .denied("This login is for \(itemHost), but the page is \(pageHost).")
        }
        if containsPunycodeLabel(pageHost) && requireConfirmForPunycode {
            return .needsConfirmation("This site uses a punycode (xn--) domain, which can hide look-alike characters. Fill only if you trust it.")
        }
        if (itemType == "bank_account" || itemType == "card") && requireConfirmForBank {
            return .needsConfirmation("This is a bank / card item. Confirm before filling it.")
        }
        return .allowed
    }
}
