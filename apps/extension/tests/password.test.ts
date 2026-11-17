/**
 * The real background password generator (src/lib/password.ts).
 * Run: npx tsx --test apps/extension/tests/password.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePassword, randomIndex } from '../src/lib/password.ts';

/** A fixed random source: hands out the given 32-bit values in order. */
function sequence(values: number[]) {
  let i = 0;
  const fill = (buf: Uint32Array) => {
    if (i >= values.length) throw new Error('sequence exhausted');
    buf[0] = values[i++];
  };
  return { fill, used: () => i };
}

test('randomIndex redraws values in the biased tail instead of taking them modulo n', () => {
  // n = 3: limit = floor(2^32 / 3) * 3 = 0xFFFFFFFF. A plain `% 3` would map
  // 0xFFFFFFFF to 0, giving 0 one extra preimage out of 2^32.
  const s = sequence([0xffffffff, 7]);
  assert.equal(randomIndex(3, s.fill), 7 % 3);
  assert.equal(s.used(), 2);

  // n = 72 (full pool): limit = 4294967256. The first value at the limit is redrawn.
  const limit = Math.floor(2 ** 32 / 72) * 72;
  const t = sequence([limit, limit + 39, limit - 1]);
  assert.equal(randomIndex(72, t.fill), (limit - 1) % 72);
  assert.equal(t.used(), 3);

  // In range on the first draw: exactly one draw.
  const u = sequence([5]);
  assert.equal(randomIndex(72, u.fill), 5);
  assert.equal(u.used(), 1);

  assert.throws(() => randomIndex(0), /positive integer/);
});

test('generatePassword: clamped length, every selected class, only pool characters', () => {
  assert.equal(generatePassword(2).length, 4);
  assert.equal(generatePassword(100).length, 64);
  assert.equal(generatePassword(Number.NaN).length, 16);
  for (let i = 0; i < 200; i++) {
    const pw = generatePassword(12, true, true);
    assert.equal(pw.length, 12);
    assert.match(pw, /[a-z]/);
    assert.match(pw, /[A-Z]/);
    assert.match(pw, /[2-9]/);
    assert.match(pw, /[!@#$%^&*()\-_=+[\]{}]/);
    assert.match(pw, /^[a-km-np-zA-HJ-KM-NP-Z2-9!@#$%^&*()\-_=+[\]{}]+$/);
    const plain = generatePassword(12, false, false);
    assert.match(plain, /^[a-zA-Z]+$/);
  }
});

test('generatePassword: no class is pinned to a fixed position', () => {
  // The old generator always put lowercase at 0, uppercase at 1, digit at 2, symbol at 3.
  const firsts = new Set<string>();
  const seconds = new Set<string>();
  for (let i = 0; i < 300; i++) {
    const pw = generatePassword(16, true, true);
    firsts.add(/[a-z]/.test(pw[0]) ? 'lower' : 'other');
    seconds.add(/[A-Z]/.test(pw[1]) ? 'upper' : 'other');
  }
  assert.deepEqual([...firsts].sort(), ['lower', 'other']);
  assert.deepEqual([...seconds].sort(), ['other', 'upper']);
});
