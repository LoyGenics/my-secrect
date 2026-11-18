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
