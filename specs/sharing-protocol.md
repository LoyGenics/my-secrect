# Sharing Protocol — v1, record format v2 (implemented, NOT audited)

> Status: implemented end to end (Rails API, `packages/core/src/sharing.ts`,
> `packages/sdk/src/sharing.ts`, desktop/web `SharesView`, mobile
> `SharesScreen`) and exercised by a two-user test against the real API
> (`tests/sharing-e2e/`). Nothing here is audited. Any change to a byte
> layout, an associated-data string or a primitive bumps the format version
> (the `v2` record strings below) and needs new tests. Record format v1
> (72-byte wraps without a share binding) is rejected by client and server.

## 1. Scope

v1 shares **one vault item** from its owner with **one recipient** (another
enrolled account). Sharing the same item with two people creates two
independent shares. Out of scope: whole-vault shares, groups,
attachments/blobs (stripped from the shared copy), version history of the
shared copy.

Goal: two independently enrolled users share an item end to end, with
recipient keys verified out of band, and permissions enforced by the server,
while the server only ever sees public keys, ciphertext and opaque ids.

## 2. Primitives (libsodium only, `libsodium-wrappers-sumo`)

| Purpose | Construction |
|---|---|
| Identity key pair (per user) | X25519, `crypto_box_keypair` |
| Wrap a per-revision Share Key for the peer | `crypto_box_easy` (X25519 + XSalsa20-Poly1305), random 24-byte nonce |
| Bind the wrap to its share + revision | SHA-256 (`crypto_hash_sha256`) of the record associated data, inside the box |
| Encrypt the shared item | XChaCha20-Poly1305 IETF (`crypto_aead_xchacha20poly1305_ietf_encrypt`) with associated data, random 24-byte nonce |
| Wrap the identity secret key for the user's own devices | the existing Vault Key AEAD (`encryptWithVaultKey`, XChaCha20-Poly1305) |
| Fingerprint | BLAKE2b-256 (`crypto_generichash`) |
| Randomness | `randombytes_buf` |

**Why `crypto_box_easy` and not `crypto_box_seal`.** A sealed box is
anonymous: anyone holding the recipient's public key — including the server —
can produce a valid one. A recipient could then not tell a share created by
the owner from one forged by the server (e.g. a fake "bank password" planted
in a share that claims to come from a colleague). `crypto_box_easy` is
libsodium's authenticated public-key encryption: a box opens under
`(peer public key, own secret key)` only if it was made with the matching
`(own public key, peer secret key)`. Opening with the **pinned** peer key
therefore proves the wrap came from that peer (or from oneself). The box key is
the X25519 shared secret of the pair, which is symmetric: a box made by A for
B opens for B with `(pk_A, sk_B)` and for A with `(pk_B, sk_A)`. Both parties —
on every one of their devices — can read every revision, and a write by
either side needs no second wrap.

## 3. Identity key: where it lives, how it reaches each device

- Generated on the first device that opens Sharing while the vault is
  unlocked and the account is signed in.
- **Public key** (32 bytes) is registered with the server:
  `PUT /api/v1/identity-key`. Registration needs a **fresh step-up** on the
  session (passkey or TOTP within 10 minutes; 403 `step_up_required`
  otherwise): whoever registers the key decides what contacts will verify, so
  a stolen session token alone must not be enough. The UIs ask for the
  step-up (desktop/web: `StepUpDialog` server-only; mobile: TOTP code) and
  retry.
- **Secret key** never leaves the client in plaintext. It is encrypted under
  the user's **Vault Key** — a key the server never has — as
  `encryptWithVaultKey(JSON {kind: "my-secrect.sharing.identity.v1",
  public_key, secret_key})` and uploaded as the opaque
  `encrypted_secret_key` next to the public key.
- **Every other device of the same user** fetches `GET /api/v1/identity-key`
  and decrypts it with its own copy of the Vault Key (no step-up needed to
  load). Devices obtain the Vault Key the same way they do for sync: master
  passphrase + an encrypted vault backup restored from a trusted device. No
  extra transfer channel exists or is needed.
- After decrypting, the client checks `kind`, that the secret key is 32
  bytes, and that `crypto_scalarmult_base(secret_key)` equals both the
  public key inside the ciphertext and the public key the server returned.
  Any mismatch fails closed. A server cannot substitute the blob: it cannot
  produce ciphertext under the Vault Key, and swapping in another
  Vault-Key ciphertext of the same user (e.g. an encrypted device name) fails
  the `kind` check.
- Registration is **write-once** (same public key again = idempotent 200; a
  different public key = 409 `identity_key_exists`). Two devices racing to
  register: the loser gets 409, discards its fresh key pair and loads the
  winner's. A malicious server can pretend no identity exists (404), so that
  a device registers a fresh one (the user still has to pass the step-up);
  it cannot read anything with that, and every contact who pinned the old
  key then gets `KeyChangedError` (§4).
- **Reset / rotation**: `POST /api/v1/identity-key/rotate` (fresh step-up
  required) replaces the public key and encrypted secret. Use it when this
  device's vault cannot open the identity (a separately created vault) or the
  key may be exposed. In the same transaction the server **revokes every
  share the account owns or receives** and erases their ciphertext (they
  were wrapped for the old key pair). Contacts see the new key as a key
  change (`KeyChangedError`) and must compare the new fingerprint before
  anything is shared again. Other devices with the same Vault Key load the
  new identity; devices with another vault cannot open it.
- The secret key is held in memory only while the Shares view is open and
  is zero-filled on lock/unmount. It is never written to local storage in
  plaintext. Limit: the JSON plaintext inside `encryptWithVaultKey` passes
  through a JS string, which cannot be zero-filled (same limit as vault items).

## 4. Contact verification and pinning

### Threats: key substitution and relabelling by a malicious server
The server hands out public keys **and the email labels shown next to them**.
A malicious or compromised server can:
- answer "B's key is `pk_S`" with a key it controls. If A wrapped the Share
  Key to `pk_S`, the server decrypts it, re-wraps to B's real key and
  reads/edits everything — a man-in-the-middle that E2EE alone does not stop.
  Symmetrically it can hand B a fake "A" key and forge shares from "A";
- keep a contact's real, verified key but show it under another email
  ("From alice@corp" on a share that really comes from mallory, whom the
  user verified earlier as mallory), so the user trusts content because of a
  name the server chose.

### Defence: fingerprint comparison + local pin of key AND email
- **Fingerprint** of a public key = BLAKE2b-256 of
  `"my-secrect:sharing:fingerprint:v1" || public_key`. Displayed as 30
  decimal digits in six groups of five: each group is a 5-byte big-endian
  slice of the hash, mod 100000 (≈ 99.7 bits).
- Every user can see **their own** fingerprint ("Your sharing key"), derived
  from the locally decrypted key pair, never from what the server says.
- **Before the first share** to a person, the sender looks the recipient up
  by email, sees the fingerprint computed from the server-provided key and
  must confirm it matches the fingerprint the recipient reads from their own
  device, reached through contact details the user already had (in person, a
  call) — not details shown by the app. Only an explicit "they match" pins
  the key. There is no trust-on-first-use: an unpinned key cannot be used
  for anything.
- **Before accepting**, the recipient does the same for the owner's key.
- **Pins** (`user_id → public_key, fingerprint, email (normalised), verified_at`)
  are stored on the device, encrypted under the Vault Key (AEAD gives
  integrity at rest), namespaced per account. They are per device: a second
  device verifies again (pins are not synced).
- **Every crypto operation uses the pinned key**, never the key the server
  just returned. The server-provided key and email are only compared with
  the pin (`PinStore.state` / `requireVerified`):
  - both equal → `verified`, proceed;
  - not pinned → `unverified`, `KeyNotVerifiedError`; the UI asks for
    verification;
  - different key → `changed`, `KeyChangedError` (reason `key`);
  - same key, different email → `relabeled`, `KeyChangedError` (reason
    `email`).
  `changed` and `relabeled` both block every action on that contact (share,
  accept, open, write, send, save) and show a warning; the only way on is to
  forget the pin and verify again out of band.
- **Display rule**: a verified contact is always shown by the **pinned**
  email. An unverified contact is shown as "`<email>` (as the server reports
  it — not verified)". A server email is never presented as verified.
- The server also cross-checks honestly-behaving clients: create requires the
  `recipient_public_key` the owner pinned to equal the recipient's registered
  key (409 `recipient_key_mismatch`), and accept requires the
  `owner_public_key` the recipient pinned to equal both the key stored on the
  share and the owner's registered key (409 `owner_key_mismatch`). These
  checks catch stale state; they are not what stops a malicious server —
  the pins are.

## 5. Share object

### Server row (`item_shares`)
| Column | Meaning |
|---|---|
| `id` | UUID v4 **chosen by the owner's client** (it is bound into the record associated data, so it must be known before encryption) |
| `owner_id`, `recipient_id` | account ids |
| `permission` | `read` or `write` |
| `status` | `pending` → `active` → `revoked` |
| `expires_at` | optional; null = no expiry; must be in the future at creation |
| `owner_public_key`, `recipient_public_key` | the two registered identity keys the share was made under |
| `revision` | starts at 1, +1 per accepted write |
| `encrypted_payload` | current revision's item ciphertext |
| `encrypted_item_key` | current revision's Share Key + binding, boxed for the pair (104 bytes) |
| `last_writer_id` | owner or recipient |
| `encrypted_owner_metadata` | owner-only, Vault-Key ciphertext (see below); never sent to the recipient |
| `accepted_at`, `revoked_at` | timestamps |

The server never sees: the item, its title/type, the Share Key, either
secret key, or which vault item a share came from.

### Byte layouts (record format v2)
For revision `r` of share `s`, the writer draws a fresh 32-byte **Share Key**
`K` (never reused across revisions or shares). Let
`AD = UTF-8("my-secrect:share-record:v2:" + s + ":" + r)`.
- `encrypted_payload` = base64(`nonce(24) || XChaCha20-Poly1305(K, nonce,
  plaintext = JSON(shared item), ad = AD)`)
- `encrypted_item_key` = base64(`nonce(24) || crypto_box_easy(K ||
  SHA-256(AD), nonce, peer_public_key, own_secret_key)`) — exactly 104
  bytes decoded (24 + 32 + 32 + 16). On opening, the client recomputes
  `SHA-256(AD)` for the share and revision it expects and requires the 32
  bytes after `K` to match (constant-time compare); otherwise
  `ShareCryptoError` ("made for another share or revision").
- `encrypted_owner_metadata` = `encryptWithVaultKey(JSON {kind:
  "my-secrect.sharing.owner-metadata.v1", share_id: s, source_item_id})`.

The binding makes the **wrap alone** verifiable for its share and revision —
this is what the pending key-exchange check (§6 step 2) relies on, since it
has no payload to decrypt. A genuine wrap that A made for B in one share
cannot be replayed into a forged pending share, and the payload AEAD
independently refuses a record moved between shares or revisions.

The shared item is the vault item with `relations` and `attachments` emptied
and `favorite`/`deleted_at` dropped (they reference the owner's private vault
graph and blobs the recipient cannot access).

### Content rules
Every item encrypted into a share (`encryptShareRecord`) and every item
merged back into a vault (`mergeSharedEdit`, used by "Save to my vault") must
pass `packages/schemas` `validateItemSchema`: supported `schema_version`,
known item type, required fields present, and **no `FORBIDDEN_FIELDS`
entry** (CVV/CVC, any PIN, live one-time codes; case-insensitive). Otherwise
`ShareContentError` and nothing is encrypted or saved. For a merge the
fields are validated against the **vault item's** type.

## 6. Lifecycle, permissions, expiry

1. **Create** (owner): owner's own identity registered; recipient pinned
   (key and email); content valid; client encrypts revision 1 and
   `POST /api/v1/shares`. Status `pending`. Server checks: recipient exists,
   is not the owner, has a registered key equal to `recipient_public_key`;
   permission valid; expiry in the future; ciphertext sizes (wrap exactly
   104 bytes); id is a fresh UUID.
2. **Accept = key-exchange check, then activation** (recipient, pending).
   The UI offers "Verify key exchange and accept" once the owner's key and
   email are pinned; pressing it runs `SharingSession.acceptShare`, which
   first performs the check and only then calls the server:
   - the owner key and email on the share must equal the pin;
   - `GET .../record` (which, while pending, returns only `revision` +
     `encrypted_item_key`, never the payload);
   - the wrap must open with the pinned owner key **and** carry the binding
     for this share id and that revision.
   Any failure throws (`KeyNotVerifiedError` / `KeyChangedError` /
   `ShareCryptoError`) and the accept request is **never sent**.
3. **Activation** (server): `POST .../accept {owner_public_key}` → `active`.
   **A share is never active before the recipient's client has verified the
   owner key and the bound wrap.** The server cannot verify the crypto; it
   enforces the state machine and the key cross-checks.
4. **Use**: see the table. Writes are revision-checked (`base_revision`,
   409 on stale) and always carry a fresh `K`.
5. **Revoke** (owner) / **decline or leave** (recipient):
   `DELETE /api/v1/shares/:id` → `revoked`, and the server **erases** the
   ciphertext, the wrapped key and the owner metadata from the row.
   An identity rotation (§3) revokes all of the account's shares the same way.

| Action | Owner | Recipient `read` | Recipient `write` | Anyone else |
|---|---|---|---|---|
| List (`GET /shares`) | own shares | own shares | own shares | never sees them |
| Read record, pending | yes | wrapped key only | wrapped key only | 404 |
| Read record, active | yes | yes | yes | 404 |
| Write record, pending | yes | 403 `share_not_active` | 403 `share_not_active` | 404 |
| Write record, active | yes | 403 `write_not_permitted` | yes | 404 |
| Accept | 403 | yes (pending only) | yes (pending only) | 404 |
| Any record access when expired | 403 `share_expired` | 403 `share_expired` | 403 `share_expired` | 404 |
| Any record access when revoked | 403 `share_revoked` | 403 `share_revoked` | 403 `share_revoked` | 404 |
| Revoke / decline | yes | yes | yes | 404 |

Expiry is evaluated by the server on every request (`expires_at <= now` ⇒
expired); there is no background job. An expired share keeps its ciphertext
until either party revokes it.

### What the crypto does and does not enforce
- Confidentiality and authenticity of content **within the pair**: enforced
  by crypto (pinned keys, authenticated box, binding, AEAD with bound
  context).
- `read` vs `write`, expiry and revocation are **server-enforced**. A
  malicious server could accept a write from a read-only recipient or keep
  serving an expired share — but only to the pair, never to a third party,
  and it can never read content. Because the box is pairwise, crypto cannot
  tell whether the owner or the recipient wrote a revision; `last_writer_id`
  comes from the server.
- Therefore recipient edits **never flow into the owner's vault
  automatically**. The owner opens the shared copy, sees who wrote it last,
  and chooses "Save this version to my vault". The save uses **exactly the
  revision the owner was shown** (`saveToVault(share, reviewed)`; nothing is
  re-fetched), so a revision written after the review is never saved unseen;
  title, fields and tags come from that revision, type, relations,
  attachments, favorite and id stay the vault's, and the result must pass
  the content rules (§5). The owner's devices find the source item via
  `encrypted_owner_metadata`, which only the owner's Vault Key opens and
  which names the share id.
- The owner's own later edits reach the recipient only when the owner
  chooses "Send latest version" (new revision, fresh `K`).

## 7. Revocation — what it does and its honest limit

- Future access stops: every record request by the recipient is refused
  (403), and the server deletes the stored ciphertext and wrapped key.
- The recipient never held the owner's Vault Key or the vault's Item Keys;
  shares use separate, fresh per-revision keys. Nothing the recipient holds
  opens anything in the owner's vault.
- After revocation nothing new is ever wrapped for that share. Re-sharing
  later creates a new share with new keys. Independently, the owner's next
  write to the vault item re-keys the vault copy (Item Keys are fresh on
  every write).
- **Limit:** anything the recipient already decrypted — what they saw,
  copied, wrote down, or a Share Key of a revision they fetched — cannot be
  erased from their device or memory. Revocation is not a remote wipe. If the
  shared item is a credential, the owner must change the credential itself
  at the service it belongs to. The UI states this next to the Revoke button.
- A malicious server could keep old ciphertext after "deleting" it; that
  gives nobody new plaintext (only the pair can open it).

## 8. Failure handling (all fail closed)

| Situation | Result |
|---|---|
| Peer key not pinned on this device | `KeyNotVerifiedError`; nothing is wrapped or opened; the UI shows the fingerprint and asks for verification |
| Server key differs from the pin | `KeyChangedError` (reason `key`); every action on the contact is blocked; warning shows the verified and the presented fingerprints; only forget + re-verify continues |
| Same key, server shows another email | `KeyChangedError` (reason `email`); blocked like a key change; warning shows the verified and the presented email |
| `encrypted_item_key` tampered, truncated, v1-sized, or made for another key pair | `crypto_box_open_easy` / length check fails → `ShareCryptoError`; accept is refused (the accept request is never sent), open fails |
| Genuine wrap moved to another share or revision | binding mismatch → `ShareCryptoError`; accept refused, open fails |
| Payload tampered, or moved to another share/revision | AEAD fails (associated data mismatch) → `ShareCryptoError` |
| Decrypted plaintext is not a valid item | `ShareCryptoError` |
| Content invalid (forbidden field, missing required field, unknown type/version) | `ShareContentError`; nothing is encrypted, written or saved |
| Owner saves a share another revision was written to after their review | the reviewed revision is saved, not the newer one |
| Identity ciphertext does not open / wrong `kind` / key pair mismatch | identity load fails; Sharing is unavailable on this device; the UI offers "Reset my sharing key" (§3) |
| Registration or rotation without a fresh step-up | 403 `step_up_required`; nothing stored; the UI asks for a step-up and retries |
| Owner metadata not openable or names another share | "Save to my vault" / "Send latest version" fail with an error for that share; nothing is written |
| Stale `base_revision` | 409 `revision_conflict`; the client re-opens and retries explicitly |
| Server rollback to an older revision of the same share | not detected beyond the AD binding (same limit as sync, `specs/sync-protocol.md`) |

## 9. API (all require a session; JSON; binary fields are standard base64)

```
GET    /api/v1/identity-key            -> {identity_key:{user_id, public_key, encrypted_secret_key, created_at}} | 404
PUT    /api/v1/identity-key            {public_key, encrypted_secret_key} -> 201 | 200 (same key) | 409 identity_key_exists | 422
                                       (step-up required: 403 step_up_required)
POST   /api/v1/identity-key/rotate     {public_key, encrypted_secret_key} -> {identity_key, revoked_shares}
                                       | 404 no_identity_key | 422 (same/malformed key) | 403 step_up_required
POST   /api/v1/identity-keys/lookup    {email} -> {user_id, email, public_key} | 404   (never returns the encrypted secret)
GET    /api/v1/shares                  -> {shares:[...]}   (only shares where the caller is owner or recipient)
POST   /api/v1/shares                  {id, recipient_id, recipient_public_key, permission, expires_at?,
                                         encrypted_payload, encrypted_item_key, encrypted_owner_metadata} -> 201 {share}
GET    /api/v1/shares/:id/record       -> {record:{revision, encrypted_item_key, encrypted_payload?, last_writer_id}}
PUT    /api/v1/shares/:id/record       {base_revision, encrypted_payload, encrypted_item_key} -> {record:{revision, ...}}
POST   /api/v1/shares/:id/accept       {owner_public_key} -> {share}
DELETE /api/v1/shares/:id              -> 204 (owner: revoke; recipient: decline/leave)
```
Audit events (`audit_events`, ids + small metadata only, never keys or
ciphertext): `identity_key_registered`, `identity_key_rotated`
(`metadata.revoked_shares`), `share_created`, `share_accepted`,
`share_record_written`, `share_revoked` (`metadata.by` = owner/recipient).

## 10. Metadata the server learns
Who shares with whom and when, permission, expiry, number and timing of
revisions, which side wrote last, ciphertext sizes, email lookups, identity
rotations. Lookup by email reveals whether an address has a registered
sharing key (account enumeration by an authenticated user; covered only by
the generic API throttle).

## 11. Known limits
- No forward secrecy (static X25519 pair key). Rotation exists (§3) but
  ends every share; there is no key history.
- Key-compromise impersonation: whoever steals B's secret key can forge
  boxes that B would accept as A's (property of `crypto_box`).
- Pins are per device and not synced.
- Mobile has no passkeys: its step-up is TOTP only, so an account without
  TOTP creates or resets its sharing key on desktop/web.
- One recipient per share; no history of the shared copy (current revision
  only); attachments not shared.
- Rollback of the shared copy by a malicious server is not detected.

## 12. Tests
- `apps/api/spec/requests/api/v1/identity_keys_spec.rb`,
  `apps/api/spec/requests/api/v1/shares_spec.rb` — every server boundary,
  including step-up and rotation.
- `packages/core/tests/sharing-proposal.test.mjs` — real libsodium: round
  trip, tampering, wrong recipient, moved record, share-bound wraps, v1 wraps
  rejected, content rules, pin store (key and email), identity wrapping.
- `tests/sharing-e2e/two-users.test.ts` — enrolled users (email code +
  real WebAuthn, passkey step-up) against the real Rails API + Postgres,
  including relabelling, a moved wrap, a reviewed-revision save, forbidden
  content and identity rotation.
- `tests/sharing-e2e/ui.spec.ts` — the flow through the real web UI in
  two Chromium contexts (Playwright, real stack from `tests/e2e-web`).
