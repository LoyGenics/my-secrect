/**
 * Account sign-in rules (real module: src/lib/account-core.ts).
 * Run: npx tsx --test apps/extension/tests/account-core.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  authErrorFor,
  googleAuthUrl,
  idTokenFromRedirect,
  normalizeApiBaseUrl,
  unverifiedJwtAccount,
} from '../src/lib/account-core';

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims: unknown) => `${b64url({ alg: 'RS256' })}.${b64url(claims)}.c2ln`;

test('server URL: https anywhere, http only on this machine, no credentials/query/hash', () => {
  assert.equal(normalizeApiBaseUrl(''), '');
  assert.equal(normalizeApiBaseUrl('  https://vault.example.com/api/ '), 'https://vault.example.com/api');
  assert.equal(normalizeApiBaseUrl('http://localhost:3000/api'), 'http://localhost:3000/api');
  assert.equal(normalizeApiBaseUrl('http://127.0.0.1:3000/api'), 'http://127.0.0.1:3000/api');
  assert.equal(normalizeApiBaseUrl('http://vault.example.com/api'), null);
  assert.equal(normalizeApiBaseUrl('http://localhost.evil.test/api'), null);
  assert.equal(normalizeApiBaseUrl('https://user:pw@vault.example.com/api'), null);
  assert.equal(normalizeApiBaseUrl('https://vault.example.com/api?x=1'), null);
  assert.equal(normalizeApiBaseUrl('javascript:alert(1)'), null);
  assert.equal(normalizeApiBaseUrl('not a url'), null);
});

test('Google authorize URL: implicit id_token with the raw nonce, state and the chromiumapp redirect', () => {
  const url = new URL(googleAuthUrl({ clientId: 'cid.apps.googleusercontent.com', redirectUri: 'https://abc.chromiumapp.org/', nonce: 'n-123', state: 's-456' }));
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('client_id'), 'cid.apps.googleusercontent.com');
  assert.equal(url.searchParams.get('response_type'), 'id_token');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://abc.chromiumapp.org/');
  assert.equal(url.searchParams.get('scope'), 'openid email profile');
  assert.equal(url.searchParams.get('nonce'), 'n-123');
  assert.equal(url.searchParams.get('state'), 's-456');
});

test('redirect parsing: id_token only from our redirect with the same state', () => {
  const token = jwt({ email: 'a@b.test' });
  const redirect = 'https://abc.chromiumapp.org/';
  assert.equal(idTokenFromRedirect(`${redirect}#state=s1&id_token=${token}`, redirect, 's1'), token);
  assert.equal(idTokenFromRedirect(`${redirect}#state=other&id_token=${token}`, redirect, 's1'), null);
  assert.equal(idTokenFromRedirect(`https://evil.test/#state=s1&id_token=${token}`, redirect, 's1'), null);
  assert.equal(idTokenFromRedirect(`${redirect}#state=s1&error=access_denied`, redirect, 's1'), null);
  assert.equal(idTokenFromRedirect(`${redirect}#state=s1&id_token=notajwt`, redirect, 's1'), null);
  assert.equal(idTokenFromRedirect(undefined, redirect, 's1'), null);
});

test('unverified JWT account: email lower-cased, else subject, else null', () => {
  assert.equal(unverifiedJwtAccount(jwt({ email: ' Alice@Example.TEST ', sub: '1' })), 'alice@example.test');
  assert.equal(unverifiedJwtAccount(jwt({ sub: '42' })), 'sub:42');
  assert.equal(unverifiedJwtAccount('a.%%%.c'), null);
  assert.equal(unverifiedJwtAccount('nodots'), null);
});

test('error mapping stays coarse: offline, device, per-step 401s, request errors', () => {
  assert.equal(authErrorFor({ status: 0, error: 'offline' }, 'request'), 'offline');
  assert.equal(authErrorFor({ status: 422, error: 'invalid_email' }, 'request'), 'invalid-email');
  assert.equal(authErrorFor({ status: 503, error: 'email_unavailable' }, 'request'), 'email-unavailable');
  assert.equal(authErrorFor({ status: 401, error: 'verification_failed' }, 'code'), 'code-failed');
  assert.equal(authErrorFor({ status: 401, error: 'verification_failed' }, 'session'), 'code-expired');
  assert.equal(authErrorFor({ status: 401, error: 'verification_failed' }, 'mfa'), 'mfa-failed');
  assert.equal(authErrorFor({ status: 401, error: 'verification_failed' }, 'oauth'), 'verification-failed');
  assert.equal(authErrorFor({ status: 401, error: 'device_verification_failed' }, 'oauth'), 'device-rejected');
  assert.equal(authErrorFor({ status: 500, error: '' }, 'oauth'), 'unknown');
  assert.equal(authErrorFor(new Error('x'), 'oauth'), 'unknown');
});
