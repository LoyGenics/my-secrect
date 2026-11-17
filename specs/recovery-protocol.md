# Recovery Protocol — v1 (DRAFT)

## 3 đường recovery
1. Login lại + unlock bằng master passphrase.
2. Chuyển khóa từ thiết bị tin cậy (HPKE / protocol đã kiểm chứng, có challenge chống replay).
3. Recovery key entropy cao lưu offline + quy trình khôi phục tài khoản.

## Yêu cầu cho mọi endpoint recovery
- Challenge + chống replay + xác thực lại + kiểm tra quyền đặc biệt.
- Không bao giờ để server suy ra được khóa giải mã từ quá trình recovery.
- Recovery key phải được tạo bằng CSPRNG, hiển thị 1 lần, người dùng xác nhận đã lưu trước khi tiếp tục.

## Key rotation
- Đổi passphrase thường: re-wrap Account Master Key.
- Nghi lộ: rotation + re-encrypt dữ liệu liên quan, thu hồi key envelopes cũ, ghi audit event.
