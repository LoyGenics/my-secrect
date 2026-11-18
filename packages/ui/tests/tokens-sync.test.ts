/**
 * tokens.ts is the single source; tokens.css is generated from it. This
 * test fails when the committed CSS is stale (someone edited one side) and
 * checks the generated variables cover every theme token in both themes.
 *
 * Run: npx tsx --test packages/ui/tests/tokens-sync.test.ts
 * Fix a failure: npm --workspace @my-secrect/ui run tokens
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderTokensCss, themeVariables } from '../src/tokens-css';
import { themeInitScript } from '../src/theme';
import { darkTheme, lightTheme } from '../src/tokens';

const css = readFileSync(fileURLToPath(new URL('../src/tokens.css', import.meta.url)), 'utf8');

test('tokens.css is exactly the output of renderTokensCss()', () => {
  assert.equal(css, renderTokensCss(), 'tokens.css is stale: run `npm --workspace @my-secrect/ui run tokens`');
});

test('dark and light themes define the same variable names', () => {
  const names = (t: typeof darkTheme) => themeVariables(t).map(([n]) => n).sort();
  assert.deepEqual(names(lightTheme), names(darkTheme));
});

test('every theme variable appears once per theme block (dark, light, system)', () => {
  for (const [name] of themeVariables(darkTheme)) {
    const count = css.split(`${name}:`).length - 1;
    assert.equal(count, 3, `${name} appears ${count} times`);
  }
});

test('each app serves the pre-paint theme script exactly as theme.ts defines it', () => {
  for (const app of ['desktop', 'web']) {
    const served = readFileSync(fileURLToPath(new URL(`../../../apps/${app}/public/theme-init.js`, import.meta.url)), 'utf8');
    assert.equal(served, themeInitScript, `apps/${app}/public/theme-init.js is stale: run \`npm --workspace @my-secrect/ui run tokens\``);
  }
});
