// Real-module test (imports packages/sdk/src/signin.ts): the create-account
// email-code step of the sign-in state machine.
//   npx tsx --test packages/sdk/tests/signin-email-step.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../src/security';
import {
  classifySignInError,
  emailCodeRequestFailed,
  emailCodeSent,
  emailCodeVerified,
  emailSignedIn,
  initialSignInState,
  passkeyVerified,
  signInFailed,
  startEmailSignIn,
  startSignIn,
} from '../src/signin';

test('create mode: a valid email goes to the email-code step (busy while the code is requested)', () => {
  const s = startSignIn(initialSignInState('create'), ' New@Example.COM ', 'create');
  assert.equal(s.step, 'email-code');
  assert.equal(s.email, 'new@example.com');
  assert.equal(s.busy, true);
  assert.equal(emailCodeSent(s).busy, false);
});

test('login mode still goes straight to the passkey step', () => {
  assert.equal(startSignIn(initialSignInState('login'), 'a@b.com', 'login').step, 'passkey');
});

test('a bad email never reaches the email-code step', () => {
  const s = startSignIn(initialSignInState('create'), 'nope', 'create');
  assert.equal(s.step, 'email');
  assert.equal(s.error, 'invalid-email');
});

test('only a verified code (ticket) leads to the passkey step; signed-in still needs a token', () => {
  const sent = emailCodeSent(startSignIn(initialSignInState('create'), 'a@b.com', 'create'));
  assert.equal(emailCodeVerified(initialSignInState('create')).step, 'email'); // not from another step
  const ceremony = emailCodeVerified(sent);
  assert.equal(ceremony.step, 'passkey');
  assert.equal(passkeyVerified(ceremony, {}).step, 'passkey');
  assert.equal(passkeyVerified(ceremony, { token: 'sess_x' }).step, 'signed-in');
});

test('a wrong code keeps the email-code step; an expired ticket or a failed request restarts from email', () => {
  const sent = emailCodeSent(startSignIn(initialSignInState('create'), 'a@b.com', 'create'));
  const wrong = signInFailed(sent, classifySignInError(new ApiError(401, '/v1/auth/email/verify', {}), 'email-code'));
  assert.equal(wrong.step, 'email-code');
  assert.equal(wrong.error, 'email-code-failed');

  const expired = signInFailed(emailCodeVerified(sent), 'signup-expired');
  assert.equal(expired.step, 'email');

  const unavailable = classifySignInError(new ApiError(503, '/v1/auth/email/request', {}), 'email-code');
  assert.equal(unavailable, 'email-unavailable');
  assert.equal(emailCodeRequestFailed(sent, unavailable).step, 'email');
  assert.equal(classifySignInError(new ApiError(422, '/v1/auth/email/request', {}), 'email-code'), 'invalid-email');
  assert.equal(classifySignInError(new TypeError('fetch failed'), 'email-code'), 'offline');
});

test('email-code sign-in: either mode reaches the email-code step; a ticket spent for a token signs in', () => {
  for (const mode of ['login', 'create'] as const) {
    const s = startEmailSignIn(initialSignInState(mode), ' A@B.com ', mode);
    assert.equal(s.step, 'email-code');
    assert.equal(s.mode, mode);
    assert.equal(s.email, 'a@b.com');
    assert.equal(s.busy, true);
  }
  assert.equal(startEmailSignIn(initialSignInState('login'), 'nope', 'login').error, 'invalid-email');

  const sent = emailCodeSent(startEmailSignIn(initialSignInState('login'), 'a@b.com', 'login'));
  assert.equal(emailSignedIn(initialSignInState('login'), { token: 'sess_x' }).step, 'email'); // not from another step
  assert.equal(emailSignedIn(sent, {}).step, 'email-code');
  assert.equal(emailSignedIn(sent, {}).error, 'verification-failed');
  assert.equal(emailSignedIn(sent, { token: 'sess_x' }).step, 'signed-in');
});

test('email-code sign-in: an MFA account parks at the mfa step with the single-use token', () => {
  const sent = emailCodeSent(startEmailSignIn(initialSignInState('login'), 'a@b.com', 'login'));
  const parked = emailSignedIn(sent, { mfa_required: true, mfa_token: 'mfa_x' });
  assert.equal(parked.step, 'mfa');
  assert.equal(parked.mfaToken, 'mfa_x');
});
