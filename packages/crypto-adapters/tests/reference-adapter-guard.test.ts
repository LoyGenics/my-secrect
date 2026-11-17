/**
 * Guard: the WebCrypto reference adapter (AES-GCM + PBKDF2) can never be
 * selected by production code.
 *
 * It lives in packages/crypto-adapters/tests/reference/ and nowhere else.
 * This test fails if
 *  - src/index.ts exports it again or uses WebCrypto for any crypto, or
 *  - any app or package source file (apps/<app>/src, apps/<app>/index.*,
 *    packages/<pkg>/src) imports the reference module or names the
 *    adapter.
 * Built bundles were also checked by hand when it moved (vite build of
 * desktop, web, extension: no PBKDF2 / AES-GCM / deriveBits strings);
 * Metro does not tree-shake, which is why it had to leave src/.
 *
 * Run: npx tsx --test packages/crypto-adapters/tests/reference-adapter-guard.test.ts
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as adapterModule from '../src/index.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'target', '.expo', 'ios', 'android']);

function walk(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SOURCE_EXT.test(name)) out.push(full);
  }
}

/** Every file that can end up in a production bundle. */
function productionSources(): string[] {
  const files: string[] = [];
  for (const app of readdirSync(path.join(repoRoot, 'apps'))) {
    const appDir = path.join(repoRoot, 'apps', app);
    if (!statSync(appDir).isDirectory()) continue;
    walk(path.join(appDir, 'src'), files);
    // Entry points that sit next to src (mobile index.js, extension background, ...).
    for (const name of readdirSync(appDir)) {
      const full = path.join(appDir, name);
      if (statSync(full).isFile() && /^(index|main|App)\./.test(name) && SOURCE_EXT.test(name)) files.push(full);
    }
  }
  for (const pkg of readdirSync(path.join(repoRoot, 'packages'))) {
    walk(path.join(repoRoot, 'packages', pkg, 'src'), files);
  }
  return files;
}

/** Code only: drop block and line comments so prose that names the adapter does not count. */
function code(file: string): string {
  return readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const REFERENCE_USE = /webCryptoReferenceAdapter|['"][^'"]*(webcrypto-reference-adapter|tests\/reference)[^'"]*['"]/;

test('src/index.ts does not export the reference adapter or use WebCrypto crypto', () => {
  assert.equal('webCryptoReferenceAdapter' in adapterModule, false);
  const src = code(path.join(repoRoot, 'packages/crypto-adapters/src/index.ts'));
  assert.doesNotMatch(src, /crypto\.subtle|deriveBits|importKey\(|PBKDF2|AES-GCM/);
  assert.doesNotMatch(src, REFERENCE_USE);
});

test('no app or package source imports the reference adapter', () => {
  const files = productionSources();
  // Sanity: the walk really covers the apps that hold vault keys.
  for (const must of ['apps/desktop/src/vault.ts', 'apps/mobile/src/vault.ts', 'apps/extension/src/lib/vault-ext.ts', 'packages/storage/src/upload.ts']) {
    assert.ok(files.includes(path.join(repoRoot, must)), `walk missed ${must}`);
  }
  const offenders = files.filter((f) => REFERENCE_USE.test(code(f)));
  assert.deepEqual(offenders.map((f) => path.relative(repoRoot, f)), []);
});

test('the reference adapter still exists only under tests/', () => {
  assert.ok(existsSync(path.join(repoRoot, 'packages/crypto-adapters/tests/reference/webcrypto-reference-adapter.ts')));
});
