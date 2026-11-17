# Recovery Protocol — v1 (DRAFT)

## 3 đường recovery
1. Login lại + unlock bằng master passphrase.
2. Chuyển khóa từ thiết bị tin cậy (HPKE / protocol đã kiểm chứng, có challenge chống replay).
3. Recovery key entropy cao lưu offline + quy trình khôi phục tài khoản.

Khôi phục vault lên thiết bị mới từ **bản sao lưu mã hóa** (passphrase hoặc
recovery key + file backup) — định dạng ở `specs/encryption-format.md`:
- Backup `format_version` 3: danh sách item có xác thực (§ Backup item index).
  File bị bớt/thêm/đổi revision một row → restore thất bại, không ghi gì.
- Backup `format_version` 2 (bản cũ): vẫn restore được, nhưng KHÔNG phát hiện được
  row bị xóa; UI phải báo "integrity of the item list not verifiable — made with
  an older version" (`backup.itemListUnverified`). Export lại để có v3.

## Yêu cầu cho mọi endpoint recovery
- Challenge + chống replay + xác thực lại + kiểm tra quyền đặc biệt.
- Không bao giờ để server suy ra được khóa giải mã từ quá trình recovery.
- Recovery key phải được tạo bằng CSPRNG, hiển thị 1 lần, người dùng xác nhận đã lưu trước khi tiếp tục.

## Recovery verifier key (account recovery sign-in)

The server can let a user prove account ownership with the recovery key
without ever seeing it: the client registers an Ed25519 **verifier** public
key (`POST /api/v1/recovery/verifiers`, step-up required) and later signs a
single-use server challenge with the private half
(`POST /api/v1/recovery/challenges` → `POST /api/v1/recovery/verify`, a
15-minute recovery session). This proves ownership of the ACCOUNT only; it
never recovers a vault key.

The same 32-byte recovery key is also the input of the vault's recovery KEK
(`SHA-256(recovery key)`, `apps/desktop/src/vault.ts`). The verifier key is
therefore derived with domain separation, so the key registered on the
server is never the vault-unwrapping secret used in another role:

```
seed   = HKDF-SHA-256(IKM = recovery key (32 bytes), salt = 32 zero bytes,
                      info = "my-secrect/recovery-verifier/v1", L = 32)
keypair = Ed25519 crypto_sign_seed_keypair(seed)
```

- HKDF is `hkdfSha256` in `packages/crypto-adapters` (libsodium HMAC-SHA-256,
  RFC 5869); clients call `recoveryVerifierKeyPair` in
  `packages/sdk/src/recovery-verifier.ts`. The seed and private key live in
  memory only and are zero-filled after use.
- Registration sends `derivation: "v1-hkdf-sha256"`; the server stores it per
  verifier and refuses any other value (422 `unsupported_derivation`).
  Registering revokes every older verifier of the account.
- **Legacy v0** (before this change): `seed = recovery key`. Existing v0
  verifiers are kept (column `recovery_verifiers.derivation =
  'v0-raw-recovery-key'`) so nobody is locked out: recovery sign-in tries the
  v1 key first and, on a 401, retries ONCE with the v0 key over a fresh
  challenge. Migration = re-register from the Security Center (desktop/web or
  mobile), which replaces the v0 verifier with a v1 one. When
  `GET /api/v1/recovery/verifiers` (field `derivation`) shows no active v0
  verifiers, delete the v0 fallback (`legacyRecoveryVerifierKeyPair`) and
  start refusing v0 verifiers at verify time.

Test vector (`packages/sdk/tests/recovery-verifier.test.ts`, cross-checked
with Node's independent `hkdfSync`):

```
recovery key = 000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f
seed         = ba6cae182e0e07662e361b5cc965f4ad23d7cba4dd39141a594d249f1bc7ad2e
public key   = efL6ta1EHZPiP7pUhUjbWe9G_qoAvGa3FnfhRKdWtwM   (base64url)
```

## Key rotation
- Đổi passphrase thường: re-wrap Account Master Key.
- Nghi lộ: rotation + re-encrypt dữ liệu liên quan, thu hồi key envelopes cũ, ghi audit event.
