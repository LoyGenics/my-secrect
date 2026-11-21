#!/usr/bin/env node
// Pocket Ledger desktop/web QA: drives the REAL web app (apps/web, which renders the desktop App)
// through its UI with synthetic data only ("Load example data"), and for every state × viewport ×
// theme writes a screenshot, the layout-audit checks (reused from
// design-lab/mobile/round-02/_shared/layout-audit.mjs), the prototype gate checks (reused from
// design-lab/desktop/round-01/capture.mjs), pane geometry vs spec.md, axe, and interaction checks.
// The report puts each real screenshot next to the approved prototype screenshot of the same state.
//
//   node design-qa/web-audit.mjs [--url http://localhost:5422] [--only vault,search]
//        [--viewports 1280x800,1440x900,820x1000] [--themes light,dark] [--no-axe] [--label name]
//        [--lab <path to design-lab>]
//
// Needs a running web dev server (npm --workspace apps/web run dev -- --port 5422 --strictPort --host localhost).
// Every request that leaves the dev-server origin is aborted and listed in the report.
// Output: design-qa/runs/<label>/{index.html,report.md,report.json,shots/…}
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const args = process.argv.slice(2);
const opt = (n, d = null) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const BASE = opt('--url', 'http://localhost:5422').replace(/\/+$/, '');
const ORIGIN = new URL(BASE).origin;
const ONLY = opt('--only')?.split(',') ?? null;
const THEMES = opt('--themes', 'light,dark').split(',');
const VIEWPORTS = opt('--viewports', '1280x800,1440x900,820x1000').split(',').map((v) => { const [w, h] = v.split('x').map(Number); return { w, h, key: v }; });
const AXE = !args.includes('--no-axe');
const PASS = 'qa synthetic passphrase 0000 !'; // throwaway local vault, never a real secret

const git = (...a) => { try { return execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim(); } catch { return '?'; } };
const sha = git('rev-parse', '--short', 'HEAD');
const dirty = git('status', '--porcelain', '--', 'apps', 'packages') ? '+dirty' : '';
const label = opt('--label', `${sha}${dirty}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}`);
const outDir = path.join(here, 'runs', label);
fs.mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------- reuse the design-lab checks
const labCandidates = [opt('--lab'), path.join(repo, 'design-lab'), path.resolve(repo, '..', 'design-approved', 'design-lab')].filter(Boolean);
const lab = labCandidates.find((p) => fs.existsSync(path.join(p, 'mobile/round-02/_shared/layout-audit.mjs')));
if (!lab) { console.error(`design-lab not found (tried ${labCandidates.join(', ')}); pass --lab`); process.exit(2); }
const proto = path.join(lab, 'desktop/round-01/screenshots');
const auditorSrc = fs.readFileSync(path.join(lab, 'mobile/round-02/_shared/layout-audit.mjs'), 'utf8');
const slice = (src, from, to) => { const a = src.indexOf(from), b = src.indexOf(to, a); if (a < 0 || b < 0) throw new Error(`cannot slice ${from}`); return src.slice(a, b); };
// measure() walks from #app; the real app portals dialogs into <body>, so walk from <body>.
const measureSrc = slice(auditorSrc, 'function measure(', '// ----------------------------------------------------------------').replace("document.querySelector('#app')", 'document.body');
const { aggregate } = await import('data:text/javascript,' + encodeURIComponent(`${slice(auditorSrc, 'const occurrences', '// ---------------------------------------------------------------- run')}\nexport { aggregate };`));
const captureSrc = fs.readFileSync(path.join(lab, 'desktop/round-01/capture.mjs'), 'utf8');
const gateSrc = slice(captureSrc, 'function audit(', 'async function shoot');

// Pane geometry against spec.md "Layout grid" (measured from anchors, not class names).
function geometry({ W, H, anchors }) {
  const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const R = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; };
  const byText = (t, sel = '*') => [...document.querySelectorAll(sel)].find((e) => vis(e) && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() === t));
  const upTo = (el, ok) => { for (let p = el; p && p !== document.body; p = p.parentElement) if (ok(p.getBoundingClientRect(), p)) return p; return null; };
  const contentLeft = (pane) => {
    const pr = pane.getBoundingClientRect();
    let min = Infinity;
    const w = document.createTreeWalker(pane, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (!n.textContent.trim() || !vis(n.parentElement)) continue;
      const rg = document.createRange(); rg.selectNodeContents(n);
      for (const r of rg.getClientRects()) if (r.width > 1 && r.top >= pr.top && r.bottom <= pr.bottom + 1 && r.top < innerHeight) min = Math.min(min, r.left);
    }
    for (const s of pane.querySelectorAll('svg')) { const r = s.getBoundingClientRect(); if (vis(s) && r.width > 1 && r.top < innerHeight) min = Math.min(min, r.left); }
    return min === Infinity ? null : Math.round((min - pr.left) * 10) / 10;
  };
  const out = { W, H, panes: {} };
  const tall = (r) => r.height >= 0.6 * H;
  const spineNav = [...document.querySelectorAll('nav')].find((n) => vis(n) && /vault navigation/i.test(n.getAttribute('aria-label') || ''));
  const search = [...document.querySelectorAll('input')].find((i) => vis(i) && /search/i.test(`${i.getAttribute('aria-label')} ${i.placeholder} ${i.type}`));
  const cover = search ? upTo(search, (r) => r.width >= 0.9 * W && r.height >= 40 && r.height <= 120) : null;
  if (cover) out.panes.cover = { ...R(cover), padLeft: (() => { const s = getComputedStyle(cover); return parseFloat(s.paddingLeft); })() };
  if (spineNav) { const sp = upTo(spineNav, (r) => tall(r) && r.width < 0.4 * W) ?? spineNav; out.panes.spine = { ...R(sp), contentLeft: contentLeft(sp) }; }
  const row = anchors.row ? byText(anchors.row) : null;
  if (row) { const l = upTo(row, (r) => tall(r) && r.width < 0.6 * W); if (l) out.panes.ledger = { ...R(l), contentLeft: contentLeft(l) }; }
  const head = anchors.heading ? [...document.querySelectorAll('h1,h2,h3')].find((h) => vis(h) && h.textContent.trim() === anchors.heading) : null;
  if (head) {
    const p = upTo(head, (r) => tall(r) && r.width < W - 100);
    if (p) out.panes.page = { ...R(p), contentLeft: contentLeft(p), headingLeft: Math.round(head.getBoundingClientRect().left - p.getBoundingClientRect().left) };
    // widest visible block inside the page that is not the page itself = content column
    if (p) { let max = 0; for (const c of p.querySelectorAll('div,section,dl,ul,form')) { const r = c.getBoundingClientRect(); if (vis(c) && c !== p && r.width > max && r.width < p.getBoundingClientRect().width - 1) max = r.width; } out.panes.page.contentMax = Math.round(max); }
  }
  const banner = byText('Web client — separate attack surface. Web is limited — use Desktop for sensitive data.') || [...document.querySelectorAll('body *')].find((e) => vis(e) && /^Web client — separate attack surface/.test(e.textContent.trim()) && e.children.length < 4);
  out.webBanner = banner ? R(banner) : null;
  out.bodyFont = getComputedStyle(document.body).fontFamily;
  out.fontsLoaded = [...new Set([...document.fonts].filter((f) => f.status === 'loaded').map((f) => `${f.family.replace(/["']/g, '')} ${f.weight}`))];
  out.docOverflowX = document.documentElement.scrollWidth - W;
  return out;
}

const EXPECT = {
  1280: { cover: 56, spine: 248, ledger: 384, page: 648 },
  1440: { cover: 56, spine: 248, ledger: 420, page: 772 },
  820: { cover: 56, spine: null, ledger: 320, page: 500 },
};

// ---------------------------------------------------------------- state results
const results = []; // {vp, theme, state, shot, annotated, proto, layout, gate, geo, axe, error}
const checks = []; // {vp, theme, name, status: ok|fail|skip, detail}
const external = new Set();
const pageErrors = [];
const check = (ctx, name, status, detail = '') => { checks.push({ ...ctx, name, status, detail }); console.log(`  ${status.padEnd(4)} ${name}${detail ? ` — ${detail}` : ''}`); };

const protoFor = (vp, theme, state) => {
  const name = { 'empty-vault': null }[state] === null ? null : state;
  if (!name) return null;
  const f = vp.w === 1280 ? `${theme}/${name}.png` : vp.w === 1440 ? `wide/${theme}-${name}.png` : vp.w === 820 ? `narrow/${theme}-${name}.png` : null;
  const fallback = `${theme}/${name}.png`; // same state at 1280 when no wide/narrow capture exists
  if (f && fs.existsSync(path.join(proto, f))) return { file: path.join(proto, f), exact: true };
  if (fs.existsSync(path.join(proto, fallback))) return { file: path.join(proto, fallback), exact: false };
  return null;
};

async function capture(page, vp, theme, state, anchors = {}) {
  if (ONLY && !ONLY.includes(state)) return;
  await page.waitForTimeout(350);
  const rel = `shots/${vp.key}/${theme}-${state}.png`;
  const file = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const rec = { vp: vp.key, theme, state, shot: rel, proto: protoFor(vp, theme, state) };
  try {
    await page.screenshot({ path: file });
    const m = await page.evaluate(`(${measureSrc})(${JSON.stringify({ W: vp.w, H: vp.h })})`);
    rec.layout = m;
    rec.gate = await page.evaluate(`(${gateSrc})(${JSON.stringify({ W: vp.w })})`);
    rec.geo = await page.evaluate(geometry, { W: vp.w, H: vp.h, anchors });
    const marks = m.findings.filter((f) => f.severity !== 'low' && f.rects.length);
    if (marks.length) {
      await page.evaluate((items) => {
        const o = document.createElement('div');
        o.id = '__qa_overlay';
        o.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;font:700 10px/13px ui-monospace,monospace';
        for (const it of items) {
          const col = it.severity === 'high' ? '#ff1f3d' : '#ff8a00';
          it.rects.forEach((r, k) => {
            const b = document.createElement('div');
            b.style.cssText = `position:absolute;left:${r.x}px;top:${r.y}px;width:${Math.max(r.w, 2)}px;height:${Math.max(r.h, 2)}px;outline:1.5px solid ${col};background:${col}14`;
            o.appendChild(b);
            if (k) return;
            const l = document.createElement('div');
            l.textContent = `${it.n} ${it.check}`;
            l.style.cssText = `position:absolute;left:${Math.max(r.x, 0)}px;top:${r.y >= 13 ? r.y - 13 : r.y + r.h}px;background:${col};color:#fff;padding:0 3px;border-radius:2px;white-space:nowrap`;
            o.appendChild(l);
          });
        }
        document.body.appendChild(o);
      }, marks.map((f, n) => ({ n: n + 1, check: f.check, severity: f.severity, rects: f.rects })));
      rec.annotated = rel.replace(/\.png$/, '.annotated.png');
      await page.screenshot({ path: path.join(outDir, rec.annotated) });
      await page.evaluate(() => document.getElementById('__qa_overlay')?.remove());
      marks.forEach((f, n) => { f.mark = n + 1; });
    }
    if (AXE) {
      const { default: AxeBuilder } = await import('@axe-core/playwright');
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
      rec.axe = r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, targets: v.nodes.slice(0, 4).map((n) => `${n.target.join(' ')} — ${(n.failureSummary || '').split('\n').slice(1).join(' ').slice(0, 160)}`) }));
    }
    console.log(`  shot ${vp.key} ${theme} ${state}: layout ${m.findings.filter((f) => f.severity === 'high').length}H/${m.findings.filter((f) => f.severity === 'medium').length}M${rec.axe ? `, axe ${rec.axe.length}` : ''}`);
  } catch (e) {
    rec.error = e.message.split('\n')[0];
    console.log(`  ERR  ${vp.key} ${theme} ${state}: ${rec.error}`);
  }
  results.push(rec);
}

// ---------------------------------------------------------------- UI helpers (role/label based; the markup is changing)
const visibleFirst = async (loc) => { const n = await loc.count(); for (let i = 0; i < n; i++) if (await loc.nth(i).isVisible().catch(() => false)) return loc.nth(i); return null; };
const clickable = (page, name) => page.getByRole('button', { name }).or(page.getByRole('link', { name })).or(page.getByRole('tab', { name })).or(page.getByRole('menuitem', { name })).or(page.getByRole('option', { name }));
async function openDrawer(page) {
  const b = await visibleFirst(page.getByRole('button', { name: /^(menu|open menu|open navigation|show sidebar|navigation|open sidebar)$/i }));
  if (b) { await b.click(); await page.waitForTimeout(250); return true; }
  return false;
}
async function clickNav(page, name, { drawer = true } = {}) {
  let el = await visibleFirst(clickable(page, name));
  if (!el && drawer && await openDrawer(page)) el = await visibleFirst(clickable(page, name));
  if (!el) throw new Error(`no visible control named ${name}`);
  await el.click();
  await page.waitForTimeout(250);
}
async function escapeAll(page) { for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(60); } }
async function home(page) {
  await escapeAll(page);
  for (const n of [/^All items/i, /^Vault$/]) { try { await clickNav(page, n); break; } catch { /* next */ } }
  await escapeAll(page);
}
async function openItem(page, title) {
  const row = await visibleFirst(page.getByRole('option', { name: new RegExp(title) }).or(page.getByRole('button', { name: new RegExp(`^${title}`) })).or(page.getByText(title, { exact: true })));
  if (!row) throw new Error(`row "${title}" not visible`);
  await row.click();
  await page.getByRole('heading', { name: title }).first().waitFor({ timeout: 5000 });
}
const tryState = async (ctx, state, fn) => { if (ONLY && !ONLY.includes(state) && !['vault'].includes(state)) return; try { await fn(); } catch (e) { check(ctx, `reach ${state}`, 'fail', e.message.split('\n')[0]); results.push({ ...ctx, state, error: `not reached: ${e.message.split('\n')[0]}` }); } };

async function newContext(browser, theme, init = {}) {
  const context = await browser.newContext({ viewport: { width: VIEWPORTS[0].w, height: VIEWPORTS[0].h }, colorScheme: theme, reducedMotion: 'reduce', locale: 'en-US', acceptDownloads: true });
  await context.addInitScript(({ theme, init }) => { try { localStorage.setItem('my-secrect:theme', theme); for (const [k, v] of Object.entries(init)) localStorage.setItem(k, v); } catch { /* ignore */ } }, { theme, init });
  await context.route('**/*', (r) => {
    const u = r.request().url();
    if (u.startsWith(ORIGIN) || /^(data|blob):/.test(u)) return r.continue();
    external.add(u.replace(/\?.*/, ''));
    return r.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(`${theme}: ${e.message.split('\n')[0]}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/ERR_FAILED|Failed to load resource/.test(m.text())) pageErrors.push(`${theme} console: ${m.text().slice(0, 200)}`); });
  return { context, page };
}

// ---------------------------------------------------------------- run
const browser = await chromium.launch();
const started = new Date();
try {
  for (const theme of THEMES) {
    console.log(`== ${theme}`);
    // Sign-in gate: needs a configured server; point it at a closed local port (requests are aborted anyway).
    if (!ONLY || ONLY.includes('signin')) {
      const { context, page } = await newContext(browser, theme, { 'my-secrect:api-base-url': 'http://127.0.0.1:9' });
      try {
        await page.goto(BASE + '/');
        await page.getByRole('heading', { name: /sign in/i }).first().waitFor({ timeout: 15000 });
        for (const vp of VIEWPORTS) { await page.setViewportSize({ width: vp.w, height: vp.h }); await capture(page, vp, theme, 'signin'); }
      } catch (e) { check({ theme }, 'reach signin', 'fail', e.message.split('\n')[0]); }
      await context.close();
    }

    const { context, page } = await newContext(browser, theme);
    await page.goto(BASE + '/');
    await page.getByLabel('Master passphrase', { exact: true }).waitFor({ timeout: 20000 });
    for (const vp of VIEWPORTS) { await page.setViewportSize({ width: vp.w, height: vp.h }); await capture(page, vp, theme, 'onboarding'); }
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByLabel('Master passphrase', { exact: true }).fill(PASS);
    await page.getByLabel('Confirm passphrase').fill(PASS);
    await page.getByRole('button', { name: 'Create vault' }).click();
    const ack = page.getByLabel(/saved my recovery key/i);
    await ack.waitFor({ timeout: 90000 });
    const c0 = { theme, vp: '1280x800' };
    check(c0, 'recovery ack unticked by default', (await ack.isChecked()) ? 'fail' : 'ok');
    const cont = await visibleFirst(page.getByRole('button', { name: /^(Done|Continue)$/ }));
    if (cont) {
      const dis = (await cont.isDisabled()) || (await cont.getAttribute('aria-disabled')) === 'true';
      check(c0, 'recovery Continue/Done disabled until ticked', dis ? 'ok' : 'fail', dis ? '' : 'enabled before the acknowledgement');
    } else check(c0, 'recovery Continue/Done disabled until ticked', 'fail', 'no Done/Continue button');
    const dl = await visibleFirst(page.getByRole('button', { name: /download/i }));
    if (!dl) check(c0, 'recovery key download (web)', 'fail', 'no Download button on the recovery step');
    else {
      try {
        const [d] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }), dl.click()]);
        const fn = d.suggestedFilename();
        await d.delete();
        check(c0, 'recovery key download (web)', /recovery/i.test(fn) && fn.endsWith('.txt') ? 'ok' : 'fail', `file "${fn}"`);
      } catch (e) { check(c0, 'recovery key download (web)', 'fail', `click produced no browser download (${e.message.split('\n')[0]})`); }
    }
    for (const vp of VIEWPORTS) { await page.setViewportSize({ width: vp.w, height: vp.h }); await capture(page, vp, theme, 'onboarding-recovery'); }
    await page.setViewportSize({ width: 1280, height: 800 });
    await ack.check();
    await (await visibleFirst(page.getByRole('button', { name: /^(Done|Continue)$/ })))?.click();
    const open = page.getByRole('button', { name: 'Open vault' });
    if (await open.isVisible({ timeout: 5000 }).catch(() => false)) await open.click();
    else check(c0, 'test label "Open vault" (a11y-web, extension e2e)', 'fail', 'button not found after recovery');
    const load = page.getByRole('button', { name: 'Load example data' }).first();
    await load.waitFor({ timeout: 15000 });
    for (const vp of VIEWPORTS) { await page.setViewportSize({ width: vp.w, height: vp.h }); await capture(page, vp, theme, 'empty-vault'); }
    await page.setViewportSize({ width: 1280, height: 800 });
    await load.click();
    await page.getByText('Example Website').first().waitFor({ timeout: 15000 });

    // Test-facing labels used by tests/a11y-web and tests/e2e-web (1280 only).
    const has = async (loc) => (await loc.count()) > 0;
    check(c0, 'nav "Vault navigation" present (a11y-web)', (await has(page.getByRole('navigation', { name: 'Vault navigation' }))) ? 'ok' : 'fail');
    check(c0, 'button "+ New item" (a11y-web)', (await has(page.getByRole('button', { name: '+ New item' }))) ? 'ok' : 'fail');
    check(c0, 'button /Lock vault/ (e2e-web)', (await has(page.getByRole('button', { name: /Lock vault/ }))) ? 'ok' : 'fail');
    const scBtn = await has(page.getByRole('button', { name: /Security Center/ }));
    check(c0, 'button /Security Center/ reachable from vault (e2e-web)', scBtn ? 'ok' : 'fail', scBtn ? '' : 'e2e-web clicks getByRole(button,/Security Center/) from the vault');
    check(c0, 'web-limits banner on web', (await page.getByText(/^Web client — separate attack surface/).count()) > 0 ? 'ok' : 'fail');

    // Keyboard model (1280).
    try {
      await home(page);
      await openItem(page, 'Example Website');
      const before = await page.evaluate(() => document.activeElement?.textContent?.trim().slice(0, 40));
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(200);
      const after = await page.evaluate(() => ({ t: document.activeElement?.textContent?.trim().slice(0, 40), h: [...document.querySelectorAll('h1,h2')].map((h) => h.textContent.trim()).join('|') }));
      check(c0, 'ledger ↓ moves selection + focus', after.t !== before && !after.h.includes('Example Website') ? 'ok' : 'fail', `focus "${before}" → "${after.t}", headings ${after.h.slice(0, 80)}`);
    } catch (e) { check(c0, 'ledger ↓ moves selection + focus', 'fail', e.message.split('\n')[0]); }
    try {
      await home(page);
      const search = await visibleFirst(page.getByRole('searchbox').or(page.getByRole('button', { name: /search/i })).or(page.getByPlaceholder(/search/i)));
      await page.keyboard.press('ControlOrMeta+K');
      const dlg = page.getByRole('dialog');
      await dlg.first().waitFor({ timeout: 3000 });
      const inInput = await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]') && document.activeElement.tagName === 'INPUT');
      check(c0, '⌘K opens palette with focus in its input', inInput ? 'ok' : 'fail');
      await page.keyboard.type('exam');
      await page.waitForTimeout(150);
      await page.keyboard.press('ArrowDown');
      const sel = await page.evaluate(() => { const d = document.querySelector('[role=dialog]'); const a = d?.querySelector('[aria-selected=true], [data-active=true], .is-active'); return a ? a.textContent.trim().slice(0, 40) : null; });
      check(c0, 'palette ↑↓ moves active option', sel ? 'ok' : 'fail', sel ? `active "${sel}"` : 'no aria-selected option after ↓');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      const closed = (await dlg.count()) === 0 || !(await dlg.first().isVisible());
      const back = await page.evaluate(() => { const a = document.activeElement; return a ? `${a.tagName.toLowerCase()} ${a.getAttribute('aria-label') || a.getAttribute('placeholder') || a.textContent.trim().slice(0, 30)}` : 'none'; });
      check(c0, 'Esc closes palette, focus returns to search', closed && /search/i.test(back) ? 'ok' : 'fail', `closed=${closed}, focus on ${back}${search ? '' : ' (no visible search control found)'}`);
    } catch (e) { check(c0, '⌘K palette', 'fail', e.message.split('\n')[0]); }
    try {
      await home(page);
      await page.locator('body').click({ position: { x: 5, y: 790 } }).catch(() => {});
      await page.keyboard.press('ControlOrMeta+N');
      await page.getByRole('heading', { name: /^New/ }).first().waitFor({ timeout: 3000 });
      check(c0, '⌘N opens a new item', 'ok');
    } catch (e) { check(c0, '⌘N opens a new item', 'fail', e.message.split('\n')[0]); }

    for (const vp of VIEWPORTS) {
      console.log(`-- ${theme} ${vp.key}`);
      await page.setViewportSize({ width: vp.w, height: vp.h });
      const ctx = { theme, vp: vp.key };
      await tryState(ctx, 'vault', async () => { await home(page); await openItem(page, 'Example Website'); await capture(page, vp, theme, 'vault', { row: 'Example Website', heading: 'Example Website' }); });
      await tryState(ctx, 'detail-revealed', async () => {
        const rev = await visibleFirst(page.getByRole('button', { name: /^(reveal|show)( password)?$|reveal password|show password/i }));
        if (!rev) throw new Error('no reveal/show button in the detail');
        await rev.click();
        await capture(page, vp, theme, 'detail-revealed', { row: 'Example Website', heading: 'Example Website' });
        await rev.click().catch(() => {});
      });
      await tryState(ctx, 'filters', async () => { await home(page); await clickNav(page, /^filter/i, { drawer: false }); await capture(page, vp, theme, 'filters'); await escapeAll(page); });
      await tryState(ctx, 'search', async () => { await home(page); await page.keyboard.press('ControlOrMeta+K'); await page.getByRole('dialog').first().waitFor({ timeout: 3000 }); await page.keyboard.type('ex'); await capture(page, vp, theme, 'search'); await escapeAll(page); });
      await tryState(ctx, 'create-login', async () => {
        await home(page);
        await clickNav(page, /new item/i, { drawer: false });
        const login = await visibleFirst(page.getByRole('button', { name: /^login$/i }).or(page.getByRole('option', { name: /^login$/i })).or(page.getByRole('menuitem', { name: /^login$/i })));
        if (login) await login.click();
        await page.getByRole('heading', { name: /^New/ }).first().waitFor({ timeout: 5000 });
        const site = await visibleFirst(page.getByLabel(/^(website|url)/i));
        if (site) { await site.fill('not a url'); await page.keyboard.press('Tab'); }
        await capture(page, vp, theme, 'create-login');
        const cancel = await visibleFirst(page.getByRole('button', { name: /^cancel$/i }));
        if (cancel) await cancel.click(); else await escapeAll(page);
        const discard = await visibleFirst(page.getByRole('button', { name: /^(discard|leave|yes)/i }));
        if (discard) await discard.click();
      });
      await tryState(ctx, 'card-detail', async () => { await home(page); await openItem(page, 'Example Visa'); await capture(page, vp, theme, 'card-detail', { row: 'Example Visa', heading: 'Example Visa' }); });
      await tryState(ctx, 'settings', async () => { await home(page); await clickNav(page, /^settings$/i); await page.waitForTimeout(300); await capture(page, vp, theme, 'settings'); });
      await tryState(ctx, 'web-limited', async () => {
        await home(page); await clickNav(page, /^settings$/i);
        try { await clickNav(page, /backup/i); } catch { await page.getByText(/plaintext export/i).first().scrollIntoViewIfNeeded(); }
        await capture(page, vp, theme, 'web-limited');
        if (vp.w === 1280) {
          const ptBtn = await visibleFirst(page.getByRole('button', { name: /plaintext|unencrypted/i }));
          check(ctx, 'web hides plaintext export', ptBtn ? 'fail' : 'ok', ptBtn ? `visible button "${await ptBtn.textContent()}"` : '');
        }
      });
      await tryState(ctx, 'security-center', async () => {
        await home(page);
        try { await clickNav(page, /security center/i); } catch { await clickNav(page, /^settings$/i); await clickNav(page, /security center/i); }
        await page.getByRole('heading', { name: /security center/i }).first().waitFor({ timeout: 5000 });
        await capture(page, vp, theme, 'security-center');
        const score = await page.getByText(/security score|health score|\b\d{1,3}\s*\/\s*100\b/i).count();
        if (vp.w === 1280) check(ctx, 'Security Center has no score/grade', score ? 'fail' : 'ok', score ? `${score} score-like texts` : '');
      });
      await tryState(ctx, 'unlock', async () => {
        await home(page);
        await clickNav(page, /lock vault/i);
        await page.getByText('Your vault is locked').waitFor({ timeout: 5000 });
        await capture(page, vp, theme, 'unlock');
        await page.getByLabel('Master passphrase', { exact: true }).fill(PASS);
        await page.getByRole('button', { name: 'Unlock', exact: true }).click();
        await page.getByText('Example Website').first().waitFor({ timeout: 60000 });
      });
    }
    await context.close();
  }
} finally {
  await browser.close();
}

// ---------------------------------------------------------------- findings
const SEV = { high: 0, medium: 1, low: 2 };
const findings = [];
for (const r of results.filter((x) => x.layout)) for (const f of r.layout.findings) findings.push({ src: 'layout', vp: r.vp, theme: r.theme, state: r.state, ...f });
for (const vp of VIEWPORTS) {
  const raw = results.filter((x) => x.layout && x.vp === vp.key && x.theme === (THEMES.includes('light') ? 'light' : THEMES[0])).map((x) => ({ state: x.state, theme: x.theme, ...x.layout }));
  if (!raw.length) continue;
  const agg = aggregate(raw);
  vp.summary = agg.summary;
  for (const f of agg.findings) findings.push({ src: 'layout-agg', vp: vp.key, theme: '*', ...f });
}
for (const r of results.filter((x) => x.gate)) for (const [k, v] of Object.entries(r.gate)) {
  if (k === 'ellipsis') continue;
  const sev = { overflow: 'high', clipped: 'high', smallTargets: 'medium', tinyText: 'medium', lowContrast: 'high', offScale: 'low' }[k] ?? 'low';
  for (const m of v) findings.push({ src: 'gate', vp: r.vp, theme: r.theme, state: r.state, check: k, severity: sev, message: m, selector: '', text: '' });
}
for (const r of results.filter((x) => x.geo)) {
  const e = EXPECT[Number(r.vp.split('x')[0])];
  if (!e) continue;
  const g = r.geo.panes;
  const geo = (check, sev, message) => findings.push({ src: 'geometry', vp: r.vp, theme: r.theme, state: r.state, check, severity: sev, message, selector: '', text: '' });
  if (g.cover && Math.abs(g.cover.h - e.cover) > 2) geo('pane-size', 'medium', `cover bar ${g.cover.h}px tall (spec ${e.cover})`);
  if (!g.cover && ['vault', 'card-detail', 'settings'].includes(r.state)) geo('pane-size', 'medium', 'no cover bar found (full-width bar containing the search field)');
  if (e.spine && g.spine && Math.abs(g.spine.w - e.spine) > 2) geo('pane-size', 'medium', `spine ${g.spine.w}px wide (spec ${e.spine})`);
  if (e.spine === null && g.spine && g.spine.w > 0 && ['vault', 'card-detail'].includes(r.state)) geo('pane-size', 'medium', `spine visible at ${r.vp} (${g.spine.w}px); spec: drawer behind the menu button below 1100`);
  if (g.ledger && Math.abs(g.ledger.w - e.ledger) > 2) geo('pane-size', 'medium', `ledger ${g.ledger.w}px wide (spec ${e.ledger})`);
  if (g.page && Math.abs(g.page.w - e.page) > 4) geo('pane-size', 'low', `page ${g.page.w}px wide (spec ${e.page})`);
  if (g.page?.contentMax > 682) geo('pane-size', 'medium', `page content ${g.page.contentMax}px wide (spec max 680)`);
  for (const k of ['spine', 'ledger', 'page']) if (g[k]?.contentLeft != null && Math.abs(g[k].contentLeft - 24) > 1) geo('pane-gutter', 'medium', `${k} content starts ${g[k].contentLeft}px from the pane edge (spec 24)`);
  if (!/be vietnam pro/i.test(r.geo.bodyFont)) geo('font', 'medium', `body font is ${r.geo.bodyFont.split(',')[0]} (spec Be Vietnam Pro)`);
  if (!['signin', 'onboarding', 'onboarding-recovery', 'unlock'].includes(r.state) && !r.geo.webBanner) geo('web-banner', 'high', 'web-limits banner not rendered on a web view');
}
for (const r of results.filter((x) => x.axe)) for (const v of r.axe) findings.push({ src: 'axe', vp: r.vp, theme: r.theme, state: r.state, check: `axe:${v.id}`, severity: ['serious', 'critical'].includes(v.impact) ? 'high' : v.impact === 'moderate' ? 'medium' : 'low', message: `${v.impact} — ${v.help} (${v.nodes} nodes): ${v.targets[0] ?? ''}`, selector: '', text: '' });
for (const c of checks.filter((x) => x.status === 'fail')) findings.push({ src: 'check', vp: c.vp ?? '*', theme: c.theme, state: '*', check: 'interaction', severity: 'high', message: `${c.name}${c.detail ? ` — ${c.detail}` : ''}`, selector: '', text: '' });
if (external.size) findings.push({ src: 'network', vp: '*', theme: '*', state: '*', check: 'external-request', severity: 'medium', message: `requests left the dev origin (aborted): ${[...external].slice(0, 8).join(', ')}`, selector: '', text: '' });
findings.sort((a, b) => SEV[a.severity] - SEV[b.severity] || a.check.localeCompare(b.check));

// ---------------------------------------------------------------- reports
const tot = { high: 0, medium: 0, low: 0 };
for (const f of findings) tot[f.severity]++;
const byCheck = {};
for (const f of findings) { byCheck[f.check] ??= { high: 0, medium: 0, low: 0 }; byCheck[f.check][f.severity]++; }
const report = { generatedAt: started.toISOString(), url: BASE, commit: sha + dirty, branch: git('branch', '--show-current'), viewports: VIEWPORTS, themes: THEMES, totals: tot, byCheck, checks, pageErrors: [...new Set(pageErrors)], external: [...external], states: results.map(({ layout, ...r }) => ({ ...r, layoutCounts: layout ? { high: layout.findings.filter((f) => f.severity === 'high').length, medium: layout.findings.filter((f) => f.severity === 'medium').length } : null })), findings };
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));

const md = [];
md.push(`# Web audit — ${report.branch} @ ${report.commit}`, '', `Run ${started.toISOString()} · ${BASE} · ${VIEWPORTS.map((v) => v.key).join(', ')} · ${THEMES.join('+')} · ${results.length} captures`, '');
md.push(`Findings: **${tot.high} high**, **${tot.medium} medium**, ${tot.low} low. By check (H/M/L): ${Object.entries(byCheck).map(([k, c]) => `${k} ${c.high}/${c.medium}/${c.low}`).join(' · ')}`, '');
md.push('## Interaction checks', '', ...checks.map((c) => `- ${c.status === 'ok' ? 'ok  ' : c.status.toUpperCase()} · ${c.theme} ${c.vp ?? ''} · ${c.name}${c.detail ? ` — ${c.detail}` : ''}`), '');
if (report.pageErrors.length) md.push('## Page errors', '', ...report.pageErrors.slice(0, 30).map((e) => `- ${e}`), '');
md.push('## Geometry (measured vs spec)', '');
for (const r of results.filter((x) => x.geo && ['vault', 'card-detail', 'settings'].includes(x.state))) {
  const g = r.geo.panes; const e = EXPECT[Number(r.vp.split('x')[0])] ?? {};
  md.push(`- ${r.vp} ${r.theme} ${r.state}: cover ${g.cover?.h ?? '—'}/${e.cover} · spine ${g.spine?.w ?? '—'}/${e.spine ?? 'drawer'} (content ${g.spine?.contentLeft ?? '—'}) · ledger ${g.ledger?.w ?? '—'}/${e.ledger} (content ${g.ledger?.contentLeft ?? '—'}) · page ${g.page?.w ?? '—'}/${e.page} (content ${g.page?.contentLeft ?? '—'}, max ${g.page?.contentMax ?? '—'}) · font ${r.geo.bodyFont.split(',')[0]} · banner ${r.geo.webBanner ? `${r.geo.webBanner.h}px` : 'none'}`);
}
md.push('');
for (const vp of VIEWPORTS.filter((v) => v.summary)) {
  const s = vp.summary;
  md.push(`## System summary ${vp.key} (light)`, '');
  md.push(`- Spacing unit ${s.rhythm.unit}px, ${(s.rhythm.grid4 * 100).toFixed(0)}% on the 4px grid; off-4: ${s.rhythm.off4 || 'none'}`);
  md.push(`- Icon sizes: ${Object.entries(s.icons).map(([k, c]) => `${k}:${c}`).join(' ')}`);
  md.push(`- Controls: ${Object.entries(s.controls).map(([t, h]) => `${t} {${Object.entries(h).map(([k, c]) => `${k}:${c}`).join(' ')}}`).join(' · ')}`);
  md.push(`- Type pairs: ${Object.entries(s.typePairs).slice(0, 14).map(([k, c]) => `${k}: ${c}`).join(' · ')}`, '');
}
for (const sev of ['high', 'medium', 'low']) {
  const list = findings.filter((f) => f.severity === sev);
  if (!list.length) continue;
  md.push(`## ${sev} (${list.length})`, '');
  for (const f of list.slice(0, sev === 'low' ? 80 : 400)) md.push(`- **${f.check}** · ${f.vp} ${f.theme} ${f.state} · ${f.selector ? `\`${f.selector}\` ` : ''}${f.text ? `"${f.text}" ` : ''}— ${f.message}${f.mark ? ` [#${f.mark}]` : ''}`);
  if (list.length > (sev === 'low' ? 80 : 400)) md.push(`- … ${list.length - (sev === 'low' ? 80 : 400)} more in report.json`);
  md.push('');
}
fs.writeFileSync(path.join(outDir, 'report.md'), md.join('\n'));

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const html = [`<!doctype html><meta charset="utf-8"><title>web audit ${esc(report.commit)}</title><style>body{font:14px/20px system-ui;margin:24px;background:#faf9fb;color:#222}h2{margin:40px 0 8px}figure{margin:0}img{width:100%;border:1px solid #ccc}.pair{display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start}figcaption{font-weight:600;margin:4px 0}.f{font:12px/16px ui-monospace,monospace;white-space:pre-wrap}.high{color:#c00}.medium{color:#b60}</style>`,
  `<h1>Web audit — ${esc(report.branch)} @ ${esc(report.commit)}</h1><p>${esc(started.toISOString())} · ${tot.high} high · ${tot.medium} medium · ${tot.low} low · <a href="report.md">report.md</a></p>`,
  `<h2>Interaction checks</h2><div class="f">${checks.map((c) => `<span class="${c.status === 'fail' ? 'high' : ''}">${esc(`${c.status} · ${c.theme} ${c.vp ?? ''} · ${c.name}${c.detail ? ` — ${c.detail}` : ''}`)}</span>`).join('\n')}</div>`];
for (const r of results) {
  const fs_ = findings.filter((f) => f.vp === r.vp && f.theme === r.theme && f.state === r.state && f.severity !== 'low');
  const protoRel = r.proto ? path.relative(outDir, r.proto.file) : null;
  html.push(`<h2 id="${esc(`${r.vp}-${r.theme}-${r.state}`)}">${esc(`${r.state} · ${r.vp} · ${r.theme}`)}</h2>`);
  if (r.error) html.push(`<p class="high">${esc(r.error)}</p>`);
  html.push(`<div class="pair"><figure><figcaption>Real app${r.annotated ? ` (<a href="${esc(r.annotated)}">annotated</a>)` : ''}</figcaption>${r.shot && !r.error ? `<img src="${esc(r.shot)}">` : '<p>—</p>'}</figure><figure><figcaption>Prototype${r.proto && !r.proto.exact ? ' (1280 capture; none at this size)' : ''}</figcaption>${protoRel ? `<img src="${esc(protoRel)}">` : '<p>no prototype state</p>'}</figure></div>`);
  if (fs_.length) html.push(`<div class="f">${fs_.map((f) => `<span class="${f.severity}">${esc(`${f.severity} ${f.check}${f.mark ? ` #${f.mark}` : ''} ${f.selector ? `${f.selector} ` : ''}${f.text ? `"${f.text}" ` : ''}— ${f.message}`)}</span>`).join('\n')}</div>`);
}
fs.writeFileSync(path.join(outDir, 'index.html'), html.join('\n'));
fs.writeFileSync(path.join(here, 'runs', 'LATEST'), label + '\n');
console.log(`\n${results.length} captures · findings high ${tot.high} medium ${tot.medium} low ${tot.low} · checks fail ${checks.filter((c) => c.status === 'fail').length}/${checks.length}`);
console.log(`wrote ${path.relative(process.cwd(), path.join(outDir, 'index.html'))}`);
