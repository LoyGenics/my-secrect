# My Secret

My Secret is a local-first encrypted vault for credentials, secure notes and
files. The mobile app opens a local vault by default. Sign in to the hosted
My Secret service from Settings to use account security, sharing and Family.

## What’s available

| Area | Current behavior |
| --- | --- |
| Mobile vault | Search from the app header or Vault, filter by category, create and edit items, generate passwords, review weak and reused passwords, and restore items from Trash. Mobile uses SQLCipher and supports device unlock where available. |
| Mobile Files | Import documents, photos and videos, create nested folders, rename or move entries, and open files. Imports are encrypted on the device. The current mobile limit is 128 MiB per file. |
| Share links | Open a credential and choose **Share**. Pick an expiry of 1 hour, 1 day or 7 days. The recipient opens a read-only copy in a browser without an account. Delete a link from the item’s sharing screen to stop future access. |
| Account sharing | Share individual items with another My Secret account through **Sharing**. This separate flow supports verified recipient keys, read or edit access, and revocation. |
| Family | Up to six people. Each member keeps a private vault. Share individual items when needed. |
| Backup and recovery | Export encrypted item backups. Mobile can restore a backup during setup. A saved recovery key can unlock the vault if the passphrase is forgotten. |
| Desktop and web | Vault management, optional account setup, encrypted backups and server-backed media transfers. The web client excludes plaintext export. |
| Item import | On desktop and web, import login CSVs locally from the My Secret template, 1Password, Bitwarden or Google Password Manager. Signed-in users can also consent to send pasted text to OpenAI and review the resulting drafts before saving. |
| Browser extension and Autofill | Chromium extension and native iOS/Android credential provider code. Native providers require a build with their respective platform integration. |

Mobile file contents stay on the importing device. Item backups include file
records but do not package their bytes. Save a separate copy of important
files. Account sign-in does not unlock a local vault or transfer its keys.

A share link grants access to anyone who has the complete URL, including its
fragment. Expiry and deletion stop future retrieval. They cannot recall a
credential someone has already copied.

## Run locally

Install Node.js 20 or newer and run `npm ci` from the repository root.

| Client | Command |
| --- | --- |
| Mobile dev server | `npm run start -w apps/mobile` |
| iOS native build | `npm run ios -w apps/mobile` |
| Android native build | `npm run android -w apps/mobile` |
| Desktop UI | `npm run dev:desktop` |
| Web vault and link viewer | `npm run dev -w apps/web` |
| Marketing site | `npm run dev -w apps/landing` |

Use a native development build for the mobile app. Its storage, crypto and
credential provider modules need a native binary. Rebuild after changing native
dependencies.

## Connect a server

The Rails API uses Ruby 3.3 and PostgreSQL. See [the self-hosting guide](infra/docker/README.md)
for local and hosted setup, including the object store for server-backed media.
Run the application’s database migrations before starting the API.

To enable text import, set `OPENAI_API_KEY` on the Rails API server. The optional
`OPENAI_IMPORT_MODEL` must support Structured Outputs and defaults to `gpt-4o-mini`.
The API needs HTTPS access to `api.openai.com`. Leave project data sharing
disabled in OpenAI. The endpoint uses `store: false` and filters pasted content
from request logs. CSV import works without this setup.
Packaged Tauri builds also need the configured API origin in their
`connect-src` policy and the app origin allowed by Rails CORS.

In a mobile development build, open **Settings → Development server** and
enter the API base URL ending in `/api`. Release builds use the My Secret
service at `https://my.msecret.app/api`. The web link viewer defaults to the
same origin. When running Vite and
Rails on separate local ports, set `VITE_API_PROXY_TARGET` when starting Vite,
then enter the Vite origin as **Web app URL** on mobile. Recipients need a web
origin they can reach.

The API stores encrypted payloads and the metadata needed to operate the
service. Vault keys remain on the client. The share link decryption key is in
the URL fragment and does not travel in the API request. See the
[threat model](specs/threat-model.md), [account sharing protocol](specs/sharing-protocol.md)
and [share link format](specs/share-links.md). The project has not been
independently audited. The marketing site can describe plans and pricing, but
billing and entitlements are not enabled by those pages.

## Repository map

- `apps/mobile` contains the Expo React Native app and platform integrations.
- `apps/desktop` contains the React vault UI and Tauri shell.
- `apps/web` hosts the vault UI and public share link viewer.
- `apps/extension` contains the Chromium extension.
- `apps/landing` contains the bilingual marketing site.
- `apps/api` contains the Rails API and request specs.
- `packages` contains shared types, crypto adapters, sync, storage, UI and translations.
- `native` contains the Rust crypto crate and platform credential providers.

## Checks

```shell
npm test
npm run typecheck -w apps/mobile
npm run build -w apps/web
npm run test:crypto-core
```

For Rails tests, configure a local test database and run `bundle exec rspec` from
`apps/api`. The sharing and media integration suites are
`npm run test:sharing-e2e` and `npm run test:media-e2e`. They use dedicated
local test environments.
