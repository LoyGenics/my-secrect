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
import { authGateStep, isAcceptableApiBaseUrl, resolveApiBaseUrl } from './src/authGate';
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
