# API — Rails modular monolith (API-only)

Same backend for cloud + self-host. Domains live under `app/domains/`
(accounts, authentication, devices, vaults, key_envelopes, encrypted_records,
sync, blobs, sharing, recovery, billing, audit). Controllers are thin;
Sidekiq jobs (`app/jobs/`) do orphan cleanup, quota, retention — never decrypt.

## What this is — and is not
- This is a complete, coherent Rails API-only app structure (config, models,
  domains, controllers, migrations, request specs), NOT a `rails new` output.
  Some generated files a real `rails new` would add (e.g. `bin/rails`,
  `config/boot` bootsnap wiring, `storage/`) are intentionally minimal here.
- It has NOT been run yet: no `bundle install`, no `rails db:migrate`,
  no RSpec run. Those need Terminal on the Mac (see commands below).
- Passkey cryptographic verification is stubbed in `Authentication::Passkeys`
  (challenge + anti-replay + single-use are real; the `webauthn` gem verify
  call must be wired before production — it raises in production until then).

## Run in Terminal (Mac)
```bash
cd /Users/loihuynh/Personal/LoyGenics/my-secrect/apps/api
cp .env.example .env   # then fill in real secrets
bundle install
bin/rails db:create db:migrate   # or: bundle exec rails db:create db:migrate
bundle exec rspec
bundle exec rails server -p 3000
# Self-host instead: cd ../../infra/docker && docker compose up --build
```

## Rules
- Server stores ciphertext + opaque ids only. No plaintext title/tags/type/relations.
- Item updates are revision-checked. No silent overwrite, no server-side merge, no LWW.
- Device enrolment / key change / recovery endpoints need challenge + anti-replay + re-auth.
- Session tokens are Bearer, 1h, SHA-256 digest stored, revocable.
- Rate limits: passkey verify 10/min/IP, recovery 5/min/IP, API 300/min/IP.
