# Key Management — v1 (DRAFT)

Định dạng byte, version và phân tích thay thế/rollback: `specs/encryption-format.md`.

## Tầng khóa
```
Master Passphrase (người dùng nhớ)
  -- Argon2id KDF --> Key Encryption Key (KEK)
  -- KEK wraps --> Account Master Key (ngẫu nhiên 256-bit)
  -- Account Master Key wraps --> Vault Key (mỗi vault / security domain)
  -- Vault Key wraps --> Item Key (mỗi lần ghi item) / File Key (mỗi file)
Recovery Key (32 byte ngẫu nhiên) -- SHA-256 --> recovery KEK -- wraps --> Account Master Key
Device-protected Key (Keychain/Keystore/Secure Enclave) wraps bản sao AMK để mở bằng sinh trắc học.
```
Mỗi tầng wrap bằng AEAD (XChaCha20-Poly1305 IETF, nonce 24B ngẫu nhiên; riêng
device key dùng AES-GCM / ECIES của nền tảng — `specs/mobile-local-store.md` §4).
DEK tách khỏi KEK (OWASP envelope encryption). Mọi key trong chuỗi là 32 byte;
unwrap ra độ dài khác bị từ chối ở TS (`libsodiumAdapter.unwrapKey`) và Rust (`unwrap_key`).

Hiện thực: `apps/desktop/src/vault.ts`, `apps/mobile/src/vault.ts`,
`apps/extension/src/lib/vault-ext.ts` (ba bản gần như giống nhau) qua
`packages/crypto-adapters`; Rust `native/crypto-core` có đủ primitive cho cùng
chuỗi (`derive_kek`, `wrap_key`/`unwrap_key`, `recovery_kek`, `encrypt_item`/`decrypt_item`)
nhưng chưa có caller production. Tương thích hai chiều được test bằng fixture chung
(`specs/encryption-format.md` § Test vector).

## Argon2id — MỘT profile duy nhất cho toàn bộ vault (v1, đã chốt Phase B)
- Thuật toán: Argon2id v1.3 (`crypto_pwhash`, `ALG_ARGON2ID13`), libsodium
  INTERACTIVE: **opslimit = 2** (`OPSLIMIT_INTERACTIVE`), **memlimit =
  67108864 bytes (64 MiB)** (`MEMLIMIT_INTERACTIVE`), lanes 1, salt **16 bytes**
  ngẫu nhiên, output **32 bytes**.
- Áp dụng ở MỌI nơi derive KEK: TypeScript
  (`packages/crypto-adapters/src/index.ts`, `ARGON2ID_PARAMS`) và Rust
  (`native/crypto-core/src/lib.rs`, `KDF_OPSLIMIT` / `KDF_MEMLIMIT` / `KDF_SALT_BYTES`,
  module `sodiumoxide::crypto::pwhash::argon2id13`).
  Lịch sử: trước Phase B, Rust dùng SENSITIVE (H3). Sau đó Rust vẫn gọi
  `sodiumoxide::crypto::pwhash`, module này re-export **scrypt**
  (scryptsalsa208sha256, salt 32 byte) chứ không phải Argon2id — sửa ở commit
  4adb39d. Crate giờ có `const` assert lúc compile cho variant, opslimit,
  memlimit và độ dài salt, nên lỗi kiểu này không compile được nữa.
  Không bao giờ dùng hai profile song song: vault tạo ở một phía phải
  mở được ở phía còn lại.
- Test vector dùng chung (không được bịa số), `tests/crypto-vectors/`:
  - `argon2id-vectors.json`: 2 KEK Argon2id + 1 XChaCha20-Poly1305, tính bằng
    libsodium (PyNaCl). Kiểm ở Rust `native/crypto-core/tests/vectors.rs`, TS mirror
    `tests/crypto-vectors/argon2id-vectors.test.mjs`, adapter thật
    `packages/crypto-adapters/tests/libsodium-adapter.import.test.mjs`, và lại
    bằng một implementation độc lập (OpenSSL Argon2id qua `node:crypto`) trong
    `packages/crypto-adapters/tests/cross-impl.test.ts`.
  - `chain-ts.json` / `chain-rust.json`: chuỗi đầy đủ KEK → AMK → Vault Key →
    Item Key → item + recovery, một phía ghi, phía kia mở (passphrase có
    tiếng Việt NFC, NFD và emoji).
- Đổi tham số = đổi format version + migration + regenerate vector.
  Không hạ tham số âm thầm.

## Unicode trong passphrase (giới hạn đã biết của v1)
- Input của Argon2id là **byte UTF-8 nguyên trạng** của passphrase
  (`TextEncoder` ở TS; Rust nhận `&[u8]`). Không bên nào normalize NFC/NFD.
- Hệ quả: cùng một passphrase nhìn giống hệt nhau nhưng gõ ở dạng khác
  (vd. "ậ" dựng sẵn U+1EAD so với "a" + U+0323 + U+0302 tổ hợp) là **passphrase khác**
  → vault không mở. Bộ gõ tiếng Việt có thể sinh dạng tổ hợp (vd. Unikey chế độ
  "Unicode tổ hợp") trong khi bàn phím iOS/Android/macOS thường sinh dạng dựng sẵn.
  Test `cross-impl.test.ts` khẳng định NFC ≠ NFD cho cùng chữ; fixture desktop dùng NFD
  để phát hiện nếu một phía âm thầm normalize mà phía kia không.
- Sửa = KDF profile mới (vd. NFC trước Argon2id) với version mới và migration:
  unlock thử byte nguyên trạng, nếu thành công thì re-wrap AMK bằng KEK từ dạng NFC.
  Chưa làm; trước mắt UI nên cảnh báo khi passphrase chứa ký tự tổ hợp.

## Recovery key
- 32 byte từ `randombytes_buf`, hiển thị một lần dưới dạng base64url không
  padding (43 ký tự). Không lưu dạng rõ ở đâu.
- recovery KEK = SHA-256(32 byte) (`sha256()` TS / `recovery_kek()` Rust). Hash
  nhanh là đủ vì input là 256 bit ngẫu nhiên, không có gì để brute-force.
- Nhập lại: `trim()`, decode base64url, bắt buộc đúng 32 byte (desktop, mobile;
  extension `unlockWithRecoveryKey` bỏ qua kiểm tra độ dài — vô hại vì sai độ dài
  thì unwrap thất bại, nhưng lệch với hai app kia).
- Desktop SecurityCenter còn dùng **chính 32 byte này làm seed Ed25519**
  (`crypto_sign_seed_keypair`) cho "recovery verifier" gửi public key lên server.
  Hai mục đích dùng hai hàm băm khác nhau (SHA-256 cho KEK, SHA-512 bên trong
  Ed25519) nên chưa thấy tấn công, nhưng đây là dùng một khóa cho hai mục đích;
  phiên bản sau nên tách bằng HKDF với `info` riêng ("my-secrect/recovery-kek/v2",
  "my-secrect/recovery-verifier/v2").

## Đăng nhập ≠ Mở khóa vault
- **Account auth:** WebAuthn/passkey với Rails API, quản lý session + thiết bị.
- **Vault unlock:** Master Passphrase giải mã Account Master Key trên client.
- **Quick unlock:** Face ID / Touch ID / Android biometrics, dùng khóa được thiết bị bảo vệ.
- **New device:** master passphrase sau khi auth, hoặc chuyển khóa an toàn từ thiết bị tin cậy.
- Passkey đăng nhập KHÔNG tự thay khóa giải mã vault. Rails không được khôi phục khóa chỉ vì login thành công.

## Recovery
1. Login lại + unlock bằng master passphrase.
2. Chuyển khóa từ thiết bị tin cậy.
3. Recovery key entropy cao, lưu offline + quy trình khôi phục tài khoản.
- Đổi passphrase thường: re-wrap Account Master Key bằng KEK mới (salt mới);
  đã implement ở cả 3 app (`changePassphrase`). Recovery key không đổi.
- Nghi lộ khóa gốc / Vault Key: key rotation + **mã hóa lại payload** bằng Item Key mới
  (chưa implement; xem `specs/encryption-format.md` § Key rotation).
- **Mất hết khóa + recovery key + thiết bị tin cậy: server không có cửa hậu.** Đó là giá của zero-knowledge thật.

## Một khóa, một mục đích
v1 dùng Vault Key cho nhiều việc (wrap Item Key, wrap File Key, mã hóa manifest,
tên thiết bị, khóa riêng của thiết bị) với AD = null, nên mọi ciphertext dưới
Vault Key thay thế được cho nhau ở tầng AEAD. Item encryption v2 (nhãn AD riêng
cho payload và wrapped Item Key) là bước đầu; các mục đích còn lại cần nhãn
riêng sau đó. Chi tiết và kế hoạch: `specs/encryption-format.md`.

## Vault riêng cho dữ liệu cực nhạy
Một master password mở tất cả là single point of compromise. Dữ liệu đặc biệt nhạy cảm nên ở vault riêng với secret bổ sung độc lập, hoặc ít nhất yêu cầu xác thực lại + giới hạn thời gian unlock. Chỉ yêu cầu Face ID lại trong cùng một key hierarchy chưa tạo ra cô lập mật mã thật.
