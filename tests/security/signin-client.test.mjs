// MIRROR: re-implements logic in-file; NOT production verification (see tests run via tsx --test for real-module coverage).
// Account sign-in client rules (passkey-first + MFA step + token storage).
//
// HONEST HEADER — READ BEFORE CITING THESE TESTS:
//   * MIRROR, not import. These tests re-implement the rules from
//     packages/sdk/src/signin.ts and packages/sdk/src/security.ts
//     (token storage helpers) in-file, and read the i18n dictionaries
//     as TEXT. They do NOT import the SDK, the desktop SignInScreen,
//     or the mobile SignInScreen. A green run proves the RULES below
//     as stated here; it cannot prove the production TS behaves the
//     same. Keep this file in sync with signin.ts / security.ts.
//   * Plain Node 20+, no server, no TS loader:
//       node --test tests/security/signin-client.test.mjs
//     (The root `npm test` script does not include tests/security/ —
//     do not "fix" that here; the script is out of scope.)
//   * These tests NEVER ran on the Mac. Nothing here is verified.
//
// What is covered:
//   1. Sign-in state machine: email -> passkey -> signed-in, and
//      email -> passkey -> mfa -> signed-in; signed-in is reachable
//      ONLY with a session token in the verify response.
//   2. Single-use tokens: a failed MFA attempt spends the mfa_token,
//      so the machine restarts from the email step with the token
//      cleared (never retried); an expired challenge does the same.
//   3. Token storage: save/read/expiry/clear; an expired token
//      reads as null and is cleared; a token with no stored expiry
//      is sent (server decides); rotated_token adoption.
//   4. Error classification: offline (TypeError), passkey-cancelled
//      (NotAllowedError), 401 at mfa -> mfa-expired, 401 elsewhere
//      -> verification-failed, challenge-expired message.
//   5. The `signin` i18n section has identical keys in EN + VI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

// --- Mirror of packages/sdk/src/signin.ts ----------------------------------
function isValidEmail(email) {
  const at = email.indexOf('@');
  return at > 0 && at === email.lastIndexOf('@') && at < email.length - 1 && !/\s/.test(email);
}
function normalizeEmail(email) { return email.trim().toLowerCase(); }
function initialSignInState(mode = 'login') {
  return { step: 'email', mode, email: '', mfaToken: null, error: null, busy: false };
}
function startSignIn(state, email, mode) {
  const normalized = normalizeEmail(email);
  if (!isValidEmail(normalized)) {
    return { ...state, step: 'email', mode, email: normalized, mfaToken: null, error: 'invalid-email', busy: false };
  }
  return { ...state, step: 'passkey', mode, email: normalized, mfaToken: null, error: null, busy: true };
}
function optionsReceived(state) {
  if (state.step !== 'passkey') return state;
  return { ...state, busy: true, error: null };
}
function passkeyVerified(state, result) {
  if (state.step !== 'passkey') return state;
  if (result.mfa_required === true && typeof result.mfa_token === 'string' && result.mfa_token) {
    return { ...state, step: 'mfa', mfaToken: result.mfa_token, error: null, busy: false };
  }
  if (typeof result.token === 'string' && result.token) {
    return { ...state, step: 'signed-in', mfaToken: null, error: null, busy: false };
  }
  return { ...state, error: 'verification-failed', busy: false };
}
function mfaVerified(state, result) {
  if (state.step !== 'mfa') return state;
  if (typeof result.token === 'string' && result.token) {
    return { ...state, step: 'signed-in', mfaToken: null, error: null, busy: false };
  }
  return { ...state, error: 'verification-failed', busy: false };
}
function signInFailed(state, kind) {
  if (kind === 'mfa-expired' || kind === 'challenge-expired') {
    return { ...state, step: 'email', mfaToken: null, error: kind, busy: false };
  }
  return { ...state, error: kind, busy: false };
}
function classifySignInError(err, step) {
  if (err instanceof TypeError) return 'offline';
  if (typeof err === 'object' && err !== null) {
    if (err.name === 'NotAllowedError') return 'passkey-cancelled';
    if (typeof err.message === 'string' && /challenge expired/i.test(err.message)) return 'challenge-expired';
    if (err.status === 401 || err.name === 'ApiError') {
      if (err.status === 401) return step === 'mfa' ? 'mfa-expired' : 'verification-failed';
    }
  }
  return 'unknown';
}

// --- Mirror of packages/sdk/src/security.ts token storage ------------------
const LS_API_TOKEN = 'my-secrect:api-token';
const LS_API_TOKEN_EXPIRES_AT = 'my-secrect:api-token-expires-at';
const LS_ACCOUNT_EMAIL = 'my-secrect:account-email';
function mapStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, v); },
    removeItem: (k) => { m.delete(k); },
    _map: m,
  };
}
async function saveSessionToken(store, token, expiresIn) {
  await store.setItem(LS_API_TOKEN, token);
  if (typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0) {
    await store.setItem(LS_API_TOKEN_EXPIRES_AT, String(Date.now() + expiresIn * 1000));
  } else {
    await store.removeItem(LS_API_TOKEN_EXPIRES_AT);
  }
}
async function clearSessionToken(store) {
  for (const k of [LS_API_TOKEN, LS_API_TOKEN_EXPIRES_AT, LS_ACCOUNT_EMAIL]) await store.removeItem(k);
}
async function getValidToken(store, now = Date.now()) {
  const token = await store.getItem(LS_API_TOKEN);
  if (!token) return null;
  const expiresAt = await store.getItem(LS_API_TOKEN_EXPIRES_AT);
  if (expiresAt !== null) {
    const at = Number(expiresAt);
    if (Number.isFinite(at) && now >= at) { await clearSessionToken(store); return null; }
  }
  return token;
}
async function adoptRotatedToken(store, res) {
  if (typeof res !== 'object' || res === null) return false;
  const rotated = res.rotated_token;
  if (typeof rotated !== 'string' || !rotated) return false;
  await store.setItem(LS_API_TOKEN, rotated);
  return true;
}

// --- 1. Email step -----------------------------------------------------------
test('startSignIn: bad email stays on email step with invalid-email', () => {
  for (const bad of ['', 'not-an-email', 'a@', '@b.com', 'a b@c.com', 'a@@b.com']) {
    const s = startSignIn(initialSignInState(), bad, 'login');
    assert.equal(s.step, 'email');
    assert.equal(s.error, 'invalid-email');
    assert.equal(s.busy, false);
    assert.equal(s.mfaToken, null);
  }
});

test('startSignIn: good email normalises and moves to passkey', () => {
  const s = startSignIn(initialSignInState(), '  Alice@Example.COM ', 'login');
  assert.equal(s.step, 'passkey');
  assert.equal(s.email, 'alice@example.com');
  assert.equal(s.error, null);
  assert.equal(s.busy, true);
});

test('optionsReceived: only valid from the passkey step', () => {
  assert.equal(optionsReceived(initialSignInState()).step, 'email');
  const s = optionsReceived(startSignIn(initialSignInState(), 'a@b.com', 'login'));
  assert.equal(s.step, 'passkey');
  assert.equal(s.busy, true);
});

// --- 2. Passkey + MFA steps --------------------------------------------------
test('passkeyVerified: session token signs in', () => {
  const s0 = startSignIn(initialSignInState(), 'a@b.com', 'login');
  const s = passkeyVerified(s0, { token: 'sess_abc', user_id: 'u1', expires_in: 3600 });
  assert.equal(s.step, 'signed-in');
  assert.equal(s.mfaToken, null);
  assert.equal(s.error, null);
});

test('passkeyVerified: mfa_required parks at the mfa step with the token', () => {
  const s0 = startSignIn(initialSignInState(), 'a@b.com', 'login');
  const s = passkeyVerified(s0, { mfa_required: true, mfa_token: 'mfa_xyz', user_id: 'u1' });
  assert.equal(s.step, 'mfa');
  assert.equal(s.mfaToken, 'mfa_xyz');
  assert.equal(s.error, null);
});

test('passkeyVerified: no token and no mfa park is verification-failed, never signed-in', () => {
  const s0 = startSignIn(initialSignInState(), 'a@b.com', 'login');
  const s = passkeyVerified(s0, {});
  assert.notEqual(s.step, 'signed-in');
  assert.equal(s.error, 'verification-failed');
});

test('mfaVerified: token signs in, only from the mfa step', () => {
  const s0 = passkeyVerified(startSignIn(initialSignInState(), 'a@b.com', 'login'), { mfa_required: true, mfa_token: 'mfa_xyz' });
  const s = mfaVerified(s0, { token: 'sess_def', expires_in: 3600 });
  assert.equal(s.step, 'signed-in');
  assert.equal(s.mfaToken, null);
  // From any other step the call is ignored, never signed-in.
  assert.equal(mfaVerified(initialSignInState(), { token: 'sess_def' }).step, 'email');
  assert.equal(mfaVerified(s0, {}).error, 'verification-failed');
});

// --- 3. Single-use tokens ----------------------------------------------------
test('signInFailed mfa-expired: restarts from email and clears the spent mfa_token', () => {
  const s0 = passkeyVerified(startSignIn(initialSignInState(), 'a@b.com', 'login'), { mfa_required: true, mfa_token: 'mfa_xyz' });
  assert.equal(s0.step, 'mfa');
  const s = signInFailed(s0, 'mfa-expired');
  assert.equal(s.step, 'email');
  assert.equal(s.mfaToken, null);
  assert.equal(s.error, 'mfa-expired');
  assert.equal(s.busy, false);
});

test('signInFailed challenge-expired: restarts from email for fresh options', () => {
  const s0 = startSignIn(initialSignInState(), 'a@b.com', 'login');
  const s = signInFailed(s0, 'challenge-expired');
  assert.equal(s.step, 'email');
  assert.equal(s.error, 'challenge-expired');
});

test('signInFailed passkey-cancelled: stays on the passkey step so the user can retry', () => {
  const s0 = startSignIn(initialSignInState(), 'a@b.com', 'login');
  const s = signInFailed(s0, 'passkey-cancelled');
  assert.equal(s.step, 'passkey');
  assert.equal(s.error, 'passkey-cancelled');
  assert.equal(s.busy, false);
});

// --- 4. Token storage --------------------------------------------------------
test('getValidToken: returns the token before expiry, null after (and clears it)', async () => {
  const store = mapStore();
  await saveSessionToken(store, 'sess_abc', 3600);
  assert.equal(await getValidToken(store, Date.now()), 'sess_abc');
  assert.equal(await getValidToken(store, Date.now() + 3601 * 1000), null);
  assert.equal(store._map.get(LS_API_TOKEN), undefined);
  assert.equal(store._map.get(LS_API_TOKEN_EXPIRES_AT), undefined);
});

test('getValidToken: no stored expiry means the token is sent (server decides)', async () => {
  const store = mapStore();
  await store.setItem(LS_API_TOKEN, 'sess_abc');
  assert.equal(await getValidToken(store, Date.now() + 365 * 86400 * 1000), 'sess_abc');
});

test('getValidToken: no token returns null without throwing', async () => {
  assert.equal(await getValidToken(mapStore()), null);
});

test('clearSessionToken: removes token, expiry, and account email', async () => {
  const store = mapStore();
  await saveSessionToken(store, 'sess_abc', 3600);
  await store.setItem(LS_ACCOUNT_EMAIL, 'a@b.com');
  await clearSessionToken(store);
  assert.equal(store._map.size, 0);
});

test('adoptRotatedToken: adopts a string rotated_token, ignores anything else', async () => {
  const store = mapStore();
  await store.setItem(LS_API_TOKEN, 'sess_old');
  assert.equal(await adoptRotatedToken(store, { rotated_token: 'sess_new' }), true);
  assert.equal(await store.getItem(LS_API_TOKEN), 'sess_new');
  assert.equal(await adoptRotatedToken(store, {}), false);
  assert.equal(await adoptRotatedToken(store, { rotated_token: '' }), false);
  assert.equal(await adoptRotatedToken(store, { rotated_token: 42 }), false);
  assert.equal(await adoptRotatedToken(store, null), false);
  assert.equal(await store.getItem(LS_API_TOKEN), 'sess_new');
});

// --- 5. Error classification ---------------------------------------------------
test('classifySignInError: TypeError is offline; NotAllowedError is passkey-cancelled', () => {
  assert.equal(classifySignInError(new TypeError('fetch failed'), 'passkey'), 'offline');
  const cancelled = new Error('user cancelled');
  cancelled.name = 'NotAllowedError';
  assert.equal(classifySignInError(cancelled, 'passkey'), 'passkey-cancelled');
});

test('classifySignInError: 401 at mfa is mfa-expired, 401 elsewhere is verification-failed', () => {
  const err401 = new Error('API 401 /v1/auth/mfa/verify: {"error":"verification_failed"}');
  err401.name = 'ApiError'; err401.status = 401;
  assert.equal(classifySignInError(err401, 'mfa'), 'mfa-expired');
  assert.equal(classifySignInError(err401, 'passkey'), 'verification-failed');
});

test('classifySignInError: challenge-expired message maps, anything else is unknown', () => {
  assert.equal(classifySignInError(new Error('challenge expired or already used'), 'passkey'), 'challenge-expired');
  assert.equal(classifySignInError(new Error('boom'), 'passkey'), 'unknown');
  assert.equal(classifySignInError(undefined, 'passkey'), 'unknown');
});

// --- 6. i18n: signin keys identical in EN + VI --------------------------------
function signinKeys(file) {
  const text = readFileSync(path.join(repoRoot, 'packages/i18n/src', file), 'utf8');
  const m = text.match(/signin:\s*\{([\s\S]*?)\n  \},\n  security:/);
  assert.ok(m, `${file} must contain a signin section before security`);
  return [...m[1].matchAll(/^    (\w+):/gm)].map((x) => x[1]);
}

test('i18n: signin keys are identical in en.ts and vi.ts', () => {
  const en = signinKeys('en.ts');
  const vi = signinKeys('vi.ts');
  assert.deepEqual([...vi].sort(), [...en].sort());
  assert.ok(en.length >= 20, `expected at least 20 signin keys, got ${en.length}`);
  for (const k of ['title', 'emailLabel', 'signInButton', 'mfaTitle', 'mfaCodeLabel', 'recoveryCodeLabel', 'continueWithGoogle', 'continueWithApple', 'changeServer', 'signOut', 'sessionExpired', 'verificationFailed', 'mfaExpired', 'offline']) {
    assert.ok(en.includes(k), `en signin is missing ${k}`);
  }
});
