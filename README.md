# my-secrect — Personal Digital Vault

> Local-first + End-to-End Encryption + Modular Monolith Backend + Pluggable Storage.
> **Không phải chỉ là password manager.** Là nền tảng vault cá nhân: mật khẩu, passkeys, ngân hàng, thẻ, SSH keys, API keys, ghi chú, tài liệu, ảnh, video.

**Trạng thái: Architecture v1.0 — Phase 1 ✅ done, Phase 2 scaffold-complete (chưa chạy).**
Chưa phải đặc tả mật mã đã audit hay production-ready. Xem `specs/` trước khi viết code xử lý dữ liệu thật.

## Những gì CHƯA xong (nói thẳng)
- **Không có external security audit.** Không ai được tuyên bố hệ thống này đã audit.
- **Passkey crypto verification chưa wire xong** (`Authentication::Passkeys` — challenge + anti-replay có thật, nhưng lệnh verify của gem `webauthn` phải hoàn thiện trước production; code hiện tại raise ở production).
- **Chưa chạy gì hết:** chưa `bundle install`, chưa `rails db:migrate`, chưa `cargo test`, chưa `npm test`, chưa `docker compose up` — vì không chạy được shell trên Mac từ xa. Các lệnh cần chạy trong Terminal ở cuối README.
- **Không có native iOS/Android credential provider thật** — chỉ có README trong `native/ios-credential-provider/` và `native/android-credential-provider/`.
- **Không có browser extension autofill** — chỉ có README + quy tắc tách privilege trong `apps/extension/`.
- **Không có production deployment** — chỉ có Docker Compose self-host + hướng dẫn cloud.
- **Crypto TypeScript vẫn là reference (WebCrypto AES-GCM/PBKDF2)**, chưa thay bằng bindings tới `native/crypto-core` (Rust + libsodium). Chưa dùng dữ liệu thật.

## Quyết định kiến trúc (đã chốt)

| Quyết định | Lựa chọn |
|---|---|
| Product model | Personal Digital Vault, không chỉ passwords |
| Kiểu ứng dụng | Local-first, offline-first |
| Bảo mật | E2EE / Zero-knowledge — server chỉ thấy ciphertext |
| Backend | Ruby on Rails API, modular monolith |
| Database server | PostgreSQL (chỉ metadata + ciphertext) |
| Dữ liệu trên thiết bị | Encrypted SQLite (SQLCipher) |
| Object storage | S3 / R2 / MinIO qua StorageProvider interface |
| Client | React / React Native, Desktop React + Tauri ưu tiên |
| Triển khai | Cloud hoặc self-host, cùng một backend |
| Search | Local, không gửi plaintext query lên server |
| Export | Bắt buộc từ MVP, định dạng được tài liệu hóa |
| AI | Không thuộc lõi |

## Ranh giới tin cậy

Server đồng bộ và lưu ciphertext, nhưng **không giữ khóa giải mã** nội dung người dùng.
Đăng nhập tài khoản (WebAuthn/passkey) **khác** mở khóa vault (Master Passphrase).
Mất toàn bộ khóa + recovery key + thiết bị tin cậy = mất dữ liệu. Không có cửa hậu.

## Cấu trúc monorepo

```
apps/
  api/        # Rails API — modular monolith
  desktop/    # React + Tauri — vault chính
  mobile/     # React Native
  extension/  # Browser extension MV3
  web/        # Web client (hạn chế tính năng nhạy cảm)
packages/
  core/            # Universal Vault Item model
  schemas/         # Item types, schema versions
  sync/            # Offline sync protocol, conflicts
  crypto-adapters/ # Crypto interface (libsodium)
  storage/         # StorageProvider: S3/R2/MinIO/Local
  import-export/   # Portable export v1
  ui/ sdk/
native/
  crypto-core/     # Thư viện crypto nhỏ, ranh giới ổn định
  ios-credential-provider/ android-credential-provider/ ssh-agent/
specs/  # encryption-format, key-management, sync-protocol, recovery-protocol, threat-model
tests/  # crypto-vectors, sync-conflicts, recovery, compatibility, end-to-end
infra/  # docker, self-host, cloud
```

## Roadmap

1. **Foundation ✅ DONE** — threat model, item schema, key hierarchy, desktop prototype local-only, import/export, crypto tests.
2. **Sync Platform — SCAFFOLD-COMPLETE, cần chạy trong Terminal** — Rails API đầy đủ (models/domains/controllers/jobs/specs), Postgres schema, encrypted sync, revision history, device enrollment, backup/restore docs, Docker Compose (Caddy + API + worker + Postgres + Redis + MinIO). Chưa chạy: `bundle install` → `db:migrate` → `rspec` → `docker compose up`.
3. **Daily-use Password Manager** — extension, generator, autofill, TOTP.
4. **Universal Personal Vault** — bank, cards, identity, SSH, notes, relations, encrypted search.
5. **Private Media & Sharing — IMPLEMENTED IN CODE (chưa chạy/audit)** — sync client (`packages/sync/src/sync-client.ts`, push queue offline + pull + checkpoint + conflict giữ cả hai bản), chunked encrypted upload/download (`packages/storage/src/upload.ts`, manifest mã hóa, resumable, video range), media view (`apps/desktop/src/components/MediaView.tsx` + `utils/media.ts`), sharing model + view (`packages/core/src/sharing.ts`, `apps/desktop/src/components/SharesView.tsx`). Chưa chạy: chưa test sync với server thật, chưa upload blob thật, HPKE key-exchange cho sharing chưa triển khai nên sharing chưa production-ready.
6. **Hardening & Public Release** — fuzz, pen test, external review, release signing.

## Chạy thử (Phase 1, local-only)

```bash
# Desktop prototype — local vault, chưa cần server
cd apps/desktop
npm install
npm run dev

# Crypto + sync tests (Node 20+, không cần server)
npm test
# Rails API specs (cần bundle install trước)
cd apps/api && bundle install && bundle exec rails db:create db:migrate && bundle exec rspec
# Rust crypto-core (cần Rust toolchain + libsodium)
cd ../../native/crypto-core && cargo test

# Self-host (Phase 2)
cd ../../infra/docker
cp .env.example .env   # điền secrets thật, sửa Caddyfile thành domain của bạn
docker compose up --build -d
docker compose exec api bundle exec rails db:migrate
curl -fsS http://localhost:3000/health
# API: http://localhost:3000/health — Postgres, Redis/Sidekiq, MinIO, Caddy
```

## Lưu ý bảo mật quan trọng

- Không tự viết thuật toán mật mã. Dùng libsodium đã kiểm chứng.
- Không lưu CVV / PIN ngân hàng / OTP đang dùng trên server (xem `specs/threat-model.md`).
- Không gửi toàn bộ vault hay khóa giải mã vào content script của extension.
- Media preview tạo plaintext tạm trong RAM — cần cleanup, không đảm bảo tuyệt đối trên thiết bị đã bị xâm nhập.

## Tên dự án

Thư mục hiện tại là `my-secrect` theo đúng tên bạn đưa. Đã có sẵn `my_secret/` (web Next.js + mobile) từ trước trong `LoyGenics/` — dự án này là monorepo mới, không ghi đè lên đó. Nếu bạn muốn đổi thành `my-secret`, nói mình đổi tên thư mục.
# my-secrect
