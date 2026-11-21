/**
 * QA DEFECT-E1 (relation types lost on save) and the mandatory account
 * sign-in gate (no local-only mode). Pure helpers used by ItemForm.tsx,
 * App.tsx and SignInScreen.tsx.
 *
 * Run: npx tsx --test apps/desktop/form-and-gate.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRelations } from './src/components/itemFormRelations';
import { authGateStep, isAcceptableApiBaseUrl, resolveApiBaseUrl, verifyStoredSession } from './src/authGate';
import { ApiError } from '../../packages/sdk/src/index';
import { LS_API_TOKEN, LS_API_TOKEN_EXPIRES_AT, type SyncTokenStore } from '../../packages/sdk/src/security';
import { visibleProviders } from './src/oauth';
import { idTokenEmail, sha256Hex } from '../../packages/sdk/src/oauth';
import { initialSignInState, oauthSignedIn } from '../../packages/sdk/src/signin';
import { detectCardBrand, formatCardNumber, prepareCardFields } from '../../packages/core/src/card';

test('detects a card network from known prefixes and waits for ambiguous input', () => {
  for (const [prefix, brand] of [
    ['4242', 'Visa'],
    ['55', 'Mastercard'],
    ['2221', 'Mastercard'],
    ['2720', 'Mastercard'],
    ['37', 'American Express'],
    ['3528', 'JCB'],
    ['624303', 'UnionPay'],
    ['9704', 'NAPAS'],
    ['6011', 'Discover'],
    ['36', 'Diners Club'],
    ['56', 'Maestro'],
  ]) {
    assert.equal(detectCardBrand(prefix), brand, prefix);
  }
  for (const prefix of ['', '6', '62', '222', '2721', '970', '411x']) {
    assert.equal(detectCardBrand(prefix), undefined, prefix);
  }
});

test('groups card digits while preserving all digits and retaining invalid input for validation', () => {
  assert.equal(formatCardNumber('42424'), '4242 4');
  assert.equal(formatCardNumber('4242-4242 4242 4242'), '4242 4242 4242 4242');
  assert.equal(formatCardNumber('378282246310005'), '3782 822463 10005');
  assert.equal(formatCardNumber('36123456789012'), '3612 345678 9012');
  assert.equal(formatCardNumber('9704000000000000001'), '9704 0000 0000 0000 001');
  assert.equal(formatCardNumber('378282246310005', 'other'), '3782 8224 6310 005');
  assert.equal(formatCardNumber('4242x'), '4242x');
});

test('saving a card stores unspaced digits and keeps explicit network and card type choices', () => {
  const inferred = { card_number: '9704 0000 0000 0000 001' };
  prepareCardFields(inferred);
  assert.deepEqual(inferred, { card_number: '9704000000000000001', brand: 'NAPAS', last4: '0001' });
  const explicit = { card_number: '4242 4242 4242 4242', brand: 'other', card_type: 'debit' };
  prepareCardFields(explicit);
  assert.deepEqual(explicit, { card_number: '4242424242424242', brand: 'other', card_type: 'debit', last4: '4242' });
});

test('E1: saving unchanged relations keeps their types', () => {
  const initial = [
    { type: 'parent_of', target_id: 'a' },
    { type: 'related_to', target_id: 'b' },
  ] as never;
  assert.deepEqual(buildRelations(initial, ['a', 'b']), initial);
});

test('E1: newly checked targets get related_to, unchecked ones are dropped', () => {
  const initial = [{ type: 'parent_of', target_id: 'a' }] as never;
  assert.deepEqual(buildRelations(initial, ['c']), [{ type: 'related_to', target_id: 'c' }]);
  assert.deepEqual(buildRelations(undefined, ['x']), [{ type: 'related_to', target_id: 'x' }]);
});

test('gate: no account server -> connect step; no session -> sign-in; never straight to the vault', () => {
  assert.equal(authGateStep('', false), 'connect-server');
  assert.equal(authGateStep('  ', true), 'connect-server');
  assert.equal(authGateStep('https://vault.example/api', false), 'sign-in');
  assert.equal(authGateStep('https://vault.example/api', true), 'vault');
});

function memoryStore(entries: Record<string, string>): SyncTokenStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(entries));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, v); },
    removeItem: (k) => { data.delete(k); },
  };
}
const ok = async () => ({ sessions: [] });
const unauthorized = async () => { throw new ApiError(401, '/v1/auth/sessions'); };
const offline = async () => { throw new TypeError('Failed to fetch'); };
const inAnHour = String(Date.now() + 3_600_000);

test('session: a stored token opens the vault only after the server accepts it', async () => {
  let calls = 0;
  const check = async () => { calls++; return ok(); };
  assert.equal(await verifyStoredSession(memoryStore({ [LS_API_TOKEN]: 't' }), check), 'signed-in');
  assert.equal(calls, 1, 'no-expiry token was checked online');
  assert.equal(await verifyStoredSession(memoryStore({ [LS_API_TOKEN]: 't', [LS_API_TOKEN_EXPIRES_AT]: inAnHour }), check), 'signed-in');
  assert.equal(calls, 2, 'a token with a known expiry is checked too');
  assert.equal(await verifyStoredSession(memoryStore({}), check), 'signed-out');
  assert.equal(await verifyStoredSession(memoryStore({ [LS_API_TOKEN]: 't', [LS_API_TOKEN_EXPIRES_AT]: String(Date.now() - 1) }), check), 'signed-out');
  assert.equal(calls, 2, 'no call without a valid token');
});

test('session: a revoked token (server 401) is cleared and signs out, even with a known expiry', async () => {
  const store = memoryStore({ [LS_API_TOKEN]: 't', [LS_API_TOKEN_EXPIRES_AT]: inAnHour, 'my-secrect:account-email': 'a@example.test' });
  assert.equal(await verifyStoredSession(store, unauthorized), 'revoked');
  assert.deepEqual([...store.data.keys()], []);
});

test('session: server unreachable -> only a token with a known, unexpired expiry stays signed in', async () => {
  const noExpiry = memoryStore({ [LS_API_TOKEN]: 't' });
  assert.equal(await verifyStoredSession(noExpiry, offline), 'signed-out');
  assert.equal(noExpiry.data.get(LS_API_TOKEN), 't', 'kept until it can be verified online');
  assert.equal(await verifyStoredSession(memoryStore({ [LS_API_TOKEN]: 't', [LS_API_TOKEN_EXPIRES_AT]: 'soon' }), offline), 'signed-out');
  assert.equal(await verifyStoredSession(memoryStore({ [LS_API_TOKEN]: 't', [LS_API_TOKEN_EXPIRES_AT]: inAnHour }), offline), 'signed-in');
  assert.equal(await verifyStoredSession(memoryStore({ [LS_API_TOKEN]: 't', [LS_API_TOKEN_EXPIRES_AT]: inAnHour }), async () => { throw new ApiError(500, '/v1/auth/sessions'); }), 'signed-in');
});

test('session: create / restore need the server now; offline unlock with a known expiry stays allowed', async () => {
  const known = () => memoryStore({ [LS_API_TOKEN]: 't', [LS_API_TOKEN_EXPIRES_AT]: inAnHour });
  assert.equal(await verifyStoredSession(known(), offline, { requireOnline: true }), 'offline', 'create/restore refused offline');
  assert.equal(await verifyStoredSession(memoryStore({ [LS_API_TOKEN]: 't' }), offline, { requireOnline: true }), 'offline');
  assert.equal(await verifyStoredSession(known(), offline), 'signed-in', 'unlock allowed offline');
  assert.equal(await verifyStoredSession(known(), ok, { requireOnline: true }), 'signed-in');
  const revoked = known();
  assert.equal(await verifyStoredSession(revoked, unauthorized, { requireOnline: true }), 'revoked');
  assert.equal(revoked.data.has(LS_API_TOKEN), false);
});

test('gate: a saved server wins, an empty saved value falls back to the build default', () => {
  assert.equal(resolveApiBaseUrl('https://mine.example/api', 'https://default.example/api'), 'https://mine.example/api');
  assert.equal(resolveApiBaseUrl('', 'https://default.example/api'), 'https://default.example/api');
  assert.equal(resolveApiBaseUrl(null, 'https://default.example/api'), 'https://default.example/api');
  assert.equal(resolveApiBaseUrl(null, ''), '');
});

test('gate: the server URL must be https, or http only on this machine', () => {
  for (const ok of ['https://vault.example/api', 'http://localhost:3301/api', 'http://127.0.0.1:3101/api', 'http://[::1]:3000']) {
    assert.equal(isAcceptableApiBaseUrl(ok), true, ok);
  }
  for (const bad of ['', 'vault.example', 'http://vault.example/api', 'ftp://vault.example', 'javascript:alert(1)']) {
    assert.equal(isAcceptableApiBaseUrl(bad), false, bad);
  }
});

test('providers: buttons follow the server answer; desktop shows Google only with a desktop client id, never Apple', () => {
  const both = { google: { web_client_id: 'g.apps' }, apple: { services_id: 'com.example.web' } };
  assert.deepEqual(visibleProviders(null, 'web', ''), []);
  assert.deepEqual(visibleProviders({ google: null, apple: null }, 'web', ''), []);
  assert.deepEqual(visibleProviders(both, 'web', ''), ['google', 'apple']);
  assert.deepEqual(visibleProviders({ google: null, apple: both.apple }, 'web', ''), ['apple']);
  assert.deepEqual(visibleProviders(both, 'desktop', ''), []);
  assert.deepEqual(visibleProviders(both, 'desktop', 'desktop.apps'), ['google']);
  assert.deepEqual(visibleProviders({ google: null, apple: both.apple }, 'desktop', 'desktop.apps'), []);
});

test('oauth: session, MFA park and failure map like the email path', () => {
  const st = initialSignInState('login');
  assert.deepEqual(oauthSignedIn(st, 'A@Example.com', { token: 'sess_x' }), { ...st, step: 'signed-in', email: 'a@example.com' });
  assert.deepEqual(oauthSignedIn(st, 'a@example.com', { mfa_required: true, mfa_token: 'm' }), { ...st, step: 'mfa', email: 'a@example.com', mfaToken: 'm' });
  assert.equal(oauthSignedIn(st, 'a@example.com', {}).error, 'oauth-failed');
  const atMfa = { ...st, step: 'mfa' as const, mfaToken: 'm' };
  assert.equal(oauthSignedIn(atMfa, 'a@example.com', { token: 't' }), atMfa);
});

test('oauth: email claim read from the ID token (scope of the device key); Apple nonce is sha256 hex', async () => {
  const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  assert.equal(idTokenEmail(`${b64url({ alg: 'RS256' })}.${b64url({ email: 'Ann@Example.COM', n: 'ü?>' })}.sig`), 'ann@example.com');
  assert.equal(idTokenEmail(`${b64url({})}.${b64url({ sub: '1' })}.sig`), '');
  assert.equal(idTokenEmail('not-a-jwt'), '');
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
