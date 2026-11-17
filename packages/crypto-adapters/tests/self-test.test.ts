// The libsodium self-test must pass on a healthy runtime and fail closed when
// randombytes_buf is broken (zeros or repeats), as seen when WebAssembly is
// blocked and libsodium falls back to asm.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import sodium from 'libsodium-wrappers-sumo';
import { libsodiumSelfTest, sodiumReady, libsodiumAdapter } from '../src/index.ts';

test('sodiumReady resolves on a healthy runtime and random bytes work', async () => {
  await sodiumReady;
  const a = libsodiumAdapter.randomBytes(32);
  const b = libsodiumAdapter.randomBytes(32);
  assert.equal(a.length, 32);
  assert.notDeepEqual(a, b);
});

function withBrokenRandom(fake: (n: number) => Uint8Array, fn: () => void): void {
  const real = sodium.randombytes_buf;
  (sodium as unknown as { randombytes_buf: (n: number) => Uint8Array }).randombytes_buf = fake;
  try { fn(); } finally {
    (sodium as unknown as { randombytes_buf: typeof real }).randombytes_buf = real;
  }
}

test('self-test rejects an all-zero random source', async () => {
  await sodiumReady;
  withBrokenRandom((n) => new Uint8Array(n), () => {
    assert.throws(libsodiumSelfTest, /all zero/);
  });
});

test('self-test rejects a random source that repeats (stale memory)', async () => {
  await sodiumReady;
  const stale = sodium.randombytes_buf(32);
  withBrokenRandom(() => stale.slice(), () => {
    assert.throws(libsodiumSelfTest, /repeated/);
  });
});
