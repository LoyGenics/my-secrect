# Product

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

Web and desktop share one React app (apps/desktop, served as apps/web; Tauri shell on desktop). Mobile is a separate Expo / React Native app (apps/mobile) for iOS and Android that keeps one shared brand but follows each OS's navigation, gestures and system type. A Chromium MV3 browser extension (apps/extension) fills logins.

## Users

Ordinary individuals, not technical specialists, who want one safe place for everything private in their life: passwords and passkeys, bank accounts, payment cards, ID documents, notes, private photos and videos, and for some users SSH and API keys. They move between a phone, a laptop and a browser during the day. Vietnamese and English speakers (both languages are first-class).

## Product Purpose

My Secret is a personal digital vault. It keeps every kind of personal secret in one place, encrypted on the user's own devices before anything is synced, so the server only ever stores ciphertext. Success means a non-technical person can create a vault, save their recovery key, add and find items quickly, fill logins in the browser and on the phone, and restore everything on a new device without ever handing their keys to anyone.

## Positioning

An all-in-one vault, not just a password manager: logins, passkeys, cards, banking, identities, documents, private media and developer keys live together, end-to-end encrypted, with relations between items. The interface should make that breadth feel natural and calm rather than like a spreadsheet of credentials.

## Operating Context

- Daily: unlock with passphrase or biometrics, search, copy or autofill a login, add an item.
- Occasional: review vault health (weak or reused passwords), manage trusted devices and sessions, export an encrypted backup, restore on a new device.
- Rare but critical: first-run onboarding (create passphrase, save the one-time recovery key), account deletion, recovery after a lost device.
- Account sign-in (passkey) is separate from vault unlock (master passphrase); the UI must keep the two clearly distinct.

## Capabilities and Constraints

- 12 item types: login, passkey, bank account, card (metadata only — never CVV or PIN), identity, SSH key, API key, secure note, document, media, collection, custom.
- Favorites, tags, trash/archive, relations between items, local-only search (Cmd/Ctrl+K), password and passphrase generator, TOTP codes, Watchtower vault health, auto-lock.
- Encrypted sync across devices with explicit conflict handling (both versions kept), encrypted media upload/download, encrypted portable backups, secure sharing (in progress), Security Center (passkeys, MFA, step-up, sessions, trusted devices, activity, account deletion).
- The web client is intentionally limited (separate attack surface) and says so; desktop is the full client.
- No AI access to decrypted vault contents. No enterprise SSO/SCIM.

## Brand Commitments

- Name: "My Secret" (repository and code identifier `my-secrect`).
- Honest security copy: never claim audits, certifications or guarantees that do not exist; revocation does not erase data already on another device and the UI says so.
- Icons: Lucide for interface icons; 3D imagery for onboarding, empty states, feature cards, success screens and the item-type tiles (a pastel square behind each type's picture), from 3dicons (CC0) and Microsoft Fluent Emoji 3D (MIT). No emoji used as interface icons. Third-party licences tracked in THIRD_PARTY_NOTICES.md.
- Look: soft and light by default (warm neutral body, white cards, pill buttons, sentence-case text, big radii, gentle shadows, one orange for the primary action), with a matching soft dark theme. It must feel friendly and trustworthy to an ordinary person, not like an IT tool or a hardware panel; the earlier "Precision Instrument" look (UPPERCASE legends, LEDs, metal edges) was rejected as too mechanical. Approved mockup: docs/mockups/ui-soft-v1.html; design contract: apps/desktop/.impeccable/surfaces/apps-desktop-src-app-tsx.md.

## Evidence on Hand

- Example data: 12 fake items, one per type (Load example data). No real testimonials, customers, audits, store ratings or press exist; none may be invented.
- Logo: the ghost holding an orange key (concept 07_ghost_key, seed 8209), on a lavender square. Source: the logo concept set; provenance in packages/ui/assets/ASSETS.md.

## Product Principles

1. Calm confidence: a vault should feel safe and quiet, never alarming or cluttered, while still being honest about risk.
2. Everything private, one place: breadth of item types is the product; each type should be recognisable at a glance.
3. Keys stay with the user: every flow that touches keys (onboarding, recovery, restore, sign-in vs unlock) is explicit and unhurried.
4. Fast daily path: unlock, find, copy/fill in seconds on any device.
5. Native where it matters: one brand, but phones behave like phones and desktops like desktops.

## Accessibility & Inclusion

WCAG 2.2 AA contrast in light and dark themes, full keyboard operation on web/desktop, visible focus, screen-reader labels, reduced-motion support, Vietnamese text lengths and diacritics accommodated in every layout, responsive from 360px phones to wide desktops.
