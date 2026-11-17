# Store Preparation — iOS App Store + Google Play (Phase H, 17 Nov 2026)

> **STATUS: NOT SUBMITTED. NOTHING HERE IS DONE.**
>
> Every item below is marked **TODO** unless it says otherwise. No
> developer account enrolment, no signing, no TestFlight / Play internal
> testing, no store submission, and no review approval has happened.
> **External developer accounts, signing, review approvals, and
> independent audits remain human-controlled and are NOT done** — no agent
> can do them, and this document does not pretend otherwise.
>
> Facts about the app today were read from `apps/mobile/app.json`,
> `apps/mobile/package.json`, and `apps/mobile/README.md` (Expo SDK 52,
> React Native 0.76.5, bundle id `com.loygenics.my-secrect`, package
> `com.loygenics.mysecrect`). Everything else is a checklist, not a
> claim.

## 0. Current state (verified by reading, 17 Nov 2026)

| Fact | Value |
|---|---|
| App name / slug | `my-secrect` |
| Version | `0.1.0` (both platforms) |
| iOS bundle id | `com.loygenics.my-secrect` |
| Android package | `com.loygenics.mysecrect` (note: differs from iOS — hyphen vs no hyphen) |
| Android versionCode | `1` |
| Expo SDK | `~52.0.0` |
| Biometrics | `expo-local-authentication` (Face ID prompt exists in `infoPlist`) |
| Credential provider | **NOT IMPLEMENTED** — `native/ios-credential-provider/` and `native/android-credential-provider/` are EMPTY (Phase A, gate 3) |
| App ever run | **NO** — never run in Expo Go or a dev build (Phase A) |
| Icons / splash | Splash background `#0B0F14` only; no icon files verified in the repo |
| Store accounts | None known — TODO, human-owned |

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
- [ ] TODO — Fix the release blockers in `docs/release-readiness.md`
      first: passkey verification, sync pull, Argon2id split, sharing
      without key exchange, server recovery stub. **Do not submit a build
      whose core flows are known-broken** — reviewers will reject it and
      users will lose data.
- [ ] TODO — External security audit (or at minimum the recorded audit
      plan with no Critical/High open). No audit exists today.
- [ ] TODO — Decide the data-safety / privacy-nutrition answers from
      `docs/privacy.md` (no ads SDKs, no third-party tracking, opt-in
      diagnostics only) and keep them consistent across both stores.
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
      (no user-generated content, no ads — answer honestly).
- [ ] TODO — Pricing: free / paid / IAP (decide; nothing is implemented).

### 2.3 Privacy disclosures (App Store)
- [ ] TODO — App Privacy / privacy nutrition labels: data collected —
      **none from the app itself** (vault is local-first; server stores
      ciphertext + metadata only — see `docs/privacy.md`). Confirm the
      exact label answers against the real network behaviour before
      submitting; a wrong label is a rejection + trust issue.
- [ ] TODO — Privacy policy URL (public, reachable).
- [ ] TODO — Account deletion: Apple requires in-app account deletion
      for apps with account creation. **NOT IMPLEMENTED** — the API has
      no delete-account endpoint (routes: devices/vaults/items/sync/
      blobs/shares/recovery only). Implement + verify before submission.
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
- [ ] TODO — Data safety form: data collected/shared — **none from the
      app itself** (see `docs/privacy.md`); data encrypted in transit
      (TLS) and at rest (E2EE); account deletion available (see §2.3 —
      NOT IMPLEMENTED yet); data deletion request path. Keep answers
      identical in substance to the Apple labels.
- [ ] TODO — Privacy policy URL (required).
- [ ] TODO — Account deletion: Play also requires account deletion
      (in-app + web link). NOT IMPLEMENTED — same blocker as iOS.
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
| 1 | Account deletion flow (in-app + server endpoint) | TODO — not implemented |
| 2 | Core flows broken (passkeys, sync pull, sharing, recovery) | TODO — see release-readiness gates 1, 5, 6, 7 |
| 3 | Credential-provider integration (AutoFill / Credential Manager) | TODO — native dirs empty |
| 4 | App never run on a real device | TODO — build + test first |
| 5 | External security audit | TODO — none exists |
| 6 | Privacy policy hosted + data-safety answers verified | TODO — `docs/privacy.md` is a draft |
| 7 | Developer accounts + signing (human) | TODO — none known |
| 8 | Export compliance (iOS encryption) | TODO — human decision |

## 5. What this document is NOT

- Not a submission: nothing has been uploaded to either store.
- Not an approval: no review has happened; no store has seen the app.
- Not legal advice: privacy labels, data-safety answers, export
  compliance, and the privacy policy need a human (and, for the policy,
  ideally a lawyer) to confirm.
