/**
 * security-step-up.test.mjs — MIRROR-STYLE tests (plain Node, no TS import).
 *
 * The step-up logic below MIRRORS apps/mobile/src/utils/stepUp.ts
 * (STEP_UP_WINDOW_MS, isStepUpFresh, isStepUpRequiredError) rather than
 * importing the TypeScript: this repo has no mobile test runner wired up
 * and the Mac side cannot run shell here. If utils/stepUp.ts changes,
 * update this mirror to match — the drift check at the bottom catches a
 * changed window constant in the source.
 *
 * Run from the repo root:
 *   node --test apps/mobile/tests/security-step-up.test.mjs
 * (or: node apps/mobile/tests/security-step-up.test.mjs)
 *
 * KNOWN PENDING DEPENDENCY: the "revocation notice" test reads
 * packages/i18n/src/en.ts and requires the `security` section (owned by
 * the desktop agent) to contain the revocation notice. Until that section
 * lands, that one test FAILS — that is the test doing its job, not a
 * broken test. The other tests do not depend on it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const enPath = path.join(repoRoot, 'packages/i18n/src/en.ts');
const securityScreenPath = path.join(repoRoot, 'apps/mobile/src/screens/SecurityScreen.tsx');
const stepUpPath = path.join(repoRoot, 'apps/mobile/src/utils/stepUp.ts');

// --- Mirror of apps/mobile/src/utils/stepUp.ts ----------------------------
const STEP_UP_WINDOW_MS = 10 * 60 * 1000;

function isStepUpFresh(lastStepUpAtMs, nowMs) {
  if (lastStepUpAtMs === null) return false;
  return nowMs - lastStepUpAtMs < STEP_UP_WINDOW_MS;
}

function apiStatus(err) {
  if (typeof err === 'object' && err !== null && typeof err.status === 'number') return err.status;
  return null;
}

function isStepUpRequiredError(err) {
  if (apiStatus(err) !== 403) return false;
  const body = err.body;
  if (typeof body === 'object' && body !== null && body.error === 'step_up_required') return true;
  if (err instanceof Error && err.message.includes('step_up_required')) return true;
  return false;
}

/** Mirror of the client decision after an API error: what happens next. */
function nextStepAfterError(err) {
  if (isStepUpRequiredError(err)) return 're-prompt';
  if (apiStatus(err) === null) return 'offline';
  return 'fail';
}

// --- Step-up window: 9 minutes passes, 11 minutes fails ------------------
test('step-up window: 9 minutes is fresh, 11 minutes is stale', () => {
  const now = Date.now();
  assert.equal(isStepUpFresh(now - 9 * 60 * 1000, now), true, '9 min after step-up must still be fresh');
  assert.equal(isStepUpFresh(now - 11 * 60 * 1000, now), false, '11 min after step-up must be stale');
});

test('step-up window: exactly 10 minutes is stale, null is stale', () => {
  const now = Date.now();
  assert.equal(isStepUpFresh(now - 10 * 60 * 1000, now), false, 'at exactly 10 min the window has closed');
  assert.equal(isStepUpFresh(now - 10 * 60 * 1000 + 1, now), true, 'just inside 10 min is still fresh');
  assert.equal(isStepUpFresh(null, now), false, 'no step-up yet is never fresh');
});

// --- 403 step-up-required must re-prompt, never proceed -------------------
test('403 step_up_required re-prompts and never proceeds', () => {
  const err = new Error('API 403 /v1/auth/sessions/others: {"error":"step_up_required"}');
  err.status = 403;
  assert.equal(isStepUpRequiredError(err), true);
  assert.equal(nextStepAfterError(err), 're-prompt');
  assert.notEqual(nextStepAfterError(err), 'proceed', 'a step-up-required error must never proceed');
});

test('other failures do not re-prompt as step-up', () => {
  const unauth = new Error('API 401 /v1/auth/sessions');
  unauth.status = 401;
  assert.equal(isStepUpRequiredError(unauth), false);
  assert.equal(nextStepAfterError(unauth), 'fail');

  const server = new Error('API 500 /v1/auth/sessions');
  server.status = 500;
  assert.equal(nextStepAfterError(server), 'fail');

  // A bare 403 without the step_up_required marker is a generic failure.
  const bare403 = new Error('API 403 /v1/auth/sessions');
  bare403.status = 403;
  assert.equal(isStepUpRequiredError(bare403), false);
  assert.equal(nextStepAfterError(bare403), 'fail');

  // No HTTP status at all means the request never reached the server.
  assert.equal(nextStepAfterError(new TypeError('Network request failed')), 'offline');
});

// --- Revocation notice invariant (reads the i18n source, no duplication) --
test('revocation notice exists under security.* in packages/i18n/src/en.ts', () => {
  const src = fs.readFileSync(enPath, 'utf8');
  const secIdx = src.indexOf('security');
  assert.ok(secIdx >= 0, 'en.ts has no security section yet (desktop agent owns it)');
  const securityBlock = src.slice(secIdx);
  assert.match(
    securityBlock,
    /does NOT erase/,
    'the security.* strings must contain the revocation notice: revocation invalidates server sessions only and does NOT erase secrets already downloaded/offline on that device',
  );
});

test('SecurityScreen renders the revocation notice from the i18n key, not a copy', () => {
  const src = fs.readFileSync(securityScreenPath, 'utf8');
  assert.ok(
    src.includes("t('security.revokeOthersConfirm')"),
    'SecurityScreen must render the revocation notice via t(security.revokeOthersConfirm)',
  );
});

// --- Honesty guards --------------------------------------------------------
test('SecurityScreen never fakes a passkey ceremony', () => {
  const src = fs.readFileSync(securityScreenPath, 'utf8');
  assert.ok(!src.includes('expo-local-authentication'), 'expo-local-authentication is NOT WebAuthn and must not be used for passkeys');
  assert.ok(!src.includes('addPasskeyOptions'), 'mobile must not call the passkey-creation ceremony (no WebAuthn in Expo Go)');
  assert.ok(!src.includes('verifyAddPasskey'), 'mobile must not call the passkey-creation ceremony (no WebAuthn in Expo Go)');
});

test('SecurityScreen imports the SDK security client at the specified path', () => {
  const src = fs.readFileSync(securityScreenPath, 'utf8');
  assert.ok(
    src.includes("from '../../../../packages/sdk/src/security'"),
    'SecurityScreen must import SecurityApiClient from ../../../../packages/sdk/src/security (four levels up from screens/)',
  );
});

test('mirror drift: stepUp.ts still uses a 10-minute window', () => {
  const src = fs.readFileSync(stepUpPath, 'utf8');
  assert.ok(src.includes('10 * 60 * 1000'), 'utils/stepUp.ts window changed — update this mirror to match');
  assert.ok(src.includes('isStepUpFresh'), 'utils/stepUp.ts must still export isStepUpFresh');
  assert.ok(src.includes('isStepUpRequiredError'), 'utils/stepUp.ts must still export isStepUpRequiredError');
});
