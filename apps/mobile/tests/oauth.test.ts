import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { ApiError, type SessionResult } from '../../../packages/sdk/src/security';
import {
  ANDROID_PACKAGE, appleFullName, appleNonce, fetchAuthProviders, googleRedirectUri, idTokenEmail,
  oauthSession, oauthSessionBody, providerButtons, startOAuth, type AuthProviders,
} from '../src/utils/oauth';

const both: AuthProviders = {
  google: { web_client_id: 'web.apps.googleusercontent.com', ios_client_id: '123-ios.apps.googleusercontent.com', android_client_id: '123-android.apps.googleusercontent.com' },
  apple: { services_id: 'com.loygenics.my-secrect.web', bundle_id: 'com.loygenics.my-secrect' },
};

test('iOS shows Apple and Google with the iOS client ID', () => {
  assert.deepEqual(providerButtons(both, 'ios', true), { apple: true, googleClientId: '123-ios.apps.googleusercontent.com' });
});

test('Android never shows Apple and uses the Android client ID', () => {
  assert.deepEqual(providerButtons(both, 'android', true), { apple: false, googleClientId: '123-android.apps.googleusercontent.com' });
});

test('a provider the server returns as null has no button', () => {
  assert.deepEqual(providerButtons({ google: null, apple: null }, 'ios', true), { apple: false, googleClientId: null });
  assert.deepEqual(providerButtons(null, 'ios', true), { apple: false, googleClientId: null });
});

test('Apple needs the device to support it and the server to know the bundle ID', () => {
  assert.equal(providerButtons(both, 'ios', false).apple, false);
  assert.equal(providerButtons({ google: null, apple: { services_id: 'com.loygenics.my-secrect.web' } }, 'ios', true).apple, false);
});

test('Google is hidden when only another platform has a client ID', () => {
  const webOnly: AuthProviders = { google: { web_client_id: 'web.apps.googleusercontent.com', ios_client_id: ' ' }, apple: null };
  assert.equal(providerButtons(webOnly, 'ios', true).googleClientId, null);
  assert.equal(providerButtons(webOnly, 'android', true).googleClientId, null);
});

test('Google redirects to the reversed client ID on iOS and the package scheme on Android', () => {
  assert.equal(googleRedirectUri('ios', '123-ios.apps.googleusercontent.com'), 'com.googleusercontent.apps.123-ios:/oauthredirect');
  assert.equal(googleRedirectUri('android', '123-android.apps.googleusercontent.com'), 'com.loygenics.mysecrect:/oauthredirect');
  assert.equal(ANDROID_PACKAGE, 'com.loygenics.mysecrect');
});

test('Apple receives the SHA-256 hex of the raw nonce', () => {
  assert.equal(appleNonce('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('Apple full name is joined and omitted when Apple sends none', () => {
  assert.equal(appleFullName({ givenName: 'Lan', middleName: null, familyName: ' Nguyen ' }), 'Lan Nguyen');
  assert.equal(appleFullName({ givenName: null, familyName: null }), undefined);
  assert.equal(appleFullName(null), undefined);
});

test('the session body carries full_name only when present', () => {
  assert.deepEqual(oauthSessionBody('t1', 'jwt'), { ticket: 't1', id_token: 'jwt' });
  assert.deepEqual(oauthSessionBody('t1', 'jwt', 'Lan Nguyen'), { ticket: 't1', id_token: 'jwt', full_name: 'Lan Nguyen' });
});

test('the display email comes from the ID token claims', () => {
  const payload = Buffer.from(JSON.stringify({ email: 'Lan@Example.test', nonce: 'n' })).toString('base64url');
  assert.equal(idTokenEmail(`h.${payload}.s`), 'lan@example.test');
  assert.equal(idTokenEmail('not-a-jwt'), '');
});

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function stubFetch(status: number, json: unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return calls;
}

test('providers are read with a GET under /v1/auth', async () => {
  const calls = stubFetch(200, both);
  assert.deepEqual(await fetchAuthProviders('https://api.test/api/'), both);
  assert.equal(calls[0].url, 'https://api.test/api/v1/auth/providers');
  assert.equal(calls[0].init?.method, undefined);
});

test('start and session POST JSON to the contract paths', async () => {
  let calls = stubFetch(200, { ticket: 't1', nonce: 'n1', expires_at: '2026-11-21T00:10:00Z' });
  assert.deepEqual(await startOAuth('https://api.test/api'), { ticket: 't1', nonce: 'n1', expires_at: '2026-11-21T00:10:00Z' });
  assert.equal(calls[0].url, 'https://api.test/api/v1/auth/oauth/start');
  assert.equal(calls[0].init?.method, 'POST');
  assert.equal(calls[0].init?.body, '{}');

  const session: SessionResult = { token: 'tok', user_id: 'u1', expires_in: 3600, account_created: true };
  calls = stubFetch(200, session);
  assert.deepEqual(await oauthSession('https://api.test/api', 'apple', oauthSessionBody('t1', 'jwt', 'Lan Nguyen')), session);
  assert.equal(calls[0].url, 'https://api.test/api/v1/auth/oauth/apple/session');
  assert.equal(calls[0].init?.body, '{"ticket":"t1","id_token":"jwt","full_name":"Lan Nguyen"}');
});

test('a refused token surfaces as an ApiError with status 401', async () => {
  stubFetch(401, { error: 'verification_failed' });
  await assert.rejects(oauthSession('https://api.test/api', 'google', oauthSessionBody('t1', 'jwt')),
    (error: unknown) => error instanceof ApiError && error.status === 401);
});
