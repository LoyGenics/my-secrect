/**
 * Imports the real fill gate. These checks are pure (URL + string only).
 * Run: node --test apps/extension/tests/domain.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkFillAllowed, checkPageAllowed } from '../src/lib/domain.ts';

const settings = {
  requireConfirmForBank: true,
  requireConfirmForPunycode: true,
};

test('https page with a matching host is allowed', () => {
  const result = checkFillAllowed(
    'https://example.com/login',
    'https://example.com/account',
    'login',
    settings,
  );
  assert.deepEqual(result, { allowed: true });
});

test('raw IP host is blocked', () => {
  const result = checkFillAllowed(
    'https://203.0.113.10/login',
    'https://203.0.113.10/',
    'login',
    settings,
  );
  assert.deepEqual(result, {
    allowed: false,
    reason: 'Refusing to fill on a raw IP address.',
  });
});

test('mismatched host is blocked', () => {
  const result = checkFillAllowed(
    'https://evil.example/login',
    'https://bank.example/login',
    'login',
    settings,
  );
  assert.deepEqual(result, {
    allowed: false,
    reason: 'This login is for bank.example, but the page is evil.example.',
  });
});

test('page gate (save offers, injection): https and localhost only, never a raw IP', () => {
  assert.deepEqual(checkPageAllowed('https://example.com:8443'), { allowed: true });
  assert.deepEqual(checkPageAllowed('http://localhost:3000/login'), { allowed: true });
  assert.deepEqual(checkPageAllowed('http://example.com/login'), {
    allowed: false,
    reason: 'Refusing to fill on a non-HTTPS page.',
  });
  for (const ip of ['https://203.0.113.10/', 'http://127.0.0.1:8080/', 'https://[2001:db8::1]/']) {
    assert.deepEqual(checkPageAllowed(ip), { allowed: false, reason: 'Refusing to fill on a raw IP address.' });
  }
  assert.deepEqual(checkPageAllowed('chrome-extension://abc/popup/index.html'), {
    allowed: false,
    reason: 'Refusing to fill on a non-HTTPS page.',
  });
  assert.deepEqual(checkPageAllowed('not a url'), { allowed: false, reason: 'Could not parse the page URL.' });
});
