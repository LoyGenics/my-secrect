/**
 * Inspects the PRODUCTION build (npm run build -> dist/) as it would be
 * loaded or published: manifest copied unchanged, no source maps, no
 * eval-family code, no inline scripts, a classic-script content.js (it is
 * injected with chrome.scripting files, where an import statement throws),
 * and no key material or test fixtures.
 * Run: npm --workspace apps/extension run test:e2e
 */
import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { extDir } from './fixtures';

const dist = path.join(extDir, 'dist');

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)],
  );
}

test.describe('production build output', () => {
  let all: string[] = [];
  const text = (f: string) => readFileSync(f, 'utf8');
  const rel = (f: string) => path.relative(dist, f);

  test.beforeAll(() => {
    execFileSync('npm', ['run', 'build'], { cwd: extDir, stdio: 'pipe' });
    all = files(dist);
  });

  test('manifest is copied unchanged and every file type is expected', () => {
    expect(JSON.parse(text(path.join(dist, 'manifest.json')))).toEqual(
      JSON.parse(text(path.join(extDir, 'public', 'manifest.json'))),
    );
    for (const f of all) expect(['.js', '.css', '.html', '.json', '.png'], rel(f)).toContain(path.extname(f));
  });

  test('no source maps and no eval-family code', () => {
    for (const f of all.filter((f) => /\.(js|css|html)$/.test(f))) {
      const src = text(f);
      expect(src, rel(f)).not.toContain('sourceMappingURL');
      if (!f.endsWith('.js')) continue;
      expect(src, rel(f)).not.toMatch(/(^|[^\w$.])eval\s*\(/);
      expect(src, rel(f)).not.toMatch(/new\s+Function\s*\(/);
      expect(src, rel(f)).not.toMatch(/(^|[^\w$.])Function\s*\(/);
      expect(src, rel(f)).not.toMatch(/set(Timeout|Interval)\s*\(\s*["'`]/);
    }
  });

  test('HTML pages load scripts from files only (no inline script)', () => {
    for (const f of all.filter((f) => f.endsWith('.html'))) {
      const scripts = text(f).match(/<script\b[^>]*>/g) ?? [];
      expect(scripts.length, rel(f)).toBeGreaterThan(0);
      for (const tag of scripts) expect(tag, rel(f)).toMatch(/\bsrc=/);
    }
  });

  test('content.js is a self-contained classic script', () => {
    const src = text(path.join(dist, 'content.js'));
    expect(src).not.toMatch(/(^|[;}\s])(import|export)\s*[{*\w"']/);
    expect(src).not.toMatch(/\bimport\s*\(/);
  });

  test('no private keys or test fixtures in the bundle', () => {
    for (const f of all.filter((f) => !f.endsWith('.png'))) {
      const src = text(f);
      expect(src, rel(f)).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
      expect(src, rel(f)).not.toContain('Not-A-Real-Secret');
    }
  });
});
