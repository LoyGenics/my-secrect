# my-secrect — Personal Digital Vault

> Local-first + End-to-End Encryption + Modular Monolith Backend + Pluggable Storage.
> **Không phải chỉ là password manager.** Là nền tảng vault cá nhân: mật khẩu, passkeys, ngân hàng, thẻ, SSH keys, API keys, ghi chú, tài liệu, ảnh, video.

**Trạng thái (17 Nov 2026): code đã viết xong phần lớn, CHƯA BAO GIỜ build/test/chạy trên máy này.** Không có external security audit, chưa production-ready. Xem `docs/implementation-status.md` để biết từng subsystem đang ở trạng thái nào, và `docs/release-readiness.md` để biết còn thiếu gì mới được gọi là release candidate.

Repo công khai: https://github.com/LoyGenics/my-secrect (branch `main`).

## Quyết định kiến trúc (đã chốt)

| Quyết định | Lựa chọn |
|---|---|
| Product model | Personal Digital Vault, không chỉ passwords |
| Kiểu repo | **Monorepo — 1 repo cho mọi app** (xem `docs/monorepo.md` để biết vì sao) |
| Kiểu ứng dụng | Local-first, offline-first |
| Bảo mật | E2EE / Zero-knowledge — server chỉ thấy ciphertext |
| Backend | Ruby on Rails API, modular monolith |
| Database server | PostgreSQL (chỉ metadata + ciphertext) |
| Dữ liệu trên thiết bị | Mục tiêu: Encrypted SQLite (SQLCipher). **Hiện tại: localStorage / AsyncStorage / chrome.storage — chưa mã hóa ở tầng lưu trữ** |
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

**Ba vault local riêng biệt, chưa đồng bộ với nhau:** desktop/web dùng localStorage, mobile dùng AsyncStorage, extension dùng chrome.storage.local. Cả ba dùng chung code crypto nhưng không chung dữ liệu cho tới khi sync được nối vào app (hiện chưa app nào import `SyncClient`).

## Cấu trúc monorepo

```
my-secrect/
  apps/
    api/        # Rails API — modular monolith (auth, sync, blobs, shares, devices)
    desktop/    # React + Vite + Tailwind, Tauri shell — vault chính
    mobile/     # Expo React Native — 10 màn hình, cùng crypto với desktop
    extension/  # Browser extension MV3 — autofill, vault riêng (xem dưới)
    web/        # Web client — CHỈ là bản mirror của desktop App + banner cảnh báo
  packages/
    core/            # Universal Vault Item model (VaultItem, sharing model)
    schemas/         # Item types, schema version, field validation
    sync/            # Offline sync: queue, pull/push client, keep-both conflicts
    crypto-adapters/ # Crypto: libsodium Argon2id + XChaCha20-Poly1305 (chính)
    storage/         # Chunked encrypted upload/download, manifest, resumable
    import-export/   # Export mã hóa v1, import CSV Bitwarden/1Password
    ui/              # My Secret Design System: tokens, Radix components (EN+VI)
    i18n/            # Từ điển EN + VI, type-checked
    sdk/             # VaultApiClient (typed sync/blob) — chưa app nào dùng
  native/
    crypto-core/               # Rust + libsodium (Argon2id/XChaCha20/secretstream)
    ios-credential-provider/   # Swift: domain matching + Keychain thật, fill CHƯA xong
    android-credential-provider/ # Kotlin: domain matching + Keystore thật, fill CHƯA xong
    ssh-agent/                 # Rust: wire protocol thật, KHÔNG giữ key/không ký
  specs/   # encryption-format, key-management, sync-protocol, recovery-protocol, threat-model
  tests/   # crypto-vectors, sync-conflicts, recovery, compatibility, end-to-end, security
  infra/   # docker (Compose: Caddy + api + worker + Postgres + Redis + MinIO), self-host, cloud
  docs/    # architecture, implementation-status, security-review, design-system,
           # product-requirements, release-readiness, deployment, store-prep, privacy, monorepo
  .github/workflows/  # CI + security scan — đã viết, CHƯA BAO GIỜ chạy
```

### App nào dùng package nào (import tương đối, xem `docs/monorepo.md`)

| App | Dùng trực tiếp |
|---|---|
| desktop | `crypto-adapters`, `core`, `import-export` (+ `ui`/`i18n` đã có sẵn nhưng màn hình chưa migrate sang) |
| mobile | `crypto-adapters`, `core` (tokens từ `ui` đã có trong `theme.ts`) |
| extension | `crypto-adapters`, `core` (chỉ background worker giữ key) |
| web | Không có package riêng — import thẳng `../../desktop/src/App`, thừa hưởng toàn bộ dependency của desktop |
| api (Rails) | Không dùng package TypeScript nào |

Chưa app nào import `sync`, `sdk`, `storage` — sync client, SDK và chunked upload đã viết xong nhưng chưa được nối vào app. `ui`/`i18n` cũng vậy: package đã có, màn hình chưa migrate.

## Những gì ĐÃ xong trong code (chưa chạy/test)

- **Vault crypto thật:** libsodium Argon2id + XChaCha20-Poly1305 ở desktop/mobile/extension, cùng key hierarchy; Argon2id đã thống nhất 1 profile TS/Rust + shared test vectors.
- **Passkey/WebAuthn verification đã wire** (`apps/api/app/domains/authentication/passkeys.rb`) + 11 RSpec examples — chưa chạy `rspec` lần nào.
- **Sync pull đã trả ciphertext**, push có vault lock, blob yêu cầu manifest mã hóa + wrapped File Key.
- **Extension MV3 autofill thật:** background giữ key trong RAM, domain-check, content script inject on-demand, không host permission. Vault riêng cho tới khi sync xong.
- **Design system + i18n:** `packages/ui` + `packages/i18n` (EN+VI, light/dark), nhưng màn hình chưa migrate sang.
- **Import/export:** export mã hóa v1, import CSV Bitwarden/1Password, Markdown notes + autosave + revisions, password history, archive, bulk ops.
- **Tauri scaffold** (`apps/desktop/src-tauri/`) và **iOS/Android credential provider** đã có code thật (domain matching, Keychain/Keystore) — nhưng fill/signing CHƯA implement, không được bật.
- **CI workflows** (typecheck, builds, Rust, Rails, gitleaks, CodeQL) — chưa chạy lần nào.

## Những gì CHƯA xong (nói thẳng)

- **Không có external security audit.** Không ai được tuyên bố hệ thống này đã audit.
- **Chưa chạy gì hết:** chưa `npm install`, chưa `bundle install`/`db:migrate`/`rspec`, chưa `cargo test`, chưa `npm test`, chưa `docker compose up`, chưa load extension lên Chrome, chưa chạy Expo — vì không chạy được shell trên Mac từ xa. Lệnh cần chạy ở cuối README.
- **Không có lockfile:** `package-lock.json` và `apps/api/Gemfile.lock` chưa tồn tại → build không tái lập được; CI sẽ đỏ ở job lockfiles cho tới khi commit chúng.
- **Server recovery vẫn là stub** (challenge không được lưu/verify, chưa có verify endpoint).
- **Sharing chưa production-ready:** HPKE key exchange chưa implement; chỉ tạo được proposal PENDING, không share ACTIVE thật.
- **Chưa có SQLCipher / Keychain / Keystore** — dữ liệu local vẫn nằm ở localStorage/AsyncStorage/chrome.storage.
- **Chưa có mobile AutoFill thật, chưa có account deletion** (cả hai đều chặn nộp store).
- **Sync/device signatures chưa bao giờ được tạo hay verify.**
- **Media vẫn manifest-only:** chưa có file bytes, thumbnail, download, player thật.
- **Không có production deployment đã validate** — chỉ có Docker Compose self-host + hướng dẫn cloud, chưa chạy.

## Chạy thử / kiểm chứng (chạy trong Terminal trên Mac)

```bash
cd /Users/loihuynh/Personal/LoyGenics/my-secrect

# 0. Sửa 1 import hỏng trước: apps/mobile/src/App.tsx đang dùng
#    '../../packages/...' (trỏ nhầm sang apps/packages) — phải là
#    '../../../packages/...' như apps/mobile/src/vault.ts đã làm đúng.

npm install                                   # tạo package-lock.json (đang thiếu)
cd apps/api && bundle lock                     # tạo Gemfile.lock (đang thiếu)
cd /Users/loihuynh/Personal/LoyGenics/my-secrect
npm test && node --test tests/security/ tests/crypto-vectors/
node --test packages/schemas/tests/ packages/storage/tests/ packages/sync/tests/

cd apps/desktop && npm install && npm run build
cd ../web && npm install && npm run build
cd ../extension && npm install && npm run build   # rồi Load unpacked trong Chrome
cd ../mobile && npm install && npm run typecheck && npx expo start

cd ../api && cp .env.example .env   # điền secrets thật, set WEBAUTHN_ORIGIN / WEBAUTHN_RP_ID
bundle install && bundle exec rails db:create db:migrate && bundle exec rspec

cd ../../native/crypto-core && cargo test
cd ../ssh-agent && cargo test

cd ../../infra/docker && cp .env.example .env   # điền secrets thật, set domain trong Caddyfile
docker compose up --build -d && docker compose exec api bundle exec rails db:migrate
curl -fsS http://localhost:3000/health

# Tauri (cần icon trước — src-tauri/icons/ chưa tồn tại):
cd ../../apps/desktop && npx @tauri-apps/cli icon path/to/icon-1024.png && npx tauri build
```

Kết quả kỳ vọng khi xanh: RSpec passkeys 11/11; `cargo test` xanh gồm `argon2id_kek_matches_shared_vectors` và `xchacha_seal_matches_shared_vector`; Node vector/security tests 14/14. Nếu test vector Argon2id fail thì **đừng sửa giá trị hex trong vector** — code/params mới là chỗ sai.

## Lưu ý bảo mật quan trọng

- Không tự viết thuật toán mật mã. Dùng libsodium đã kiểm chứng.
- Không lưu CVV / PIN ngân hàng / OTP đang dùng trên server (xem `specs/threat-model.md`).
- Không gửi toàn bộ vault hay khóa giải mã vào content script của extension.
- Media preview tạo plaintext tạm trong RAM — cần cleanup, không đảm bảo tuyệt đối trên thiết bị đã bị xâm nhập.
- Thu hồi session từ xa không xóa được secret offline người khác đã tải về — đừng trình bày ngược lại trong UI.

## Tài liệu

- `docs/architecture.md` — kiến trúc như đã xây (audit Phase A)
- `docs/implementation-status.md` — ledger trạng thái từng subsystem + ranked blockers
- `docs/security-review.md` — review bảo mật, các lỗi đã sửa / còn lại
- `docs/monorepo.md` — vì sao giữ monorepo, quy ước thư mục, quy tắc import
- `docs/design-system.md`, `docs/product-requirements.md`, `docs/deployment.md`, `docs/store-prep.md`, `docs/privacy.md`
- `specs/` — đặc tả mật mã / sync / recovery / threat model (đọc trước khi viết code xử lý dữ liệu thật)

## Tên dự án

Thư mục hiện tại là `my-secrect` theo đúng tên bạn đưa. Đã có sẵn `my_secret/` (web Next.js + mobile) từ trước trong `LoyGenics/` — dự án này là monorepo mới, không ghi đè lên đó. Nếu bạn muốn đổi thành `my-secret`, nói mình đổi tên thư mục.
