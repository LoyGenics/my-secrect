# Key Management — v1 (DRAFT)

## Tầng khóa
```
Master Passphrase (người dùng nhớ)
  -- Argon2id KDF --> Key Encryption Key (KEK)
  -- KEK wraps --> Account Master Key (ngẫu nhiên 256-bit)
  -- Account Master Key wraps --> Vault Key (mỗi vault / security domain)
  -- Vault Key wraps --> Item Key (mỗi item) / File Key (mỗi file)
Device-protected Key (Keychain/Keystore) wraps bản sao khóa để mở bằng sinh trắc học.
```
Mỗi tầng wrap bằng AEAD. DEK tách khỏi KEK (OWASP envelope encryption).

## Argon2id — MỘT profile duy nhất cho toàn bộ vault (v1, đã chốt Phase B)
- Thuật toán: Argon2id (`crypto_pwhash`, `ALG_ARGON2ID13`), libsodium
  INTERACTIVE: **opslimit = 2** (`OPSLIMIT_INTERACTIVE`), **memlimit =
  67108864 bytes (64 MiB)** (`MEMLIMIT_INTERACTIVE`), salt **16 bytes**
  ngẫu nhiên, output **32 bytes**.
- Áp dụng ở MỌI nơi derive KEK: TypeScript
  (`packages/crypto-adapters/src/index.ts`, `ARGON2ID_PARAMS`) và Rust
  (`native/crypto-core/src/lib.rs`, `KDF_OPSLIMIT` / `KDF_MEMLIMIT`).
  Trước Phase B, Rust dùng SENSITIVE nên KEK hai phía không khớp (H3)
  — đã sửa về INTERACTIVE theo đúng `specs/encryption-format.md`.
  Không bao giờ dùng hai profile song song: vault tạo ở một phía phải
  mở được ở phía còn lại.
- Test vector dùng chung (không được bịa số):
  `tests/crypto-vectors/argon2id-vectors.json` — 2 vector KEK Argon2id
  + 1 vector XChaCha20-Poly1305, tính bằng chính libsodium (xem ghi chú
  `_generated` trong file). TypeScript assert ở
  `tests/crypto-vectors/argon2id-vectors.test.mjs`, Rust assert ở
  `native/crypto-core/tests/vectors.rs`.
- Đổi tham số = đổi format version + migration + regenerate vector.
  Không hạ tham số âm thầm.

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
- Đổi passphrase thường: re-wrap khóa gốc.
- Nghi lộ khóa gốc: key rotation + mã hóa lại dữ liệu liên quan.
- **Mất hết khóa + recovery key + thiết bị tin cậy: server không có cửa hậu.** Đó là giá của zero-knowledge thật.

## Vault riêng cho dữ liệu cực nhạy
Một master password mở tất cả là single point of compromise. Dữ liệu đặc biệt nhạy cảm nên ở vault riêng với secret bổ sung độc lập, hoặc ít nhất yêu cầu xác thực lại + giới hạn thời gian unlock. Chỉ yêu cầu Face ID lại trong cùng một key hierarchy chưa tạo ra cô lập mật mã thật.
