# Device Identity — v1

Status: v1, implemented by the API (`Authentication::DeviceProof`) and the
web/desktop client (`packages/sdk/src/device-identity.ts`,
`packages/sdk/src/device-key-store.ts`). Mobile: plan only (§8.3).

## 1. What a device key is (and is not)

A **device key** is an Ed25519 key pair generated on one client install for
one account on one server. It lets that install prove "this request comes
from device X" without the server ever holding a secret for it.

v1 uses it for:

1. **Enrolment proof-of-possession** — a device row is only created when the
   client signs a fresh server challenge with the private half of the public
   key it registers.
2. **Session binding** — a session is only associated with a device when the
   client signs a fresh, single-use server challenge with that device's key.

Reserved for later: signing sync events (§4, purpose `sync-event`).

A device key is NOT:

- an account credential — it never creates a session on its own (a passkey
  ceremony, MFA or the recovery flow still does that);
- a vault key — it never wraps, derives or unlocks vault keys, and it is
  never derived from the passphrase, the recovery key or any vault key;
- remote wipe — revoking a device ends its server sessions only (see
  `Devices::Revoke`); data already on the device stays there.

## 2. Key and encodings

| Item | Value |
|---|---|
| Algorithm | Ed25519, RFC 8032 (pure, no pre-hash) |
| Public key | 32 raw bytes; on the wire **base64url without padding** |
| Signature | 64 raw bytes; on the wire base64url without padding |
| Device id | server-assigned UUID, lower-case canonical form |

The server tolerates standard base64 / padding on input, but the **signed
payload always carries the canonical form** (base64url, no padding), so a
client must sign exactly that.

Scope: one key per (API origin, account, install). A client MUST NOT reuse a
device key with another server or another account, and MUST NOT copy it to
another install.

## 3. Signed message format (all purposes)

```
message   = DOMAIN || purpose || 0x0A || canonical_payload
DOMAIN    = "my-secrect/device/v1/"            (21 ASCII bytes)
purpose   = [a-z][a-z0-9-]{0,31}               (ASCII, from the registry in §4)
signature = Ed25519-Sign(device_private_key, message)
```

`canonical_payload` (v1) is a single flat JSON object serialised as:

- keys: ASCII `[a-z_]+`, unique, sorted by byte value;
- values: JSON **strings only**, each character printable ASCII
  `0x20–0x7E` excluding `"` (0x22) and `\` (0x5C);
- no whitespace anywhere: `{"k1":"v1","k2":"v2"}`.

Anything else (numbers, booleans, nesting, non-ASCII, characters that would
need escaping) is **not representable**: encoders MUST reject it instead of
escaping. Put binary data in base64url, numbers in decimal strings.

Why this shape:

- **Byte-identical everywhere.** With no escaping rules the encoder is a
  few lines in Ruby, TypeScript, Rust, Swift or Kotlin and cannot disagree
  (JSON escaping and number formatting differ between libraries).
- **Domain separation.** The fixed `DOMAIN` prefix keeps these signatures
  apart from anything else an Ed25519 key in this system signs (the
  recovery-key flow signs a raw 32-byte challenge with a different key; a
  WebAuthn assertion signs `authenticatorData || SHA-256(clientDataJSON)`
  with the passkey). The purpose is followed by `0x0A`, which cannot occur
  inside a purpose, and the payload always starts with `{`, which cannot
  occur inside a purpose either — so the split between purpose and payload
  is unambiguous and a signature for one purpose never verifies as another.
- **Versioned.** A v2 format changes `DOMAIN`; v1 verifiers reject it.

Verifiers MUST build the message themselves from server-side state (the
stored challenge, the device id from the database, the canonicalised public
key) and never verify a client-supplied message blob.

## 4. Purpose registry (v1)

| Purpose | Payload fields | Challenge | Used by |
|---|---|---|---|
| `enroll` | `challenge`, `public_key` | see §5 | creating a device row |
| `session-bind` | `challenge`, `device_id` | see §5 | associating a session with an existing device |
| `sync-event` | *reserved* — defined by `specs/sync-protocol.md` before use | none (sequence/revision gives freshness) | sync workstream |

Rules for new purposes: register them here first, with every payload field;
a payload MUST name everything the signature is meant to bind (ids,
revisions, content hashes) so it cannot be replayed in another context.

## 5. Challenges

- 32 bytes from a CSPRNG, base64url without padding (43 characters).
- **Single-use**: the server consumes the challenge atomically *before* it
  verifies the signature, so a failed attempt burns it too, and two
  concurrent uses cannot both succeed.
- **Expiring**: a challenge past its TTL is rejected.
- Three sources, all server-issued:
  1. **Sign-in (inline)** — the WebAuthn challenge of the passkey ceremony
     in the same request (`creation_options.challenge` /
     `request_options.challenge`, TTL 5 minutes). It is consumed by the
     passkey verification, and the device proof is only accepted together
     with that passkey verification.
  2. **Email sign-in (inline)** — the single-use registration ticket
     (`rt_` + 64 hex = 256 bits, TTL 10 minutes) from
     `POST /api/v1/auth/email/verify`, spent by `POST /api/v1/auth/email/session`
     (§6.4). The proof is only accepted together with that spend.
  3. **Authenticated (explicit)** — `POST /api/v1/devices/challenges`
     `{ purpose }` → `{ challenge, purpose, expires_in }`, TTL 2 minutes.
     The server stores only `SHA-256(challenge)`, bound to the user, the
     **session that requested it** and the purpose. The client echoes the
     challenge back; a challenge requested by another session, for another
     purpose, already used, or expired fails.

## 6. Flows

### 6.1 Sign-in with device proof (`POST /api/v1/auth/passkeys/verify`)

Optional body field `device`:

- **New device (enrol at sign-in):**
  `device: { public_key, signature, platform?, name_encrypted? }`,
  `signature` over purpose `enroll`, payload
  `{"challenge":<webauthn challenge>,"public_key":<b64url pk>}`.
- **Existing device (bind):** `device: { id, signature }`,
  `signature` over purpose `session-bind`, payload
  `{"challenge":<webauthn challenge>,"device_id":<id>}`.

Server order: the passkey is verified first (it consumes the challenge).
Only a verified passkey makes the server look at `device`; a device proof
that then fails answers `401 { error: "device_verification_failed" }` and
issues **no** session (the ceremony must be redone with fresh options). A
client receiving that error SHOULD drop its local device record and enrol a
new key on the next attempt (the device may have been revoked). If the
passkey enrolled that revoked device, the enrolment is refused with
`403 device_approval_required` until the passkey is re-approved (§6.3).

With MFA enabled the proof is checked at the passkey step, but enrolment /
binding only happens after the second factor succeeds: the pending
enrolment (public key, platform, encrypted name) or the device id is held on
the single-use MFA challenge.

Without `device` the session is issued **unbound** (`device_id: null`). The
server never infers a device (before v1 it silently attached the account's
first device to every session — that was the bug this spec fixes). The same
holds for recovery-key sessions (`POST /api/v1/recovery/verify`).

Enrolment at sign-in needs no extra step-up: the user-verified passkey
ceremony in the same request is the authorisation, and the device key
signs that very ceremony's challenge.

### 6.2 Authenticated, explicit

- `POST /api/v1/devices/challenges { purpose: "enroll" | "session-bind" }`
- `POST /api/v1/devices/enroll { public_key, challenge, signature, platform?, name_encrypted? }`
  — step-up required (unchanged) **and** proof-of-possession (purpose
  `enroll`). If the current session is unbound it is bound to the new
  device; a bound session is never re-bound.
- `POST /api/v1/devices/:id/bind { challenge, signature }` — binds the
  current session to device `:id` (purpose `session-bind`).
  `409 already_bound` if the session is already bound; every other failure
  is a generic `401 device_verification_failed`.

### 6.3 Revocation (durable)

`DELETE /api/v1/devices/:id` marks the device revoked, ends its sessions and
rotates its key envelopes. A revoked device key can never bind, sign or be
enrolled again — not even as a "new" device (one device row per key, ever).
Session rotation keeps the binding.

That alone is not durable: the revoked browser still holds a passkey, could
sign in again and enrol a fresh key (QA DEFECT-H2). So every device records
the passkey (authenticator) whose sign-in enrolled it (`devices.
authenticator_id`; sessions record theirs too, so a device enrolled later
from a session is attributed as well), and revocation restricts that
passkey:

- **Default — re-approval required.** The enrolling passkey gets
  `reapproval_required_at`. Until re-approved it can still sign in on a
  device that is still ACTIVE (a valid `session-bind` proof — which needs
  that device's key, so a synced passkey keeps working on the user's other
  devices), but a sign-in with it that carries no proof or an `enroll`
  proof is refused with `403 device_approval_required` (after the passkey
  verified, before any MFA token or session), and a session it authenticated
  cannot enrol through `POST /devices/enroll` either.
- **`?revoke_passkey=true`** — the enrolling passkey is revoked instead
  (step-up required; refused with 422 `last_authenticator` when it is the
  last passkey and MFA is off). It can no longer sign in anywhere. The
  device list reports `passkey_active_devices` (how many active devices that
  passkey enrolled); when it is above 1 the passkey is probably synced, and
  the UI warns that revoking it signs those devices out of passkey sign-in.
- **Enrolling passkey unknown** (devices enrolled before this rule, or from a
  recovery session): every active passkey of the account is marked for
  re-approval — the secure default.

**Re-approval rule** (the simplest secure one): `POST
/api/v1/auth/passkeys/:id/approve`, step-up required, from a session bound
to an active device of the account (another still-trusted device) — or, when
no trusted device is left, from a recovery session (recovery-key proof). The
revoked browser can obtain neither: its device is revoked, its passkey can
only bind active devices, and it does not hold the recovery key unless the
user does. Email possession is deliberately NOT enough: a stolen device
usually has the mailbox signed in too.

What revocation cannot do, and the UI says so: it does not erase data or
keys already on the device (no remote wipe), and the vault key that device
holds still decrypts anything encrypted under it if it ever obtains that
ciphertext again. Only rotating the vault key protects items created after
the revocation — vault key rotation is not implemented yet.

### 6.4 Sign-in with the email alone (`POST /api/v1/auth/email/session`)

The default for an account without a passkey (a passkey is an optional
upgrade added later from the Security Center, step-up required). Body
`{ email, registration_ticket, device? }`; `device` is the same proof as in
§6.1, signed over the **ticket** as `challenge` (source 2 in §5). The code and
ticket flow is `POST /auth/email/request` -> `POST /auth/email/verify`
(unchanged). Server order: the live ticket for that address is checked, then
in one transaction it is spent, the user row is created on first use, and the
proof is verified and the device enrolled/bound. A bad proof answers `401
device_verification_failed`, rolls the account back and leaves the ticket
usable; every other failure is one generic `401 verification_failed`.

- **Closed for an account with an active passkey.** `request` mails such an
  address a notice instead of a code, and `session` refuses it again. The
  passkey is then the only way in (or the recovery key): email possession alone
  is not enough, as in §6.3.
- With MFA enabled the response is `{ mfa_required, mfa_token }` and nothing is
  bound or created until `POST /auth/mfa/verify` succeeds, as in §6.1.
- Without `device` the session is unbound and cannot reach vault data.
- **Step-up** for such an account is a code mailed to it
  (`POST /auth/step-up/email/request`, `POST /auth/step-up/email`): allowed only
  while the account has no active passkey and no MFA (its login factor is the
  email already); `403 email_step_up_unavailable` otherwise. This is how it
  adds its first passkey.
- **No durable revocation here.** A device enrolled through this flow has no
  enrolling passkey (`devices.authenticator_id` is null), so revoking it cannot
  restrict anything: whoever holds the mailbox can enrol a new device. Adding a
  passkey is what closes that (§6.3 applies from then on; the account's passkeys
  are all marked for re-approval after a revocation, the "enrolling passkey
  unknown" rule).

## 7. Server verification rules (normative)

1. Look up the challenge; consume it atomically; reject when missing,
   expired, already consumed, of another purpose, or (explicit flow) issued
   to another session.
2. Resolve the key. `session-bind`: the stored key of device `device_id`
   that belongs to the authenticated user, is not revoked, and has
   `public_key_alg = "ed25519"`. `enroll`: the public key being enrolled
   (32 bytes after decoding, else reject). A client-supplied key is never
   used to verify a `session-bind`.
3. Build `message` (§3) from server-side values.
4. Verify with RbNaCl (`RbNaCl::VerifyKey#verify`, libsodium
   `crypto_sign_verify_detached`).
5. Any failure → one generic error, audit `device_bind_failed` (purpose
   only in metadata — never the challenge, signature or key).

Legacy device rows created before v1 hold the passkey's COSE public key and
have `public_key_alg = NULL`: they stay listable and revocable but can never
satisfy a proof.

## 8. Client key storage

### 8.1 Web and desktop (implemented)

Preferred: **non-extractable WebCrypto Ed25519 key in IndexedDB.**
`crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])`;
the `CryptoKeyPair` is stored in IndexedDB (structured clone keeps the
private key non-extractable). Script on the origin can ask it to sign but
cannot read the private bytes, so an XSS can misuse the key only while it
runs, not exfiltrate it.

Fallback, when the runtime has no WebCrypto Ed25519 (older WebKit / Firefox
/ WebView builds): **libsodium** `crypto_sign_keypair`; the 64-byte secret
key is stored in the same IndexedDB store as raw bytes. This is weaker: any
script on the origin can read and exfiltrate it. The record says which
backend it uses (`storage: "webcrypto" | "libsodium"`).

The record is keyed by (API base URL, account email) and holds
`{ device_id, alg: "ed25519", storage, key }`. It is not encrypted under
the vault key on purpose: sign-in (and therefore binding) happens before
the vault is unlocked, and the key grants no vault access.

The Security Center's manual "Enroll this browser" keeps its own,
separately generated key (stored encrypted under the Vault Key) and now
also proves possession through §6.2.

### 8.2 Desktop (Tauri)

Same code as web, inside the system WebView: WKWebView (macOS 14+/Safari
17+) and WebView2 (Chromium) expose WebCrypto Ed25519 on current versions;
older ones take the libsodium fallback.

### 8.3 Mobile (plan, not implemented)

React Native has no WebCrypto Ed25519, and the iOS Secure Enclave only
holds P-256 keys, so the plan is:

- generate with libsodium (`crypto_sign_keypair`) in JS;
- store the 32-byte seed in the platform keystore — iOS Keychain with
  `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` (no iCloud sync), Android:
  native Ed25519 in Android Keystore on API 33+, else the seed wrapped by a
  Keystore AES-GCM key;
- that native storage belongs to the mobile storage workstream.

Until it lands the mobile app does **not** enrol or bind devices (its
recovery-key sessions are unbound) and never writes a device key to
AsyncStorage.

## 9. Security properties

- A stolen session token alone cannot bind that session to a device (needs
  the device private key) or enrol one without step-up.
- A stolen device key alone cannot create a session (needs the passkey).
- A captured proof cannot be replayed: the challenge is single-use and
  short-lived, and (explicit flow) tied to the session that asked for it.
- A proof made by one device key never verifies for another device id: the
  server picks the key from the database by `device_id`.

## 10. Test vector (Ed25519 is deterministic)

```
seed (private, test only) = 000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f
public_key                = A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg
challenge                 = ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8

purpose session-bind
payload   = {"challenge":"ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8","device_id":"6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b"}
message   = "my-secrect/device/v1/session-bind\n" || payload
signature = KFN1G09bb_AoNZUh77OX3tjTRdjXEnmZEsCaNUxK4-R6X-qn4m-v6qACHOB0XDLH6LO8e_aztE49ihsRhzyuDQ

purpose enroll
payload   = {"challenge":"ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8","public_key":"A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg"}
message   = "my-secrect/device/v1/enroll\n" || payload
signature = 53CXmLHTJIzg38orguydfr11SGBznkcKMiGeoyBLz8TNP-q2OPbHH44z0sOYREYQWj59r9AfGJSK8aJOfKJqDA
```

Checked by `apps/api/spec/domains/device_proof_spec.rb` (RbNaCl) and
`packages/sdk/tests/device-identity.test.ts` (libsodium + WebCrypto). A
failing vector means the code is wrong — never edit the expected values.
