# Encryption Format — v1 (CHỐT, chưa audit)

> Status: parameters below are LOCKED for v1. Do not change a value without
> bumping the format/encryption version and writing a migration + test
> vectors. Nothing in this repo is audited or production-ready.

## Nguyên tắc
- Không tự viết thuật toán. Dùng libsodium đã kiểm chứng (`libsodium-wrappers-sumo` in JS/TS; native crypto-core in Rust + libsodium for the audited path).
- Mọi ciphertext đều là AEAD: không có plaintext + tag hợp lệ thì reject.
- Không reuse nonce dưới cùng một key. Mỗi item/file có key riêng (envelope encryption).
- Mọi định dạng đều có version. Migration phải có test vector.

## Thuật toán — tham số đã chốt (v1)
| Mục đích | Công nghệ | Tham số chính xác |
|---|---|---|
| KDF (passphrase → KEK) | Argon2id (`crypto_pwhash`, `ALG_ARGON2ID13`) | opslimit = `OPSLIMIT_INTERACTIVE` = **2**; memlimit = `MEMLIMIT_INTERACTIVE` = **67108864 bytes (64 MiB)**; salt **16 bytes** ngẫu nhiên; output **32 bytes** |
| Item nhỏ | XChaCha20-Poly1305 (`crypto_aead_xchacha20poly1305_ietf`) | key **32 bytes**; nonce **24 bytes** ngẫu nhiên mỗi lần mã hóa; tag Poly1305 **16 bytes** |
| File tuần tự | libsodium `secretstream` | (ghi chú — chưa implement trong prototype) |
| Media random-access | AEAD theo chunk, nonce + manifest riêng | XChaCha20-Poly1305 IETF, AD rỗng, chunk 1 MiB plaintext, nonce 24 byte ngẫu nhiên mỗi chunk — xem § File / blob |
| Subkey derivation | HKDF-SHA-256 | HMAC-SHA-256 based, RFC 5869; salt mặc định 32 byte 0; xem § HKDF |
| Trao khóa | HPKE hoặc protocol đã kiểm chứng | (chưa implement) |
| Random | CSPRNG của OS qua `sodium.randombytes_buf` | — |

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

## Key hierarchy (v1)
```
passphrase --Argon2id (salt 16B, ops 2, mem 64 MiB)--> KEK (32B)
KEK --XChaCha20-Poly1305 wrap--> Account Master Key (32B, ngẫu nhiên)
Account Master Key --wrap--> Vault Key (32B, ngẫu nhiên)
Vault Key --wrap--> Item Key (32B, ngẫu nhiên, mới cho mỗi lần ghi item)
Item Key --XChaCha20-Poly1305 encrypt--> VaultItem JSON

Recovery: recovery key 32B ngẫu nhiên, base64url, hiển thị 1 lần duy nhất.
  recovery KEK = SHA-256(recovery key bytes)  [sodium.crypto_hash_sha256]
  recovery KEK --wrap--> Account Master Key (lưu wrapped_recovery + nonce)
Mất cả passphrase lẫn recovery key = mất vault. Không có reset.
```

## Byte layout — ciphertext (v1)
- XChaCha20-Poly1305, nonce **24 bytes** ngẫu nhiên cho mỗi lần mã hóa, không bao giờ reuse dưới cùng một key.
- Layout khi lưu trữ/gộp: `nonce (24B) || ciphertext || Poly1305 tag (16B)`.
  libsodium trả ciphertext đã gồm tag 16B gắn cuối; tổng độ dài phần
  ciphertext = `len(plaintext) + 16`.
- Trong row lưu local / DB, nonce và ciphertext lưu **tách riêng** thành
  2 field base64 (`nonce`, `ciphertext`) — xem `EncryptedItemVersion` và
  `StoredRow`. Khi export (`VaultExport` v1), 2 field được gộp lại thành
  1 chuỗi base64 theo layout `nonce (24B) || ciphertext+tag`, và import
  tách 24 byte đầu làm nonce.
- Key wrap dùng cùng AEAD: wrapped key = ciphertext (gồm tag 16B) của
  key bytes, kèm nonce 24B riêng, lưu tách riêng (`wrapped_*` + `*_nonce`)
  hoặc gộp `nonce (24B) || wrapped` trong export (`encrypted_item_key`).

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
- `revision`: tăng 1 mỗi lần ghi; import merge giữ revision cao hơn.

## HKDF-SHA-256 (RFC 5869)
- KHÔNG dùng `crypto_kdf_derive_from_key`: hàm đó dùng BLAKE2b, subkey
  theo context 8 byte cố định, không phải HKDF và không nhận `info` tùy ý
  hay độ dài output tùy ý.
- Implement bằng HMAC-SHA-256 (`crypto_auth_hmacsha256`):
  - Extract: `PRK = HMAC-SHA-256(salt, IKM)`, salt mặc định = 32 byte 0.
  - Expand: `T(1) = HMAC(PRK, info || 0x01)`, `T(i) = HMAC(PRK, T(i-1) || info || i)`; OKM = `length` byte đầu của `T(1) || T(2) || ...`.
  - `length` cho phép 1..8160 byte (255 × 32).

## File / blob
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
- **Re-wrap (không re-encrypt item):** khi đổi passphrase, chỉ cần
  derive KEK mới và wrap lại Account Master Key (và cập nhật
  `wrapped_recovery` nếu recovery key được tạo mới). Vault Key, Item Key
  và mọi payload giữ nguyên — không cần giải mã/re-encrypt item nào.
- **Re-encrypt (khi Vault Key hoặc Item Key bị lộ / nghi lộ):** tạo
  Vault Key mới, wrap bằng Master Key, rồi với mỗi item: unwrap Item Key
  cũ, re-wrap bằng Vault Key mới (payload không cần re-encrypt vì Item
  Key không đổi). Chỉ khi Item Key bị lộ mới phải re-encrypt payload
  của item đó bằng Item Key mới.
- **Đổi Master Key:** wrap lại Vault Key + wrapped_recovery bằng Master
  Key mới; payload và Item Key giữ nguyên.
- Mọi rotation đều tăng `encryption_version` khi format thay đổi; rotation
  chỉ đổi key (cùng format) thì ghi log/audit, không đổi version.
- Rotation chưa implement trong prototype desktop (Phase 1): prototype chỉ
  có create/unlock/recovery; rotation là việc của giai đoạn sau và phải
  có test: unlock bằng passphrase cũ thất bại sau rotation, unlock bằng
  passphrase mới + recovery key mới thành công, dữ liệu item nguyên vẹn.

## Những gì spec này CHƯA quyết (phải chốt trước khi code dữ liệu thật)
- Tham số Argon2id trên mobile thấp: v1 dùng INTERACTIVE (2 / 64 MiB);
  benchmark lại trên thiết bị yếu trước khi lock cho mobile, có thể cần
  bộ tham số riêng cho mobile (version hóa theo `ARGON2ID_PARAMS.version`).
- Nonce management cho chunked media + chống replay/truncation.
- Test vectors chính thức cho Argon2id + XChaCha20-Poly1305 + HKDF-SHA-256
  (chưa có — phải thêm trước khi coi v1 là hoàn thiện).
