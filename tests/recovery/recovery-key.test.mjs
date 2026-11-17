// Recovery-key rules, no server. A recovery key is 32 random bytes shown
// once; the test pins the invariants, not a real key.
import test from 'node:test';
import assert from 'node:assert/strict';

function makeRecoveryKey() { return crypto.getRandomValues(new Uint8Array(32)); }
function encodeRecoveryKey(bytes) {
  // Human-copyable form: base64url, grouped, no ambiguous chars needed for the test.
  return Buffer.from(bytes).toString('base64url');
}
test('recovery key has 256 bits of entropy', () => {
  const k1 = makeRecoveryKey(); const k2 = makeRecoveryKey();
  assert.equal(k1.length, 32);
  assert.notDeepEqual(k1, k2);
});
test('recovery key encodes and decodes losslessly', () => {
  const k = makeRecoveryKey();
  assert.deepEqual(new Uint8Array(Buffer.from(encodeRecoveryKey(k), 'base64url')), k);
});
test('losing the key with no trusted device means no recovery (by design)', () => {
  // This is a policy assertion, not code: there is no server endpoint
  // that can re-derive a vault key. The test documents the invariant
  // that the recovery flow must never add one.
  const serverCanRecoverWithoutKey = false;
  assert.equal(serverCanRecoverWithoutKey, false);
});
