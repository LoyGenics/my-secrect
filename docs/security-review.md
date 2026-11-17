# Security Review — threat model as implemented (Phase A, 17 Nov 2026; Phase B fixes, 17 Nov 2026)

> Code-read only. Nothing has been built, tested, or run on the Mac, or audited.
> Phase B changes (C1, H3 fixed — see §8) were verified by code read
> against the `webauthn` gem 3.x source, and the new Node vector/security
> tests were run on the agent's sandbox VM against real libsodium
> (14/14 pass — that validates the test files, NOT the Mac repo).
> The RSpec + cargo suites still need their first run on the Mac.
> Severities: Critical = blocks any release / exploitable by design;
> High = must fix before real user data; Medium = fix before public
> release; Low = hardening / polish.

## 1. Threat model as implemented

Per `specs/threat-model.md` (short, honest, and mostly accurate): the server
is untrusted for content (E2EE, ciphertext + opaque ids only); the device
is trusted only while uncompromised (malware in an unlocked session wins);
metadata (email, IP, timing, sizes, counts) is NOT protected; the web
client is a separate attack surface (compromised served JS reads secrets
after unlock). The code largely honours this — with the exceptions in §6.

Trust boundaries:

| Boundary | Enforcement (verified) |
|---|---|
| Client ↔ server | Bearer session token, 1 h, SHA-256 digest stored; narrow CORS (never `*`); `force_ssl` in production; `filter_parameters` hides ciphertext/keys from logs |
| Vault unlock ↔ account auth | Separate: passkey logs into the ACCOUNT; only the passphrase/recovery key unwraps the Master Key client-side. Rails cannot recover a vault key |
| Extension background ↔ popup/content/page | Background alone holds keys; popup gets one item at a time; content script gets one username+password, top-frame only, origin-checked |
| Server ↔ object storage | 5-min presigned URLs; Rails never sees file plaintext |
| Local storage | **Weakest boundary**: ciphertext + wrapped keys in localStorage / AsyncStorage / chrome.storage.local, no SQLCipher, no OS keystore |

## 2. Key hierarchy (as built)

```
passphrase --Argon2id--> KEK (salt 16 B random)
KEK --XChaCha20-Poly1305--> Account Master Key (32 B random)
Master Key --wrap--> Vault Key (32 B random)
Vault Key --wrap--> Item Key (32 B random, fresh per item write)
Item Key --XChaCha20-Poly1305 (nonce 24 B fresh)--> VaultItem JSON
Recovery key (32 B random, base64url, shown once)
  --SHA-256--> recovery KEK --wrap--> Account Master Key
```

All wrapping/encryption is AEAD; decrypt throws on any tampering (fail
closed). Keys live in memory only, zero-filled on lock (`clearMemory`).
Passphrase change re-wraps the Master Key only (no re-encryption).
No key rotation beyond that exists.

## 3. Encryption format (locked v1, `specs/encryption-format.md`)

- KDF: Argon2id, libsodium INTERACTIVE (opslimit 2, memlimit 64 MiB),
  salt 16 B, output 32 B — **TS and Rust, one profile since Phase B**
  (§8, H3 fixed). Shared vectors: tests/crypto-vectors/argon2id-vectors.json.
- AEAD: XChaCha20-Poly1305 (IETF), key 32 B, nonce 24 B random per
  encryption, tag 16 B appended. Stored split (`nonce` + `ciphertext`
  base64 fields); export joins as `nonce || ciphertext+tag`.
- HKDF-SHA-256 via HMAC (`crypto_auth_hmacsha256`), salt fixed 32 zero
  bytes, RFC 5869 expand. (Rust `hkdf` crate equivalent; not cross-tested.)
- Nonce strategy: fresh random nonce per encryption + fresh per-item key
  ⇒ nonce reuse under one key requires a CSPRNG failure. No nonce is
  ever reused by construction. No additional-data (AD) is bound in any
  AEAD call (`null` AD everywhere) — item type/id are inside the plaintext
  JSON, so a swapped ciphertext still fails the id check on import/apply.
- File chunks: per-file key, fresh nonce per 1 MiB chunk, manifest binds
  order/sizes/SHA-256(ciphertext); manifest itself Vault-Key-encrypted.
- Recovery: SHA-256(recovery key) as KEK — a fast hash, but the input is
  256-bit random, so brute force is infeasible; acceptable as specified.

## 4. Auth, sessions, devices

- Passkey registration: challenge 32 random bytes (base64url, generated
  by the `webauthn` gem), single-use, 5-min TTL, `PasskeyChallenge#consume!`
  — real. **Verification IS wired since Phase B** (§8, C1 fixed):
  `WebAuthn::Credential.from_create/from_get(...).verify(...)` checks
  stored challenge, origin, RP ID, UP/UV flags, signature against the
  stored key, and sign count. No non-production bypass remains.
- Sessions: `sess_` + 64 hex chars, digest stored, 1 h TTL, `Session.live`
  scope enforces expiry + revocation; device `last_seen_at` touched.
- Devices: enrol stores a caller-supplied `public_key` verbatim (no
  verification); revoke marks revoked + revokes sessions + deletes key
  envelopes for that device id — but envelopes are keyed by *recipient*
  (user/device ids are conflated in `KeyEnvelopes::Rotate`: it deletes by
  `recipient_id = device.id`, while shares use `recipient_id = user.id`).
- Rate limits exist (`rack_attack.rb`) but the cache store is never set —
  in-memory per-process store, resets on restart, no cross-worker sharing.

## 5. What was checked and found clean

- **CVV/PIN**: no CVV/PIN/CVC field in any form or schema; `ItemDetail`
  suppresses such keys if present; `specs/threat-model.md` forbids storing
  them. ✅
- **Plaintext secrets in logs**: `filter_parameters` covers `password`,
  `encrypted_payload`, `encrypted_item_key`, `encrypted_key` (application
  + production configs); audit log stores event types + ids only;
  no `console.log` of secrets found in the client files read; recovery
  key is shown once and never stored readable. ✅ (log output itself was
  never observed — nothing has run.)
- **Extension content-script exposure**: content script receives exactly
  one username+password, never the vault/keys/list; form detection sends
  only origin + field presence; no persistent content script; manifest has
  zero `host_permissions`. ✅
- **`.gitignore` / secrets leakage**: `.gitignore` covers `node_modules/`,
  `.env`, `.env.*`, `*.key`, `*.pem`, `*.sqlite`, `vault-*.json`,
  `apps/api/log|tmp`. No `.env` file exists on disk (`apps/api/.env` and
  `infra/docker/.env` both absent). `.env.example` files contain only
  `CHANGE_ME` placeholders. ✅ But: no `Gemfile.lock`/npm lockfile exists,
  and git history was not audited for previously committed secrets.
- **Server never sees plaintext**: presenters return ciphertext only;
  RSpec `items_spec` asserts no title/password/bank/tag in responses. ✅
- **TOTP**: RFC 6238, HMAC-SHA1, 30 s, 6 digits, base32 decode validated;
  secret stored inside the encrypted item. ✅ (SHA-256/512 + 8-digit
  variants unsupported — Low.)

## 6. Open security risks (ranked)

### Critical

| # | Risk | Evidence |
|---|---|---|
| C1 | **Passkey verification not wired.** **FIXED in Phase B (§8).** Real gem verification on every ceremony, Authenticator persisted (credential_id / public_key / sign_count), sign-count enforced, non-prod token bypass removed. Remaining gaps: no route for `authentication_options`; no authenticated add-passkey flow (second passkey via the public endpoint is refused by design); the user row is still created at options time. | `apps/api/app/domains/authentication/passkeys.rb:38-47`; `accounts/register.rb:7` |
| C2 | **No external security audit, and nothing ever run.** No KAT vectors for any primitive; Rust/Node tests are round-trips only. | Whole repo; `specs/encryption-format.md` ("chưa audit") |

### High

| # | Risk | Evidence |
|---|---|---|
| H1 | **Sync pull returns no ciphertext** — remote changes can never be applied; E2E sync is broken by construction, and no app wires the sync client at all. A user believing sync works will lose cross-device updates. | `apps/api/app/domains/sync/pull.rb:9-13`; `packages/sync/src/index.ts` ("no ciphertext payload — cannot verify or apply"); no imports of `SyncClient`/`VaultApiClient` in any app |
| H2 | **Web plaintext export reachable despite "encrypted-only" claim.** Web reuses the desktop App wholesale, including Settings plaintext export (ack checkbox only). The banner + web README claim otherwise. | `apps/web/src/App.tsx:1,6-9`; `apps/desktop/src/App.tsx:616-618`; `SettingsView.tsx:195-222` |
| H3 | **Argon2id parameter split TS vs Rust.** **FIXED in Phase B (§8).** Rust now uses INTERACTIVE (2 / 64 MiB), identical to TS; shared known-answer vectors asserted in both suites. No vaults existed yet (nothing ever ran), so no migration was needed. | `packages/crypto-adapters/src/index.ts` (`ARGON2ID_PARAMS`); `native/crypto-core/src/lib.rs` (`KDF_OPSLIMIT/MEMLIMIT`) |
| H4 | **Sharing without key exchange.** `Sharing::Create` accepts null `encrypted_key` and creates an ACTIVE share; no recipient keypair infrastructure exists. A share can exist that nobody can decrypt — or that was created with a key the server/creator invented. | `apps/api/app/domains/sharing/create.rb:9-14`; `packages/core/src/sharing.ts` ("HPKE not implemented") |
| H5 | **Recovery server flow is a stub.** **FIXED 17 Nov 2026 (§9).** Challenges are now persisted (`recovery_challenges`: SHA-256 digest + MessageEncryptor ciphertext, 5-min TTL, single-use, max 5 attempts); `POST /v1/recovery/verify` checks a real Ed25519 signature against a registered verifier key and only then issues a 15-min recovery session; unknown emails get the same response shape (no existence leak). Remaining: trusted-device transfer still unimplemented; no external audit; nothing has run. | `apps/api/app/domains/recovery/challenge.rb`, `verify.rb`, `verifiers.rb`; `recovery_controller.rb` |
| H6 | **Local storage is not encrypted at rest.** Wrapped keys + ciphertext in localStorage / AsyncStorage / chrome.storage.local. No SQLCipher, no Keychain/Keystore. A stolen unlocked-device image or localStorage read exposes the wrapped keys to offline passphrase brute force (Argon2id INTERACTIVE only). `createVault` also overwrites an existing vault without a guard. | `apps/desktop/src/vault.ts` (localStorage backend; `createVault`); `apps/mobile/src/vault.ts`; `apps/extension/src/lib/vault-ext.ts` |
| H7 | **Sync/device signatures never verified.** `signature` is accepted by push, dropped by `Upsert`, never stored; the "signed events" claim in the sync spec is false. Any authenticated device can push any item into any vault it can access. | `apps/api/app/domains/sync/push.rb`; `encrypted_records/upsert.rb`; `db/schema.rb` (`sync_events.signature`) |
| H8 | **Blob upload abuse surface.** `part_count` is uncapped (attacker can request millions of presigned URLs + DB rows); per-user quota (`Billing::Quota`) is never called by any controller; `Complete` checks only that parts exist, not sizes; client 1 MiB vs server 8 MiB parts; **no wrapped File Key is stored anywhere**, so downloads cannot be decrypted. | `apps/api/app/domains/blobs/upload_session.rb:8-15`, `complete.rb`; `packages/storage/src/upload.ts` (`BlobManifest` has no key field) |

### Medium

| # | Risk | Evidence |
|---|---|---|
| M1 | Sync `sequence` = max+1 without a lock/transaction guard → concurrent pushes can collide on the unique `(vault_id, sequence)` index (500s, lost pushes). | `encrypted_records/upsert.rb:21-22`, `delete.rb:13` |
| M2 | Rack::Attack cache store never configured → throttles are per-process, in-memory, reset on restart. | `config/initializers/rack_attack.rb`; no `cache.store` in `application.rb` |
| M3 | S3 defaults in code (`minio`/`minio123`, `localhost:9000`, `force_path_style: true` unconditionally) + `POSTGRES_PASSWORD` default `''`. Safe only if env is always set in production. | `blobs/storage_provider.rb:11-16`; `config/database.yml` |
| M4 | Tauri production origin (`tauri://localhost`) is not in the default CORS allowlist (`localhost:1420,3000`) — packaged desktop → API calls may be rejected. Unverified (never run). | `config/initializers/cors.rb` |
| M5 | Node tests re-implement logic instead of importing it (incl. AES-GCM reference + placeholder wrapped key; one recovery test is a tautology). A green `npm test` proves nothing about production code. | `tests/**/*.test.mjs` (all files) |
| M6 | No CSP/headers, no SRI, no documented hosting for the web client — the acknowledged weakest attack surface has no hardening beyond the banner. | `apps/web/*` (no headers config found) |
| M7 | `toggleFavorite` re-encrypts fire-and-forget; failures silently revert in memory only. Plaintext export has no audit trail. | `apps/desktop/src/vault.ts` (`toggleFavorite`); `exportPlaintext` |
| M8 | Password generators use modulo reduction (`buf % n`) — small bias; extension generator has the same pattern. | `apps/desktop/src/utils/password.ts` (`randomIndex`); `apps/extension/src/background.ts` (`generatePassword`) |

### Low

| # | Risk | Evidence |
|---|---|---|
| L1 | Health scoring differs between desktop (weak = login-only, score ≤ 1) and extension (any short password) — inconsistent user guidance. | `utils/health.ts`; `background.ts:computeHealth` |
| L2 | Session tokens are not bound to IP/device fingerprint; 1 h TTL is the only mitigation. | `session_tokens.rb` |
| L3 | `ItemForm` card `last4` uses `autoComplete="cc-number"` (full-number semantics) — browser autofill could misbehave. | `ItemForm.tsx:70` |
| L4 | `Dockerfile.api` deprecated stub still ships in `infra/docker/`; R2 `force_path_style` note in cloud README contradicts the code. | `infra/docker/README.md`; `infra/cloud/README.md` |

## 7. Trust assumptions that must be told to users (already mostly in specs)

- Losing passphrase + recovery key + trusted devices = permanent data loss.
- Revoking a share/device does not erase copies already decrypted elsewhere.
- Server compromise exposes metadata (who syncs what, when, how much) but
  not content — provided the crypto above is correct, which is unaudited.
- Media preview plaintext exists in RAM / the OS graphics pipeline while shown.

## 8. Phase B fixes (17 Nov 2026) — security foundations

> Nothing was built, tested, or run on the Mac in Phase B either.
> The RSpec + cargo suites below need their FIRST run in Terminal.
> The only tests executed anywhere were the new Node vector/security
> tests, run on the agent's sandbox VM against real libsodium
> (`libsodium-wrappers-sumo`): 14/14 pass. That validates those test
> files and the shared vectors — it does NOT validate the Mac repo,
> the Rails app, or the Rust crate.

### Fixed

**C1 — Passkey verification wired (was Critical).**
`apps/api/app/domains/authentication/passkeys.rb` rewritten:
- `verify()` now calls `WebAuthn::Credential.from_create/from_get(...)
  .verify(...)` on EVERY ceremony, in every environment. The old
  non-production path that issued a session token for ANY credential
  is deleted; prod no longer raises instead of verifying.
- Checks enforced by the gem against the stored challenge + RP config
  (`config/initializers/webauthn.rb`, env `WEBAUTHN_ORIGIN` /
  `WEBAUTHN_RP_ID`): challenge (constant-time, single-use — consumed
  before verification), origin, RP ID hash, ceremony type, user
  presence + user verification (both required; options request UV
  `'required'`), assertion signature against the STORED public key
  (never a client-supplied key), sign count (non-increasing counter
  rejected; stored count advances monotonically, never decreases).
- `Authenticator` record persisted on registration (credential_id =
  base64url id, public_key = base64url COSE key as returned by the
  gem, sign_count). Model + migration + schema already existed — no
  new migration was needed.
- Challenges now come from the gem (`options_for_create` /
  `options_for_get`, 32 random bytes, base64url). The previous
  hex-encoded challenge could never have verified (the gem decodes
  base64url before comparing) — wire format changed accordingly;
  clients must base64url-decode `challenge` and `user.id`.
- Takeover guard: the unauthenticated registration endpoint only
  verifies a FIRST passkey (user with no active authenticator). A
  second passkey for an existing account is refused until an
  authenticated add-passkey flow exists (see Remaining).
- New `authentication_options(email:)` domain method (request options
  + stored challenge; unknown emails get an empty allow-list so the
  response does not leak account existence). No route exposes it yet.
- New RSpec: `apps/api/spec/requests/api/v1/passkeys_spec.rb` — real
  credentials from the gem's `FakeClient` (real ES256 authenticator,
  real signatures), no stubs: valid registration + valid assertion,
  wrong origin, wrong RP, reused challenge, replayed assertion (same
  sign count, fresh challenge, valid signature — only the counter
  check can reject it), tampered signature, cross-account assertion,
  second-passkey refusal, missing user verification. NOT YET RUN.

**H3 — Argon2id unified (was High).**
- One locked profile everywhere (also in `specs/key-management.md`):
  Argon2id, `OPSLIMIT_INTERACTIVE = 2`, `MEMLIMIT_INTERACTIVE =
  67108864` (64 MiB), salt 16 B, output 32 B. Rust
  (`native/crypto-core/src/lib.rs`) changed SENSITIVE → INTERACTIVE;
  TS was already INTERACTIVE and is unchanged.
- Shared known-answer vectors `tests/crypto-vectors/argon2id-vectors.json`
  (2 Argon2id KEKs + 1 XChaCha20-Poly1305 seal, computed with libsodium
  itself via PyNaCl 1.6.2 — see the file's `_generated` note; no
  invented bytes), asserted in TS
  (`tests/crypto-vectors/argon2id-vectors.test.mjs`) and Rust
  (`native/crypto-core/tests/vectors.rs`). Node side: 14/14 pass on
  the sandbox VM (includes the security tests below).

**Security tests (new).** `tests/security/reject-tampering-libsodium.test.mjs`
(+ `tests/security/README.md`): invalid ciphertext, tampered
metadata, wrong key, wrong-passphrase KEK, corrupted backup, replayed
old revision, swapped encrypted payload — each must REJECT; one control
case proves a valid envelope still opens. These test the PRODUCTION
libsodium primitives (XChaCha20-Poly1305, Argon2id INTERACTIVE).
Note: a sibling agent concurrently added `tamper.test.mjs`,
`backup-corruption.test.mjs`, `sync-replay.test.mjs` in the same folder
using the WebCrypto REFERENCE adapter (AES-GCM + PBKDF2) — those prove
the reference construction, not production crypto, and their AAD
metadata test proves a property production code does NOT have
(production AEAD uses null AD; metadata binding comes from the
item_id/revision fields inside the plaintext — covered by the
libsodium file). Do not cite either set as proof the apps enforce
the checks (M5, below).

### Remaining (Phase B did not fix these)

- **H5 — server recovery still a stub (High).** **FIXED 17 Nov 2026
  (§9, WorkOS-inspired scope).** Challenges are persisted
  (`recovery_challenges`: digest + ciphertext, 5-min TTL, single-use,
  max 5 attempts) and `POST /v1/recovery/verify` verifies a real
  Ed25519 signature against a registered verifier before issuing a
  15-min recovery session. Trusted-device transfer is still
  unimplemented.
- **H7 — sync/device signatures still never verified (High).**
  Outside Phase B scope (`apps/api/app/domains/sync/`,
  `encrypted_records/`); unchanged. Any authenticated device can
  still push any item into any vault it can access.
- **No route for `authentication_options`.** **FIXED 17 Nov 2026
  (§9).** `POST /v1/auth/passkeys/authenticate` →
  `AuthController#authenticate_passkey` calls
  `Authentication::Passkeys.authentication_options`.
- **No authenticated add-passkey flow.** **FIXED 17 Nov 2026 (§9).**
  `POST /v1/auth/passkeys/add/options` + `/add/verify` (step-up
  required, session rotated on success); the unauthenticated
  registration endpoint still refuses a second passkey by design.
- **M5 partially remains.** Node tests still cannot import the TS
  adapter (`node --test` has no TS loader); the new libsodium tests
  call libsodium directly with the adapter's exact parameters, and the
  vector test guards the adapter's constants by reading its source.
  A vitest/ts-node test importing `libsodiumAdapter` directly is
  still missing. `tests/security/` is also not yet in the root
  `package.json` `test` script — add `tests/security/` there.
- **C2 remains.** No external audit; nothing has run on the Mac.
  First green runs of the suites below are the next gate, not a
  release signal.

### Verification commands (run in Terminal on the Mac)

```sh
cd /Users/loihuynh/Personal/LoyGenics/my-secrect
npm install
node --test tests/crypto-vectors/ tests/security/
cd native/crypto-core && cargo test
cd ../../apps/api && bundle install && bundle exec rspec
# Full check from the repo root:
npm test && npm run test:crypto-core && npm run test:rails
```

Expected when green: RSpec passkeys specs 11 examples, 0 failures;
`cargo test` passes incl. `argon2id_kek_matches_shared_vectors` and
`xchacha_seal_matches_shared_vector`; Node 14/14 (vectors +
security). If the Argon2id vector test fails, do NOT edit the
hex values — the implementation or parameters are wrong.
Production env needed before any real use: `WEBAUTHN_ORIGIN` =
the exact public origin (e.g. `https://vault.example.com`) and
`WEBAUTHN_RP_ID` = its registrable domain; defaults are
localhost-only.

## 9. WorkOS-inspired security scope (17 Nov 2026)

> Strict scope only: passkeys/MFA/recovery, trusted devices &
> sessions, step-up auth, activity. No SSO, SCIM, FGA, OAuth, or
> risk engines. Nothing below has been built, tested, or run on the
> Mac — the new RSpec suite needs its first run in Terminal.
> Account auth stays separate from vault unlock throughout: sessions
> never decrypt vault content.

### Threats addressed and mitigations as implemented

| Threat | Mitigation (as built) |
|---|---|
| Session theft | Bearer tokens are opaque (`sess_` + 64 hex), only SHA-256 digests stored; 1 h TTL; `user_agent`/`ip_address` recorded per session and shown in the session list; any privilege change (MFA enable/disable, passkey add/remove, recovery verifier register, recovery-code regenerate) rotates the session token (`SessionTokens.rotate`) so a stolen pre-change token dies. |
| Step-up bypass | Privileged actions require a second-factor verification bound to the CURRENT session within the last 10 min (`Authentication::StepUp`, `WINDOW = 10.minutes`); otherwise 403 `{ error: 'step_up_required' }`. Step-up is per-session, is never inherited from login (completing MFA at login does NOT mark step-up), and is verified by real TOTP/recovery-code checks or a real passkey assertion against the stored key. |
| Recovery abuse | Challenges are persisted single-use with a 5-min TTL, SHA-256 digest + MessageEncryptor ciphertext only (raw bytes never stored); max 5 failed attempts then the challenge is consumed; verification is a real Ed25519 signature (`RbNaCl::VerifyKey`) over the exact challenge bytes against a registered verifier; every failure is the same generic 401; unknown emails get an identical response shape with a nil `challenge_id` (no existence leak); success issues only a 15-min recovery session, never a vault key. |
| MFA replay | TOTP verified with ±1-step drift, then the code's step is rejected when `<= totp_last_step` (the stored step only ever advances); the pending MFA token is single-use and burns on first use even when the second factor fails; recovery codes are single-use, stored as SHA-256 digests only, compared constant-time, consumed under a row lock. |
| Recovery-code theft | Codes are generated from an unambiguous alphabet, shown once, stored as digests only; regeneration (step-up required) replaces all existing codes and rotates the session token; use is audited (`mfa_recovery_code_used`). |
| Account lockout | Removing the last active passkey is refused with 422 while MFA is disabled; the recovery session path (Ed25519 verifier) is a second way back in. |
| Revocation not working | Revoking a session/device invalidates the server session immediately and rotates key envelopes for the device. Revocation does NOT erase secrets already downloaded/offline on that device — stated in `SessionTokens`, `Devices::Revoke`, and the controllers, not as remote wipe. |

### What changed (code)

- Migration `20261117000003` + `schema.rb` (v2026_11_17_000003): sessions gain `step_up_verified_at`, `step_up_method`, `recovery_session`, `user_agent`, `ip_address`; devices gain `platform`, `trusted_at`; users gain `mfa_enabled`, `totp_secret_ciphertext`, `totp_last_step`, `totp_confirmed_at`; new tables `recovery_challenges`, `recovery_verifiers`, `recovery_codes`, `mfa_challenges`; `audit_events.metadata` (jsonb).
- Gems: `rotp` (TOTP), `rbnacl` (Ed25519). `filter_parameters` extended with `totp_secret`, `code`, `recovery_code`, `signature`, `mfa_token`, `challenge`.
- New domains: `Authentication::Totp`, `Authentication::StepUp`, `Authentication::Sessions`, `Authentication::MfaTokens`, `Authentication::SecretEncryptor`, `Recovery::Verify`, `Recovery::Verifiers`; `Recovery::Challenge` rewritten (persisted); `SessionTokens` gains `rotate` + richer `issue`/`verify` (now returns the session record); `ApplicationController` exposes `current_session` + `require_step_up!`.
- New endpoints: `POST /v1/auth/passkeys/authenticate`, `GET /v1/auth/passkeys`, `POST /v1/auth/passkeys/add/options|verify`, `DELETE /v1/auth/passkeys/:id`, `POST /v1/auth/mfa/enroll|confirm|disable`, `POST /v1/auth/mfa/recovery_codes`, `POST /v1/auth/mfa/verify`, `POST /v1/auth/step-up/totp|passkey(|/options)`, `GET /v1/auth/activity`, `GET /v1/auth/sessions`, `DELETE /v1/auth/sessions/:id|others`, `PATCH /v1/devices/:id`, `POST /v1/recovery/verify`, `GET|POST /v1/recovery/verifiers`. Devices enrol now requires step-up and accepts `platform:`.
- New audit events: `passkey_added/removed`, `mfa_enabled/disabled`, `mfa_recovery_code_used`, `mfa_recovery_codes_regenerated`, `mfa_verified`, `session_revoked`, `sessions_revoked_others`, `device_trusted/untrusted`, `recovery_verified`, `recovery_verifier_registered`, `step_up_verified`, `step_up_failed` (metadata `{ method }` only — never the code).
- Rack::Attack: throttles added for MFA verify (5/60 s per IP), recovery verify (5/60 s), step-up (10/60 s), passkey add (10/60 s). The middleware is now actually mounted (`config.middleware.use Rack::Attack`) and disabled in test so request specs are not throttled.
- New spec: `spec/requests/api/v1/security_spec.rb` (real FakeClient passkeys, real ROTP codes, real RbNaCl signatures; no crypto mocks).

### Remaining (not done)

- **C2 remains.** No external security audit; nothing has ever run on the Mac. First green `bundle exec rspec` is the next gate, not a release signal.
- **M2 remains.** Rack::Attack cache store still unconfigured — throttles are per-process, in-memory, reset on restart, no cross-worker sharing (needs Redis `cache.store`).
- **L2 partially remains.** Sessions now record `user_agent`/`ip_address`, but tokens are still not bound to an IP or device fingerprint — a stolen token works from anywhere until expiry/revocation; 1 h TTL + rotation are the mitigations.
- Trusted-device transfer (recovery kind `trusted_device`) is still unimplemented; only the `recovery_key` (Ed25519) kind verifies.
- No Unified Security Center UI exists yet — the API surface above is the backend for it; the client still needs one interface for auth methods, trusted devices, sessions, recovery settings, and activity.
- `GET /v1/auth/activity` has no pagination beyond a capped `limit` (max 50).
- The unauthenticated registration flow still creates the user row at options time (deliberate, documented in `passkeys.rb`); only the authenticated add flow avoids it.

## 9. Account sign-in UI (17 Nov 2026 — WorkOS next step)

> Code-read only. Nothing has been built, tested, or run on the Mac.
> The clients below were read, not executed; the Node mirror tests in
> `tests/security/signin-client.test.mjs` were not run either.

### What changed (code)

- **Sign-in screens (passkey-first, no password anywhere).** The API
  has no password login endpoint, so none is offered or invented:
  desktop/web `apps/desktop/src/components/SignInScreen.tsx`
  (create-account + sign-in, MFA TOTP/recovery-code step) and mobile
  `apps/mobile/src/screens/SignInScreen.tsx` (recovery-key challenge
  only — see below). Both store the session token through the SDK
  only (`saveSessionToken`, key `my-secrect:api-token`); there is no
  second token store. Sign-in never unlocks the vault: the master
  passphrase is still required afterwards, as a separate step, and
  is never stored with the token or sent to the server. No token,
  code, or recovery key is logged.
- **Shared state machine** (`packages/sdk/src/signin.ts`, pure, no
  fetch/DOM): email → passkey → signed-in, or → mfa → signed-in.
  It encodes the server's single-use rules — a WebAuthn challenge
  and an `mfa_token` are each consumed whether the attempt succeeds
  or fails, so a failed MFA attempt restarts the login from the
  email step and the spent token is never retried. Signed-in is
  reachable only with a session token in the verify response.
- **Expiry-aware token storage** (`packages/sdk/src/security.ts`):
  `saveSessionToken` / `getValidToken` / `clearSessionToken` /
  `adoptRotatedToken` / `isUnauthorized`, with a `TokenStore`
  interface shared by localStorage (desktop/web) and AsyncStorage
  (mobile). An expired token reads as null, so clients never send
  a stale token. `rotated_token` responses are now adopted
  automatically when the client is built with a `tokenStore`.
- **Sign-out revokes the server session.** New
  `SecurityApiClient.revokeCurrentSession()`: lists sessions,
  DELETEs the one flagged `current` (there is no dedicated logout
  endpoint; revoking the current session IS the logout), then the
  app clears the token and locks the vault. Local sign-out proceeds
  even when the server cannot confirm (offline / already expired).
  Revocation invalidates the server session only — it does NOT
  erase secrets already downloaded or cached offline; both UIs say so.
- **401 handling.** Desktop `SecurityCenter` and mobile
  `SecurityScreen` call `onUnauthorized` when every load answers
  401; the Apps clear the token and show SignIn with a
  session-expired note. No silent retry with a stale token.
- **Gating (local-first preserved).** The sign-in gate appears
  only when an API base URL is configured and no valid session is
  stored, and only before the vault. "Continue without signing in"
  keeps the local vault usable offline; account features stay
  signed out. With no server configured there is no gate at all.
- **Mobile sign-in is recovery-key only, honestly labelled.** Expo
  Go has no WebAuthn API and `expo-local-authentication` is not
  WebAuthn, so no passkey ceremony is faked. The screen implements
  the one API-supported path: `POST /v1/recovery/challenges` →
  Ed25519 sign with the keypair derived from the 32 recovery-key
  bytes (`crypto_sign_seed_keypair`, same derivation as the mobile
  recovery-verifier registration) → `POST /v1/recovery/verify`.
  The result is a 15-minute recovery session, labelled as such in
  the UI — not a daily sign-in. It requires a recovery verifier
  already registered for the account; without one every attempt
  fails with the server's generic 401. TOTP/MFA completion alone
  cannot sign a mobile user in: there is no `mfa_token` without a
  passkey assertion first.
- **SDK endpoint bugs fixed (found while building sign-in).**
  `mfaDisable()` called `DELETE /v1/auth/mfa`, which has no route
  — now `POST /v1/auth/mfa/disable`. `mfaRecoveryCodes()` posted
  `/v1/auth/mfa/recovery-codes` — now `POST
  /v1/auth/mfa/recovery_codes`. The recovery-codes wire key is
  `recovery_codes`, not `codes`: the old SDK type and both Security
  Centers read `res.codes`, which is always `undefined`, so
  regenerated codes never displayed. Fixed in the SDK type and
  both call sites.
- **i18n.** New `signin` section in `packages/i18n/src/en.ts` +
  `vi.ts` (identical keys; asserted by
  `tests/security/signin-client.test.mjs`). The `security` 65-key
  contract is untouched.

### Threats considered

| Threat | Mitigation (as built) |
|---|---|
| Stale-token replay / retry loop | Expired tokens read as null client-side; 401 always routes back to SignIn, never retries the same token. |
| MFA-token reuse after failure | The server consumes `mfa_token` on first use; the client machine clears it and restarts from email. |
| Token theft via rotation miss | `rotated_token` is adopted automatically (tokenStore) or the next call 401s and re-prompts sign-in. |
| Sign-out that only clears local state | `revokeCurrentSession` DELETEs the current session server-side first; local clear happens regardless, so the user is never stuck signed in. |
| Recovery-key sign-in abuse (mobile) | Same server guarantees as recovery verify: single-use 5-min challenge, max 5 attempts, generic 401, registered-verifier only, 15-min recovery session, step-up verified at issue. The seed/private key are zero-filled after use and the input cleared. |
| Vault confused with account auth | Sign-in stores only the Bearer token; vault unlock still needs the passphrase/recovery key afterwards. No code path stores them together. |

### Remaining (not done)

- **Nothing has run.** First `tsc` / `rspec` / builds on the Mac are
  still pending for every file above; the mirror tests were not run.
- **No token refresh endpoint exists.** Sessions live 1 h (recovery
  15 min); after expiry the user signs in again. Rotation happens
  only on privilege changes.
- **Mobile has no full sign-in** (no WebAuthn in Expo Go; no
  password login in the API). The recovery-key path is emergency /
  recovery use, not daily sign-in.
- **Web sign-in needs a secure context** and a matching
  `WEBAUTHN_ORIGIN` / `WEBAUTHN_RP_ID` on the server, or the
  ceremony fails client-side; per-deployment values are not
  validated by any test here.
- Session tokens are still not bound to IP/device fingerprint (L2
  partial, as before); a stolen token works from anywhere until
  expiry/revocation.
