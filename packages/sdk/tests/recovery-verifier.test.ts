// Real-module test (imports packages/sdk/src/recovery-verifier.ts and the
// crypto-adapters HKDF it uses): the recovery-verifier key is derived with
// domain separation and matches the vector in specs/recovery-protocol.md.
// Node's own hkdfSync is the independent reference implementation.
//   npx tsx --test packages/sdk/tests/recovery-verifier.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, hkdfSync } from 'node:crypto';
import sodium from 'libsodium-wrappers-sumo';
import {
  RECOVERY_VERIFIER_INFO,
  legacyRecoveryVerifierKeyPair,
  recoveryVerifierKeyPair,
} from '../src/recovery-verifier';

const recoveryKey = Uint8Array.from({ length: 32 }, (_, i) => i);
const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

test('v1 seed = HKDF-SHA-256(recovery key, zero salt, "my-secrect/recovery-verifier/v1")', async () => {
  assert.equal(RECOVERY_VERIFIER_INFO, 'my-secrect/recovery-verifier/v1');
  const seed = Buffer.from(hkdfSync('sha256', recoveryKey, Buffer.alloc(32), RECOVERY_VERIFIER_INFO, 32));
  await sodium.ready;
  const reference = sodium.crypto_sign_seed_keypair(seed);
  const kp = await recoveryVerifierKeyPair(recoveryKey);
  assert.equal(b64u(kp.publicKey), b64u(reference.publicKey));
  // Literal vector (specs/recovery-protocol.md). Never edit to make a run pass.
  assert.equal(seed.toString('hex'), 'ba6cae182e0e07662e361b5cc965f4ad23d7cba4dd39141a594d249f1bc7ad2e');
  assert.equal(b64u(kp.publicKey), 'efL6ta1EHZPiP7pUhUjbWe9G_qoAvGa3FnfhRKdWtwM');
});

test('the v1 key is unrelated to the recovery key in any other role', async () => {
  const v1 = await recoveryVerifierKeyPair(recoveryKey);
  const v0 = await legacyRecoveryVerifierKeyPair(recoveryKey);
  assert.notEqual(b64u(v1.publicKey), b64u(v0.publicKey));
  // The seed is neither the recovery key nor the vault's recovery KEK input/output.
  const kek = createHash('sha256').update(recoveryKey).digest();
  await sodium.ready;
  assert.notEqual(b64u(v1.publicKey), b64u(sodium.crypto_sign_seed_keypair(kek).publicKey));
  // The input buffer is left intact (callers zero it themselves).
  assert.equal(recoveryKey[31], 31);
});

test('rejects anything but a 32-byte recovery key', async () => {
  await assert.rejects(() => recoveryVerifierKeyPair(new Uint8Array(31)));
  await assert.rejects(() => legacyRecoveryVerifierKeyPair(new Uint8Array(33)));
});
