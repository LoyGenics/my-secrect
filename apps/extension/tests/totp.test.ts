/**
 * RFC 6238 Appendix B SHA-1 vectors (8-digit values truncated to the 6 digits
 * this extension emits) against the real generateTotp.
 * Run: node --test apps/extension/tests/totp.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateTotp, isValidBase32Secret } from '../src/lib/totp.ts';

const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // base32("12345678901234567890")
const vectors: [number, string][] = [
  [59, '287082'],
  [1111111109, '081804'],
  [1111111111, '050471'],
  [1234567890, '005924'],
  [2000000000, '279037'],
  [20000000000, '353130'],
];

for (const [t, code] of vectors) {
  test(`RFC 6238 vector t=${t}`, async () => {
    assert.equal((await generateTotp(SECRET, t * 1000)).code, code);
  });
}

test('seconds remaining and invalid secrets', async () => {
  assert.equal((await generateTotp(SECRET, 59_000)).secondsRemaining, 1);
  assert.equal((await generateTotp(SECRET, 60_000)).secondsRemaining, 30);
  assert.equal((await generateTotp('not base32!!', 59_000)).code, '');
  assert.equal(isValidBase32Secret('SHORT'), false);
});
