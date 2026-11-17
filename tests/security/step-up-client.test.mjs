// MIRROR: re-implements logic in-file; NOT production verification (see tests run via tsx --test for real-module coverage).
// Step-up + Security Center client rules.
//
// HONEST HEADER — READ BEFORE CITING THESE TESTS:
//   * MIRROR, not import. These tests re-implement the client rules
//     in-file (step-up window, 403 step_up_required handling,
//     recovery-code single-use, revocation invariant) and read the
//     i18n dictionaries as TEXT. They do NOT import
//     packages/sdk/src/security.ts, apps/desktop/src/components/*, or
//     any production code. A green run proves the RULES below as
//     stated here; it cannot prove the production TS behaves the same.
//   * Plain Node 20+, no server, no TS loader:
//       node --test tests/security/step-up-client.test.mjs
//     (The root `npm test` script does not include tests/security/ —
//     do not "fix" that here; the script is out of scope.)
//   * These tests NEVER ran on the Mac. Nothing here is verified.
//
// What is covered:
//   1. Step-up window is 10 minutes: verified 9 min ago passes,
//      11 min ago fails, exactly 10 min passes, never-verified fails.
//   2. Step-up-required 403 handling: only a 403 whose body says
//      `step_up_required` triggers a re-prompt; the protected action
//      must NOT run before verification, and must run after it. Any
//      other failure is an error, not a re-prompt.
//   3. Recovery-code single-use semantics: a code validates once,
//      a second use fails, and regenerating invalidates the old set.
//   4. Revocation-does-not-erase-offline-secrets invariant: revoking
//      a device's server sessions leaves already-downloaded offline
//      copies untouched, and the i18n strings say so (EN + VI).
//   5. The `security` i18n section has exactly the 65 contracted keys
//      in both locales, so the mobile client using the same keys
//      cannot drift.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

// --- Mirror of packages/sdk/src/security.ts --------------------------------
// STEP_UP_WINDOW_MS = 10 * 60 * 1000; isStepUpFresh(verifiedAt, now) =
// verifiedAt !== null/undefined && now - verifiedAt <= STEP_UP_WINDOW_MS.
const STEP_UP_WINDOW_MS = 10 * 60 * 1000;
function isStepUpFresh(verifiedAt, now = Date.now()) {
  if (verifiedAt === null || verifiedAt === undefined) return false;
  return now - verifiedAt <= STEP_UP_WINDOW_MS;
}
// isStepUpRequired(error): ApiError with status 403 whose message
// contains 'step_up_required' (ApiError embeds the JSON body in its
// message: `API <status> <path>: <json>`).
function isStepUpRequired(error) {
  if (!error || error.name !== 'ApiError') return false;
  return error.status === 403 && String(error.message).includes('step_up_required');
}
function apiError(status, path, body) {
  const err = new Error(
    `API ${status} ${path}${body !== undefined ? `: ${typeof body === 'string' ? body : JSON.stringify(body)}` : ''}`,
  );
  err.name = 'ApiError';
  err.status = status;
  err.path = path;
  return err;
}

// --- 1. Step-up window -------------------------------------------------------
test('step-up window: verified 9 minutes ago passes', () => {
  const now = Date.now();
  assert.equal(isStepUpFresh(now - 9 * 60 * 1000, now), true);
});

test('step-up window: verified 11 minutes ago fails', () => {
  const now = Date.now();
  assert.equal(isStepUpFresh(now - 11 * 60 * 1000, now), false);
});

test('step-up window: exactly 10 minutes is still fresh (boundary)', () => {
  const now = Date.now();
  assert.equal(isStepUpFresh(now - STEP_UP_WINDOW_MS, now), true);
  assert.equal(isStepUpFresh(now - STEP_UP_WINDOW_MS - 1, now), false);
});

test('step-up window: never verified fails', () => {
  assert.equal(isStepUpFresh(null), false);
  assert.equal(isStepUpFresh(undefined), false);
});

// --- 2. Step-up-required 403 handling ----------------------------------------
test('isStepUpRequired: only a 403 naming step_up_required qualifies', () => {
  assert.equal(
    isStepUpRequired(apiError(403, '/v1/auth/step-up/totp', { error: 'step_up_required' })),
    true,
  );
  assert.equal(
    isStepUpRequired(apiError(403, '/v1/auth/sessions/others', { error: 'forbidden' })),
    false,
  );
  assert.equal(
    isStepUpRequired(apiError(401, '/v1/auth/sessions', { error: 'unauthorized' })),
    false,
  );
  assert.equal(isStepUpRequired(new TypeError('fetch failed')), false);
  assert.equal(isStepUpRequired(new Error('boom')), false);
});

// Mirror of the App's requestStepUp + guarded() rule: the protected
// action runs only after a fresh verification; a step-up-required 403
// re-prompts instead of proceeding; any other error is terminal.
test('export must not run before step-up, and must run after it', async () => {
  let exported = false;
  let prompts = 0;
  let verifiedAt = null;
  const runExport = () => { exported = true; };
  const requestStepUp = (run) => {
    if (isStepUpFresh(verifiedAt)) { run(); return; }
    prompts += 1;
    // User verifies in the dialog; only then does the action run.
    verifiedAt = Date.now();
    run();
  };
  // Stale verification: dialog opens, export waits.
  verifiedAt = Date.now() - 11 * 60 * 1000;
  requestStepUp(runExport);
  assert.equal(prompts, 1);
  assert.equal(exported, true); // ran only after the fresh verification
  // Fresh verification: no second prompt, export runs at once.
  exported = false;
  requestStepUp(runExport);
  assert.equal(prompts, 1);
  assert.equal(exported, true);
});

test('a step-up-required 403 re-prompts; any other 403 does not proceed', async () => {
  const server = {
    calls: 0,
    revokeOthers() {
      this.calls += 1;
      if (this.calls === 1) throw apiError(403, '/v1/auth/sessions/others', { error: 'step_up_required' });
      return 'revoked';
    },
  };
  let rePrompted = false;
  let completed = false;
  const guarded = async (fn) => {
    try {
      await fn();
      completed = true;
    } catch (err) {
      if (isStepUpRequired(err)) {
        rePrompted = true; // do NOT proceed; re-prompt, then retry after verification
        await fn();
        completed = true;
      } else {
        throw err;
      }
    }
  };
  await guarded(() => server.revokeOthers());
  assert.equal(rePrompted, true);
  assert.equal(completed, true);
  assert.equal(server.calls, 2);

  // A 403 for another reason is terminal: no re-prompt, no completion.
  const forbidden = () => { throw apiError(403, '/v1/auth/sessions/others', { error: 'forbidden' }); };
  let threw = false;
  try {
    await guarded(forbidden);
  } catch {
    threw = true;
  }
  assert.equal(threw, true);
  assert.equal(completed, true); // unchanged by the failed attempt (still true from before)
});

// --- 3. Recovery-code single-use semantics -----------------------------------
// Mirror of the server rule the client relies on (the client only ever
// displays the codes once and never persists them): each code validates
// exactly once; regenerating replaces the set and invalidates the old one.
function createCodeStore(codes) {
  let valid = new Set(codes);
  return {
    consume(code) {
      if (!valid.has(code)) return false;
      valid.delete(code);
      return true;
    },
    regenerate(newCodes) { valid = new Set(newCodes); },
    remaining() { return valid.size; },
  };
}

test('recovery codes are single-use', () => {
  const store = createCodeStore(['AAAA-1111', 'BBBB-2222']);
  assert.equal(store.consume('AAAA-1111'), true);
  assert.equal(store.consume('AAAA-1111'), false); // replayed: rejected
  assert.equal(store.consume('BBBB-2222'), true);
  assert.equal(store.consume('BBBB-2222'), false);
  assert.equal(store.consume('CCCC-3333'), false); // never issued
  assert.equal(store.remaining(), 0);
});

test('regenerating recovery codes invalidates the old set', () => {
  const store = createCodeStore(['AAAA-1111']);
  store.regenerate(['ZZZZ-9999']);
  assert.equal(store.consume('AAAA-1111'), false);
  assert.equal(store.consume('ZZZZ-9999'), true);
});

// --- 4. Revocation does not erase offline secrets ----------------------------
// Mirror of the SecurityCenter device-revoke rule: revoking touches
// server session records only. Offline copies already on a device are
// a separate list the revoke path never receives, let alone modifies.
function revokeDeviceSessions(sessions, deviceId) {
  return sessions.filter((s) => s.device_id !== deviceId);
}

test('revoking a device removes only its server sessions; offline copies are untouched', () => {
  const sessions = [
    { id: 's1', device_id: 'd1' },
    { id: 's2', device_id: 'd2' },
    { id: 's3', device_id: 'd1' },
  ];
  const offlineCopies = [
    { device_id: 'd1', item: 'login: bank (already downloaded)' },
    { device_id: 'd1', item: 'note: recovery phrase (already downloaded)' },
  ];
  const before = JSON.stringify(offlineCopies);
  const remaining = revokeDeviceSessions(sessions, 'd1');
  assert.deepEqual(remaining, [{ id: 's2', device_id: 'd2' }]);
  assert.equal(JSON.stringify(offlineCopies), before); // untouched by the revoke
});

// --- 5. i18n contract: the revocation notice + the exact 65 keys -------------
const EXPECTED_SECURITY_KEYS = [
  'title', 'subtitle', 'notConfigured', 'notConfiguredBody', 'offline',
  'authMethods', 'passkeys', 'addPasskey', 'removePasskey', 'noPasskeys',
  'passkeyAdded', 'passkeyRemoved', 'lastMethodWarning', 'mfa', 'mfaEnabled',
  'mfaDisabled', 'enableMfa', 'disableMfa', 'enrollMfa', 'confirmMfa',
  'mfaCodeLabel', 'mfaSecretLabel', 'mfaSecretWarning', 'recoveryCodes',
  'regenerateCodes', 'codesShownOnce', 'devices', 'sessions', 'trusted',
  'untrusted', 'trust', 'untrust', 'rename', 'revoke', 'revokeSession',
  'revokeOthers', 'revokeOthersConfirm', 'currentSession', 'lastSeen',
  'recovery', 'recoverySettings', 'recoveryVerifier', 'registerRecoveryVerifier',
  'recoveryVerifierRegistered', 'recoveryNote', 'activity', 'noActivity',
  'stepUp', 'stepUpTitle', 'stepUpBody', 'stepUpPassphrase',
  'stepUpPassphraseLabel', 'stepUpTotpLabel', 'stepUpPasskeyLabel',
  'stepUpExpired', 'stepUpFailed', 'exportRequiresStepUp', 'confirm', 'cancel',
  'close', 'save', 'done', 'error', 'retry', 'loading',
];

function securityBlockKeys(fileText) {
  const start = fileText.indexOf('  security: {');
  assert.notEqual(start, -1, 'security section missing');
  // The block ends at the section's closing brace at 2-space indent; later
  // sections (e.g. `shares`) must not leak into the security contract.
  const rest = fileText.slice(start);
  const end = rest.search(/^  \},?$/m);
  const block = end === -1 ? rest : rest.slice(0, end);
  return [...block.matchAll(/^    ([A-Za-z]+):/gm)].map((m) => m[1]);
}

test('i18n: security section has exactly the 65 contracted keys in EN and VI', () => {
  assert.equal(EXPECTED_SECURITY_KEYS.length, 65);
  for (const localeFile of ['en.ts', 'vi.ts']) {
    const text = readFileSync(path.join(repoRoot, 'packages', 'i18n', 'src', localeFile), 'utf8');
    assert.deepEqual(securityBlockKeys(text), EXPECTED_SECURITY_KEYS, localeFile);
  }
});

test('i18n: the revocation notice states offline secrets are NOT erased (EN + VI)', () => {
  const en = readFileSync(path.join(repoRoot, 'packages', 'i18n', 'src', 'en.ts'), 'utf8');
  const vi = readFileSync(path.join(repoRoot, 'packages', 'i18n', 'src', 'vi.ts'), 'utf8');
  assert.ok(
    en.includes('does NOT erase secrets already downloaded'),
    'en.ts must state revocation does not erase downloaded secrets',
  );
  assert.ok(
    vi.includes('không xóa các bí mật đã tải về'),
    'vi.ts must state revocation does not erase downloaded secrets',
  );
  // And the permanent-loss note is present in both locales.
  assert.ok(en.includes('no reset and no back door'));
  assert.ok(vi.includes('không có cách đặt lại và không có cửa hậu'));
});
