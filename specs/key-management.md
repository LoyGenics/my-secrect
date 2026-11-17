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
