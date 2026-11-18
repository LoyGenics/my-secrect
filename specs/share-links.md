# Expiring share links — format v1

Read-only snapshots for recipients without a My Secret account. This is a
separate protocol from pairwise account sharing in sharing-protocol.md.

The client generates an independent 32-byte key and a 24-byte random link
identifier with libsodium. It encrypts a sanitized item snapshot using
XChaCha20-Poly1305 IETF, a fresh random 24-byte nonce, and UTF-8 associated
data `my-secrect:share-link:v1:<id>:<expires_at>`. The id is base64url without
padding (32 characters); expiry is canonical ISO 8601 UTC with milliseconds.
Payload is standard base64 of `nonce || ciphertext || 16-byte tag`.

The shared copy excludes original item id, tags, graph, attachments, favorite,
archive state, password history and note revisions. Files and collections
use their own flows and are rejected. Schema and forbidden-field validation
runs before encryption and after decryption. Editing the original never
changes an existing link.

The URL is `<trusted-web-origin>/share/<id>#k=<base64url-key>`. Only an origin
configured by the user (default: the configured API's origin) is used; an API
response cannot choose the key destination. The fragment is not included in
HTTP requests. The recipient client makes same-origin API requests without
a session or credentials. No third-party analytics or remote assets run on
the recipient page. No-store and no-referrer response policies apply.

The API stores ciphertext, Vault-Key-encrypted owner metadata (source item
id and link key so the owner can copy an existing link), owner id, format,
expiry and timestamps. Public reads return only id, format, expiry and
ciphertext. Creating/listing/revoking requires an authenticated owner; other
accounts cannot enumerate or revoke links. Maximum lifetime is seven days;
choices are one hour, one day and seven days. The API limits active links to
100 per owner and bounds payload/metadata sizes. Public reads and creation
are throttled. Account deletion deletes these rows.

Expiry is checked by both server and recipient clock. Revocation clears
ciphertext and encrypted owner metadata and stops subsequent reads. A copied
or already decrypted credential cannot be taken back: change the password
at its service if it must stop working. Anyone holding the entire link can
view it; there is no email restriction or single-use claim in v1. The server
learns the owner, timing, size and request metadata, never plaintext or the
fragment key. A compromised web client can steal recipient plaintext; the
web origin remains part of the trust boundary. This protocol is not audited.

Tests: core share-link tests exercise real libsodium; API request specs cover
public response shape, ownership, expiry, revocation and input bounds. A
fixed independent crypto vector belongs in tests/crypto-vectors/.
