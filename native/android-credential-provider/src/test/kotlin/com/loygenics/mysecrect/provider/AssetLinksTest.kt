package com.loygenics.mysecrect.provider

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AssetLinksTest {

    private val pkg = "com.example.app"
    private val cert = "14:6D:E9:83:C5:73:06:50:D8:EE:B9:95:2F:34:FC:64:16:A0:83:42:E6:1D:BE:A8:8A:04:96:B2:3F:CF:44:E5"
    private val otherCert = "AA:6D:E9:83:C5:73:06:50:D8:EE:B9:95:2F:34:FC:64:16:A0:83:42:E6:1D:BE:A8:8A:04:96:B2:3F:CF:44:E5"

    private fun site(relation: String = AssetLinks.GET_LOGIN_CREDS, packageName: String = pkg, fingerprint: String = cert) = """
        [{"relation": ["$relation"],
          "target": {"namespace": "android_app", "package_name": "$packageName", "sha256_cert_fingerprints": ["$fingerprint"]}}]
    """.trimIndent()

    @Test fun siteGrantingPackageAndCertAuthorizes() = assertTrue(AssetLinks.siteAuthorizesApp(site(), pkg, cert))

    @Test fun fingerprintCaseAndColonsDoNotMatter() =
        assertTrue(AssetLinks.siteAuthorizesApp(site(fingerprint = cert.replace(":", "").lowercase()), pkg, cert))

    @Test fun otherCertificateIsRefused() = assertFalse(AssetLinks.siteAuthorizesApp(site(fingerprint = otherCert), pkg, cert))

    @Test fun otherPackageIsRefused() = assertFalse(AssetLinks.siteAuthorizesApp(site(packageName = "com.evil.app"), pkg, cert))

    @Test fun appLinksRelationAloneIsNotEnough() =
        assertFalse(AssetLinks.siteAuthorizesApp(site(relation = "delegate_permission/common.handle_all_urls"), pkg, cert))

    @Test fun malformedDocumentsAreRefused() {
        assertFalse(AssetLinks.siteAuthorizesApp("not json", pkg, cert))
        assertFalse(AssetLinks.siteAuthorizesApp("{}", pkg, cert))
        assertFalse(AssetLinks.siteAuthorizesApp("""[{"include": "https://example.com/.well-known/assetlinks.json"}]""", pkg, cert))
        assertFalse(AssetLinks.siteAuthorizesApp(site(), pkg, "not-a-fingerprint"))
    }

    @Test fun appDeclaredSitesFromIncludesAndWebStatements() {
        val declared = """
            [{"include": "https://example.com/.well-known/assetlinks.json"},
             {"include": "https://Login.Example.org/.well-known/assetlinks.json"},
             {"relation": ["${AssetLinks.GET_LOGIN_CREDS}"], "target": {"namespace": "web", "site": "https://accounts.example.net"}},
             {"relation": ["delegate_permission/common.handle_all_urls"], "target": {"namespace": "web", "site": "https://links-only.example"}}]
        """.trimIndent()
        assertEquals(listOf("example.com", "login.example.org", "accounts.example.net"), AssetLinks.sitesDeclaredByApp(declared))
    }

    @Test fun appDeclaredSitesRejectNonHttpsPortsPathsAndIps() {
        val declared = """
            [{"include": "http://example.com/.well-known/assetlinks.json"},
             {"include": "https://example.com:8443/.well-known/assetlinks.json"},
             {"include": "https://example.com/other.json"},
             {"include": "https://203.0.113.5/.well-known/assetlinks.json"},
             {"include": "https://user@example.com/.well-known/assetlinks.json"},
             {"include": "https://localhost/.well-known/assetlinks.json"}]
        """.trimIndent()
        assertEquals(emptyList<String>(), AssetLinks.sitesDeclaredByApp(declared))
        assertEquals(emptyList<String>(), AssetLinks.sitesDeclaredByApp("garbage"))
    }

    @Test fun fingerprintHelpers() {
        assertEquals(cert, AssetLinks.normalizeFingerprint(cert.lowercase()))
        assertNull(AssetLinks.normalizeFingerprint("14:6D"))
        // SHA-256("abc")
        assertEquals(
            "BA:78:16:BF:8F:01:CF:EA:41:41:40:DE:5D:AE:22:23:B0:03:61:A3:96:17:7A:9C:B4:10:FF:61:F2:00:15:AD",
            AssetLinks.sha256Fingerprint("abc".toByteArray()),
        )
    }

    @Test fun plainHostRules() {
        assertTrue(AssetLinks.isPlainHost("example.com"))
        assertFalse(AssetLinks.isPlainHost("Example.com"))
        assertFalse(AssetLinks.isPlainHost("localhost"))
        assertFalse(AssetLinks.isPlainHost("../etc"))
        assertFalse(AssetLinks.isPlainHost("a..b"))
        assertFalse(AssetLinks.isPlainHost("10.0.0.1"))
        assertFalse(AssetLinks.isPlainHost("example.com/path"))
    }
}
