# my-secrect — Web

Web mirror of the desktop vault app (`apps/desktop`). It is **not** a
separate app: `src/App.tsx` imports the desktop `App` directly
(`../../desktop/src/App`) and renders it under a persistent attack-surface
warning banner. Tailwind, the dark theme, and the Vite setup mirror the
desktop app so shared code stays shared — a fix in the desktop UI shows up
here too.

## Run

```sh
cd apps/web
npm install
npm run dev    # http://localhost:5174
```

`npm run build` type-checks (`tsc`) and bundles with Vite; `npm run preview`
serves the production build locally.

## Screens — inherited from the desktop app

Every screen comes from the shared desktop `App`, so this list is the same
as desktop: onboarding (create passphrase + one-time recovery key), lock
screen (passphrase or recovery key), main vault with sidebar (All /
Favorites / Trash / Security Health + 8 categories + Tags), instant local
search + Cmd/Ctrl+K palette, item list, item detail, create/edit forms for
all 8 modules (Credentials with live TOTP, Finance, Identity, Developer,
Secure Notes, Private Media, Documents, Collections), password generator,
health view, auto-lock, encrypted export/import.

The Settings screen is rendered by the desktop `App` when its `settings`
view is implemented there — the web client inherits it automatically and
adds nothing of its own. If Settings is missing on desktop, it is missing
here too; that is a desktop gap, not a web-only one.

## Web-only polish (`src/App.tsx`, `src/index.css`)

- Sticky amber **attack-surface banner** on every page (always visible,
  not dismissible) with an expandable "Why is the web client limited?"
  explanation and the line: "Web is limited — use Desktop for sensitive data."
- Footer note on every page repeating the same guidance.
- **Responsive layout** (`.web-shell` rules in `index.css`): below 900px the
  wide desktop flex-row shell (sidebar | list | detail) stacks vertically
  so every screen stays reachable in a narrow browser window. Desktop
  styling is untouched — the rules are scoped under `.web-shell`.
- `index.html` has a description + `theme-color` meta.

## Attack-surface warning

The web client is a **separate attack surface** from the desktop app. The
code served to the browser could be compromised (server breach, malicious
dependency, network tampering), and a compromised page can read secrets
after unlock. The banner at the top of every web page says so, and it is
always visible.

**Prefer the desktop app for full use.**

## Limited features (web only)

- No browser autofill — the web client never fills credentials into other
  sites or forms. (Autofill lives in `apps/extension`, not here.)
- File/media upload is enabled and shares the desktop code (`MediaView`): files are split into 1 MiB chunks and encrypted in the tab (XChaCha20-Poly1305 v1, per-file File Key wrapped by the Vault Key) before only ciphertext is PUT to presigned storage URLs. It needs an account server (API base URL + sign-in) and a storage endpoint whose CORS allows this origin (the compose stack sets `MINIO_API_CORS_ALLOW_ORIGIN` from `CORS_ORIGINS`). Limits: whole file in browser memory (256 MiB max); plaintext exists in tab memory while encrypting/decrypting/previewing; downloads go through the browser download manager; no cross-reload upload resume. A compromised web origin could read these files after unlock — the reason the banner stays.
- Export is encrypted-only — vault data leaves the browser only in
  encrypted form; there is no plaintext export.

## Status

Phase 1 prototype. **NOT audited and NOT production-ready.** Do not store
real secrets in it yet. Crypto uses `libsodium-wrappers-sumo`; see the
project README and `specs/` for the threat model and what is still missing.
Nothing here has been built or run on the Mac yet (no shell access) — run
`npm run build` in Terminal as the first verification step.
