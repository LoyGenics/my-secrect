/**
 * Cross-implementation tests, TypeScript side. Nothing here is a mirror:
 * every check goes through packages/crypto-adapters/src/index.ts and,
 * where an app is involved, through that app's real vault module (only
 * platform storage is shimmed — see ./support/app-vaults.ts).
 *
 * Fixtures (tests/crypto-vectors/):
 *  - chain-rust.json       written by native/crypto-core ONLY
 *                          (cargo run --example gen_chain_vectors);
 *                          restored here through the desktop, extension
 *                          and mobile restore code.
 *  - chain-ts.json         written by the real TS apps
 *                          (scripts/gen-chain-vectors.ts); opened by
 *                          native/crypto-core/tests/cross_impl.rs.
 *  - item-v2-vectors.json  fixed-nonce v2 known answers (Rust-generated).
 *  - hkdf-vectors.json     HKDF-SHA-256 (Rust-generated), also checked
 *                          against OpenSSL here.
 *  - argon2id-vectors.json PyNaCl/libsodium; also checked against OpenSSL
 *                          here when node:crypto has argon2 (Node >= 24.7).
 * Expected values come only from those files. Never edit one to pass.
 *
 * Run: npx tsx --test packages/crypto-adapters/tests/cross-impl.test.ts
 * (also pulled into root `npm test` via libsodium-adapter.import.test.mjs).
 */
import assert from 'node:assert/strict';
import * as nodeCrypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import sodium from 'libsodium-wrappers-sumo';
import {
  ARGON2ID_PARAMS,
  DEFAULT_ITEM_ENCRYPTION_VERSION,
  ITEM_AD_V2_LABELS,
  ITEM_AD_V2_MAX_ID_BYTES,
  ITEM_ENCRYPTION_V1,
  ITEM_ENCRYPTION_V2,
  decryptItemPayloadV2,
  fromBase64,
  fromBase64Url,
  itemAdV2,
  libsodiumAdapter,
  sha256,
  sodiumReady,
  toBase64,
  unwrapItemKeyV2,
  wrapItemKeyV2,
  type ItemBindingV2,
} from '../src/index.ts';
import { loadAppVaults, storage } from './support/app-vaults.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fixture = (name: string): any =>
  JSON.parse(readFileSync(path.join(repoRoot, 'tests/crypto-vectors', name), 'utf8'));

const argonVectors = fixture('argon2id-vectors.json');
const rustChain = fixture('chain-rust.json');
const tsChain = fixture('chain-ts.json');
const v2Vectors = fixture('item-v2-vectors.json');
const hkdfVectors = fixture('hkdf-vectors.json');

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const unhex = (s: string) => new Uint8Array(Buffer.from(s, 'hex'));
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const split24 = (b64: string) => {
  const bytes = fromBase64(b64);
  return { nonce: bytes.subarray(0, 24), rest: bytes.subarray(24) };
};
const binding = (b: { vault_id: string; item_id: string; revision: number }): ItemBindingV2 => ({
  vaultId: b.vault_id,
  itemId: b.item_id,
  revision: b.revision,
});

test.before(async () => {
  await sodiumReady;
});

// ---------------------------------------------------------------------------
// Parameters and independent re-derivation
// ---------------------------------------------------------------------------

test('libsodium runtime constants are the frozen v1 profile', () => {
  const s = sodium as unknown as Record<string, number>;
  assert.equal(s.crypto_pwhash_ALG_ARGON2ID13, 2);
  assert.equal(s.crypto_pwhash_OPSLIMIT_INTERACTIVE, ARGON2ID_PARAMS.opslimit);
  assert.equal(s.crypto_pwhash_MEMLIMIT_INTERACTIVE, ARGON2ID_PARAMS.memlimit);
  assert.equal(s.crypto_pwhash_SALTBYTES, ARGON2ID_PARAMS.saltBytes);
  assert.equal(s.crypto_aead_xchacha20poly1305_ietf_KEYBYTES, 32);
  assert.equal(s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES, 24);
  assert.equal(s.crypto_aead_xchacha20poly1305_ietf_ABYTES, 16);
});

const opensslArgon2 = (nodeCrypto as unknown as {
  argon2Sync?: (alg: string, p: Record<string, unknown>) => Buffer;
}).argon2Sync;

test(
  'Argon2id KEKs reproduce under an independent implementation (OpenSSL via node:crypto)',
  { skip: typeof opensslArgon2 !== 'function' && 'node:crypto.argon2Sync needs Node >= 24.7' },
  () => {
    // libsodium crypto_pwhash(ALG_ARGON2ID13) = Argon2id v1.3, lanes 1,
    // m = memlimit / 1024 KiB, t = opslimit. Same inputs through OpenSSL
    // must give the same bytes, so the shared vectors are not merely
    // libsodium agreeing with itself.
    const derive = (passphrase: string, salt: Uint8Array) =>
      opensslArgon2!('argon2id', {
        message: Buffer.from(passphrase, 'utf8'),
        nonce: Buffer.from(salt),
        parallelism: 1,
        tagLength: ARGON2ID_PARAMS.outputBytes,
        memory: ARGON2ID_PARAMS.memlimit / 1024,
        passes: ARGON2ID_PARAMS.opslimit,
      }).toString('hex');
    for (const v of argonVectors.argon2id.vectors) {
      assert.equal(derive(v.passphrase, unhex(v.salt_hex)), v.kek_hex, v.id);
    }
    assert.equal(
      derive(rustChain.passphrase, fromBase64(rustChain.export.keys.salt)),
      rustChain.expected.kek_hex,
      'Rust KEK',
    );
    for (const [name, app] of Object.entries<any>(tsChain.apps)) {
      assert.equal(derive(app.passphrase, fromBase64(app.export.keys.salt)), app.kek_hex, `${name} KEK`);
    }
  },
);

// ---------------------------------------------------------------------------
// Rust wrote it, TypeScript opens it
// ---------------------------------------------------------------------------

test('Rust-written chain opens layer by layer with libsodiumAdapter', { timeout: 120_000 }, async () => {
  const { keys } = rustChain.export;
  const exp = rustChain.expected;
  const kek = await libsodiumAdapter.deriveKek(rustChain.passphrase, fromBase64(keys.salt));
  assert.equal(hex(kek), exp.kek_hex, 'Argon2id KEK, non-ASCII passphrase');
  const amk = await libsodiumAdapter.unwrapKey(kek, fromBase64(keys.wrapped_master_nonce), fromBase64(keys.wrapped_master));
  assert.equal(hex(amk), exp.amk_hex);

  // Recovery path: unpadded base64url -> 32 bytes -> SHA-256 -> unwrap.
  const rk = fromBase64Url(rustChain.recovery_key);
  assert.equal(rk.length, 32);
  const rkek = await sha256(rk);
  assert.equal(hex(rkek), exp.recovery_kek_hex);
  const amk2 = await libsodiumAdapter.unwrapKey(rkek, fromBase64(keys.wrapped_recovery_nonce), fromBase64(keys.wrapped_recovery));
  assert.equal(hex(amk2), exp.amk_hex);

  const vk = await libsodiumAdapter.unwrapKey(amk, fromBase64(keys.wrapped_vault_nonce), fromBase64(keys.wrapped_vault));
  assert.equal(hex(vk), exp.vault_key_hex);

  assert.equal(rustChain.export.items.length, exp.items.length);
  for (const row of rustChain.export.items) {
    assert.equal(row.encryption_version, ITEM_ENCRYPTION_V1);
    const want = exp.items.find((i: { item_id: string }) => i.item_id === row.item_id);
    const wk = split24(row.encrypted_item_key);
    const itemKey = await libsodiumAdapter.unwrapKey(vk, wk.nonce, wk.rest);
    assert.equal(hex(itemKey), want.item_key_hex);
    const p = split24(row.encrypted_payload);
    assert.deepEqual(JSON.parse(text(await libsodiumAdapter.decrypt(itemKey, p.nonce, p.rest))), want.plaintext);
  }
});

test('Rust-written backup restores through the real desktop, extension and mobile vault code', { timeout: 180_000 }, async () => {
  const vaults = await loadAppVaults();
  const json = JSON.stringify(rustChain.export);
  const want = rustChain.expected.items.map((i: { plaintext: unknown }) => i.plaintext);
  const sortById = <T extends { id: string }>(xs: T[]) => [...xs].sort((a, b) => a.id.localeCompare(b.id));

  const apps = [
    {
      name: 'desktop',
      restore: vaults.desktop.restoreEncrypted,
      list: () => vaults.desktop.listItems(true),
      lock: async () => vaults.desktop.lockVault(),
      unlock: vaults.desktop.unlockVault,
      unlockWithRecoveryKey: vaults.desktop.unlockWithRecoveryKey,
      wipe: async () => vaults.desktop.wipeVault(),
    },
    {
      name: 'extension',
      restore: vaults.extension.restoreEncrypted,
      list: () => vaults.extension.listUnlockedItems(),
      lock: async () => vaults.extension.lockVault(),
      unlock: vaults.extension.unlockVault,
      unlockWithRecoveryKey: vaults.extension.unlockWithRecoveryKey,
      wipe: () => vaults.extension.wipeVault(),
    },
    {
      name: 'mobile',
      restore: vaults.mobile.restoreEncrypted,
      list: () => vaults.mobile.listItems(true),
      lock: async () => vaults.mobile.lockVault(),
      unlock: vaults.mobile.unlockVault,
      unlockWithRecoveryKey: vaults.mobile.unlockWithRecoveryKey,
      wipe: () => vaults.mobile.wipeVault(),
    },
  ];

  for (const app of apps) {
    // Fresh device, passphrase (Argon2id KEK).
    await app.restore(json, { passphrase: rustChain.passphrase });
    assert.deepEqual(sortById(app.list()), sortById(want), `${app.name}: passphrase restore`);
    // The restored envelope unlocks again with both secrets.
    await app.lock();
    assert.equal(await app.unlockWithRecoveryKey(rustChain.recovery_key), true, `${app.name}: recovery unlock`);
    assert.deepEqual(sortById(app.list()), sortById(want));
    await app.lock();
    assert.equal(await app.unlock(rustChain.passphrase), true, `${app.name}: passphrase unlock`);
    await app.lock();
    await app.wipe();

    // Fresh device, recovery key (SHA-256 KEK).
    await app.restore(json, { recoveryKey: rustChain.recovery_key });
    assert.deepEqual(sortById(app.list()), sortById(want), `${app.name}: recovery-key restore`);
    await app.lock();
    await app.wipe();
  }
  assert.equal(storage.desktop.size, 0);
  assert.equal(storage.extension.size, 0);
  assert.equal(storage.mobile.size, 0);
});

test('a tampered or row-swapped Rust backup is rejected by every app and nothing is written', { timeout: 180_000 }, async () => {
  const vaults = await loadAppVaults();
  const flip = (b64: string) => { const b = fromBase64(b64); b[b.length - 1] ^= 0x01; return toBase64(b); };

  const tampered = structuredClone(rustChain.export);
  tampered.items[1].encrypted_payload = flip(tampered.items[1].encrypted_payload);

  // Substitution (a): row 0 keeps its item_id but carries row 1's
  // ciphertext AND wrapped key. v1 AEAD (AD = null) verifies; only the
  // decrypted-id check in each app catches it.
  const swapped = structuredClone(rustChain.export);
  swapped.items[0].encrypted_payload = rustChain.export.items[1].encrypted_payload;
  swapped.items[0].encrypted_item_key = rustChain.export.items[1].encrypted_item_key;

  for (const [name, restore] of [
    ['desktop', vaults.desktop.restoreEncrypted],
    ['extension', vaults.extension.restoreEncrypted],
    ['mobile', vaults.mobile.restoreEncrypted],
  ] as const) {
    await assert.rejects(restore(JSON.stringify(tampered), { passphrase: rustChain.passphrase }), /could not decrypt/, `${name}: tamper`);
    await assert.rejects(restore(JSON.stringify(swapped), { passphrase: rustChain.passphrase }), /does not match/, `${name}: swap`);
  }
  assert.equal(storage.desktop.size, 0);
  assert.equal(storage.extension.size, 0);
  assert.equal(storage.mobile.size, 0);
});

// ---------------------------------------------------------------------------
// TypeScript wrote it (checked by Rust in cross_impl.rs) — regression here
// ---------------------------------------------------------------------------

test('TS-written app backups still open with the adapter; passphrases are not normalised', { timeout: 120_000 }, async () => {
  for (const [name, app] of Object.entries<any>(tsChain.apps)) {
    const { keys } = app.export;
    const kek = await libsodiumAdapter.deriveKek(app.passphrase, fromBase64(keys.salt));
    assert.equal(hex(kek), app.kek_hex, name);
    const amk = await libsodiumAdapter.unwrapKey(kek, fromBase64(keys.wrapped_master_nonce), fromBase64(keys.wrapped_master));
    const vk = await libsodiumAdapter.unwrapKey(amk, fromBase64(keys.wrapped_vault_nonce), fromBase64(keys.wrapped_vault));
    for (const row of app.export.items) {
      assert.equal(row.encryption_version, DEFAULT_ITEM_ENCRYPTION_VERSION, `${name}: apps write v1`);
      const wk = split24(row.encrypted_item_key);
      const p = split24(row.encrypted_payload);
      const itemKey = await libsodiumAdapter.unwrapKey(vk, wk.nonce, wk.rest);
      const item = JSON.parse(text(await libsodiumAdapter.decrypt(itemKey, p.nonce, p.rest)));
      assert.deepEqual(item, app.expected_items.find((i: { id: string }) => i.id === row.item_id));
    }
  }
  // Known v1 limitation (specs/key-management.md): the KEK input is the
  // raw UTF-8 of the passphrase. The desktop fixture passphrase is NFD;
  // its NFC spelling is a different passphrase on every platform.
  const nfd: string = tsChain.apps.desktop.passphrase;
  assert.notEqual(nfd, nfd.normalize('NFC'));
  const salt = fromBase64(tsChain.apps.desktop.export.keys.salt);
  assert.notEqual(hex(await libsodiumAdapter.deriveKek(nfd.normalize('NFC'), salt)), tsChain.apps.desktop.kek_hex);
});

// ---------------------------------------------------------------------------
// Item encryption v2 (primitives only; apps still write v1)
// ---------------------------------------------------------------------------

async function checkV2Section(v2: any) {
  assert.equal(v2.encryption_version, ITEM_ENCRYPTION_V2);
  const b = binding(v2.binding);
  const vk = unhex(v2.vault_key_hex);
  const wk = split24(v2.encrypted_item_key);
  const p = split24(v2.encrypted_payload);
  const itemKey = await unwrapItemKeyV2(vk, wk.nonce, wk.rest, b);
  assert.equal(hex(itemKey), v2.item_key_hex);
  assert.deepEqual(JSON.parse(text(await decryptItemPayloadV2(itemKey, p.nonce, p.rest, b))), v2.plaintext);

  // (a) another item, (c) another vault, (b) an older revision: all fail.
  for (const wrong of [
    { ...b, itemId: 'item_other' },
    { ...b, vaultId: 'vault_other' },
    { ...b, revision: b.revision - 1 },
  ]) {
    await assert.rejects(unwrapItemKeyV2(vk, wk.nonce, wk.rest, wrong));
    await assert.rejects(decryptItemPayloadV2(itemKey, p.nonce, p.rest, wrong));
  }
  // Relabelled as v1 (AD = null): never opens.
  await assert.rejects(libsodiumAdapter.unwrapKey(vk, wk.nonce, wk.rest));
  await assert.rejects(libsodiumAdapter.decrypt(itemKey, p.nonce, p.rest));
  // A wrapped key is not a payload (different label).
  await assert.rejects(decryptItemPayloadV2(vk, wk.nonce, wk.rest, b));
}

test('Rust-written v2 item opens in TS only under its own binding', async () => {
  await checkV2Section(rustChain.v2);
});

test('TS-written v2 item still opens (Rust checks it in cross_impl.rs)', async () => {
  await checkV2Section(tsChain.v2);
});

test('v2 known-answer vectors: TS rebuilds the AD and the exact ciphertext', async () => {
  assert.deepEqual(v2Vectors.labels, { payload: ITEM_AD_V2_LABELS.payload, key_wrap: ITEM_AD_V2_LABELS.keyWrap });
  const itemKey = unhex(v2Vectors.item_key_hex);
  const vaultKey = unhex(v2Vectors.vault_key_hex);
  assert.equal(v2Vectors.vectors.length, 3);
  for (const v of v2Vectors.vectors) {
    const b = binding(v);
    const payloadAd = itemAdV2('payload', b);
    const wrapAd = itemAdV2('keyWrap', b);
    assert.equal(hex(payloadAd), v.payload_ad_hex, v.id);
    assert.equal(hex(wrapAd), v.key_wrap_ad_hex, v.id);
    // The adapter never takes a caller nonce, so the fixed-nonce check
    // calls libsodium directly with the adapter-built AD.
    const pn = unhex(v.payload_nonce_hex);
    const wn = unhex(v.key_wrap_nonce_hex);
    const pt = new TextEncoder().encode(v.plaintext);
    assert.equal(hex(sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(pt, payloadAd, null, pn, itemKey)), v.payload_ciphertext_hex);
    assert.equal(hex(sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(itemKey, wrapAd, null, wn, vaultKey)), v.wrapped_item_key_hex);
    // Public v2 API opens the vector.
    assert.equal(hex(await unwrapItemKeyV2(vaultKey, wn, unhex(v.wrapped_item_key_hex), b)), v2Vectors.item_key_hex);
    assert.equal(text(await decryptItemPayloadV2(itemKey, pn, unhex(v.payload_ciphertext_hex), b)), v.plaintext);
    await assert.rejects(libsodiumAdapter.decrypt(itemKey, pn, unhex(v.payload_ciphertext_hex)));
  }
});

test('itemAdV2 rejects bindings Rust would reject or could not represent', () => {
  const ok = { vaultId: 'v', itemId: 'i', revision: 0 };
  assert.doesNotThrow(() => itemAdV2('payload', ok));
  const bad: ItemBindingV2[] = [
    { ...ok, vaultId: '' },
    { ...ok, itemId: '' },
    { ...ok, itemId: 'x'.repeat(ITEM_AD_V2_MAX_ID_BYTES + 1) },
    { ...ok, itemId: 'lone \ud800 surrogate' },
    { ...ok, revision: -1 },
    { ...ok, revision: 1.5 },
    { ...ok, revision: Number.MAX_SAFE_INTEGER + 1 },
  ];
  for (const b of bad) assert.throws(() => itemAdV2('payload', b), undefined, JSON.stringify(b));
  assert.throws(() => itemAdV2('nope' as never, ok));
  // Length prefixes keep ("ab","c") and ("a","bc") apart.
  assert.notEqual(
    hex(itemAdV2('payload', { vaultId: 'ab', itemId: 'c', revision: 1 })),
    hex(itemAdV2('payload', { vaultId: 'a', itemId: 'bc', revision: 1 })),
  );
});

test('v2 round-trips through the adapter and v1 stays the default writer', async () => {
  assert.equal(DEFAULT_ITEM_ENCRYPTION_VERSION, ITEM_ENCRYPTION_V1);
  const vk = libsodiumAdapter.randomBytes(32);
  const ik = libsodiumAdapter.randomBytes(32);
  const b = { vaultId: 'vault_rt', itemId: 'item_rt', revision: 9 };
  const w = await wrapItemKeyV2(vk, ik, b);
  assert.equal(hex(await unwrapItemKeyV2(vk, w.nonce, w.wrapped, b)), hex(ik));
  await assert.rejects(wrapItemKeyV2(vk, ik.subarray(0, 31), b));
});

// ---------------------------------------------------------------------------
// HKDF and wrap-length parity
// ---------------------------------------------------------------------------

test('adapter hkdf matches the Rust vectors, OpenSSL, and RFC 5869 case 3', async () => {
  const ikm = unhex(hkdfVectors.ikm_hex);
  for (const v of hkdfVectors.vectors) {
    assert.equal(hex(await libsodiumAdapter.hkdf(ikm, v.info, v.length)), v.okm_hex, v.id);
    const openssl = nodeCrypto.hkdfSync('sha256', ikm, new Uint8Array(32), new TextEncoder().encode(v.info), v.length);
    assert.equal(Buffer.from(openssl).toString('hex'), v.okm_hex, `${v.id} (OpenSSL)`);
  }
  // RFC 5869 A.3: IKM = 0x0b * 22, salt and info empty, L = 42.
  assert.equal(
    hex(await libsodiumAdapter.hkdf(new Uint8Array(22).fill(0x0b), '', 42)),
    '8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8',
  );
});

test('wrapKey / unwrapKey insist on 32-byte keys, like crypto-core', async () => {
  const kek = libsodiumAdapter.randomBytes(32);
  await assert.rejects(libsodiumAdapter.wrapKey(kek, new Uint8Array(31)), /32 bytes/);
  const notAKey = await libsodiumAdapter.encrypt(kek, new Uint8Array(31));
  await assert.rejects(libsodiumAdapter.unwrapKey(kek, notAKey.nonce, notAKey.ciphertext), /32 bytes/);
});
