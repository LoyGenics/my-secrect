# Store Preparation — iOS App Store + Google Play (updated 17 Nov 2026)

> **STATUS: NOT SUBMITTED. NOT APPROVED. NO ACCOUNTS, NO SIGNING.**
>
> No developer account enrolment, signing identity, TestFlight / Play
> testing track, store submission or review has happened. Developer
> accounts, signing keys, legal review, review approvals and audits are
> **human-controlled and PENDING** — no agent can do them, and this document
> does not pretend otherwise. Everything below is TODO unless marked.
>
> "Read" = read in the repo on 17 Nov 2026. "Run" = observed in a scripted
> run that day (`docs/deployment.md` §A). Nothing on this page was run on a
> phone, simulator or store build.

## 0. Current state

| Fact | Value | Source |
|---|---|---|
| App name / slug | `my-secrect` | read `apps/mobile/app.json` |
| Version | `0.1.0` (both platforms); Android versionCode `1` | read |
| iOS bundle id | `com.loygenics.my-secrect` | read |
| Android package | `com.loygenics.mysecrect` (differs from iOS: hyphen) | read |
| Expo SDK | `~52.0.0` | read `apps/mobile/package.json` |
| Biometrics | `expo-local-authentication`; `NSFaceIDUsageDescription` set | read |
| Credential providers | Source files exist under `native/ios-credential-provider/` and `native/android-credential-provider/`; never built, signed or run in this pass | read (git ls-files) |
| Icons / splash | Splash background colour only; no icon assets tracked under `apps/mobile` | read |
| Server account deletion | `DELETE /api/v1/auth/account` works: step-up required, data + object storage removed, sessions revoked | **run** (scenario L, `smoke.sh`) |
| In-app account deletion | Desktop + web Security Center: yes. **Mobile: no** (no `deleteAccount` call in `apps/mobile/src`) | read |
| Web deletion path (Google Play) | The web client served at `https://<domain>/` has the same Security Center deletion (sign-in + step-up) | **run** locally (CSP check flow reaches Security Center); public URL PENDING |
| Store accounts, signing | None | PENDING (human) |

## 1. Shared — do before either store

- [ ] TODO — Decide the public app name, subtitle, and keywords (the
      repo name `my-secrect` is a typo of "secret" — decide deliberately
      whether the public name keeps it or fixes it; bundle ids already
      bake it in, changing them later is painful).
- [ ] TODO — App icon: 1024×1024 master, no transparency, no rounded
      corners (Apple adds the mask). Export iOS + Android adaptive icon
      (foreground/background) + monochrome variants.
- [ ] TODO — Splash screen + launch assets for both platforms.
- [ ] TODO — Screenshots for every required size (iPhone 6.9"/6.5"/5.5",
      iPad, Android phone + 7"/10" tablet). Capture from a real build,
      never mockups.
- [ ] TODO — Privacy policy URL (hosted, public) — see `docs/privacy.md`.
      Both stores require it before submission.
- [ ] TODO — Support URL + support email (monitored inbox).
- [ ] TODO — Terms of use (or confirm the privacy policy covers it).
- [ ] TODO — Re-check the release gates in `docs/release-readiness.md`
      (not re-assessed here). Run today against a LOCAL server with the
      desktop/web code (not the mobile app): passkey registration/sign-in
      verified by the API, encrypted items pushed by one client and pulled +
      decrypted by a fresh one, encrypted media round trip, account deletion. **Do not submit a build whose core flows are untested on a
      real device.**
- [ ] TODO — External security audit (or at minimum the recorded audit
      plan with no Critical/High open). No audit exists today.
- [ ] TODO — Decide the data-safety / privacy-nutrition answers from
      `docs/privacy.md` and keep them consistent across both stores. Note:
      with a sync account the server DOES collect the email address, and per
      session the IP address and user agent (`sessions` table), plus
      timestamps and sizes. Vault content is end-to-end encrypted. Include
      AdMob's data collection for free mobile banners and RevenueCat's use
      of account IDs and purchase records.
- [ ] TODO — App versioning scheme + release tagging (none exists today).

## 2. iOS App Store

### 2.1 Accounts, signing, build — HUMAN-CONTROLLED, TODO
- [ ] TODO — Apple Developer Program enrolment (paid, human identity +
      payment; agent cannot do this).
- [ ] TODO — App Store Connect record for `com.loygenics.my-secrect`
      (app name, primary language, bundle id must match `app.json`).
- [ ] TODO — Signing: distribution certificate + provisioning profile
      (or Xcode automatic signing on the human's Mac). No signing
      identity exists in CI and none is stored in the repo — **never
      commit certificates, .p12 files, or provisioning profiles**.
- [ ] TODO — EAS Build (`eas build --platform ios`) or Xcode archive
      from a dev build. **WASM-in-Expo-Go is flagged uncertain in the
      mobile README** — confirm the crypto path works in a real device
      build before submitting.
- [ ] TODO — `expo-local-authentication` Face ID string is already in
      `app.json` (`NSFaceIDUsageDescription`) — verify the wording
      survives review and matches actual behaviour (passphrase still
      required after install).

### 2.2 Metadata
- [ ] TODO — App name, subtitle (30 chars), keywords (100 chars).
- [ ] TODO — Description: what the vault does, local-first E2EE,
      recovery-key warning (lost passphrase = unrecoverable — say so).
- [ ] TODO — Promotional text, support URL, marketing URL (optional).
- [ ] TODO — App category (Productivity), age rating questionnaire
      (free mobile builds include ads when configured).
- [ ] TODO — Configure and verify the in-app purchase products and AdMob
      banner units described in [billing setup](billing-setup.md).

### 2.3 Privacy disclosures (App Store)
- [ ] TODO — App Privacy / privacy nutrition labels. Local-only use collects
      nothing; a sync account means the operator's server holds the email
      (contact info, app functionality, linked to the user), session IP +
      user agent, and encrypted content it cannot read (`docs/privacy.md` §2).
      Confirm against the real network behaviour of the shipped build; a
      wrong label is a rejection + trust issue.
- [ ] TODO — Privacy policy URL (public, reachable).
- [ ] TODO — Account deletion: Apple requires in-app account deletion for
      apps with account creation. Server endpoint: done and run-verified.
      **Mobile UI: NOT IMPLEMENTED** (desktop/web only). Add it to the
      mobile Security screen, then verify on a device before submission.
- [ ] TODO — Permission explanations: Face ID (exists), no camera/
      location/contacts requested — confirm no permission is declared
      that the app does not use.

### 2.4 TestFlight + review
- [ ] TODO — TestFlight internal testing (up to 100 internal testers),
      then external testing (Beta App Review required, up to 10,000).
- [ ] TODO — TestFlight build notes + test account for reviewers (a
      demo vault / test credentials — reviewers need a working login;
      passkey registration must work for them).
- [ ] TODO — App Review submission; respond to rejections (common risks:
      account-deletion rule, privacy-label mismatch, crypto export
      compliance — see §4).
- [ ] TODO — Export compliance (encryption): the app uses standard
      encryption (libsodium/AES) — confirm whether an ERN / self-
      classification is required and file it (human-controlled).

## 3. Google Play

### 3.1 Accounts, signing, build — HUMAN-CONTROLLED, TODO
- [ ] TODO — Google Play Console account (paid, human identity +
      payment; agent cannot do this).
- [ ] TODO — App record for `com.loygenics.mysecrect` (note the package
      name differs from the iOS bundle id — confirm this is intended).
- [ ] TODO — Play App Signing (upload key vs signing key; keep the
      upload keystore offline, backed up, **never in the repo**).
- [ ] TODO — EAS Build (`eas build --platform android`) / AAB upload.
      Confirm the crypto/WASM path works in a real Android build.
- [ ] TODO — Target API level / SDK compliance for the submission date
      (Play requires a recent target SDK — check at build time, SDK 52
      era is 2024–2025; re-check before submitting).

### 3.2 Metadata
- [ ] TODO — Short description (80 chars), full description (4,000).
- [ ] TODO — App icon (512×512), feature graphic (1024×500),
      screenshots (phone + tablet), optional video.
- [ ] TODO — Category, content rating questionnaire (IARC).
- [ ] TODO — Pricing & distribution (countries, free/paid).

### 3.3 Data safety + privacy disclosures (Play)
- [ ] TODO — Data safety form: collected = email + session IP/user agent
      when a sync account is used (see §1); encrypted in transit (TLS 1.2/1.3,
      run locally) and end-to-end for vault content; account deletion
      (server done, mobile UI missing); deletion request path = web client
      Security Center (public URL PENDING); backups keep deleted data until
      rotated (period PENDING, `docs/privacy.md` §7). Keep answers identical
      in substance to the Apple labels.
- [ ] TODO — Privacy policy URL (required).
- [ ] TODO — Account deletion: Play requires in-app deletion AND a web link.
      Server + web path exist (run locally); mobile UI missing (same
      blocker as iOS); the public web URL needs a real domain (PENDING).
- [ ] TODO — Permissions declarations: biometrics only; confirm no
      unused permissions are declared in the manifest.
- [ ] TODO — Foreground services / exact alarms / other declarations:
      none expected — confirm at build time.

### 3.4 Internal testing + review
- [ ] TODO — Internal testing track (up to 100 testers), then closed
      track, then production. Play requires a closed test (14 days, 12+
      testers for new personal accounts) before production — plan for it.
- [ ] TODO — Pre-launch report: fix crashes / ANRs it finds.
- [ ] TODO — Production rollout (staged rollout recommended).

## 4. Cross-store blockers (must clear before ANY submission)

| # | Blocker | Status |
|---|---|---|
| 1 | Account deletion in the mobile app (server + web exist, run-verified) | TODO — mobile UI missing |
| 2 | Release gates in `docs/release-readiness.md` re-assessed on real devices | TODO |
| 3 | Credential-provider extensions built, signed, tested on devices | TODO — source exists, never built here |
| 4 | App built and run on a real iPhone + Android device | TODO |
| 5 | External security audit | PENDING (human) |
| 6 | Privacy policy: retention periods set, legal review, public URL; labels/data-safety answers checked against real traffic | PENDING (human + lawyer) |
| 7 | Apple Developer + Google Play accounts; signing certificates / upload keystore kept offline | PENDING (human) |
| 8 | Export compliance (iOS encryption) | PENDING (human decision) |
| 9 | Production server on a real domain with public TLS (needed for passkeys, the web deletion link and reviewer test accounts) | PENDING (human) |

## 5. What this document is NOT

- Not a submission: nothing has been uploaded to either store.
- Not an approval: no review has happened; no store has seen the app.
- Not legal advice: privacy labels, data-safety answers, export
  compliance, and the privacy policy need a human (and, for the policy,
  ideally a lawyer) to confirm.
