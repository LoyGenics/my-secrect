import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, isVerificationFailed } from '../src/security';

const body = { error: 'verification_failed' };

test('verification_failed on the MFA-confirm path -> true', () => {
  assert.equal(isVerificationFailed(new ApiError(401, '/v1/auth/mfa/confirm', body)), true);
});

test('verification_failed on another path -> false', () => {
  assert.equal(isVerificationFailed(new ApiError(401, '/v1/auth/passkeys/add/verify', body)), false);
});

test('plain unauthorized 401 on the MFA-confirm path -> false', () => {
  assert.equal(isVerificationFailed(new ApiError(401, '/v1/auth/mfa/confirm', { error: 'unauthorized' })), false);
});

test('non-ApiError -> false', () => {
  assert.equal(isVerificationFailed(new Error('API 401 /v1/auth/mfa/confirm: verification_failed')), false);
});
