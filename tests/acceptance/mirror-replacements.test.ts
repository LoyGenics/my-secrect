/**
 * Real-module replacements for the rule-only mirror suites.
 *
 * Each `describe` names the mirror file it supersedes; each test names the
 * mirror test(s) it replaces. Everything here IMPORTS production code
 * (packages/* and apps/*); nothing is re-implemented. Where a mirror test
 * has no production counterpart (the rule is not implemented, or it is
 * server-side and covered by RSpec / a real-stack test), that is recorded in
 * docs/acceptance-matrix.md §3 instead of being faked here.
 *
 * Run: npx tsx --test tests/acceptance/mirror-replacements.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { libsodiumAdapter as A, sodiumReady, fromBase64Url, toBase64 } from '../../packages/crypto-adapters/src/index.ts';
import {
  CHUNK_SIZE, MANIFEST_VERSION, chunkIndexForByteRange, decryptChunks, encryptChunks, splitIntoChunks, verifyManifest,
  type BlobManifest,
} from '../../packages/storage/src/upload.ts';
import {
  ENCRYPTED_EXPORT_FORMAT, buildEncryptedExport, validateEncryptedExport, type WrappedKeyEnvelope,
} from '../../packages/import-export/src/index.ts';
import {
  SYNC_QUEUE_KEY, applyRemoteEvents, detectConflict, detectDeleteConflict, enqueuePush, loadQueue, memorySyncStorage,
  resolveConflictKeepBoth, type LocalItemState, type SyncEvent,
} from '../../packages/sync/src/index.ts';
import {
  classifySignInError, initialSignInState, mfaVerified, optionsReceived, passkeyVerified, signInFailed, startSignIn,
} from '../../packages/sdk/src/signin.ts';
import {
  LS_ACCOUNT_EMAIL, LS_API_TOKEN, LS_API_TOKEN_EXPIRES_AT, STEP_UP_WINDOW_MS, adoptRotatedToken, clearSessionToken,
  getValidToken, isStepUpFresh, isStepUpRequired, saveSessionToken,
} from '../../packages/sdk/src/security.ts';
import { ApiError } from '../../packages/sdk/src/index.ts';
import { en } from '../../packages/i18n/src/en.ts';
import { vi } from '../../packages/i18n/src/vi.ts';
import type { VaultItem } from '../../packages/core/src/types';

const enc = new TextEncoder();
const flipAt = (b: Uint8Array, i: number) => { const c = b.slice(); c[i] ^= 0x01; return c; };

// ---------------------------------------------------------------------------
describe('supersedes tests/crypto-vectors/roundtrip.test.mjs + tests/security/tamper.test.mjs + reject-tampering-libsodium (cipher level)', () => {
  // The mirrors run AES-GCM (a reference cipher production never uses) or raw
  // libsodium calls. These go through the production libsodiumAdapter.
  test('round-trip, incl. empty plaintext (roundtrip: "encrypt/decrypt round-trip"; tamper: "empty plaintext")', async () => {
    await sodiumReady;
    const key = A.randomBytes(32);
    for (const pt of [enc.encode('hello vault'), new Uint8Array(0), new Uint8Array(randomBytes(70_000))]) {
      const { nonce, ciphertext } = await A.encrypt(key, pt);
      assert.equal(nonce.length, 24);
      assert.equal(ciphertext.length, pt.length + 16, 'ciphertext = plaintext + 16-byte tag (never silently empty)');
      assert.deepEqual(await A.decrypt(key, nonce, ciphertext), pt);
    }
  });

  test('any flipped bit in ciphertext or tag, or in the nonce, is rejected (roundtrip: "tampered ciphertext"; tamper: "tampered tag", "tampered nonce"; libsodium: "flipped byte")', async () => {
    const key = A.randomBytes(32);
    const { nonce, ciphertext } = await A.encrypt(key, enc.encode('my password'));
    for (const i of [0, Math.floor(ciphertext.length / 2), ciphertext.length - 16, ciphertext.length - 1]) {
      await assert.rejects(() => A.decrypt(key, nonce, flipAt(ciphertext, i)));
    }
    for (const i of [0, 12, 23]) await assert.rejects(() => A.decrypt(key, flipAt(nonce, i), ciphertext));
  });

  test('wrong key, wrong passphrase KEK, truncated, random bytes, short nonce, short key are rejected (roundtrip: "wrong key"; tamper: "truncated", "invalid ciphertext"; libsodium: "wrong passphrase KEK", "truncated seal", "short nonce")', async () => {
    const key = A.randomBytes(32);
    const { nonce, ciphertext } = await A.encrypt(key, enc.encode('secret'));
    await assert.rejects(() => A.decrypt(A.randomBytes(32), nonce, ciphertext));
    await assert.rejects(() => A.decrypt(key, nonce, ciphertext.subarray(0, ciphertext.length - 5)));
    await assert.rejects(() => A.decrypt(key, nonce, ciphertext.subarray(0, 15)));
    await assert.rejects(() => A.decrypt(key, A.randomBytes(24), A.randomBytes(64)));
    await assert.rejects(() => A.decrypt(key, nonce.subarray(0, 12), ciphertext), /nonce must be 24 bytes/);
    await assert.rejects(() => A.encrypt(A.randomBytes(16), enc.encode('x')));
    const salt = A.randomBytes(16);
    const good = await A.deriveKek('correct horse battery staple', salt);
    const bad = await A.deriveKek('wrong passphrase', salt);
    const wrapped = await A.wrapKey(good, key);
    await assert.rejects(() => A.unwrapKey(bad, wrapped.nonce, wrapped.wrapped));
    assert.deepEqual(await A.unwrapKey(good, wrapped.nonce, wrapped.wrapped), key);
    await assert.rejects(() => A.deriveKek('x', A.randomBytes(8)), /salt must be 16 bytes/);
  });

  test('nonces are fresh per encryption (tamper: "nonces are random and unique")', async () => {
    const key = A.randomBytes(32);
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(toBase64((await A.encrypt(key, enc.encode('same'))).nonce));
    assert.equal(seen.size, 500);
  });
});

// ---------------------------------------------------------------------------
describe('supersedes tests/compatibility/chunk-manifest.test.mjs + sync-replay "interrupted upload"', () => {
  async function real(size: number) {
    await sodiumReady;
    const data = new Uint8Array(randomBytes(size));
    const fileKey = A.randomBytes(32);
    const { chunks, manifest } = await encryptChunks(data, fileKey, 'blob_acc', 'video/mp4', A);
    return { data, fileKey, chunks, manifest };
  }

  test('2.5 MiB splits into 3 contiguous chunks; manifest verifies; bytes round-trip ("2.5 MiB file splits into 3 chunks")', async () => {
    const { data, fileKey, chunks, manifest } = await real(2 * CHUNK_SIZE + 512 * 1024);
    assert.equal(splitIntoChunks(data).length, 3);
    assert.equal(manifest.chunks.length, 3);
    assert.equal(manifest.format_version, MANIFEST_VERSION);
    assert.equal(manifest.chunks[2].byte_end, data.length);
    verifyManifest(manifest);
    assert.deepEqual(await decryptChunks(chunks, manifest, fileKey, A), data);
  });

  test('tampered / missing / reordered / duplicated chunk and size mismatch are rejected ("tampered chunk", "missing chunk", "reordered manifest", "truncated manifest size mismatch"; sync-replay "out-of-order, duplicate, hash-mismatched")', async () => {
    const { fileKey, chunks, manifest } = await real(2 * CHUNK_SIZE + 10);
    const tampered = chunks.map((c, i) => (i === 1 ? { ...c, ciphertext: flipAt(c.ciphertext, 5) } : c));
    await assert.rejects(() => decryptChunks(tampered, manifest, fileKey, A), /hash mismatch/);
    await assert.rejects(() => decryptChunks(chunks.slice(0, 2), manifest, fileKey, A), /expected 3 chunks, got 2/);
    await assert.rejects(() => decryptChunks([chunks[1], chunks[0], chunks[2]], manifest, fileKey, A), /out of order/);
    await assert.rejects(() => decryptChunks([chunks[0], { ...chunks[0], part_number: 2 }, chunks[2]], manifest, fileKey, A));
    const reordered: BlobManifest = { ...manifest, chunks: [manifest.chunks[1], manifest.chunks[0], manifest.chunks[2]] };
    assert.throws(() => verifyManifest(reordered), /out of order|not contiguous/);
    assert.throws(() => verifyManifest({ ...manifest, plaintext_size: manifest.plaintext_size + 1 }), /does not match chunk ranges/);
    assert.throws(() => verifyManifest({ ...manifest, format_version: 2 }), /unsupported manifest version/);
  });

  test('video seek maps a byte range to chunk numbers ("video seek maps a byte range")', async () => {
    const { manifest } = await real(3 * CHUNK_SIZE);
    assert.deepEqual(chunkIndexForByteRange(manifest, 0, 100), [1]);
    assert.deepEqual(chunkIndexForByteRange(manifest, CHUNK_SIZE - 10, CHUNK_SIZE + 10), [1, 2]);
    assert.deepEqual(chunkIndexForByteRange(manifest, 2 * CHUNK_SIZE, 3 * CHUNK_SIZE), [3]);
  });
});

// ---------------------------------------------------------------------------
describe('supersedes tests/compatibility/export-format.test.mjs', () => {
  const keys: WrappedKeyEnvelope = {
    salt: toBase64(randomBytes(16)),
    wrapped_master: toBase64(randomBytes(48)), wrapped_master_nonce: toBase64(randomBytes(24)),
    wrapped_vault: toBase64(randomBytes(48)), wrapped_vault_nonce: toBase64(randomBytes(24)),
    wrapped_recovery: toBase64(randomBytes(48)), wrapped_recovery_nonce: toBase64(randomBytes(24)),
  };
  const row = { item_id: 'item_01', revision: 1, encryption_version: 1 as const, encrypted_payload: toBase64(randomBytes(80)), encrypted_item_key: toBase64(randomBytes(72)) };

  test('current format (v2, built by the real builder) validates', () => {
    const doc = buildEncryptedExport({ vaultId: 'v1', keys, items: [row] });
    assert.equal(doc.format, ENCRYPTED_EXPORT_FORMAT);
    const v = validateEncryptedExport(doc);
    assert.equal(v.ok, true, v.errors.join(' | '));
  });

  test('STALE MIRROR RULE: the mirror says "v1 export validates"; production REJECTS v1 (no key envelope)', () => {
    const v = validateEncryptedExport({ format: ENCRYPTED_EXPORT_FORMAT, format_version: 1, vault_id: 'v1', items: [row] });
    assert.equal(v.ok, false);
    assert.match(v.errors.join(' '), /format_version 1/);
  });

  test('unknown future version and missing ciphertext are rejected', () => {
    const doc = buildEncryptedExport({ vaultId: 'v1', keys, items: [row] });
    assert.equal(validateEncryptedExport({ ...doc, format_version: 99 }).ok, false);
    assert.equal(validateEncryptedExport({ ...doc, items: [{ item_id: 'x', revision: 1, encryption_version: 1 }] }).ok, false);
  });
});

// ---------------------------------------------------------------------------
describe('supersedes tests/recovery/recovery-key.test.mjs (the key the real vault issues)', () => {
  test('createVault issues a 32-byte base64url key, distinct per vault, that opens the vault; a random one does not', async () => {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true, writable: true,
      value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } },
    });
    const vault = await import('../../apps/desktop/src/vault.ts');
    const { recoveryKey: k1 } = await vault.createVault('pass one 1234');
    const { recoveryKey: k2 } = await vault.createVault('pass two 1234');
    for (const k of [k1, k2]) {
      assert.match(k, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(fromBase64Url(k).length, 32, '256 bits');
    }
    assert.notEqual(k1, k2);
    vault.lockVault();
    assert.equal(await vault.unlockWithRecoveryKey(k1), false, 'the overwritten vault\'s key no longer opens anything');
    assert.equal(await vault.unlockWithRecoveryKey(randomBytes(32).toString('base64url')), false);
    assert.equal(await vault.unlockWithRecoveryKey(k2), true);
    assert.equal(JSON.stringify([...store.values()]).includes(k2), false, 'the recovery key is never stored');
    vault.wipeVault();
  });
});

// ---------------------------------------------------------------------------
describe('supersedes tests/sync-conflicts/{conflict,sync-engine}.test.mjs + sync-replay queue/conflict tests', () => {
  test('detectConflict / detectDeleteConflict (all mirror cases)', () => {
    assert.equal(detectConflict(3, 3, 5), 'none');
    assert.equal(detectConflict(5, 3, 3), 'none');
    assert.equal(detectConflict(4, 3, 5), 'same_item_both_changed');
    assert.equal(detectDeleteConflict(true, 5, 3), 'delete_vs_update');
    assert.equal(detectDeleteConflict(true, 3, 3), 'none');
    assert.equal(detectDeleteConflict(false, 5, 3), 'none');
  });

  test('keep-both record holds both versions, unresolved ("both-changed same item => conflict, BOTH versions kept")', () => {
    const local = { id: 'item_1', title: 'local edit' } as VaultItem;
    const remote = { id: 'item_1', title: 'remote edit' } as VaultItem;
    const c = resolveConflictKeepBoth(local, remote, { localRevision: 4, remoteRevision: 5, baseRevision: 3, remoteDeviceId: 'device_b' });
    assert.equal(c.kind, 'same_item_both_changed');
    assert.equal(c.resolution, 'unresolved');
    assert.equal(c.local.title, 'local edit');
    assert.equal(c.remote.title, 'remote edit');
  });

  test('queue: FIFO, deduped per item, survives a "restart", corrupted JSON reads as empty ("offline queue", "queue survives an app restart", "corrupted queue JSON")', () => {
    const s = memorySyncStorage();
    const push = (item_id: string, base_revision: number) => enqueuePush(s, { vault_id: 'v', item_id, base_revision, encrypted_payload: 'AA==', encrypted_item_key: 'AA==', encryption_version: 1, operation: 'upsert' });
    push('a', 1); push('b', 1); push('a', 2);
    assert.deepEqual(loadQueue(s).map((q) => q.item_id), ['b', 'a']);
    assert.equal(loadQueue(s).find((q) => q.item_id === 'a')!.base_revision, 2);
    const restarted = memorySyncStorage({ [SYNC_QUEUE_KEY]: s.get(SYNC_QUEUE_KEY)! });
    assert.deepEqual(loadQueue(restarted).map((q) => q.item_id), ['b', 'a']);
    const broken = memorySyncStorage({ [SYNC_QUEUE_KEY]: '{broken json' });
    assert.deepEqual(loadQueue(broken), []);
    enqueuePush(broken, { vault_id: 'v', item_id: 'z', base_revision: 0, encrypted_payload: 'AA==', encrypted_item_key: 'AA==', encryption_version: 1, operation: 'upsert' });
    assert.equal(loadQueue(broken).length, 1);
  });

  test('stale remote revision is skipped; tombstone applies only when newer ("stale remote revision is skipped", "tombstone only applies when newer")', async () => {
    const item = (title: string) => ({ id: 'w1', type: 'login', schema_version: 1, title, fields: {}, tags: [], relations: [], attachments: [], created_at: '', updated_at: '' }) as VaultItem;
    const local = new Map<string, LocalItemState>([['w1', { item: item('local v5'), revision: 5, baseRevision: 5 }]]);
    const ev = (revision: number, operation: 'upsert' | 'delete', sequence: number): SyncEvent => ({
      sequence, item_id: 'w1', revision, operation, encrypted_payload: operation === 'upsert' ? 'AA==' : null, encrypted_item_key: operation === 'upsert' ? 'AA==' : null, encryption_version: 1,
    } as unknown as SyncEvent);
    const decrypt = async () => item('remote');
    const stale = await applyRemoteEvents([ev(4, 'upsert', 1)], local, decrypt);
    assert.deepEqual(stale.applied, []);
    assert.equal(local.get('w1')!.item.title, 'local v5');
    const oldDelete = await applyRemoteEvents([ev(5, 'delete', 2)], local, decrypt);
    assert.deepEqual(oldDelete.tombstones, []);
    const newDelete = await applyRemoteEvents([ev(6, 'delete', 3)], local, decrypt);
    assert.deepEqual(newDelete.tombstones, ['w1']);
  });
});

// ---------------------------------------------------------------------------
describe('supersedes tests/security/signin-client.test.mjs (packages/sdk/src/signin.ts + security.ts)', () => {
  test('email step: bad emails stay put; good email normalises and moves to passkey; optionsReceived only from passkey', () => {
    for (const bad of ['', 'not-an-email', 'a@', '@b.com', 'a b@c.com', 'a@@b.com']) {
      const s = startSignIn(initialSignInState(), bad, 'login');
      assert.equal(s.step, 'email'); assert.equal(s.error, 'invalid-email'); assert.equal(s.busy, false); assert.equal(s.mfaToken, null);
    }
    const s = startSignIn(initialSignInState(), '  Alice@Example.COM ', 'login');
    assert.equal(s.step, 'passkey'); assert.equal(s.email, 'alice@example.com'); assert.equal(s.busy, true);
    assert.equal(optionsReceived(initialSignInState()).step, 'email');
    assert.equal(optionsReceived(s).step, 'passkey');
  });

  test('passkey + MFA steps: token signs in; mfa parks with token; nothing else ever signs in', () => {
    const s0 = startSignIn(initialSignInState(), 'a@b.com', 'login');
    assert.equal(passkeyVerified(s0, { token: 'sess_abc' } as never).step, 'signed-in');
    const mfa = passkeyVerified(s0, { mfa_required: true, mfa_token: 'mfa_xyz' } as never);
    assert.equal(mfa.step, 'mfa'); assert.equal(mfa.mfaToken, 'mfa_xyz');
    const none = passkeyVerified(s0, {} as never);
    assert.notEqual(none.step, 'signed-in'); assert.equal(none.error, 'verification-failed');
    assert.equal(mfaVerified(mfa, { token: 'sess_def' }).step, 'signed-in');
    assert.equal(mfaVerified(mfa, { token: 'sess_def' }).mfaToken, null);
    assert.equal(mfaVerified(initialSignInState(), { token: 'sess_def' }).step, 'email');
    assert.equal(mfaVerified(mfa, {}).error, 'verification-failed');
  });

  test('single-use tokens: mfa-expired / challenge-expired restart from email; cancelled stays on passkey', () => {
    const mfa = passkeyVerified(startSignIn(initialSignInState(), 'a@b.com', 'login'), { mfa_required: true, mfa_token: 'mfa_xyz' } as never);
    const exp = signInFailed(mfa, 'mfa-expired');
    assert.equal(exp.step, 'email'); assert.equal(exp.mfaToken, null); assert.equal(exp.busy, false);
    assert.equal(signInFailed(startSignIn(initialSignInState(), 'a@b.com', 'login'), 'challenge-expired').step, 'email');
    const c = signInFailed(startSignIn(initialSignInState(), 'a@b.com', 'login'), 'passkey-cancelled');
    assert.equal(c.step, 'passkey'); assert.equal(c.error, 'passkey-cancelled');
  });

  test('token storage: expiry clears; no expiry is sent; clear removes token+expiry+email; rotated token adoption', async () => {
    const m = new Map<string, string>();
    const store = { getItem: async (k: string) => m.get(k) ?? null, setItem: async (k: string, v: string) => { m.set(k, v); }, removeItem: async (k: string) => { m.delete(k); } };
    await saveSessionToken(store, 'sess_abc', 3600);
    assert.equal(await getValidToken(store, Date.now()), 'sess_abc');
    assert.equal(await getValidToken(store, Date.now() + 3601 * 1000), null);
    assert.equal(m.has(LS_API_TOKEN), false); assert.equal(m.has(LS_API_TOKEN_EXPIRES_AT), false);
    await store.setItem(LS_API_TOKEN, 'sess_abc');
    assert.equal(await getValidToken(store, Date.now() + 365 * 86400 * 1000), 'sess_abc');
    assert.equal(await getValidToken({ getItem: async () => null, setItem: async () => {}, removeItem: async () => {} }), null);
    await saveSessionToken(store, 'sess_abc', 3600);
    await store.setItem(LS_ACCOUNT_EMAIL, 'a@b.com');
    await clearSessionToken(store);
    assert.equal(m.size, 0);
    await store.setItem(LS_API_TOKEN, 'sess_old');
    assert.equal(await adoptRotatedToken(store, { rotated_token: 'sess_new' }), true);
    for (const bad of [{}, { rotated_token: '' }, { rotated_token: 42 }, null]) assert.equal(await adoptRotatedToken(store, bad), false);
    assert.equal(await store.getItem(LS_API_TOKEN), 'sess_new');
  });

  test('error classification', () => {
    assert.equal(classifySignInError(new TypeError('fetch failed'), 'passkey'), 'offline');
    const cancelled = Object.assign(new Error('user cancelled'), { name: 'NotAllowedError' });
    assert.equal(classifySignInError(cancelled, 'passkey'), 'passkey-cancelled');
    const e401 = new ApiError(401, '/v1/auth/mfa/verify', { error: 'verification_failed' });
    assert.equal(classifySignInError(e401, 'mfa'), 'mfa-expired');
    assert.equal(classifySignInError(e401, 'passkey'), 'verification-failed');
    assert.equal(classifySignInError(new Error('challenge expired or already used'), 'passkey'), 'challenge-expired');
    assert.equal(classifySignInError(new Error('boom'), 'passkey'), 'unknown');
    assert.equal(classifySignInError(undefined, 'passkey'), 'unknown');
  });

  test('i18n: signin + security sections have identical keys in en and vi (real dictionaries, not regex over text)', () => {
    assert.deepEqual(Object.keys(vi.signin).sort(), Object.keys(en.signin).sort());
    assert.deepEqual(Object.keys(vi.security).sort(), Object.keys(en.security).sort());
    for (const k of ['title', 'emailLabel', 'signInButton', 'mfaTitle', 'sessionExpired', 'verificationFailed', 'mfaExpired', 'offline']) {
      assert.ok(k in en.signin, `en.signin.${k}`);
    }
  });
});

// ---------------------------------------------------------------------------
describe('supersedes tests/security/step-up-client.test.mjs (client half; server half is RSpec + e2e)', () => {
  test('step-up window: 9 min fresh, 11 min stale, exactly 10 min fresh, never-verified stale', () => {
    const now = Date.now();
    assert.equal(STEP_UP_WINDOW_MS, 10 * 60 * 1000);
    assert.equal(isStepUpFresh(now - 9 * 60_000, now), true);
    assert.equal(isStepUpFresh(now - 11 * 60_000, now), false);
    assert.equal(isStepUpFresh(now - STEP_UP_WINDOW_MS, now), true);
    assert.equal(isStepUpFresh(now - STEP_UP_WINDOW_MS - 1, now), false);
    assert.equal(isStepUpFresh(null), false);
    assert.equal(isStepUpFresh(undefined), false);
  });

  test('isStepUpRequired: only a real ApiError 403 naming step_up_required', () => {
    assert.equal(isStepUpRequired(new ApiError(403, '/v1/auth/sessions/others', { error: 'step_up_required' })), true);
    assert.equal(isStepUpRequired(new ApiError(403, '/v1/auth/sessions/others', { error: 'forbidden' })), false);
    assert.equal(isStepUpRequired(new ApiError(401, '/v1/auth/sessions', { error: 'unauthorized' })), false);
    assert.equal(isStepUpRequired(new TypeError('fetch failed')), false);
    assert.equal(isStepUpRequired(new Error('API 403 x: step_up_required')), false, 'a plain Error with the text is not an ApiError');
  });

  test('revocation copy: both locales say revocation does NOT erase offline data, and there is no back door', () => {
    const all = (d: object) => JSON.stringify(d);
    assert.ok(all(en).includes('does NOT erase secrets already downloaded'));
    assert.ok(all(vi).includes('không xóa các bí mật đã tải về'));
    assert.ok(all(en).includes('no reset and no back door'));
    assert.ok(all(vi).includes('không có cách đặt lại và không có cửa hậu'));
  });
});
