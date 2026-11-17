/**
 * QA DEFECT-E1 (relation types lost on save) and DEFECT-H4 (local-only
 * choice reset by a 401). Pure helpers used by ItemForm.tsx and App.tsx.
 *
 * Run: npx tsx --test apps/desktop/form-and-gate.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRelations } from './src/components/itemFormRelations';
import { afterUnauthorized, shouldShowSignInGate } from './src/authGate';

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

test('H4: a 401 after "Continue without signing in" keeps the local-only choice', () => {
  const next = afterUnauthorized({ signedIn: false, localOnlyBypass: true, sessionExpired: false });
  assert.equal(next.localOnlyBypass, true);
  assert.equal(shouldShowSignInGate(true, next), false);
});

test('H4: a 401 for a signed-in user still returns to the gate with "session expired"', () => {
  const next = afterUnauthorized({ signedIn: true, localOnlyBypass: false, sessionExpired: false });
  assert.deepEqual(next, { signedIn: false, localOnlyBypass: false, sessionExpired: true });
  assert.equal(shouldShowSignInGate(true, next), true);
  assert.equal(shouldShowSignInGate(false, next), false);
});
