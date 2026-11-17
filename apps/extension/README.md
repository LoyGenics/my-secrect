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

## Permissions — minimal by design

`storage`, `activeTab`, `scripting`, `alarms`. **No broad host permissions**
(`host_permissions` is empty, and there is no persistent `content_scripts`
entry in the manifest). The content script is injected on demand with
`chrome.scripting.executeScript` into the active tab only, for one fill.

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
That is correct behaviour — unlock again.

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
4. Pin my-secrect to the toolbar. Click it, create a vault, add a login for a site, then click **Fill** on that site.

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
src/lib/settings.ts         Settings load/save (chrome.storage.local)
src/popup/                  Popup React UI (Popup.tsx, main.tsx, index.html, popup.css)
src/content/content.ts      On-demand fill + form detection (values never leave the page)
src/options/                Options React UI (Options.tsx, main.tsx, index.html)
```

## Status / honest gaps

- **Not tested in a real browser yet.** Nothing here has been loaded in
  Chrome: `npm run build` has not run on the Mac (no shell access), the
  extension has not been loaded unpacked, and no fill has been exercised
  end-to-end. The first load in Chrome is the real verification step.
- No sync with desktop/web yet (separate vault, see above).
- No login capture of typed credentials (deliberate — see rule 9).
- No passkey fill yet; passkey items are listed, not filled.
- Not audited, not production-ready.

## Phase F verification (17 Nov 2026, code read only — still never loaded in Chrome)

- Fixed: `background.ts` now checks the content script's fill reply instead of reporting success when the page refused (iframe / origin mismatch / no password field).
- Fixed: `domain.ts` now treats IPv6 literals (`::1`, `2001:db8::1`, …) as raw IPs and refuses to fill on them, and punycode confirmation now triggers on an `xn--` label in any position, not just the first label.
- Fixed: `generatePassword` clamps length to 4–64 (the class-guarantee writes touch indices 0–3); `changePassphrase` rejects an empty new passphrase.
- Known limitation (by design, not fixed): the content script is injected on demand for a fill only, so login-form detection — and the popup's "Login form detected" banner — only runs right after a fill injection, not on ordinary page loads. Adding a persistent content script would need broader host permissions, so this stays as-is until a deliberate decision is made.
