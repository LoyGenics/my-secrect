# Sync Protocol — v1 (DRAFT)

Offline-first, optimistic concurrency, append-only change history.

## Luồng
1. Client sửa item local -> encrypt revision mới -> đưa vào sync queue.
2. Push ciphertext + base revision lên Rails. Server validate version, append sync event, cấp sequence mới.
3. Client khác pull `GET /v1/vaults/:id/sync?since=cursor` -> verify AEAD + revision -> decrypt + apply local.

## Quy tắc
| Tình huống | Hành vi |
|---|---|
| Sửa offline | Ghi local, queue sync |
| 2 thiết bị sửa 2 item khác nhau | Sync bình thường |
| 2 thiết bị sửa cùng 1 item | Giữ cả 2 version, phát hiện conflict — client resolve sau decrypt |
| Xóa | Encrypted tombstone, hỗ trợ khôi phục |
| Upload file gián đoạn | Resume các chunk còn thiếu |
| Server down | Đọc/sửa local, sync sau |
| Server gửi dữ liệu lỗi/cũ | Kiểm tra AEAD, revision, checkpoint |

## Không dùng Last Write Wins mặc định
Mất một bản cập nhật password/recovery code có thể khiến người dùng mất quyền truy cập.
Server không biết nội dung nên không thể merge thông minh. Client xử lý sau khi giải mã.

## Chống rollback / giả mạo lịch sử
- Sync event được ký bởi thiết bị có quyền, ràng buộc revision.
- Device checkpoint + hash. Lưu ý: checkpoint trên cùng server không đủ chống server độc hại; cần trạng thái tin cậy trên thiết bị hoặc đối chiếu độc lập.
- Khi tất cả thiết bị + checkpoint đều mất, không thể bảo đảm chống rollback chỉ bằng AEAD.

## Đã triển khai trong code (implemented in code — CHƯA chạy với server thật, CHƯA audit)
- `packages/sync/src/index.ts`: push queue offline bền vững (localStorage, key versioned `my-secrect.sync.queue.v1`, FIFO, dedupe theo item), checkpoint save/load (`my-secrect.sync.checkpoint.v1`), `applyRemoteEvents` — verify AEAD trước khi apply, revision phải đơn điệu (stale bị skip), tombstone chỉ apply khi mới hơn local, conflict giữ CẢ HAI bản (`SyncConflict`, resolution do người dùng chọn, không merge tự động).
- `packages/sync/src/sync-client.ts`: `SyncClient` dùng `VaultApiClient` — `pushQueue()` chỉ xóa khỏi queue khi 2xx, mất mạng thì giữ queue, 409 thì không retry mù mà ghi conflict; `pull()` apply xong mới lưu checkpoint; `syncAll()` = push rồi pull, offline trả `{ offline: true }` và không mất queue.
- `packages/storage/src/upload.ts`: chunk 1 MiB, mỗi file một File Key riêng, nonce ngẫu nhiên mỗi chunk, manifest mã hóa bằng Vault Key, verify hash + AEAD từng chunk, `ResumableUpload` track part đã upload để resume, `chunkIndexForByteRange` cho video seek. Upload cần presigned URL từ Rails (`POST /v1/blobs/upload-session`) — không fake server.
- `packages/core/src/sharing.ts`: model share qua key envelope, permission read/write, revoke (không xóa được bản copy recipient đã giải mã — phải hiện rõ trong UI).
- `apps/desktop/src/utils/media.ts` + `components/MediaView.tsx`: metadata media mã hóa, thumbnail chỉ hiện khi đã giải mã client-side, trạng thái manifest verified/missing/tampered/unknown, ghi chú range/chunk cho video.
- `apps/desktop/src/components/SharesView.tsx`: tạo share proposal + danh sách share + revoke có xác nhận, kèm cảnh báo HPKE chưa triển khai nên sharing chưa production-ready.
- Tests Node tự chạy được: `tests/sync-conflicts/sync-engine.test.mjs`, `tests/end-to-end/export-import-relations.test.mjs`, `tests/compatibility/chunk-manifest.test.mjs` — xem `npm test`.
