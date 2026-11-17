import AuthenticationServices
import Foundation

/// A login the provider may offer for one AutoFill request.
public struct AutoFillCandidate: Equatable {
    public let entry: AutoFillIndexEntry
    public let serviceIdentifier: ASCredentialServiceIdentifier
    /// Non-nil when DomainMatching wants an explicit confirmation (punycode).
    public let confirmation: String?
}

public enum AutoFillMatcher {
    /// Safari passes `.URL` identifiers (the page URL); apps with associated
    /// domains pass `.domain`, which is treated as `https://<domain>`.
    public static func pageURLString(for service: ASCredentialServiceIdentifier) -> String {
        service.type == .URL ? service.identifier : "https://" + service.identifier
    }

    public static func pageHost(for service: ASCredentialServiceIdentifier) -> String? {
        DomainMatching.host(of: pageURLString(for: service))
    }

    /// The anti-phishing gate for one index entry against one requesting
    /// service. Logins only: passkey entries have no password to fill.
    public static func decision(entry: AutoFillIndexEntry, service: ASCredentialServiceIdentifier) -> FillDecision {
        guard entry.type == "login" else { return .denied("Only logins can fill a password.") }
        return DomainMatching.checkFillAllowed(
            pageURLString: pageURLString(for: service),
            itemURLString: "https://" + entry.host,
            itemType: entry.type
        )
    }

    /// Index entries that may be offered for these service identifiers,
    /// each at most once, in index order.
    public static func candidates(
        entries: [AutoFillIndexEntry],
        serviceIdentifiers: [ASCredentialServiceIdentifier]
    ) -> [AutoFillCandidate] {
        var offered = Set<String>()
        var result: [AutoFillCandidate] = []
        for service in serviceIdentifiers {
            for entry in entries where !offered.contains(entry.id) {
                switch decision(entry: entry, service: service) {
                case .allowed:
                    result.append(AutoFillCandidate(entry: entry, serviceIdentifier: service, confirmation: nil))
                case .needsConfirmation(let reason):
                    result.append(AutoFillCandidate(entry: entry, serviceIdentifier: service, confirmation: reason))
                case .denied:
                    continue
                }
                offered.insert(entry.id)
            }
        }
        return result
    }
}

/// Keeps the system's QuickType suggestions (`ASCredentialIdentityStore`)
/// equal to `autofill_index` logins. Identities carry username + host +
/// item id only — the same data as the index, never a secret.
///
/// Callers: the extension (configuration screen, every credential list)
/// and — required for QuickType suggestions to stay current — the app,
/// after every `autofill_index` rewrite, and `removeAll` on wipe, on
/// "disable biometric unlock" and on lock-out settings change. See
/// README.md "Credential identity store".
public enum CredentialIdentitySync {
    public static func identities(from entries: [AutoFillIndexEntry]) -> [ASPasswordCredentialIdentity] {
        entries.filter { $0.type == "login" && !$0.host.isEmpty }.map { entry in
            ASPasswordCredentialIdentity(
                serviceIdentifier: ASCredentialServiceIdentifier(identifier: entry.host, type: .domain),
                user: entry.username,
                recordIdentifier: entry.id
            )
        }
    }

    public static func replaceAll(with entries: [AutoFillIndexEntry], completion: ((Bool) -> Void)? = nil) {
        let store = ASCredentialIdentityStore.shared
        store.getState { state in
            guard state.isEnabled else { completion?(false); return }
            store.replaceCredentialIdentities(with: identities(from: entries)) { success, _ in completion?(success) }
        }
    }

    public static func removeAll(completion: ((Bool) -> Void)? = nil) {
        let store = ASCredentialIdentityStore.shared
        store.getState { state in
            guard state.isEnabled else { completion?(false); return }
            store.removeAllCredentialIdentities { success, _ in completion?(success) }
        }
    }
}
