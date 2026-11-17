# Encryption Format — v1 (CHỐT, chưa audit) + v2 item primitives (CHƯA BẬT)

> Status: parameters below are LOCKED for v1. Do not change a value without
> bumping the format/encryption version and writing a migration + test
> vectors. Nothing in this repo is audited or production-ready.
>
> Item encryption **v2** (AD-bound, § "Item encryption v2") exists as
> primitives in TS and Rust with shared vectors. **No app writes v2.**
> v1 is the default writer until the rollout in § "Kế hoạch migration v1 → v2".

## Nguyên tắc
- Không tự viết thuật toán. Dùng libsodium đã kiểm chứng (`libsodium-wrappers-sumo` 0.7.15 in JS/TS; `native/crypto-core` = Rust + `sodiumoxide` 0.2.7 / libsodium).
- Mọi ciphertext đều là AEAD: không có plaintext + tag hợp lệ thì reject.
- Không reuse nonce dưới cùng một key. Mỗi item/file có key riêng (envelope encryption).
- Mọi định dạng đều có version. Migration phải có test vector.

## Phiên bản định dạng (đúng với code hiện tại)
| Đối tượng | Field / hằng số | Giá trị | Code |
|---|---|---|---|
| Item ciphertext | `encryption_version` (export item, sync push/pull, Rails `item_versions`) | **1** = writer mặc định, AD = null. **2** = AD-bound, chỉ có primitives | `DEFAULT_ITEM_ENCRYPTION_VERSION`, `ITEM_ENCRYPTION_V1/V2` (`packages/crypto-adapters/src/index.ts`); `ITEM_ENCRYPTION_V1/V2` (`native/crypto-core/src/lib.rs`) |
| Local row (desktop localStorage, extension `chrome.storage.local`, mobile AsyncStorage / SQLCipher `rows`) | **không có field version** → ngầm hiểu 1 | — | `StoredRow` trong mỗi `vault.ts`; `specs/mobile-local-store.md` §2 |
| KDF profile | `ARGON2ID_PARAMS.version` = `'1.0'`; Rust `CRYPTO_FORMAT_VERSION` = 1; export `kdf` object | Argon2id INTERACTIVE (bảng dưới) | `ARGON2ID_PARAMS`, `KDF_OPSLIMIT/KDF_MEMLIMIT/KDF_SALT_BYTES`, `EXPORT_KDF_METADATA` |
| Encrypted backup | `format: "my-secrect-vault-export"`, `format_version` | **3** = writer (key envelope + `item_index` đã xác thực, § Backup item index). **2** vẫn restore/import được nhưng danh sách item KHÔNG xác minh được (UI phải báo). 1 và ≥ 4 bị từ chối | `packages/import-export/src/index.ts` |
| Plaintext export | `format: "my-secrect-vault-plaintext-export"` | 1 | không mã hóa |
| Blob manifest | `BlobManifest.format_version`; `EncryptedManifest.encryption_version`; `WrappedFileKey.encryption_version` | 1 / 1 / 1 | `packages/storage/src/upload.ts` |

## Thuật toán — tham số đã chốt (v1)
| Mục đích | Công nghệ | Tham số chính xác |
|---|---|---|
| KDF (passphrase → KEK) | Argon2id (`crypto_pwhash`, `ALG_ARGON2ID13` = 2, v1.3) | opslimit = `OPSLIMIT_INTERACTIVE` = **2**; memlimit = `MEMLIMIT_INTERACTIVE` = **67108864 bytes (64 MiB)** (= m 65536 KiB); lanes **1** (libsodium cố định); salt **16 bytes** ngẫu nhiên; output **32 bytes**; input = UTF-8 của passphrase, **không** Unicode-normalize |
| Recovery KEK | SHA-256 (`crypto_hash_sha256`) | input = 32 byte recovery key; output 32 byte |
| Item nhỏ + mọi key wrap | XChaCha20-Poly1305 IETF (`crypto_aead_xchacha20poly1305_ietf`) | key **32 bytes**; nonce **24 bytes** ngẫu nhiên mỗi lần; tag Poly1305 **16 bytes**; AD = null (v1) |
| File / media (TS, `packages/storage`) | XChaCha20-Poly1305 IETF theo chunk 1 MiB | File Key 32B ngẫu nhiên / file; nonce 24B ngẫu nhiên / chunk; manifest (thứ tự, byte range, kích thước, SHA-256 của ciphertext) mã hóa bằng Vault Key |
| File tuần tự (Rust) | libsodium `secretstream_xchacha20poly1305` | `EncryptStream` / `DecryptStream` trong `native/crypto-core` — CHƯA có caller, không tương thích với định dạng chunk của `packages/storage` |
| Subkey derivation | HKDF-SHA-256 | RFC 5869; salt cố định 32 byte 0; xem § HKDF. Vault: chỉ dùng cho khóa niêm phong item index của backup v3 (`info = "my-secrect/backup-item-index/v1"`) |
| Trao khóa | HPKE hoặc protocol đã kiểm chứng | (chưa implement — `packages/core/src/sharing.ts` từ chối activation) |
| Random | CSPRNG của OS qua `sodium.randombytes_buf` / `randombytes` | — |

Mã hằng số dùng trong code (`packages/crypto-adapters/src/index.ts`):
```ts
export const ARGON2ID_PARAMS = {
  algorithm: 'argon2id',
  opslimit: 2,                 // crypto_pwhash_OPSLIMIT_INTERACTIVE
  memlimit: 67108864,          // crypto_pwhash_MEMLIMIT_INTERACTIVE (64 MiB)
  saltBytes: 16,
  outputBytes: 32,
  version: '1.0',
} as const;
```
Rust (`native/crypto-core/src/lib.rs`) dùng `sodiumoxide::crypto::pwhash::argon2id13`
(**không** phải `crypto::pwhash`, module đó re-export scrypt — lỗi đã sửa ở 4adb39d)
và có `const` assert lúc compile: `VARIANT == 2`, opslimit 2, memlimit 67108864,
salt 16, XChaCha key/nonce/tag 32/24/16. Đổi module hay hằng số là crate không compile.

## Mã hóa base64 và chuỗi
- Mọi binary lưu / xuất / gửi server (salt, nonce, wrapped key, payload,
  manifest, chunk metadata): **base64 chuẩn RFC 4648 §4, có padding**
  (`toBase64` = `btoa`; Rust `sodiumoxide::base64::Variant::Original`).
  Validator của backup chỉ nhận đúng alphabet `A–Z a–z 0–9 + /` + padding.
- Ngoại lệ duy nhất: **recovery key hiển thị cho người dùng** = base64url
  RFC 4648 §5 **không padding** (43 ký tự) (`toBase64Url`; Rust
  `Variant::UrlSafeNoPadding`). Khi nhập: `trim()`, decode, bắt buộc đúng 32 byte.
- Passphrase → bytes: UTF-8 (`TextEncoder`; Rust nhận `&[u8]` UTF-8). Không
  normalize NFC/NFD ở bên nào — xem `specs/key-management.md` § Unicode.
- Item JSON → bytes: UTF-8 (`TextEncoder` desktop/extension, `Buffer` utf8 mobile — cùng kết quả).

## Key hierarchy (v1)
```
passphrase --Argon2id (salt 16B, ops 2, mem 64 MiB)--> KEK (32B)
KEK --XChaCha20-Poly1305 wrap--> Account Master Key (32B, ngẫu nhiên)
Account Master Key --wrap--> Vault Key (32B, ngẫu nhiên)
Vault Key --wrap--> Item Key (32B, ngẫu nhiên, mới cho mỗi lần ghi item)
Item Key --XChaCha20-Poly1305 encrypt--> VaultItem JSON

Recovery: recovery key 32B ngẫu nhiên, base64url không padding, hiển thị 1 lần duy nhất.
  recovery KEK = SHA-256(recovery key bytes)  [sodium.crypto_hash_sha256; Rust recovery_kek()]
  recovery KEK --wrap--> Account Master Key (lưu wrapped_recovery + nonce)
Mất cả passphrase lẫn recovery key = mất vault. Không có reset.
```

### Khóa nào mã hóa cái gì (v1, AD = null ở mọi chỗ)
| Khóa | Mã hóa / wrap | Nơi |
|---|---|---|
| KEK (Argon2id) | Account Master Key → `wrapped_master` | 3 app `vault.ts` |
| recovery KEK (SHA-256) | Account Master Key → `wrapped_recovery` | 3 app `vault.ts` |
| Account Master Key | Vault Key → `wrapped_vault` | 3 app `vault.ts` |
| **Vault Key** | Item Key; File Key (`manifest.wrapped_file_key`); BlobManifest JSON; tên thiết bị (`encryptWithVaultKey` → `name_encrypted`, gửi server); Ed25519 private key của thiết bị (desktop localStorage) | `vault.ts`, `packages/storage/src/upload.ts`, `apps/desktop/src/components/SecurityCenter.tsx:433,492,498`, `apps/mobile/src/screens/SecurityScreen.tsx:355` |
| Item Key | payload VaultItem JSON | 3 app `vault.ts` |
| Index key = HKDF-SHA-256(Vault Key, salt 32×0, `"my-secrect/backup-item-index/v1"`, 32) | `item_index` của backup v3 (danh sách item, § Backup item index). Khóa riêng, không phải Vault Key → ciphertext khác dưới Vault Key không thay được | `packages/import-export/src/index.ts` (`sealItemIndex` / `verifyItemIndex`), gọi từ 3 app |
| File Key | chunk 1 MiB | `packages/storage/src/upload.ts` |
| Device unlock key (Keychain / Keystore / Secure Enclave) | bản sao AMK, chỉ trên thiết bị (AES-GCM / ECIES của nền tảng, không phải libsodium) | `specs/mobile-local-store.md` §4 |

Vì AD = null, mọi ciphertext dưới Vault Key là **cùng một loại** đối với AEAD —
hệ quả ở § Phân tích thay thế (a').

## Byte layout — ciphertext (v1)
- XChaCha20-Poly1305, nonce **24 bytes** ngẫu nhiên cho mỗi lần mã hóa, không bao giờ reuse dưới cùng một key.
- Layout khi lưu trữ/gộp: `nonce (24B) || ciphertext || Poly1305 tag (16B)`.
  libsodium trả ciphertext đã gồm tag 16B gắn cuối; tổng độ dài phần
  ciphertext = `len(plaintext) + 16`.
- Trong row lưu local / DB, nonce và ciphertext lưu **tách riêng** thành
  2 field base64 (`nonce`, `ciphertext`) — xem `StoredRow`. Khi export
  (backup `format_version` 3 và 2), 2 field được gộp lại thành 1 chuỗi base64
  theo layout `nonce (24B) || ciphertext+tag`, và import tách 24 byte đầu làm nonce.
- Key wrap dùng cùng AEAD: wrapped key = ciphertext (gồm tag 16B) của
  key bytes (luôn 32 byte → 48 byte), kèm nonce 24B riêng, lưu tách riêng
  (`wrapped_*` + `*_nonce`) hoặc gộp `nonce (24B) || wrapped` trong export
  (`encrypted_item_key`, 72 byte).
- Unwrap ra thứ không phải 32 byte bị từ chối ở cả hai phía
  (`libsodiumAdapter.unwrapKey`, Rust `unwrap_key`).

## Envelope cho một item (logical)
```
item_plaintext (JSON, schema_version)
  -> encrypt với Item Key ngẫu nhiên 256-bit (XChaCha20-Poly1305, nonce 24B ngẫu nhiên)
  -> Item Key được wrap bằng Vault Key (XChaCha20-Poly1305)
  -> server lưu: { item_id, vault_id, revision, encrypted_payload, encrypted_item_key, encryption_version }
  -> server KHÔNG lưu: title, tags, type, relations (tất cả nằm trong payload đã mã hóa)
```
- `encrypted_payload`: base64 của `nonce (24B) || ciphertext+tag`.
- `encrypted_item_key`: base64 của `wrapped nonce (24B) || wrapped Item Key`.
- `encryption_version`: 1.
- `revision`, `item_id`, `vault_id`, `deleted_at`: **metadata plaintext, không nằm dưới tag nào ở v1**.
- `revision`: tăng 1 mỗi lần ghi; import merge giữ revision cao hơn.

## Phân tích thay thế / rollback (v1, AD = null)
Kẻ tấn công: server độc hại, hoặc ai sửa được storage local / file backup;
KHÔNG có passphrase, recovery key hay Vault Key. Kết luận dưới đây đã kiểm
chứng trên code thật (desktop `vault.ts`, `packages/sync`) — test commit ở
`packages/crypto-adapters/tests/cross-impl.test.ts`; các kịch bản tấn công
thành công được chạy một lần bằng script tạm, không commit (một test khẳng
định lỗ hổng tồn tại sẽ chặn CI của người sửa nó).

**(a) Đổi ciphertext + wrapped key của item A sang slot của item B (cùng vault).**
- AEAD v1 KHÔNG chặn: cùng Vault Key, AD rỗng → tag hợp lệ.
- Cái chặn: so `id` trong JSON đã giải mã với id của row, ở mọi reader:
  `apps/desktop/src/vault.ts:160` (unlock) và `:549` (import/restore),
  `apps/mobile/src/vault.ts:94` / `:291`, `apps/extension/src/lib/vault-ext.ts:123` / `:339`,
  `packages/sync/src/index.ts:375`. Test: "a tampered or row-swapped Rust backup is rejected by every app".
- Ghép payload A với wrapped key B: Item Key B không mở payload A → AEAD fail.
- Hệ quả phụ: `decryptRows` throw ở row đầu tiên lỗi → cả lần unlock thất bại (DoS, không lộ dữ liệu).
- Kiểm tra id là quy ước của từng caller, không phải của crypto: caller mới quên nó là mất bảo vệ.

**(a') Giả mạo item bằng một ciphertext khác mục đích dưới Vault Key — KHÔNG được chặn ở v1.**
Mọi ciphertext v1 dưới Vault Key của một plaintext **32 byte mà kẻ tấn công biết**
unwrap ra một "Item Key" hợp lệ mà kẻ tấn công cũng biết. Đã kiểm chứng trên
desktop thật: tên thiết bị đúng 32 byte → `name_encrypted` (server giữ) đặt vào
`wrapped_item_key`, payload do kẻ tấn công mã hóa bằng chính 32 byte đó với
`id` tùy chọn → `unlockVault` chấp nhận item giả. Điều kiện: biết/đoán được
plaintext 32 byte (độ dài lộ qua độ dài ciphertext). Mức độ: **Medium** khi
item được sync qua server, **Low** hiện tại (item chỉ ở local). v2 chặn:
wrapped Item Key cần AD nhãn `item-key-wrap`, ciphertext AD-null không mở được.

**(b) Phát lại revision cũ (rollback) — KHÔNG được chặn ở v1.**
- `revision` là metadata plaintext ở row local, item trong backup, `SyncEvent`.
- Backup v2: `importEncrypted` chỉ so revision. Đã kiểm chứng: ciphertext CŨ của một item,
  sửa `revision` thành 99 → import ghi đè bản mới → item quay về nội dung cũ.
  Backup v3: `item_index` ràng buộc (item_id, revision) → sửa revision trong file
  bị từ chối. Vẫn KHÔNG chặn: phát lại NGUYÊN một backup v3 cũ hợp lệ (index của
  chính nó khớp) — import merge bỏ qua row có revision thấp hơn local, nhưng restore
  lên thiết bị trống sẽ ra trạng thái cũ đó.
- Sync: `applyRemoteEvents` (`packages/sync/src/index.ts:362`) áp dụng ciphertext
  cũ nếu server gắn revision mới hơn. Đã kiểm chứng.
- `SyncEvent.signature` không được client kiểm tra; Rails ghi rõ không xác thực
  (`apps/api/app/domains/sync/push.rb:20-24`). "Signed events" trong
  `specs/threat-model.md` / `specs/sync-protocol.md` CHƯA tồn tại.
- `updated_at` nằm trong payload (có xác thực) nhưng không reader nào so sánh.
- Tombstone (delete) không có ciphertext; `deleted_at` của row là plaintext →
  server/storage có thể xóa hoặc khôi phục item tùy ý. Không version nào chặn
  được nếu không có event ký.
- Chỉ chặn được: echo cũ từ server **trung thực** (so revision với state local).

**(c) Chuyển item sang vault khác.**
- Chặn bởi tách khóa: mỗi vault có Vault Key ngẫu nhiên riêng; Item Key wrap
  dưới VK_A không unwrap được bằng VK_B (AEAD fail — đã kiểm chứng).
- `vault_id` không bị ràng buộc. Hiện mọi backup dùng vault_id hằng số
  (`'local'` desktop/mobile, `'extension-local'` extension) nên vault_id
  không mang thông tin. Nếu sau này hai vault dùng chung Vault Key (vd. chia sẻ),
  v1 không phân biệt được.

**(d) File / blob.** Chunk đổi chỗ / thay thế trong một file bị chặn bởi
SHA-256 ciphertext + thứ tự trong manifest (đã mã hóa). Nhưng
`downloadBlob` không so `manifest.blob_id` với blob được yêu cầu
(`packages/storage/src/upload.ts:198-212`) → server có thể trả manifest +
chunk của file B khi client xin file A (cùng Vault Key). Việc của owner
`packages/storage`: nhận `expectedBlobId` và so sánh.

## Item encryption v2 (AD-bound) — primitives, CHƯA BẬT
Cùng AEAD, cùng layout byte (`nonce (24B) || ciphertext+tag`), version nằm ở
field `encryption_version` = 2. Khác v1 duy nhất ở additional data:

```
AD = u32be(len(label))    || label            (ASCII)
  || u32be(len(vault_id)) || vault_id         (UTF-8, 1..1024 byte)
  || u32be(len(item_id))  || item_id          (UTF-8, 1..1024 byte)
  || u64be(revision)                          (0 .. 2^53-1)

label (payload, dưới Item Key)        = "my-secrect/item-payload/v2"
label (wrapped Item Key, dưới VK)     = "my-secrect/item-key-wrap/v2"
```
- Mọi field có length prefix → encoding đơn ánh (`("ab","c")` ≠ `("a","bc")`).
- Id so sánh byte-for-byte, không normalize. TS từ chối lone surrogate (Rust `&str` không chứa được).
- Revision tối đa 2^53-1 để JS biểu diễn chính xác.
- Payload và key-wrap có nhãn khác nhau → không thể thay cho nhau.
- AD v2 luôn khác rỗng, còn libsodium coi AD null = AD rỗng → **ciphertext v2 không bao giờ mở được như v1 và ngược lại**. Đổi nhãn `encryption_version` 2 → 1 là fail-closed.
- API: TS `itemAdV2`, `encryptItemPayloadV2` / `decryptItemPayloadV2`, `wrapItemKeyV2` / `unwrapItemKeyV2`
  (`packages/crypto-adapters/src/index.ts`); Rust `item_ad_v2`, `encrypt_item_v2` / `decrypt_item_v2`,
  `wrap_item_key_v2` / `unwrap_item_key_v2` (`native/crypto-core/src/lib.rs`). Không API nào nhận nonce từ caller.
- v2 giải quyết: (a) bằng crypto thay vì quy ước caller; (a') đóng khi reader không còn nhận v1 cho vault đó
  (bước 4 dưới); (b) server không còn gắn nhãn revision mới cho ciphertext cũ; (c) ràng buộc vault_id.
- v2 KHÔNG giải quyết: server phát lại nhất quán cặp (ciphertext, revision) cũ cho thiết bị chưa từng thấy
  revision mới hơn; tombstone; metadata khác ngoài item (manifest, tên thiết bị) — các thứ đó cần nhãn riêng ở bước sau.

## Kế hoạch migration v1 → v2
Không bước nào được bật một mình. Mỗi bước là một PR có test riêng.

0. **(Đã xong, branch `fix/crypto-compat`)** Primitives TS + Rust, vector chung,
   test chéo. `DEFAULT_ITEM_ENCRYPTION_VERSION` = 1. Không caller nào đổi.
1. **Điều kiện tiên quyết.**
   - `vault_id` ổn định, giống nhau trên mọi thiết bị của vault: sinh ngẫu
     nhiên (UUIDv4 / 16 byte CSPRNG) lúc `createVault`, lưu trong key envelope
     (`StoredKeys` + `WrappedKeyEnvelope` của backup), thay các hằng `'local'` /
     `'extension-local'`; khi sync thì server dùng (hoặc ánh xạ 1-1) id đó.
   - Writer phải biết revision cuối cùng lúc mã hóa: local = `existing.revision + 1`;
     sync push = `base_revision + 1` (Rails `EncryptedRecords::Upsert` gán đúng
     `current_revision + 1` khi base khớp); 409 → mã hóa lại với base mới.
   - Row local thêm `encryption_version` (thiếu = 1): desktop/extension `StoredRow`,
     mobile AsyncStorage + bảng `rows` SQLCipher (`specs/mobile-local-store.md`, cần migration cột).
2. **Reader trước.** Mọi reader dispatch theo `encryption_version`
   (1 → AD null; 2 → AD từ row metadata): 3 app `vault.ts` (unlock, import, restore),
   callback `decrypt` của sync, validator backup (`packages/import-export` hiện từ
   chối mọi `encryption_version !== 1` — phải nhận 2), native nếu sau này giải mã
   (iOS/Android provider), Rust caller. Phát hành và chờ tới khi mọi client đủ
   phiên bản tối thiểu. App cũ gặp backup/row v2 sẽ từ chối (fail-closed, đúng ý).
3. **Writer.** Đổi `DEFAULT_ITEM_ENCRYPTION_VERSION` sang 2: mọi upsert ghi v2
   (Item Key mới như cũ). Tùy chọn: sau unlock, ghi lại toàn bộ item còn v1.
4. **Khóa cửa hạ cấp.** Khi mọi row của vault đã là v2, ghi
   `min_item_encryption_version = 2` vào trạng thái **có xác thực** của vault
   (vd. blob cài đặt mã hóa bằng Vault Key với nhãn AD riêng, hoặc trong envelope
   wrap bởi AMK). Reader từ chối row v1 của vault đó. Trước bước này, (a') và
   phát lại ciphertext v1 cũ vẫn khả thi.
5. **Sau đó.** Nhãn AD riêng cho manifest (ràng buộc `blob_id`), File Key wrap,
   tên thiết bị, khóa thiết bị; event sync ký thật (Ed25519 thiết bị) để có tombstone xác thực.

Test bắt buộc cho bước 2–4: row v1 cũ vẫn mở; row v2 đổi nhãn sang v1 bị từ chối;
vault trộn v1/v2; sau bước 4, row v1 bị từ chối; backup v2 qua Rust ↔ TS.

## Backup item index (`format_version` 3)
Lỗi đã sửa: DEFECT-K2-omission — backup v2 không xác thực danh sách item, nên
file bị xóa bớt 1 row (các row còn lại vẫn hợp lệ) restore "thành công" thành N-1 item.

```
index key = HKDF-SHA-256(IKM = Vault Key, salt = 32 byte 0,
                         info = "my-secrect/backup-item-index/v1", L = 32)

index = u32be(len(format))   || format          ("my-secrect-vault-export")
     || u32be(format_version)                    (3)
     || u32be(len(vault_id)) || vault_id         (UTF-8)
     || u32be(count)
     || với mỗi item, sắp theo byte UTF-8 của item_id (tăng dần):
          u32be(len(item_id)) || item_id || u64be(revision)   (0 .. 2^53-1)

item_index = { nonce: base64(24B),
               sealed: base64(XChaCha20-Poly1305(index key, nonce, index, AD = null)) }
```
- Writer: `sealItemIndex` khi export (cần vault đang mở; key dẫn xuất bị zero-fill).
  Thứ tự row trong file không quan trọng; tập (id, revision) và số lượng thì có.
- Reader (`verifyItemIndex`), ở cả restore lẫn import merge của 3 app: SAU khi mọi
  row giải mã + so id, TRƯỚC mọi lần ghi. Mở `sealed` bằng index key của Vault Key
  vừa unwrap, so byte-for-byte với `index` tính lại từ file. Lệch bất kỳ (thiếu/thừa
  row, đổi revision, đổi vault_id, index bị sửa/tráo/của vault khác) → lỗi
  `item list does not match its authenticated index`, không ghi gì (fail closed).
- Validator: v3 thiếu hoặc sai dạng `item_index` → từ chối trước khi giải mã;
  revision > 2^53-1 → từ chối. id/vault_id chứa lone surrogate → từ chối (TextEncoder
  sẽ biến nó thành U+FFFD, làm encoding không còn đơn ánh).
- Migration: v2 (không index) vẫn restore/import được; hàm trả `'unverifiable-legacy'`
  và UI hiện `backup.itemListUnverified` ("integrity of the item list not verifiable —
  made with an older version"). Không có cách đọc lại hay nâng cấp file v2 cũ: export
  lại từ app để có v3.
- Giới hạn đã biết: (1) downgrade — kẻ sửa file có thể xóa `item_index` và đặt
  `format_version` 2; file vẫn restore nhưng UI hiện cảnh báo legacy. Muốn chặn hẳn
  phải bỏ hỗ trợ v2. (2) Phát lại nguyên một backup v3 cũ hợp lệ (§ rollback (b)).
- Test: `packages/import-export/tests/backup-corruption.real.test.ts` (known-answer
  của `index`, mọi kiểu thiếu/thừa/đổi, index giả bằng Vault Key trực tiếp),
  `tests/acceptance/recovery-failures.test.ts` (K2-omission × 3 app),
  `tests/e2e-web-restore/*` (UI), vector HKDF ở `tests/crypto-vectors/hkdf-vectors.json`.

## HKDF-SHA-256 (RFC 5869)
- KHÔNG dùng `crypto_kdf_derive_from_key`: hàm đó dùng BLAKE2b, subkey
  theo context 8 byte cố định, không phải HKDF và không nhận `info` tùy ý
  hay độ dài output tùy ý.
- Implement bằng HMAC-SHA-256 (`crypto_auth_hmacsha256`):
  - Extract: `PRK = HMAC-SHA-256(salt, IKM)`, salt mặc định = 32 byte 0.
  - Expand: `T(1) = HMAC(PRK, info || 0x01)`, `T(i) = HMAC(PRK, T(i-1) || info || i)`; OKM = `length` byte đầu của `T(1) || T(2) || ...`.
  - `length` cho phép 1..8160 byte (255 × 32).
- Rust `hkdf_sha256(ikm, salt, info, len)` (RustCrypto `hkdf`). Với salt `None`
  hoặc 32 byte 0 cho cùng kết quả với TS (HMAC pad key bằng 0).
- Nhãn `info` đang dùng: `"my-secrect/backup-item-index/v1"` (index key của backup v3,
  IKM = Vault Key) và `"my-secrect/recovery-verifier/v1"` (`specs/recovery-protocol.md`).
  Nhãn mới = thêm vector. Vector chéo: `tests/crypto-vectors/hkdf-vectors.json`
  (Rust tạo, có vector cho nhãn backup-item-index; TS adapter + OpenSSL `hkdfSync` kiểm)
  và RFC 5869 A.3 ở cả hai phía.

## File / blob (`packages/storage/src/upload.ts`)
- Mỗi file có File Key riêng (32 byte ngẫu nhiên). Chunk độc lập, nonce không trùng (hoặc subkey riêng/chunk).
- Manifest (`format_version` 1) mã hóa bằng Vault Key, ràng buộc: `blob_id`, kích thước plaintext,
  `chunk_size`, danh sách chunk (part_number, byte range, nonce, kích thước + SHA-256 của ciphertext),
  SHA-256 của toàn bộ plaintext (`plaintext_sha256_b64`, tùy chọn với manifest cũ), tên file, MIME,
  và File Key đã wrap bằng Vault Key (`wrapped_file_key`). Thiết bị nào có Vault Key (thiết bị thứ hai
  restore cùng vault) đều giải mã được. Download từ chối manifest có `blob_id` khác blob được yêu cầu.
- Upload hai lượt (bộ nhớ không phụ thuộc kích thước file): lượt 1 mã hóa từng chunk với nonce mới chỉ để
  ghi nonce + hash vào manifest; lượt 2 mã hóa lại với ĐÚNG nonce đã ghi (ra cùng ciphertext), so hash
  với manifest rồi mới PUT. File đổi giữa hai lượt → hash lệch → không gửi gì (không bao giờ có hai
  ciphertext khác nhau cùng một nonce rời thiết bị).
- Download kiểm tra từng chunk (kích thước, SHA-256 theo manifest, tag AEAD) trước khi giải mã, rồi hash
  toàn file; lỗi bất kỳ → hủy, không trả/hiển thị plaintext nào.
- Thumbnail tạo trên client, mã hóa và upload thành blob RIÊNG (File Key riêng); item lưu
  `thumbnail_blob_id`. Manifest cũ có thể nhúng `thumbnail` (mã hóa bằng File Key) — vẫn đọc được.
  Không dùng thumbnail generation của server.
- Upload qua presigned URL ngắn hạn (5 phút), client upload ciphertext trực tiếp lên R2/S3/MinIO.
  API (`POST /v1/blobs/upload-session`) nhận `part_count`, `part_size`, `ciphertext_size`,
  `encrypted_manifest`; mọi part trừ part cuối có đúng `part_size` byte, kích thước từng part được ký
  vào URL (Content-Length là signed header) nên storage từ chối độ dài khác. Gọi lại cùng `blob_id` +
  manifest + layout khi session chưa hết hạn (24 h) = resume: URL mới, mỗi part có `stored` theo
  storage. Complete kiểm tra từng part tồn tại đúng kích thước và quota.
- **File encryption qua libsodium `secretstream` (ghi chú — chưa implement
  trong prototype; chỉ dùng cho file tuần tự, không dùng cho item nhỏ).**

## Key rotation (v1)
- **Đổi passphrase (đã implement ở cả 3 app, `changePassphrase`):** verify
  passphrase cũ, derive KEK mới với **salt mới**, wrap lại đúng Account Master
  Key cũ. `wrapped_recovery`, Vault Key, Item Key và payload giữ nguyên —
  recovery key cũ vẫn dùng được.
- **Nghi lộ Vault Key (CHƯA implement):** lộ Vault Key = lộ mọi Item Key từng
  wrap bằng nó (server giữ sẵn mọi `encrypted_item_key`). Vì vậy phải tạo
  Vault Key mới, wrap bằng AMK, và **mã hóa lại mọi payload bằng Item Key mới**;
  chỉ re-wrap Item Key cũ là KHÔNG đủ.
- **Nghi lộ AMK (CHƯA implement):** tương tự — AMK mới, Vault Key mới, mã hóa lại
  mọi payload; wrap AMK mới bằng KEK + recovery KEK (recovery key mới).
- Mọi rotation đều tăng `encryption_version` khi format thay đổi; rotation
  chỉ đổi key (cùng format) thì ghi log/audit, không đổi version.
- Test bắt buộc khi implement: unlock bằng passphrase cũ thất bại sau rotation,
  unlock bằng passphrase mới + recovery key mới thành công, dữ liệu item nguyên vẹn.

## Test vector và test chéo TS ↔ Rust
| File (`tests/crypto-vectors/`) | Ai tạo | Ai kiểm |
|---|---|---|
| `argon2id-vectors.json` | libsodium qua PyNaCl | Rust `tests/vectors.rs`; TS mirror `argon2id-vectors.test.mjs`; TS adapter thật `packages/crypto-adapters/tests/libsodium-adapter.import.test.mjs`; **OpenSSL** Argon2id (`node:crypto.argon2Sync`, Node ≥ 24.7) trong `cross-impl.test.ts` |
| `chain-ts.json` | code app TS thật (desktop, extension, mobile: `createVault` + `upsertItem` + `exportEncrypted`) — `npx tsx packages/crypto-adapters/scripts/gen-chain-vectors.ts` | Rust `native/crypto-core/tests/cross_impl.rs` mở từng tầng + recovery |
| `chain-rust.json` | chỉ Rust crate — `cargo run --example gen_chain_vectors` (trong `native/crypto-core`) | TS: adapter từng tầng + `restoreEncrypted` / `unlockVault` / `unlockWithRecoveryKey` thật của desktop, extension, mobile |
| `item-v2-vectors.json` | Rust, nonce cố định (tất định) | Rust + TS dựng lại AD và ciphertext từng byte |
| `hkdf-vectors.json` | Rust (tất định), gồm nhãn `my-secrect/backup-item-index/v1` | TS adapter + OpenSSL `hkdfSync`; test import-export kiểm nhãn nó dùng có vector |

Chạy: `cd native/crypto-core && cargo test`; `npx tsx --test packages/crypto-adapters/tests/cross-impl.test.ts`
(cũng nằm trong root `npm test`). Không bao giờ sửa tay giá trị expected; sinh lại bằng đúng lệnh trên.

`chain-ts.json` / `chain-rust.json` là backup `format_version` 2 (chưa sinh lại sau v3):
TS restore chúng qua đường legacy (`'unverifiable-legacy'`). Rust chưa có reader cho
`item_index`; sinh lại `chain-ts.json` sẽ ra v3 và `cross_impl.rs` (đang assert
`format_version` 2) phải được cập nhật cùng lúc.

## Những gì spec này CHƯA quyết (phải chốt trước khi code dữ liệu thật)
- Tham số Argon2id trên mobile thấp: v1 dùng INTERACTIVE (2 / 64 MiB);
  benchmark lại trên thiết bị yếu trước khi lock cho mobile, có thể cần
  bộ tham số riêng cho mobile (version hóa theo `ARGON2ID_PARAMS.version`).
- Unicode normalization của passphrase (xem `specs/key-management.md`): đổi = KDF version mới.
- Thời điểm và thứ tự rollout v2 (§ migration), nguồn `vault_id` ổn định.
- Event sync ký thật + checkpoint tin cậy để chống rollback / tombstone giả.
