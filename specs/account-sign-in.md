# Account Sign-in — v1

Status: v1, implemented by the API (`Authentication::OauthStart`,
`Authentication::IdToken`, `Authentication::OauthSignIn`,
`Authentication::EmailSignIn`, shared end `Authentication::SignInCompletion`).

## 1. What sign-in is (and is not)

Every user signs in to an **account** before creating or unlocking a vault.
Account sign-in proves who the user is to the server and yields a short-lived
Bearer session. It never unlocks the vault: the vault key is still derived
only from the user's passphrase on the device (`specs/key-management.md`), and
nothing below gives the server, Google or Apple any vault key material.

Methods:

| Method | Endpoints |
|---|---|
| Sign in with Google | `POST /auth/oauth/start` -> `POST /auth/oauth/google/session` |
| Sign in with Apple | `POST /auth/oauth/start` -> `POST /auth/oauth/apple/session` |
| Email + 6-digit code | `POST /auth/email/request` -> `/verify` -> `/session` (`specs/device-identity.md` §6.4) |

No enterprise SSO. Passkeys and MFA keep their existing rules.

## 2. Configuration

`GET /api/v1/auth/providers` returns the public client ids from ENV:

```json
{ "google": { "web_client_id": "...", "ios_client_id": "...", "android_client_id": "...", "extension_client_id": "..." },
  "apple":  { "services_id": "...", "bundle_id": "..." } }
```

ENV: `GOOGLE_WEB_CLIENT_ID`, `GOOGLE_IOS_CLIENT_ID`, `GOOGLE_ANDROID_CLIENT_ID`,
`GOOGLE_EXTENSION_CLIENT_ID`, `APPLE_SERVICES_ID`, `APPLE_BUNDLE_ID`. An unset
id is `null`; a provider with no id set is `null` (clients hide its button) and
the server accepts none of its tokens. These are public client ids, not
secrets; the server needs no Google/Apple client secret.

`GOOGLE_DESKTOP_CLIENT_ID` is the Google "Desktop app" client the Tauri app
uses (its build-time `VITE_GOOGLE_DESKTOP_CLIENT_ID`). The server accepts it
as a Google audience and counts it when deciding whether Google is on, but
`auth/providers` does not list it: the desktop app already ships that id and
needs nothing from the server except `google` being non-null.

## 3. Google / Apple flow

1. `POST /auth/oauth/start` (body `{}`) -> `200 { ticket, nonce, expires_at }`.
   * `ticket` = `"ot_"` + 64 hex (256 bits), shown once. The server stores
     only `SHA-256(ticket)` (`oauth_tickets`). TTL 10 minutes, single use.
   * `nonce` = base64url(HMAC-SHA-256(server key, ticket)), 43 chars. Never
     stored; recomputed from the presented ticket.
2. The client asks the provider for an ID token with that nonce: Google gets
   the raw `nonce`, Apple gets `hex(SHA-256(nonce))`, as Apple requires.
3. `POST /auth/oauth/:provider/session`, body
   `{ ticket, id_token, device?, full_name? }`.
   * `device` is optional and is the same proof as `specs/device-identity.md`
     §6.1, signed over the **raw nonce** as `challenge`. Without it the session
     is unbound (mobile, §8.3 there), exactly as for the email session.
   * `full_name` (Apple, first sign-in only) is accepted and **not stored**.
   * `200` is the same body as `POST /auth/email/session`:
     `{ token, user_id, device_id, expires_in, account_created }`, or
     `{ mfa_required: true, mfa_token, user_id }` for an MFA account (finished
     by `POST /auth/mfa/verify`; nothing is bound until then).
   * `401 { error: "verification_failed" }` for every token or ticket problem;
     `401 { error: "device_verification_failed" }` for a bad device proof (the
     ticket, user row and identity roll back; the ticket stays usable).
   * An ID token that fails verification (§3.1) **spends the ticket**: one
     ticket cannot be retried with other tokens. Only a bad device proof
     leaves it usable.

### 3.1 ID-token verification (normative)

* `alg` is `RS256` only (no `none`, no HMAC). The key comes from the
  provider's JWKS by `kid`: `https://www.googleapis.com/oauth2/v3/certs`,
  `https://appleid.apple.com/auth/keys`. Cached in-process for 1 hour; an
  unknown `kid` triggers one refetch, at most once a minute. A failed fetch
  fails closed (`401 verification_failed`) and is not retried for 30 seconds.
* `iss`: Google `accounts.google.com` or `https://accounts.google.com`; Apple
  `https://appleid.apple.com`.
* `aud` is one of this deployment's client ids for that provider. When `aud`
  is an array, `azp` must be present and one of those client ids too.
* `exp` not passed and `iat` not in the future, 60 seconds of clock skew.
* `nonce` equals the ticket's nonce (Google) or its SHA-256 hex (Apple),
  compared in constant time.
* `sub` present; `email` present and `email_verified` true (Apple sends
  `"true"`).
* The ticket is live; it is spent in the same transaction as the sign-in.

### 3.2 Account linking

1. A known `(provider, sub)` in `user_identities` signs in to its user (even
   if the provider's email has since changed).
2. Otherwise the user is found or created by the verified email (lower-cased),
   and `(provider, sub, email)` is recorded. Apple private-relay addresses are
   accepted as-is, so the same person may end up with a separate account.
   * Linking to an **existing** account needs an **authoritative** email.
     Apple's verified email (relay included) is. A Google email is only
     authoritative for `@gmail.com` / `@googlemail.com`, or for a Workspace
     account whose `hd` claim equals the email's domain (Google's own rule:
     `email_verified` alone is not proof for other domains). A
     non-authoritative Google email that matches an existing account gets
     `401 verification_failed`; it may only create a new account when no user
     has that email.
3. **Never by email to an account with an active passkey** (`401
   verification_failed`): email possession alone is not enough there
   (`specs/device-identity.md` §6.3, same rule as the email session).

### 3.3 Client rules (desktop / web)

* A stored session token is never trusted on its own. At start and before
  creating, unlocking or restoring a vault the client checks it with the
  server (`GET /auth/sessions`): `401` clears it and returns to sign-in. If
  the server cannot be reached, only a token with a known, unexpired expiry
  may reach the lock screen (offline, local-first); a token without a stored
  expiry stays on sign-in until it can be verified. Same policy as mobile.
* Apple: the `state` sent to Apple must come back unchanged in the popup
  answer, or the answer is dropped.
* Web: when the sign-in screen loaded the Google or Apple script, a
  successful sign-in reloads the page, so those scripts and their globals
  never share a page with the unlocked vault.
* Desktop (Tauri) CSP: `connect-src` allows any `https:` origin (plus
  `http://localhost:*` / `http://127.0.0.1:*`) because the account server URL
  is chosen by the user at run time; a static allow-list is impossible. Only
  `connect-src` is opened this way: scripts, frames and objects stay `'self'`.
  The desktop Google sign-in stops its loopback listener as soon as the user
  cancels.

## 4. What the server learns and stores

* From Google/Apple: the stable subject id (`sub`) and the verified email (an
  Apple relay address if the user hid theirs). Stored in `user_identities`
  (`provider`, `subject`, `email`, `user_id`). Name, picture and the ID token
  itself are not stored.
* Google/Apple learn that the user signs in to this app (and when); they see
  the nonce, which reveals nothing about the ticket. They learn nothing about
  the vault.
* Audit events carry the provider name only (`{ method: "google" }`), never
  the token, nonce, ticket or email. A refused sign-in (`sign_in_failed`) is
  recorded on an account only when the token identifies it: a verified token
  whose `(provider, sub)` is linked to it, or whose authoritative email is
  its email. A failed token, or a non-authoritative email, is recorded on no
  account.
* Request logs filter `id_token`, `ticket`, `nonce`, `full_name`, `email`.

## 5. Rate limits (Rack::Attack)

Per IP: `POST /auth/oauth/start` 10/min; `POST /auth/oauth/{google,apple}/session`
10/min together (same as `POST /auth/email/session`).

## 6. Account deletion

`user_identities` rows are deleted with the account (`Accounts::Delete`).
`oauth_tickets` hold no user reference.
