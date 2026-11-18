import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAccountEmail, matchesRecoveryKeyEnding, normalizeMfaRecoveryCode, normalizeOtp } from '../src/utils/authInput';

test('email validation leaves deliverability to the server but rejects missing or multiple separators', () => {
  assert.equal(isAccountEmail('example+test@example.test'), true);
  for (const address of ['example', '@example.test', 'example@', 'a@b@c', 'a b@example.test']) {
    assert.equal(isAccountEmail(address), false, address);
  }
});

test('six-digit entry accepts formatted pasted input and preserves an initial zero', () => {
  assert.equal(normalizeOtp(' 012-345 '), '012345');
  assert.equal(normalizeOtp('1ABC2'), '12');
  assert.equal(normalizeOtp('01234567'), '012345');
});

test('authenticator recovery codes have an independent eight-character input format', () => {
  assert.equal(normalizeMfaRecoveryCode('ab09 qr31'), 'AB09-QR31');
  assert.equal(normalizeMfaRecoveryCode('a-b'), 'AB');
});

test('onboarding verifies exactly the last four characters, preserving base64url case', () => {
  assert.equal(matchesRecoveryKeyEnding('synthetic-test-qZ_7', 'qZ_7'), true);
  assert.equal(matchesRecoveryKeyEnding('synthetic-test-qZ_7', 'qz_7'), false);
  assert.equal(matchesRecoveryKeyEnding('synthetic-test-qZ_7', 'Z_7'), false);
  assert.equal(matchesRecoveryKeyEnding('synthetic-test-qZ_7', 't-qZ_7'), false);
});
