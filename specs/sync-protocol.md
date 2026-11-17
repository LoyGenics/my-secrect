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

**Vault key check.** `GET /v1/vaults` (và `POST`, `GET /v1/vaults/:id`) trả `encrypted_metadata`: ciphertext dưới Vault Key do thiết bị tạo vault ghi (`encryptWithVaultKey`), trả lại đúng chuỗi base64 client đã gửi (không phải base64 hợp lệ → `null`). Server không đọc được nó; nó chỉ để thiết bị kiểm tra mình có cùng Vault Key hay không.

**Signature.** `signature` là bytes mờ tùy chọn: server lưu và trả lại khi pull, KHÔNG xác thực; thiếu cũng được nhận. Không được coi `signature` là bằng chứng gì cho tới khi purpose `sync-event` (`specs/device-identity.md` §4, đang *reserved*) được định nghĩa và verify theo kế hoạch K3 bên dưới.

## Tombstone, khôi phục, xóa vĩnh viễn
- Xóa = tombstone (`deleted_at`, revision + 1, event `delete`); server giữ version ciphertext cuối để khôi phục. Item tombstone không đọc được qua `GET items/:id` (404) nhưng vẫn trong sync log.
- Khôi phục (resurrect) = upsert với `base_revision` = revision của tombstone (client đã thấy lệnh xóa), ciphertext mới hoặc ciphertext của version mới nhất. Upsert dựa trên revision trước khi xóa → 409, item vẫn bị xóa (client ghi conflict delete-vs-update, giữ cả hai).
- Client: event delete mới hơn base → item vào trash (khôi phục được); nếu local có sửa đổi chưa push → conflict, không xóa.
- "Delete forever" (purge) chỉ là thao tác LOCAL của thiết bị đó: không gửi lên server. Nhưng lệnh xóa mà nó ngụ ý thì có: nếu server có item (`base_revision > 0`) mà chưa có tombstone của nó (item còn live — vd. "Clear example data" — hoặc lệnh xóa chưa push), `vault.ts` giữ một row tombstone KHÔNG còn nội dung (`purged: true`, mọi field ciphertext = `''`, không decrypt / list / export) cho tới khi sync đẩy được lệnh xóa — kể cả khi lúc purge sync không chạy (chưa đăng nhập, sync tắt) — rồi xóa hẳn row đó. Engine queue tombstone ngay khi xóa hoặc purge. Server giữ tombstone + version cuối; thiết bị khác vẫn thấy item trong trash. Nếu thiết bị khác khôi phục hoặc sửa item trước khi tombstone lên tới server, bản đó thắng (không bỏ thay đổi của người khác) và item quay lại cả trên thiết bị đã purge. Server KHÔNG có purge từng item (chỉ xóa cả tài khoản).

## Gắn thiết bị với vault của account (`apps/desktop/src/sync/engine.ts`)
- Lần đầu: nếu account chưa có vault trên server → tạo vault (kèm `encrypted_metadata` dưới Vault Key). Nếu đã có → chọn vault CŨ NHẤT mà Vault Key của thiết bị mở được: `encrypted_metadata` qua được AEAD, hoặc (vault không có metadata) item đầu tiên trong sync log decrypt được; vault rỗng không metadata thì không có gì để lệch.
- Không vault nào mở được (thiết bị tạo vault MỚI thay vì Restore) → trạng thái `vault_mismatch`: sync dừng hẳn, KHÔNG push gì (không item, không vault mới), báo "restore from a backup". Thiết bị đã gắn từ trước cũng được kiểm tra lại mỗi lần engine khởi động.
- Cách khắc phục: Restore từ backup (hoặc recovery key) của vault account trên thiết bị đó.

## Client xử lý kết quả push (`packages/sync/src/sync-client.ts`)
- 2xx (kể cả `replayed`): xóa đúng entry đó khỏi queue, cập nhật base revision.
- Lỗi mạng / mất response: giữ queue, thử lại sau; nhờ luật replay, lần thử lại không tạo bản trùng.
- 409: không retry mù; bỏ entry, lần pull sau ghi conflict giữ cả hai bản (bản local không bị ghi đè).
- 401 (session hết/bị revoke) hoặc 403 (`device_not_authorized`) ở push HAY pull (và ở `GET /v1/vaults`): `SyncRunResult.signedOut`; engine dừng hẳn (không retry), xóa token đã lưu (`clearToken`), báo `signed_out` và gọi `onUnauthorized` (app quay về màn đăng nhập). Queue giữ nguyên cho lần đăng nhập sau.
- 422 / 5xx: giữ trong queue, báo lỗi hiển thị, thử lại sau.

## Chống rollback / giả mạo lịch sử
- Đã có: luật revision + replay + `ciphertext_reuse` ở trên (chặn client/session đẩy lịch sử cũ); client bỏ qua revision cũ hơn local và verify AEAD trước khi apply.
- CHƯA có: sync event được ký bởi thiết bị có quyền, ràng buộc revision; ciphertext ràng buộc revision (AD v2). Vì vậy QA DEFECT-K3 còn mở: server (độc hại hoặc DB bị sửa) có thể trả một ciphertext THẬT nhưng cũ dưới nhãn revision mới hơn và client sẽ apply nó (AEAD v1 có AD = null nên không biết revision). Kế hoạch đóng ở mục "Kế hoạch đóng K3".
- CHƯA có: device checkpoint + hash. Client chỉ lưu cursor (`checkpoint_hash` luôn `null`); bảng `device_checkpoints` trên server không được sync dùng. Lưu ý: checkpoint trên cùng server không đủ chống server độc hại; cần trạng thái tin cậy trên thiết bị hoặc đối chiếu độc lập.
- Khi tất cả thiết bị + checkpoint đều mất, không thể bảo đảm chống rollback chỉ bằng AEAD.

## Hạn chế đã biết
- Mất response rồi người dùng sửa tiếp TRƯỚC khi retry: entry trong queue đã bị thay bằng ciphertext mới, nên không còn là replay → 409 → conflict giữa bản mới và bản trung gian của chính mình (giữ cả hai, không mất gì, nhưng là conflict thừa).
- Xóa hoặc purge trên một client KHÁC desktop/web (mobile, extension chưa sync) không áp dụng các luật trên.
- `apps/desktop/src/utils/media.ts` (`resolveServerVaultId`) chọn `vaults[0]` cho media mà không kiểm tra Vault Key như engine; cần dùng chung kiểm tra `encrypted_metadata`.
- Restore từ trash một bản cũ hơn version mới nhất trên server (hiếm: xóa offline trước khi pull bản mới) → 422 `ciphertext_reuse`, entry ở lại queue với lỗi hiển thị; sửa item (encrypt lại) sẽ gỡ được.

## Kế hoạch đóng K3 (rollback bằng ciphertext thật nhưng cũ) — CHƯA triển khai
Hai lớp, cùng cần: lớp 1 khiến ciphertext cũ không mở được ở revision khác; lớp 2 xác thực cả lệnh xóa (không có ciphertext) và tác giả. Mỗi bước là một PR có test riêng; không bước nào làm hỏng client cũ một cách im lặng (fail-closed).

**Lớp 1 — revision nằm trong AD (item encryption v2, `specs/encryption-format.md` § "Kế hoạch migration v1 → v2").** Primitives đã có: `itemAdV2`, `encryptItemPayloadV2` / `decryptItemPayloadV2`, `wrapItemKeyV2` / `unwrapItemKeyV2` (`packages/crypto-adapters`), Rust `item_ad_v2`; AD = nhãn || `vault_id` || `item_id` || u64 `revision`.
1. `vault_id` ổn định: UUID sinh lúc `createVault`, lưu trong key envelope (`StoredKeys` + envelope của backup), giống nhau trên mọi thiết bị của vault; engine ánh xạ 1-1 sang id vault trên server (binding), hoặc API nhận id do client chọn khi tạo vault.
2. Revision được ràng buộc = revision SERVER mà lần ghi sẽ trở thành = `base_revision + 1`. Vì vậy ciphertext v2 cho sync được tạo lúc push (`buildSyncPush` mã hóa lại plaintext đang mở khóa với AD(vault_id, wire item_id, base + 1), Item Key mới), không dùng ciphertext của row local. Retry sau mất response gửi lại đúng bytes đó → vẫn là replay; 409 → mã hóa lại với base mới. `encryption_version` = 2 trên wire và trên row.
3. Reader trước writer: callback `decrypt` của sync (`decryptSyncEvent`) dispatch theo `encryption_version`; v2 verify với AD(vault_id, `event.item_id`, `event.revision`). Server gắn ciphertext rev 3 vào event rev 7 → AEAD fail → event bị `rejected`, checkpoint giữ trước nó, lỗi hiển thị (đường đi đã có và đã test cho AEAD fail). Server không cần đổi: nó vẫn không đọc gì; luật `ciphertext_reuse` vẫn giữ làm lớp phụ.
4. Writer: `DEFAULT_ITEM_ENCRYPTION_VERSION = 2` khi mọi client đã đọc được v2.
5. Khóa hạ cấp: khi mọi row của vault là v2, ghi `min_item_encryption_version = 2` vào trạng thái vault có xác thực (blob dưới Vault Key với nhãn AD riêng); từ đó reader từ chối event v1 của vault — nếu không, server vẫn có thể trả một ciphertext v1 cũ (AD rỗng).
Test: e2e sửa trực tiếp DB (`UPDATE item_versions` gắn ciphertext revision cũ vào revision mới hơn) → client từ chối, không apply, checkpoint giữ; row v2 đổi nhãn sang v1 → từ chối; replay sau mất response vẫn idempotent với v2.

**Lớp 2 — event do thiết bị ký (purpose `sync-event`, `specs/device-identity.md` §3–4).**
1. Đăng ký purpose `sync-event` trong `specs/device-identity.md` §4 với payload (chuỗi, sắp xếp theo khóa): `base_revision`, `device_id`, `encryption_version`, `item_id`, `item_key_sha256`, `operation`, `payload_sha256`, `revision` (= base + 1), `vault_id` (vault_id ổn định ở lớp 1). Hash = base64url(SHA-256(bytes ciphertext)); với `delete` hai hash là chuỗi rỗng. Thiết bị ký bằng khóa Ed25519 của nó lúc tạo push; `signature` trên wire = chữ ký đó.
2. Server: khi push, verify chữ ký với public key của CHÍNH thiết bị gắn với session (đang active), dựng message từ dữ liệu của server (không nhận message blob từ client); sai → 422 `invalid_signature`, không ghi gì. Replay trả lại event gốc (cùng chữ ký). Pull trả `signature` + `device_id` như hiện nay.
3. Client chỉ tin public key nằm trong danh sách thiết bị CÓ XÁC THỰC: một registry (device_id → public key, trạng thái revoke) mã hóa dưới Vault Key với nhãn AD riêng, do thiết bị có Vault Key cập nhật — danh sách thiết bị server trả về KHÔNG đủ (server có thể chèn thiết bị giả).
4. Client verify mỗi event trước khi apply: chữ ký hợp lệ với một thiết bị trong registry, `revision`/`operation`/hash khớp event và ciphertext nhận được. Sai → `rejected` như AEAD fail. Từ đây tombstone cũng được xác thực.
5. Bật bắt buộc theo vault bằng cờ có xác thực (như bước 5 lớp 1); trước đó event không ký vẫn được nhận nhưng hiển thị là "chưa xác thực".

**Lớp 1 + 2 vẫn KHÔNG giải quyết:** server giấu event mới hoặc trả lịch sử cũ NHẤT QUÁN cho thiết bị chưa từng thấy revision mới hơn (freeze / fork). Việc đó cần checkpoint có xác thực (hash chain của sync log, ký bởi thiết bị, so giữa các thiết bị) — bước sau K3.

## Đã triển khai trong code (chạy với Rails + Postgres thật trong `tests/sync-e2e`, CHƯA audit)
- `packages/sync/src/index.ts`: push queue offline bền vững (localStorage, key versioned `my-secrect.sync.queue.v1`, FIFO, dedupe theo item), checkpoint save/load (`my-secrect.sync.checkpoint.v1`, chỉ cursor), `applyRemoteEvents` — verify AEAD trước khi apply, revision phải đơn điệu (stale bị skip), tombstone chỉ apply khi mới hơn local, conflict giữ CẢ HAI bản (`SyncConflict`, resolution do người dùng chọn, không merge tự động).
- `packages/sync/src/sync-client.ts`: `SyncClient` dùng `VaultApiClient` — `pushQueue()` chỉ xóa khỏi queue khi 2xx, mất mạng thì giữ queue, 409 thì bỏ entry và để pull ghi conflict (không retry mù); `pull()` apply xong mới lưu checkpoint, dừng ngay trước event bị AEAD từ chối; `syncAll()` = push rồi pull, offline trả `{ offline: true }` và không mất queue.
- `packages/storage/src/upload.ts`: chunk 1 MiB, mỗi file một File Key riêng, nonce ngẫu nhiên mỗi chunk, manifest mã hóa bằng Vault Key, upload/download streaming (bộ nhớ chặn), verify hash + AEAD từng chunk, resume qua `ResumeState` (không plaintext, không key) + `stored` từ server, `chunkIndexForByteRange` cho video seek. Upload cần presigned URL từ Rails (`POST /v1/blobs/upload-session`) — không fake server. Đã chạy với API + MinIO thật: `tests/media-e2e`.
- `apps/desktop/src/sync/engine.ts`: `SyncEngine` nối `SyncClient` với vault desktop (cũng dùng cho web); kiểm tra Vault Key trước khi gắn vault (`vault_mismatch`); 401/403 → `signed_out`; conflict lưu MÃ HÓA bằng Vault Key (`my-secrect.sync.conflicts.enc.v1`); "Keep both" tạo bản copy và giữ item local.
- `packages/core/src/sharing.ts`: model share qua key envelope, permission read/write, revoke (không xóa được bản copy recipient đã giải mã — phải hiện rõ trong UI). Sharing CHƯA live: chưa có HPKE / crypto_box / key wrap.
- `apps/desktop/src/utils/media.ts` + `components/MediaView.tsx`: metadata media mã hóa, thumbnail chỉ hiện khi đã giải mã client-side, trạng thái manifest verified/missing/tampered/unknown, ghi chú range/chunk cho video.
- `apps/desktop/src/components/SharesView.tsx`: tạo share proposal + danh sách share + revoke có xác nhận; proposal luôn ở trạng thái pending (từ chối kích hoạt khi chưa có key wrap đã verify).
- Tests: mirror (chỉ lặp lại luật, không import code thật) `tests/sync-conflicts/*.mjs` — `npm run test:mirrors`; real module `packages/sync/tests/{real-sync-client-import,sync-client-pull,sync-client-queue}` — `npm run test:real`; server `apps/api/spec` (RSpec, Postgres thật); hai client thật + Chromium với API thật, và `tests/sync-e2e/account-guards.test.ts` (vault mismatch, 401/403 khi pull, xóa/purge lúc sync tắt): `npm run test:sync-e2e`.
