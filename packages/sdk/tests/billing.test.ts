import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BillingApiClient, formatBillingPrice, storeManagementUrl, stripeRedirectUrl } from '../src/billing';

test('only accepts exact Stripe HTTPS Checkout and portal destinations', () => {
  assert.equal(stripeRedirectUrl('https://checkout.stripe.com/c/pay/example', 'checkout'), 'https://checkout.stripe.com/c/pay/example');
  for (const url of ['javascript:alert(1)', 'https://checkout.stripe.com.attacker.test/', 'https://user:password@checkout.stripe.com/', 'http://checkout.stripe.com/', 'https://billing.stripe.com/']) {
    assert.throws(() => stripeRedirectUrl(url, 'checkout'));
  }
  assert.equal(storeManagementUrl('app_store'), 'https://apps.apple.com/account/subscriptions');
  assert.equal(storeManagementUrl('google_play', true), 'https://play.google.com/store/account/orderhistory');
});

test('formats Stripe zero-decimal and standard currency amounts', () => {
  assert.equal(formatBillingPrice(299, 'usd', 'en'), '$2.99');
  assert.match(formatBillingPrice(1000, 'jpy', 'en'), /1,000/);
  assert.match(formatBillingPrice(100000, 'vnd', 'vi'), /100\.000/);
  assert.match(formatBillingPrice(10000, 'isk', 'en'), /100/);
  assert.match(formatBillingPrice(10000, 'ugx', 'en'), /100/);
  assert.match(formatBillingPrice(1000, 'kwd', 'en'), /1\.000/);
});

test('checkout sends only a purchase option, authenticated to the configured API', async () => {
  const original = globalThis.fetch;
  let call: { url: string; init?: RequestInit } | undefined;
  globalThis.fetch = (async (url, init) => {
    call = { url: String(url), init };
    return new Response(JSON.stringify({ url: 'https://checkout.stripe.com/c/pay/example' }), { status: 200 });
  }) as typeof fetch;
  try {
    const api = new BillingApiClient({ baseUrl: 'https://api.example.test/api/', getToken: async () => 'fixture-account-session' });
    await api.checkout('lifetime');
    assert.equal(call?.url, 'https://api.example.test/api/v1/billing/checkout');
    assert.deepEqual(JSON.parse(String(call?.init?.body)), { option: 'lifetime' });
    assert.equal(new Headers(call?.init?.headers).get('Authorization'), 'Bearer fixture-account-session');
    assert.equal(call?.init?.cache, 'no-store');
  } finally { globalThis.fetch = original; }
});
