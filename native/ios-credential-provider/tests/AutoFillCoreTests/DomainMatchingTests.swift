import AuthenticationServices
import XCTest
@testable import AutoFillCore

/// DomainMatching (mirror of apps/extension/src/lib/domain.ts) and the
/// matcher that applies it to AutoFill service identifiers.
final class DomainMatchingTests: XCTestCase {
    func testExactAndSubdomainMatch() {
        XCTAssertEqual(check("https://example.com/login", "https://example.com"), .allowed)
        XCTAssertEqual(check("https://www.example.com", "https://example.com"), .allowed)
        XCTAssertEqual(check("https://accounts.example.com", "https://example.com"), .allowed)
        XCTAssertEqual(check("https://example.com", "https://accounts.example.com"), .allowed)
        XCTAssertEqual(check("https://EXAMPLE.com", "https://example.COM"), .allowed)
    }

    func testMismatchAndLookalikeSuffixAreDenied() {
        XCTAssertTrue(isDenied(check("https://example.net", "https://example.com")))
        XCTAssertTrue(isDenied(check("https://notexample.com", "https://example.com")))
        XCTAssertTrue(isDenied(check("https://example.com.evil.io", "https://example.com")))
    }

    func testOnlyHTTPSPagesAndNoIPLiterals() {
        XCTAssertTrue(isDenied(check("http://example.com", "https://example.com")))
        XCTAssertTrue(isDenied(check("https://192.168.1.10", "https://192.168.1.10")))
        XCTAssertTrue(isDenied(check("https://[::1]", "https://[::1]")))
        XCTAssertTrue(isDenied(check("not a url", "https://example.com")))
    }

    func testPunycodeInAnyLabelNeedsConfirmation() {
        guard case .needsConfirmation = check("https://xn--exmple-cua.com", "https://xn--exmple-cua.com") else {
            return XCTFail("punycode must need confirmation")
        }
        guard case .needsConfirmation = check("https://login.xn--exmple-cua.com", "https://xn--exmple-cua.com") else {
            return XCTFail("punycode in a subdomain label must need confirmation")
        }
    }

    func testMatcherWithSafariURLIdentifiers() {
        let entries = index()
        let url = ASCredentialServiceIdentifier(identifier: "https://www.example.com/login?next=/", type: .URL)
        XCTAssertEqual(AutoFillMatcher.candidates(entries: entries, serviceIdentifiers: [url]).map(\.entry.id),
                       ["login_example", "login_example_sub"])
        let http = ASCredentialServiceIdentifier(identifier: "http://example.com/login", type: .URL)
        XCTAssertTrue(AutoFillMatcher.candidates(entries: entries, serviceIdentifiers: [http]).isEmpty)
        let other = ASCredentialServiceIdentifier(identifier: "https://example.org/", type: .URL)
        XCTAssertTrue(AutoFillMatcher.candidates(entries: entries, serviceIdentifiers: [other]).isEmpty)
    }

    func testMatcherWithDomainIdentifiersDedupesAndSkipsPasskeys() {
        let entries = index()
        let services = [
            ASCredentialServiceIdentifier(identifier: "example.com", type: .domain),
            ASCredentialServiceIdentifier(identifier: "mail.example.com", type: .domain),
        ]
        let candidates = AutoFillMatcher.candidates(entries: entries, serviceIdentifiers: services)
        XCTAssertEqual(candidates.map(\.entry.id), ["login_example", "login_example_sub"])
        XCTAssertFalse(candidates.contains { $0.entry.type == "passkey" })
        XCTAssertTrue(candidates.allSatisfy { $0.confirmation == nil })
    }

    func testMatcherCarriesPunycodeConfirmation() {
        let entry = AutoFillIndexEntry(id: "puny", title: "Puny", username: "u", host: "xn--exmple-cua.com", type: "login")
        let service = ASCredentialServiceIdentifier(identifier: "https://xn--exmple-cua.com/", type: .URL)
        let candidates = AutoFillMatcher.candidates(entries: [entry], serviceIdentifiers: [service])
        XCTAssertEqual(candidates.count, 1)
        XCTAssertNotNil(candidates.first?.confirmation)
    }

    func testIdentityStoreGetsLoginsOnlyAsDomains() {
        let identities = CredentialIdentitySync.identities(from: index())
        XCTAssertEqual(identities.map(\.recordIdentifier), ["login_example", "login_example_sub", "login_other"])
        XCTAssertTrue(identities.allSatisfy { $0.serviceIdentifier.type == .domain })
        XCTAssertEqual(identities.first?.serviceIdentifier.identifier, "example.com")
        XCTAssertEqual(identities.first?.user, "alice")
    }

    // MARK: - helpers

    private func index() -> [AutoFillIndexEntry] {
        [
            AutoFillIndexEntry(id: "login_example", title: "Example", username: "alice", host: "example.com", type: "login"),
            AutoFillIndexEntry(id: "passkey_example", title: "Example passkey", username: "", host: "example.com", type: "passkey"),
            AutoFillIndexEntry(id: "login_example_sub", title: "Example mail", username: "bob", host: "mail.example.com", type: "login"),
            AutoFillIndexEntry(id: "login_other", title: "Other", username: "carol", host: "other.test", type: "login"),
        ]
    }

    private func check(_ page: String, _ item: String) -> FillDecision {
        DomainMatching.checkFillAllowed(pageURLString: page, itemURLString: item, itemType: "login")
    }

    private func isDenied(_ decision: FillDecision) -> Bool {
        if case .denied = decision { return true }
        return false
    }
}
