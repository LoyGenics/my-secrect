# Threat Model — v1

## Chống lại
| Mối đe dọa | Biện pháp |
|---|---|
| Server/DB bị chiếm | E2EE, server không giữ decryption keys |
| Password yếu | Argon2id mạnh, hướng dẫn passphrase |
| Chiếm tài khoản cloud | Passkey/MFA, E2EE, device authorization |
| Thiết bị thất lạc | Local encryption, device protection, revoke session |
| Sync bị thay thế/rollback | AEAD, signed events, trusted checkpoints |
| Browser phishing | Domain verification, user-confirmed autofill |
| Extension bị khai thác | Least privilege, cô lập secret-handling |
| File media hỏng | Authenticated chunks, manifest verification, backup |
| Mất server | Local offline vault, encrypted backups |
| Mất mọi thiết bị | Master passphrase hoặc offline recovery key |

## Giới hạn (phải nói rõ với người dùng)
1. **E2EE không bảo vệ thiết bị đã bị xâm nhập hoàn toàn.** Malware đọc được plaintext trong phiên unlock.
2. **Zero-knowledge ≠ không rò metadata.** Email, IP, thời gian truy cập, dung lượng, số lượng record server vẫn có thể biết.
3. **Server không thể kiểm tra nội dung.** Nếu mở sharing công khai, cần chính sách chống lạm dụng/quota riêng mà không phá E2EE.
4. **Web client là bề mặt tấn công riêng.** Kẻ kiểm soát JS được phân phối có thể đọc secret sau unlock. HTTPS + E2EE không đủ nếu nguồn phân phối mã bị xâm nhập.
5. **Nhập bằng AI là luồng xử lý văn bản riêng.** Sau khi người dùng đồng ý, API gửi nguyên văn nội dung đã dán tới OpenAI để trả về bản xem trước. Nội dung này không nằm trong phạm vi E2EE khi xử lý. API không lưu nội dung hoặc ghi vào log và yêu cầu OpenAI tắt lưu phản hồi. Xử lý CSV diễn ra trên thiết bị.

## Thẻ ngân hàng / PCI
- Hỗ trợ metadata thẻ, tài khoản, ghi chú tài chính.
- **Không lưu CVV trên server trong sản phẩm thương mại (kể cả đã mã hóa).** PCI cấm lưu CVV sau authorization.
- Không lưu PIN, OTP đang dùng, không auto-login Internet Banking bằng scraping trong MVP.
