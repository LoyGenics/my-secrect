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
| Xóa | Encrypted tombstone, hỗ trợ khôi phục (xem "Tombstone, khôi phục, xóa vĩnh viễn") |
| Upload file gián đoạn | Resume các chunk còn thiếu |
| Server down | Đọc/sửa local, sync sau |
| Mất response của push (server đã ghi) | Client retry; server nhận ra replay, trả lại kết quả cũ, không ghi thêm |
| Server lỗi giữa chừng khi push | Không ghi gì (một transaction); thay đổi vẫn nằm trong queue |
| Server gửi dữ liệu lỗi/cũ | Client kiểm tra AEAD và revision. Checkpoint hiện chỉ là cursor: CHƯA phát hiện server rollback (xem dưới) |

## Không dùng Last Write Wins mặc định
Mất một bản cập nhật password/recovery code có thể khiến người dùng mất quyền truy cập.
Server không biết nội dung nên không thể merge thông minh. Client xử lý sau khi giải mã.

## Wire format (v1)
Mọi request cần `Authorization: Bearer <session token>`. Server chỉ thấy ciphertext + id mờ (opaque); không bao giờ giải mã.

**Push** — `POST /v1/vaults/:vault_id/sync/push` (và `PUT`/`DELETE /v1/vaults/:vault_id/items/:id`, cùng luật):
```json
{ "item_id": "<uuid chữ thường>", "base_revision": 3, "operation": "upsert" | "delete",
  "encrypted_payload": "<base64>", "encrypted_item_key": "<base64>", "encryption_version": 1,
  "signature": "<base64, tùy chọn>" }
```
- `encrypted_payload` / `encrypted_item_key`: base64 chuẩn; bắt buộc với `upsert`, bỏ qua với `delete`. Server lưu bytes đã decode, pull trả lại đúng chuỗi base64 đó.
- 200: `{ item_id, revision, sequence }` (delete thêm `deleted_at`). Push là replay (xem dưới): `{ item_id, revision, sequence, replayed: true }`, không ghi gì.
- 409 `{ error: "revision_conflict", current_revision }`; 422 `{ error: "invalid_request", message }` hoặc `{ error: "ciphertext_reuse", revision }`; 401 / 403 / 404 xem "Quyền".

**Pull** — `GET /v1/vaults/:vault_id/sync?since=<sequence>`: tối đa 500 event theo thứ tự `sequence`, `next_cursor` = sequence cuối của trang (null khi rỗng). Mỗi event: `id, vault_id, sequence, item_id, revision, operation, tombstone, device_id, signature, encrypted_payload, encrypted_item_key, encryption_version, created_at`. Event `upsert` mang ciphertext của đúng revision đó; event `delete` có `tombstone: true` và ciphertext `null`.

## Luật phía server (enforced in code)
Code: `apps/api/app/domains/encrypted_records/{upsert,delete,append_event}.rb`, `apps/api/app/domains/sync/push.rb`, `apps/api/app/controllers/concerns/active_device_required.rb`. Tests: `apps/api/spec/requests/api/v1/sync_revision_rules_spec.rb`, `sync_device_authorization_spec.rb`, `spec/domains/sync_sequence_concurrency_spec.rb`, `sync_push_atomicity_spec.rb`.

**Sequence.** Mỗi vault một dãy 1, 2, 3, … duy nhất và không có lỗ. Mọi write khóa dòng vault (`SELECT … FOR UPDATE`) trước khi đụng item; `AppendEvent` cấp `max(sequence) + 1` trong lúc giữ khóa đó. Vì vậy sequence N đã commit (hoặc rollback, trả lại số N) trước khi ai khác đọc max: client pull theo cursor không bao giờ bỏ sót event. Index unique `(vault_id, sequence)` và `(item_id, revision)` (mỗi revision đúng một event) là lớp chặn cuối ở DB.

**Revision.** Mỗi write thành công tăng `current_revision` của item đúng 1 và append đúng 1 event; upsert còn thêm 1 `item_version`. Tất cả trong một transaction: không bao giờ có event thiếu version, version thiếu event, hay revision tăng mà thiếu cả hai.
- `base_revision` phải là số nguyên không âm (JSON number hoặc chuỗi chữ số); sai kiểu → 422. Upsert thiếu `base_revision` = 0; delete thiếu → 409.
- `base_revision` phải bằng `current_revision` (item mới: 0). Nhỏ hơn (stale) hay lớn hơn (revision server chưa từng cấp) đều → 409 kèm `current_revision`, không ghi gì. Item mới mà `base_revision > 0` → 409 với `current_revision: 0`.
- `item_id` đã thuộc vault khác → 422.

**Replay (idempotent).** Push lặp lại một write đã được nhận (thường do mất response) không ghi thêm gì mà trả lại kết quả gốc với `replayed: true` — kể cả khi đã có revision mới hơn sau đó (client sẽ pull chúng):
- upsert: version tại `base_revision + 1` có cùng bytes `encrypted_payload`, `encrypted_item_key` và cùng `encryption_version`;
- delete: event tại `base_revision + 1` là delete (mất response, hoặc thiết bị khác cũng xóa từ cùng base), hoặc item đã là tombstone tại đúng `base_revision`. Không bao giờ có tombstone thứ hai.
Payload khác bytes (dù cùng nội dung) không phải replay: theo luật revision ở trên.

**Chống rollback bằng ciphertext cũ.** Upsert có `encrypted_payload` trùng bytes với một version đã lưu của item → 422 `ciphertext_reuse` (kèm `revision` của bản trùng), không ghi gì. Người cầm session nhưng không có vault key (vd. token bị đánh cắp) không thể đẩy lại ciphertext cũ thành revision mới để đưa mật khẩu về giá trị cũ — kể cả qua delete rồi restore. Ngoại lệ duy nhất: restore tombstone bằng ciphertext của version MỚI NHẤT (đúng nội dung vừa bị xóa — trash restore của desktop gửi đúng như vậy). Muốn ghi lại nội dung cũ hơn thì client phải encrypt lại (nonce mới), việc chỉ người có vault key làm được.

**Quyền.** Chỉ session gắn với một thiết bị đang hoạt động (không bị revoke) của chính chủ vault mới được push/pull (cả `items` và `vaults`):
- session hết hạn / bị revoke (kể cả do `Devices::Revoke`) → 401;
- session còn sống nhưng thiết bị đã revoke, thiết bị của user khác, hoặc session không có thiết bị (recovery session khi mọi thiết bị đã bị revoke) → 403 `device_not_authorized`;
- vault của user khác → 404, giống hệt vault không tồn tại (không lộ vault có tồn tại hay không).

**Signature.** `signature` là bytes mờ tùy chọn: server lưu và trả lại khi pull, KHÔNG xác thực; thiếu cũng được nhận. Verify chữ ký sync event (khóa Ed25519 của thiết bị) sẽ được thêm SAU khi có `specs/device-identity.md`; trước đó không được coi `signature` là bằng chứng gì.

## Tombstone, khôi phục, xóa vĩnh viễn
- Xóa = tombstone (`deleted_at`, revision + 1, event `delete`); server giữ version ciphertext cuối để khôi phục. Item tombstone không đọc được qua `GET items/:id` (404) nhưng vẫn trong sync log.
- Khôi phục (resurrect) = upsert với `base_revision` = revision của tombstone (client đã thấy lệnh xóa), ciphertext mới hoặc ciphertext của version mới nhất. Upsert dựa trên revision trước khi xóa → 409, item vẫn bị xóa (client ghi conflict delete-vs-update, giữ cả hai).
- Client: event delete mới hơn base → item vào trash (khôi phục được); nếu local có sửa đổi chưa push → conflict, không xóa.
- "Delete forever" (purge) chỉ là thao tác LOCAL của thiết bị đó: không gửi lên server. Lệnh xóa trước nó vẫn được gửi — engine queue tombstone ngay khi xóa nên purge ngay sau đó không làm mất nó. Server giữ tombstone + version cuối; thiết bị khác vẫn thấy item trong trash. Nếu thiết bị khác khôi phục item, nó quay lại cả trên thiết bị đã purge. Server KHÔNG có purge từng item (chỉ xóa cả tài khoản).

## Client xử lý kết quả push (`packages/sync/src/sync-client.ts`)
- 2xx (kể cả `replayed`): xóa đúng entry đó khỏi queue, cập nhật base revision.
- Lỗi mạng / mất response: giữ queue, thử lại sau; nhờ luật replay, lần thử lại không tạo bản trùng.
- 409: không retry mù; bỏ entry, lần pull sau ghi conflict giữ cả hai bản (bản local không bị ghi đè).
- 401: dừng, giữ queue. 422 / 5xx: giữ trong queue, báo lỗi hiển thị, thử lại sau.

## Chống rollback / giả mạo lịch sử
- Đã có: luật revision + replay + `ciphertext_reuse` ở trên (chặn client/session đẩy lịch sử cũ); client bỏ qua revision cũ hơn local và verify AEAD trước khi apply.
- CHƯA có: sync event được ký bởi thiết bị có quyền, ràng buộc revision (chờ `specs/device-identity.md`). Nếu chưa có chữ ký thì một server độc hại vẫn có thể giấu event hoặc trả về lịch sử cũ.
- CHƯA có: device checkpoint + hash. Client chỉ lưu cursor (`checkpoint_hash` luôn `null`); bảng `device_checkpoints` trên server không được sync dùng. Lưu ý: checkpoint trên cùng server không đủ chống server độc hại; cần trạng thái tin cậy trên thiết bị hoặc đối chiếu độc lập.
- Khi tất cả thiết bị + checkpoint đều mất, không thể bảo đảm chống rollback chỉ bằng AEAD.

## Hạn chế đã biết
- Mất response rồi người dùng sửa tiếp TRƯỚC khi retry: entry trong queue đã bị thay bằng ciphertext mới, nên không còn là replay → 409 → conflict giữa bản mới và bản trung gian của chính mình (giữ cả hai, không mất gì, nhưng là conflict thừa).
- Xóa rồi purge khi engine KHÔNG chạy (chưa đăng nhập / vault khóa), hoặc "Clear example data" purge item đang live đã sync: thao tác xóa không được ghi lại nên không bao giờ lên server. Cần `vault.ts` lưu tombstone chờ gửi.
- Restore từ trash một bản cũ hơn version mới nhất trên server (hiếm: xóa offline trước khi pull bản mới) → 422 `ciphertext_reuse`, entry ở lại queue với lỗi hiển thị; sửa item (encrypt lại) sẽ gỡ được.

## Đã triển khai trong code (chạy với Rails + Postgres thật trong `tests/sync-e2e`, CHƯA audit)
- `packages/sync/src/index.ts`: push queue offline bền vững (localStorage, key versioned `my-secrect.sync.queue.v1`, FIFO, dedupe theo item), checkpoint save/load (`my-secrect.sync.checkpoint.v1`, chỉ cursor), `applyRemoteEvents` — verify AEAD trước khi apply, revision phải đơn điệu (stale bị skip), tombstone chỉ apply khi mới hơn local, conflict giữ CẢ HAI bản (`SyncConflict`, resolution do người dùng chọn, không merge tự động).
- `packages/sync/src/sync-client.ts`: `SyncClient` dùng `VaultApiClient` — `pushQueue()` chỉ xóa khỏi queue khi 2xx, mất mạng thì giữ queue, 409 thì bỏ entry và để pull ghi conflict (không retry mù); `pull()` apply xong mới lưu checkpoint, dừng ngay trước event bị AEAD từ chối; `syncAll()` = push rồi pull, offline trả `{ offline: true }` và không mất queue.
- `packages/storage/src/upload.ts`: chunk 1 MiB, mỗi file một File Key riêng, nonce ngẫu nhiên mỗi chunk, manifest mã hóa bằng Vault Key, upload/download streaming (bộ nhớ chặn), verify hash + AEAD từng chunk, resume qua `ResumeState` (không plaintext, không key) + `stored` từ server, `chunkIndexForByteRange` cho video seek. Upload cần presigned URL từ Rails (`POST /v1/blobs/upload-session`) — không fake server. Đã chạy với API + MinIO thật: `tests/media-e2e`.
- `apps/desktop/src/sync/engine.ts`: `SyncEngine` nối `SyncClient` với vault desktop (cũng dùng cho web); conflict lưu MÃ HÓA bằng Vault Key (`my-secrect.sync.conflicts.enc.v1`); "Keep both" tạo bản copy và giữ item local.
- `packages/core/src/sharing.ts`: model share qua key envelope, permission read/write, revoke (không xóa được bản copy recipient đã giải mã — phải hiện rõ trong UI). Sharing CHƯA live: chưa có HPKE / crypto_box / key wrap.
- `apps/desktop/src/utils/media.ts` + `components/MediaView.tsx`: metadata media mã hóa, thumbnail chỉ hiện khi đã giải mã client-side, trạng thái manifest verified/missing/tampered/unknown, ghi chú range/chunk cho video.
- `apps/desktop/src/components/SharesView.tsx`: tạo share proposal + danh sách share + revoke có xác nhận; proposal luôn ở trạng thái pending (từ chối kích hoạt khi chưa có key wrap đã verify).
- Tests: mirror (chỉ lặp lại luật, không import code thật) `tests/sync-conflicts/*.mjs` — `npm run test:mirrors`; real module `packages/sync/tests/{real-sync-client-import,sync-client-pull,sync-client-queue}` — `npm run test:real`; server `apps/api/spec` (RSpec, Postgres thật); hai client thật + Chromium với API thật: `npm run test:sync-e2e`.
