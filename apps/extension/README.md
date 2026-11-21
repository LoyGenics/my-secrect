# my-secrect — Browser Extension (Manifest V3)

Local-first, end-to-end encrypted autofill. TypeScript + React, built with Vite.

## Architecture — three separated parts

| Part | File | What it may touch |
|---|---|---|
| **Privileged background** (service worker) | `src/background.ts` + `src/lib/vault-ext.ts` | The ONLY place that holds the vault key (in memory only) and decrypts items — one item at a time, only the one the user chose. |
| **Popup / options UI** | `src/popup/`, `src/options/` | No keys, no vault. Talks to the background via `chrome.runtime` messages only. Holds at most the single item the user opened. |
| **Content script** | `src/content/content.ts` | Receives exactly ONE username + ONE password for one user-chosen fill. Never the vault, never a key, never the item list. Never stores anything. |

## Who may talk to the background (enforced in `src/background.ts`)

- Every vault request (`ExtRequest`) is answered only when the browser-provided
  `sender` is this extension's `popup/index.html` or `options/index.html`.
- A content script counts as the web page: it may send only `ext-form-detected`
  and `ext-login-submitted`, only from the top frame, and the page origin is
  taken from `sender`, never from the message. Anything else gets `Forbidden`.
- Other extensions: there is no `onMessageExternal` / `onConnectExternal` listener.
- `chrome.storage.local` is restricted to extension pages + the worker with
  `setAccessLevel('TRUSTED_CONTEXTS')`; by default Chrome lets content scripts
  read and write it. Injection fails closed if the browser refuses.
- A fill is injected into frame 0 only, the tab is re-read after injection, and
  the credential is addressed to that exact `documentId`.

Proven in real Chromium by `e2e/hardening.spec.ts`.

## Account sign-in (required before any vault)

The extension refuses to create, unlock or restore a vault until an account
is signed in (`background.ts`: `createVault`, `unlock`, `unlockRecovery`,
`restoreBackup` answer `authError: 'signed-out'`). The passphrase step stays
separate and comes after sign-in. Code: `src/lib/account.ts` (background
only), `src/lib/account-core.ts` (pure rules), `src/popup/SignIn.tsx` (shared
by popup and options).

- **Server**: build-time default `VITE_API_BASE_URL` (see `.env.example`,
  e.g. `https://vault.example.com/api`), overridable on the options page.
  https only; plain http only for `localhost` / `127.0.0.1`. Changing the
  server signs out and locks. With no server set, the popup says so and
  offers no way around sign-in. The API must allow the extension origin
  `chrome-extension://<extension-id>` in `CORS_ORIGINS` (there are no host
  permissions).
- **Email + code**: `POST /v1/auth/email/request` → `/verify` (ticket) →
  `/session`, with the device proof signed over the ticket. MFA accounts get
  the authenticator/recovery-code step (`/v1/auth/mfa/verify`).
- **Google**: shown only when `GET /v1/auth/providers` returns a Google
  `extension_client_id`. `POST /v1/auth/oauth/start` gives `{ ticket, nonce }`;
  the worker opens Google's authorize URL (`response_type=id_token`, raw
  nonce, random `state`) with `chrome.identity.launchWebAuthFlow`, reads the
  id token from the redirect fragment and posts it to
  `/v1/auth/oauth/google/session` with a device proof over the nonce. Google
  Cloud setup: an OAuth client of type *Web application* whose authorized
  redirect URI is `https://<extension-id>.chromiumapp.org/`
  (`chrome.identity.getRedirectURL()`); put its id in
  `GOOGLE_EXTENSION_CLIENT_ID` on the server. Pin the extension id with a
  manifest `key` for a stable redirect URI in development.
- **Apple: not offered in the extension.** Apple returns an id token carrying
  the email only with `response_mode=form_post` when the `email` scope is
  requested, i.e. an HTTP POST to the redirect URI. `launchWebAuthFlow`
  captures only the redirect URL, never a POST body, so the token never
  reaches the extension. Without scopes Apple allows a fragment response, but
  that token has no email, which the server needs to find or create the
  account. Supporting it would need a server-side relay page, which is not in
  the contract. Sign in with Apple on desktop/mobile, or use email/Google here.
- **Session storage**: the session token, its expiry, the account email and a
  pending step (address being verified, single-use MFA token) are kept in
  `chrome.storage.session` by the worker only: memory-backed, cleared when
  the browser quits, survives a worker restart, unreadable by content
  scripts. Never in `chrome.storage.local`. The popup/options receive an
  `AccountStatus` (step, email, server) and never the token. A local expiry
  or a 401 from `GET /v1/auth/sessions` (checked when the popup opens) means
  signed out. Sign-out revokes the current server session (best effort),
  clears the record and locks the vault.
- **Device proof**: the SDK device-key store (`packages/sdk/src/device-key-store.ts`,
  IndexedDB of the extension origin, non-extractable WebCrypto Ed25519 when
  available), scoped per server + account, platform `extension`. A rejected
  proof drops the key and retries once with a fresh enrolment.
- **Messages** (extension pages only, like every `ExtRequest`): `getAccount`,
  `getAuthProviders`, `setApiBaseUrl`, `requestEmailCode`, `verifyEmailCode`,
  `verifyMfa`, `signInWithGoogle`, `cancelSignIn`, `signOut`. None carries
  vault data.

## Permissions — minimal by design

`storage`, `activeTab`, `scripting`, `alarms`, `identity`. **No broad host permissions**
(`host_permissions` is empty, and there is no persistent `content_scripts`
entry in the manifest). The content script is injected on demand with
`chrome.scripting.executeScript` into the active tab only, for one fill.

- `storage`: the encrypted vault + settings. `activeTab` + `scripting`: inject
  into the tab the user clicked, nowhere else. `alarms`: auto-lock.
  `identity`: the Google sign-in window (`launchWebAuthFlow`) only.
- No `web_accessible_resources` (pages cannot frame or fetch extension pages),
  `externally_connectable: { ids: [] }` (no web page, no other extension).
- CSP `script-src 'self' 'wasm-unsafe-eval'; object-src 'none'`.
  `'wasm-unsafe-eval'` is required for libsodium's WebAssembly; without it
  libsodium fell back to asm.js, which returned non-random bytes (see
  `vite.config.ts`). It permits compiling wasm, not JS `eval`.
- Guarded by `tests/manifest.test.ts` (`npm --workspace apps/extension test`)
  and `e2e/build-output.spec.ts` (production `dist/`: manifest unchanged, no
  source maps, no eval/`Function`, no inline scripts, classic `content.js`,
  no private keys or fixtures).

## Autofill security rules (enforced in `src/lib/domain.ts` + `src/content/`)

1. Fill only on **https** (except `http://localhost` for development).
2. Never fill on a **raw IP address**.
3. The item's stored URL host must match the page host (exact or subdomain both ways) — otherwise the fill is refused with the mismatch shown.
4. **Punycode (`xn--`) domains** need explicit user confirmation (homograph protection, on by default).
5. **Bank / card items** need explicit user confirmation (on by default).
6. The content script fills **only the top-level frame** (`window.top === window.self`) — never an iframe.
   Within it, only a **visible, editable** login password field (never hidden,
   off-page, transparent, tiny, read-only, disabled or `new-password`-only) and
   the username field of the **same form**, placed before it. Other forms on
   the page are never touched.
7. The content script verifies the fill message's `origin` equals `window.location.origin`.
8. Blocked origins (options page) always win; an allow-list, when set, restricts filling to those origins.
9. Login-form detection reports **only that a form exists** (which fields exist; the origin comes from the browser).
10. No autofill happens without a user click. There is no automatic fill on page load.
11. **Save / update offer.** Field values leave a page in exactly one case: a
    real (`isTrusted`) submit of a top-frame form with a visible password
    field, on a page that passes rules 1, 2 and 8. The content script sends
    that username + password to the background only and gets a bare `{ok:true}`
    back. The background keeps it in worker memory (never `chrome.storage`,
    never the popup, never a page) for at most 5 minutes and sets the toolbar
    badge. The popup shows "Save this login" (new) or "Update password" (same
    username, different password, for a domain-matching login) and "Not now".
    Nothing is saved until the user clicks; lock, wipe, decline and expiry
    drop the capture. Because there are no host permissions, the script is
    present only on a tab where the user opened the popup or filled.

## Crypto

Same hierarchy as the desktop app, mirrored in `src/lib/vault-ext.ts`:
passphrase → Argon2id KEK → wrapped Account Master Key → wrapped Vault Key →
per-item keys → XChaCha20-Poly1305 (fresh 24-byte nonce per encryption),
via `libsodium-wrappers-sumo`. Recovery key is shown once at creation.

**Separate vault:** the extension runs under the `chrome-extension://`
origin, so its `chrome.storage.local` is NOT the desktop app's storage and
NOT the web client's storage. Items saved here do not appear on desktop
until Phase 2 sync unifies devices. Do not present it as synced.

**MV3 service workers are ephemeral:** Chrome may terminate the worker at
any time; the in-memory session is then gone and the vault reports locked.
That is correct behaviour — unlock again. Keys are deliberately not kept in
`chrome.storage.session` (it would outlive the worker and be readable by
every extension page). The auto-lock alarm is browser state and survives a
restart; a pending save offer does not. Proven by the worker-restart test in
`e2e/hardening.spec.ts` (CDP `ServiceWorker.stopWorker`).

**libsodium + wasm note:** `libsodium-wrappers-sumo` loads its WebAssembly
module at runtime. If the worker cannot instantiate wasm under the extension
CSP it falls back to the wrapper's embedded asm.js module (same API and
results, slower Argon2id). Verify on first load that unlock works; if it is
merely slow, that is the asm fallback.

## What the popup does

- Onboarding: create passphrase (labelled inputs, strength meter, mismatch
  validation) → one-time recovery key → done.
- Lock screen: unlock by passphrase or by recovery key.
- **For this site**: logins whose URL matches the active tab, with Fill / View.
- Search vault, all-items list, item detail (show/hide + copy username,
  password, live TOTP with countdown), Add login (prefilled with the active
  tab's origin), password generator, vault health score, lock button,
  Settings link.
- Fill confirmation dialog whenever a fill needs confirmation (bank/card,
  punycode).
- Save / update offer for a login just submitted (rule 11).

## What the options page does

Auto-lock timer, confirm-before-fill toggles, allowed/blocked origins,
change master passphrase (re-wraps the master key; items untouched),
encrypted-only export, wipe vault (type DELETE to confirm), about/crypto note.

## Install (Chrome / Edge / Brave)

```sh
cd apps/extension
npm install
npm run build    # tsc + vite build -> dist/
```

1. Open `chrome://extensions` (or `edge://extensions` / `brave://extensions`).
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select the `apps/extension/dist/` folder.
4. Pin my-secrect to the toolbar. Click it, sign in to your account, create a vault, add a login for a site, then click **Fill** on that site.

`npm run dev` runs `vite build --watch` for iteration; reload the extension
from `chrome://extensions` after each rebuild.

## Files

```
public/manifest.json        Manifest V3, minimal permissions, icons
public/icons/icon*.png      Padlock icons (16/32/48/128)
src/background.ts           Privileged worker: keys, decrypt-one, fill orchestration
src/lib/vault-ext.ts        Extension vault (Argon2id + XChaCha20, chrome.storage)
src/lib/domain.ts           Origin/domain matching + fill gate
src/lib/messages.ts         Popup <-> background protocol
src/lib/account.ts          Account sign-in, session, device proof (background only)
src/lib/account-core.ts     Pure sign-in rules: server URL, Google URL, error mapping
src/popup/SignIn.tsx        Sign-in form (popup + options)
src/lib/settings.ts         Settings load/save (chrome.storage.local)
src/lib/password.ts         Password generator (rejection sampling, as desktop/mobile)
src/popup/                  Popup React UI (Popup.tsx, main.tsx, index.html, popup.css)
src/content/content.ts      On-demand fill, form detection, submit capture (rule 11)
src/options/                Options React UI (Options.tsx, main.tsx, index.html)
e2e/                        Real-Chromium Playwright specs + firefox-probe.mjs
tests/                      Unit tests (npm --workspace apps/extension test)
```

## Tests

```sh
npm --workspace apps/extension test       # unit: domain gate, manifest, TOTP, generator, recovery key
npm --workspace apps/extension run test:e2e
```

`test:e2e` runs in real Chromium: `extension.spec.ts` (onboarding, fill and
refusals, TOTP, lock/unlock, auto-lock), `hardening.spec.ts` (sender and
storage isolation attacks, hostile markup, save/update/decline, worker
restart) and `build-output.spec.ts` (production `dist/`). The e2e copy of the
manifest adds host permissions only because automation cannot click the
toolbar to grant `activeTab` (see `e2e/fixtures.ts`).

## Firefox — not supported (tested on Firefox 151, 18 Nov 2026)

Method: `e2e/firefox-probe.mjs` installs the built extension into real
Firefox over WebDriver BiDi and drives the real popup/options pages.

- **The production build does not install:** "background.service_worker is
  currently disabled. Add background.scripts."
- With `background.scripts` added (test copy only): installs; popup and
  options render; create vault, lock, unlock, wrong recovery key refused,
  save login work; no plaintext in storage. **Fill is refused** (fail
  closed): Firefox has no `storage.local.setAccessLevel`, so content scripts
  could read extension storage, and injection is never done in that case.
- Not tested in Firefox: the popup UI flows, save offer, auto-lock, worker
  (event page) restarts, any automated suite.
- Needed for real support: both `background.service_worker` and
  `background.scripts` in the manifest, a `browser_specific_settings.gecko`
  id, a Firefox answer to storage isolation from content scripts, and a
  Firefox e2e suite.

## Status / honest gaps

- Chromium only (see Firefox above). Verified by the e2e suites listed under Tests.
- No sync with desktop/web yet (separate vault; plan in `SYNC-PLAN.md`).
  Encrypted backup restore on the options page is the supported way in.
- Login capture needs the content script on the tab (popup opened or a
  fill there); there is no always-on capture without host permissions.
- Field detection does not look inside shadow DOM, and a field covered by
  another element still counts as visible.
- No passkey fill yet; passkey items are listed, not filled.
- Not audited, not production-ready.

## Phase F verification (17 Nov 2026, code read only — still never loaded in Chrome)

- Fixed: `background.ts` now checks the content script's fill reply instead of reporting success when the page refused (iframe / origin mismatch / no password field).
- Fixed: `domain.ts` now treats IPv6 literals (`::1`, `2001:db8::1`, …) as raw IPs and refuses to fill on them, and punycode confirmation now triggers on an `xn--` label in any position, not just the first label.
- Fixed: `generatePassword` clamps length to 4–64 (the class-guarantee writes touch indices 0–3); `changePassphrase` rejects an empty new passphrase.
- Known limitation (by design, not fixed): the content script is injected on demand for a fill only, so login-form detection — and the popup's "Login form detected" banner — only runs right after a fill injection, not on ordinary page loads. Adding a persistent content script would need broader host permissions, so this stays as-is until a deliberate decision is made. (18 Nov: the popup now also injects it when opened on a tab, for save offers — still no host permissions.)
