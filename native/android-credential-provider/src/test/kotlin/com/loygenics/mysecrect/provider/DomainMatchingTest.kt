package com.loygenics.mysecrect.provider

import com.loygenics.mysecrect.provider.DomainMatching.FillDecision
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Same cases as apps/extension/tests/domain.test.ts, plus the provider's stricter rules (no localhost). */
class DomainMatchingTest {

    private fun check(page: String, item: String, type: String = "login") = DomainMatching.checkFillAllowed(page, item, type)

    @Test fun httpsMatchingHostIsAllowed() =
        assertEquals(FillDecision.Allowed, check("https://example.com/login", "https://example.com/account"))

    @Test fun rawIpv4IsDenied() =
        assertEquals(FillDecision.Denied("Refusing to fill on a raw IP address."), check("https://203.0.113.10/login", "https://203.0.113.10/"))

    @Test fun rawIpv6IsDenied() =
        assertEquals(FillDecision.Denied("Refusing to fill on a raw IP address."), check("https://[2001:db8::1]/login", "https://[2001:db8::1]/"))

    @Test fun mismatchedHostIsDenied() = assertEquals(
        FillDecision.Denied("This login is for bank.example, but the page is evil.example."),
        check("https://evil.example/login", "https://bank.example/login"),
    )

    @Test fun lookalikeSuffixIsDenied() =
        assertTrue(check("https://notexample.com/", "https://example.com/") is FillDecision.Denied)

    @Test fun subdomainsMatchBothWays() {
        assertEquals(FillDecision.Allowed, check("https://login.example.com/", "https://example.com/"))
        assertEquals(FillDecision.Allowed, check("https://example.com/", "https://accounts.example.com/"))
        assertEquals(FillDecision.Allowed, check("https://www.example.com/", "https://example.com/"))
    }

    @Test fun httpIsDeniedEvenOnLocalhost() {
        assertEquals(FillDecision.Denied("Refusing to fill on a non-HTTPS page."), check("http://example.com/", "https://example.com/"))
        assertEquals(FillDecision.Denied("Refusing to fill on a non-HTTPS page."), check("http://localhost/", "https://localhost/"))
    }

    @Test fun punycodeInAnyLabelNeedsConfirmation() {
        assertTrue(check("https://xn--exmple-cua.com/", "https://xn--exmple-cua.com/") is FillDecision.NeedsConfirmation)
        assertTrue(check("https://xn--80ak6aa92e.example.com/", "https://example.com/") is FillDecision.NeedsConfirmation)
    }

    @Test fun bankAndCardNeedConfirmation() {
        assertTrue(check("https://bank.example/", "https://bank.example/", "bank_account") is FillDecision.NeedsConfirmation)
        assertTrue(check("https://bank.example/", "https://bank.example/", "card") is FillDecision.NeedsConfirmation)
    }

    @Test fun unparseableUrlIsDenied() =
        assertEquals(FillDecision.Denied("Could not parse the page or item URL."), check("https://exa mple.com/", "https://example.com/"))

    @Test fun ipLiteralDetection() {
        assertTrue(DomainMatching.isIpLiteral("10.0.0.1"))
        assertTrue(DomainMatching.isIpLiteral("::1"))
        assertTrue(DomainMatching.isIpLiteral("010.0.0.1"))
        assertFalse(DomainMatching.isIpLiteral("1.2.3.4.example"))
        assertFalse(DomainMatching.isIpLiteral("example.com"))
    }
}
