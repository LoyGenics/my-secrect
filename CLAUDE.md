# CLAUDE.md — my-secrect

Personal Digital Vault: local-first, end-to-end encrypted. Monorepo: npm
workspaces (`apps/*`, `packages/*`) + Rails API + Rust/Swift/Kotlin native.
The server only ever sees ciphertext and opaque ids.

Reply in the user's language (usually Vietnamese). Code, comments and commit
messages in English (Conventional Commits, as in `git log`).

## How to work (Karpathy guidelines)

1. **Think first.** State assumptions. If a request has two readings, ask —
   never guess in crypto, sync, auth or recovery code.
2. **Simplest thing.** Minimum code for the ask. No speculative abstractions,
   options or error handling for impossible cases.
3. **Surgical.** Every changed line traces to the request. Match local style.
   Don't tidy adjacent code — mention it. Remove only orphans you created.
4. **Verify.** Turn the task into a check (failing test → passing), run the
   narrowest test that proves it, report exactly what ran and what didn't.
5. **Answer what was asked.** First sentence is the answer (location, name,
   verdict); cite `file:line` and stop. No tours, tables or headers unless asked —
   offer more in one line. Answer length matches question length.

## Git

- Never `git push`, and never offer to. The user pushes.
- Local branches, worktrees, commits and merges are allowed for the
  multi-agent workflow: each agent commits on its own local branch; the
  orchestrator merges verified branches into local `main`.
- Never rewrite or discard history or work: no `reset --hard`, `rebase`,
  `clean`, `stash drop`, or force-deleting a branch.
- No `gh` commands that write to GitHub (PRs, comments, reviews, issues).

## Local environment

- Run local dev work without asking: `rails console/runner`, migrations, seeds,
  tests, builds, dev servers, editing local DB records.
- Ask before wiping a whole local DB (`db:drop`, `db:reset`, bulk deletes). The
  e2e harness recreating its own `*_e2eauth` DB is fine.
- Before any DB command, confirm `POSTGRES_HOST` / `DATABASE_URL` point at
  localhost. Never touch hosted DBs, remote servers or deploys — give the user
  the command instead.
- Never call third-party services with real credentials; never print or copy
  values from `.env` or credentials files.

## Search and processes

- Search the narrowest directory (`rg <pattern> <path>`, `git ls-files`); no
  `--no-ignore` / `--follow` without a reason.
- At most two searches (shell or subagent) at once; don't retry a slow one —
  find out why it is slow.
- Never `pkill` / `killall` by name; stop only a PID you confirmed this session started.

## Token budget

- Never read: `package-lock.json`, `node_modules/`, `**/target/`, `.ruby-lsp/`,
  `apps/api/{log,tmp}/`, Playwright `test-results/`. Dep version → `npm ls <pkg>`.
- Grep for the symbol, then Read with offset/limit. Never read these whole
  (25–55 KB): `apps/desktop/src/App.tsx`, `apps/desktop/src/components/{SecurityCenter,ItemForm}.tsx`,
  `apps/desktop/src/vault.ts`, `apps/mobile/src/screens/SecurityScreen.tsx`,
  `apps/extension/src/popup/Popup.tsx`, `packages/sdk/src/security.ts`,
  `packages/import-export/src/index.ts`, `apps/api/spec/requests/api/v1/security_spec.rb`,
  `docs/security-review.md`.
- Don't open docs/specs "for context" — open only the one the task needs (below).
- Run the single test file / spec you touched, not the whole suite, unless the
  change is in shared code (`packages/*`, crypto, sync).
- Wide sweeps across many files → Explore subagent; keep file dumps out of main context.

## Map

| Path | What |
|---|---|
| `apps/api` | Rails API-only. Logic in `app/domains/<domain>/`, thin controllers in `app/controllers/api/`, specs in `spec/{domains,requests}` |
| `apps/desktop` | React + Vite + Tailwind; the main vault UI. Tauri shell in `src-tauri/` |
| `apps/web` | Mirror only: `src/App.tsx` renders `../../desktop/src/App` with `allowPlaintextExport={false}`. No screens of its own |
| `apps/mobile` | Expo React Native, same crypto, AsyncStorage |
| `apps/extension` | MV3. Background worker is the only key holder |
| `packages/*` | `core` (VaultItem), `schemas` (types, `FORBIDDEN_FIELDS`), `crypto-adapters` (libsodium), `sync`, `storage`, `import-export`, `sdk` (API client), `ui` (tokens `--ms-*`), `i18n` (en/vi) |
| `native/*` | `crypto-core` (Rust), `ssh-agent` (Rust), iOS/Android credential providers |
| `tests/*` | Node `.mjs` **mirror** tests (rules only) + `e2e-web` (Playwright, real stack) |

| Task touches | Read |
|---|---|
| Crypto, keys, envelopes | `specs/encryption-format.md`, `specs/key-management.md` |
| Sync / conflicts | `specs/sync-protocol.md` |
| Recovery | `specs/recovery-protocol.md` |
| What the server may store | `specs/threat-model.md` |
| Where new code goes, import paths | `docs/monorepo.md` §3–4 |
| UI tokens / components | `docs/design-system.md` |
| Docker / deploy | `docs/deployment.md`, `infra/docker/` |

**Stale docs warning:** `README.md`, `docs/monorepo.md` and
`docs/implementation-status.md` say "nothing has ever been built or run" and
list fixes that have since landed. Trust code + `git log` over status claims there.

## Commands

```bash
npx tsx --test <file>                        # one real-module TS test
node --test tests/<area>/                    # one mirror suite
cd apps/api && bundle exec rspec <spec_file> # one Rails spec (Ruby 3.3, Postgres)
npm run test:crypto-core                     # cargo test in native/crypto-core
npx tsc --noEmit -p apps/<app>/tsconfig.json # typecheck desktop/web/extension
npm --workspace apps/mobile run typecheck
npm --workspace apps/<app> run build
npm run test:e2e:web                         # real Rails + Postgres + Vite; drops/recreates DB *_e2eauth
npm --workspace apps/extension run test:e2e
npm test                                     # all mirrors + test:real (shared-code changes)
```

No ESLint/Prettier config — typecheck and tests are the static checks.

## Hard rules

- **Crypto:** libsodium only (Argon2id + XChaCha20-Poly1305); never hand-roll.
  One Argon2id profile shared by TS and Rust. Crypto change → update
  `tests/crypto-vectors/` in the same change. A failing vector means the code
  is wrong — never edit the expected hex.
- **Zero-knowledge:** never send plaintext or keys to the API. Never store
  CVV, bank PIN or live OTP (`FORBIDDEN_FIELDS`).
- **Extension:** popup/options/content scripts talk to the background via
  messages; they never import `vault-ext.ts` or receive the whole vault.
- **Imports:** apps import packages by relative path — count `../` from the
  file, copy the prefix from a working neighbour. No bare `@my-secrect/*`
  unless declared in that app's `package.json`. Packages never import apps.
- **Rails, conventional over clever:** Active Record query interface (`where`,
  `where.not`, `find_by`, `order(col: :desc)`, `pluck`, `pick`, `exists?`) — no
  SQL strings or `Arel.sql`, filter in the DB not with Ruby `select`.
  ActiveSupport helpers over hand-rolled ones (`presence`, `squish`, `index_with`).
  Guard clauses and named `?` predicates; no nested ternaries or `unless`/`else`.
  Controllers: find, authorize, one domain call. Specs assert literal results and
  never re-run the implementation.
- **Strings** go in `packages/i18n` (`en.ts` + `vi.ts` together).
- **Specs:** a protocol change updates `specs/*` in the same commit.
- **Unfinished features fail closed** and say NOT implemented — no buttons that pretend.
- **Report honestly:** `tests/<area>/*.mjs` mirror the rules and don't import
  production code; only `test:real`, rspec, cargo and Playwright exercise real
  code. Say which kind ran.
- **No secrets** in any file (gitleaks runs in CI); `.env.example` holds placeholders only.
