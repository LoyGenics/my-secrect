/**
 * Regression guard: libsodium needs WebAssembly in the MV3 service worker.
 * Without 'wasm-unsafe-eval' in the extension-pages CSP libsodium falls back
 * to asm.js, which produced non-random bytes in this bundle (see the e2e).
 * Run: node --test apps/extension/tests/manifest.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(
  readFileSync(new URL('../public/manifest.json', import.meta.url), 'utf8'),
) as Record<string, unknown> & {
  host_permissions: string[];
  permissions: string[];
  content_security_policy: { extension_pages: string };
};

test("extension_pages CSP allows wasm and nothing broader", () => {
  const csp = manifest.content_security_policy.extension_pages;
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'(;|$)/);
  assert.match(csp, /object-src 'none'(;|$)/);
  assert.doesNotMatch(csp, /'unsafe-eval'/);
  assert.doesNotMatch(csp, /'unsafe-inline'/);
  assert.doesNotMatch(csp, /https?:/);
});

test('no standing host permissions (activeTab + on-demand injection only)', () => {
  assert.deepEqual(manifest.host_permissions, []);
  assert.ok(manifest.permissions.includes('activeTab'));
});

// Each permission is used: storage (vault), activeTab + scripting (on-demand
// injection into the clicked tab), alarms (auto-lock). Nothing else.
test('least privilege: exact permission set, no page-facing surface', () => {
  assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'alarms', 'scripting', 'storage']);
  for (const key of ['optional_permissions', 'optional_host_permissions', 'content_scripts', 'web_accessible_resources']) {
    assert.equal(manifest[key], undefined, `${key} must not be declared`);
  }
  // No web page may connect; no other extension may connect (ids empty).
  assert.deepEqual(manifest.externally_connectable, { ids: [] });
});
