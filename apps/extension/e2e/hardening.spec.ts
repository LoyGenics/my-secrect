/**
 * Real-Chromium attack tests for the MV3 extension: message-sender isolation,
 * storage isolation from content scripts, and what a content script may ever
 * receive. Serial: one persistent context, one vault, a hostile second
 * extension loaded next to ours.
 *
 * "Content-script world" below means code run by chrome.scripting in the
 * extension's ISOLATED world of a tab — the same world (and the same message
 * sender identity) as content.js. That is what a page that compromised its
 * renderer, or a bug in content.js, would control.
 * Run: npm --workspace apps/extension run test:e2e
 */
import { chromium, expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildExtension, startServers, writeHostileExtension, type Servers } from './fixtures';

// Test fixtures only (not real secrets).
const PASSPHRASE = 'hardening-Passphrase-Not-A-Real-Secret-2';
const PW_A = 'pw-A-hardening-fixture-3Rt8';
const PW_B = 'pw-B-hardening-fixture-7Wq1';
const TOTP_B = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const FORBIDDEN = 'Forbidden: only the my-secrect popup and options page may make this request.';
const STORAGE_DENIED = 'Access to storage is not allowed from this context.';

let servers: Servers;
let ctx: BrowserContext;
let extId = '';
let admin: Page; // options page: a legitimate extension page
let web: Page; // the "website" tab
let hostile: Worker; // the other extension's worker
let recoveryKey = '';
const ids: Record<string, string> = {};

type Msg = Record<string, unknown>;
type Reply = Record<string, unknown>;

/** Our worker. Looked up each time: it is a new JS realm after a restart. */
function worker(): Worker {
  const w = ctx.serviceWorkers().find((s) => s.url() === `chrome-extension://${extId}/background.js`);
  if (!w) throw new Error('extension worker not found');
  return w;
}

const bg = (msg: Msg) => admin.evaluate((m) => chrome.runtime.sendMessage(m) as Promise<Reply>, msg);
const origin = (host: string) => `https://${host}:${servers.httpsPort}`;
const https = (host: string, pathname = '/login') => `${origin(host)}${pathname}`;

async function openSite(url: string): Promise<number> {
  await web.goto(url);
  await web.bringToFront();
  return worker().evaluate(async (u) => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url !== u || tab.id === undefined) throw new Error(`active tab is ${tab?.url}`);
    return tab.id;
  }, url);
}

const values = async () => ({ user: await web.inputValue('#user'), pass: await web.inputValue('#pass') });

/** Send each request from the content-script world of the tab (top frame, or every frame). */
async function fromContentWorld(tabId: number, requests: Msg[], allFrames = false) {
  return worker().evaluate(
    async ({ tabId, requests, allFrames }) => {
      const results = await chrome.scripting.executeScript({
        target: allFrames ? { tabId, allFrames: true } : { tabId },
        args: [requests],
        func: async (reqs: Record<string, unknown>[]) => {
          const replies: unknown[] = [];
          for (const r of reqs) {
            try {
              replies.push(await chrome.runtime.sendMessage(r));
            } catch (e) {
              replies.push({ thrown: String(e) });
            }
          }
          return { top: window.top === window, origin: location.origin, replies };
        },
      });
      return results.map((r) => ({ frameId: r.frameId, ...(r.result as { top: boolean; origin: string; replies: Reply[] }) }));
    },
    { tabId, requests, allFrames },
  );
}

/** Try chrome.storage from the content-script world; returns 'allowed' or the error message. */
async function contentWorldStorage(tabId: number) {
  return worker().evaluate(async (tabId) => {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: async () => {
        const attempt = async (f: () => Promise<unknown>) => {
          try {
            await f();
            return 'allowed';
          } catch (e) {
            return e instanceof Error ? e.message : String(e);
          }
        };
        return {
          localGet: await attempt(() => chrome.storage.local.get(null)),
          localSet: await attempt(() => chrome.storage.local.set({ 'hostile-e2e': 1 })),
          sessionGet: await attempt(() => chrome.storage.session.get(null)),
        };
      },
    });
    return r.result as { localGet: string; localSet: string; sessionGet: string };
  }, tabId);
}

/** Record every message the content-script world of the tab receives from now on. */
async function installSpy(tabId: number): Promise<void> {
  await worker().evaluate(async (tabId) => {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const w = window as unknown as { __e2eSpy?: unknown[] };
        if (w.__e2eSpy) return;
        w.__e2eSpy = [];
        chrome.runtime.onMessage.addListener((m) => {
          w.__e2eSpy!.push(m);
        });
      },
    });
  }, tabId);
}

async function readSpy(tabId: number): Promise<unknown[]> {
  return worker().evaluate(async (tabId) => {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => (window as unknown as { __e2eSpy?: unknown[] }).__e2eSpy ?? [],
    });
    return r.result as unknown[];
  }, tabId);
}

function loginItem(title: string, fields: Record<string, unknown>) {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(), type: 'login', schema_version: 1, title, fields,
    tags: [], relations: [], attachments: [], created_at: now, updated_at: now,
  };
}

/** Every privileged request type, aimed at real data where it takes an id. */
function privilegedRequests(): Msg[] {
  const item = loginItem('Injected', { username: 'mallory', password: 'x', url: 'https://evil.test/' });
  return [
    { type: 'getStatus' },
    { type: 'listAll' },
    { type: 'listLogins', origin: origin('example.test') },
    { type: 'getItem', id: ids.A },
    { type: 'getHealth' },
    { type: 'exportEncrypted' },
    { type: 'fill', id: ids.A, confirmed: true },
    { type: 'getSettings' },
    { type: 'saveSettings', settings: { autoLockMinutes: 0, requireConfirmForBank: false, requireConfirmForPunycode: false, allowedOrigins: [], blockedOrigins: [] } },
    { type: 'saveLogin', item },
    { type: 'deleteItem', id: ids.A },
    { type: 'changePassphrase', oldPassphrase: PASSPHRASE, newPassphrase: 'attacker-chosen' },
    { type: 'unlock', passphrase: PASSPHRASE },
    { type: 'unlockRecovery', recoveryKey },
    { type: 'createVault', passphrase: 'attacker-chosen' },
    { type: 'restoreBackup', json: '{}', passphrase: 'x' },
    { type: 'generatePassword' },
    { type: 'getPendingForm' },
    { type: 'lock' },
    { type: 'wipeVault' },
  ];
}

async function vaultIntact(): Promise<void> {
  expect(((await bg({ type: 'getStatus' })).status as { locked: boolean }).locked).toBe(false);
  const items = (await bg({ type: 'listAll' })).items as { id: string }[];
  expect(items.map((i) => i.id).sort()).toEqual([ids.A, ids.B].sort());
  const a = (await bg({ type: 'getItem', id: ids.A })).item as { fields: Record<string, unknown> };
  expect(a.fields.password).toBe(PW_A);
  const settings = (await bg({ type: 'getSettings' })).settings as Record<string, unknown>;
  expect(settings).toMatchObject({ requireConfirmForBank: true, requireConfirmForPunycode: true });
  const raw = await admin.evaluate(() => chrome.storage.local.get(null));
  expect(Object.keys(raw)).not.toContain('hostile-e2e');
}

test.describe.serial('extension hardening in real Chromium', () => {
  test.beforeAll(async () => {
    const dist = buildExtension();
    const hostileDir = writeHostileExtension();
    servers = await startServers();
    ctx = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'my-secrect-hardening-')), {
      channel: 'chromium',
      headless: process.env.E2E_HEADED !== '1',
      args: [
        `--disable-extensions-except=${dist},${hostileDir}`,
        `--load-extension=${dist},${hostileDir}`,
        '--host-resolver-rules=MAP *.test 127.0.0.1',
        '--ignore-certificate-errors',
      ],
    });
    const waitWorker = async (suffix: string): Promise<Worker> => {
      for (;;) {
        const w = ctx.serviceWorkers().find((s) => s.url().endsWith(suffix));
        if (w) return w;
        await ctx.waitForEvent('serviceworker', { timeout: 30_000 });
      }
    };
    extId = new URL((await waitWorker('/background.js')).url()).host;
    hostile = await waitWorker('/bg.js');
    admin = await ctx.newPage();
    await admin.goto(`chrome-extension://${extId}/options/index.html`);
    web = await ctx.newPage();

    const created = await bg({ type: 'createVault', passphrase: PASSPHRASE });
    recoveryKey = String(created.recoveryKey);
    const a = loginItem('Example', { username: 'alice', password: PW_A, url: origin('example.test') + '/' });
    const b = loginItem('Other', { username: 'bob', password: PW_B, url: origin('other.test') + '/', totp_secret: TOTP_B });
    for (const item of [a, b]) expect((await bg({ type: 'saveLogin', item })).ok).toBe(true);
    ids.A = a.id;
    ids.B = b.id;
  });

  test.afterAll(async () => {
    await ctx?.close();
    await servers?.close();
  });

  test('content-script world: every privileged request is refused and the vault is untouched', async () => {
    for (const host of ['evil.test', 'example.test']) {
      const tabId = await openSite(https(host));
      const [top] = await fromContentWorld(tabId, privilegedRequests());
      expect(top.top).toBe(true);
      expect(top.origin).toBe(origin(host));
      for (const reply of top.replies) expect(reply).toEqual({ ok: false, error: FORBIDDEN });
      // A forged origin in a content message is ignored: the browser's sender origin is used.
      await fromContentWorld(tabId, [{ type: 'ext-form-detected', origin: origin('bank.test'), hasUsername: true, hasPassword: true }]);
      const pending = (await bg({ type: 'getPendingForm' })).pending as { origin: string };
      expect(pending.origin).toBe(origin(host));
    }
    await vaultIntact();
  });

  test('content-script world cannot read or write extension storage', async () => {
    const tabId = await openSite(https('evil.test'));
    expect(await contentWorldStorage(tabId)).toEqual({
      localGet: STORAGE_DENIED,
      localSet: STORAGE_DENIED,
      sessionGet: STORAGE_DENIED,
    });
    await vaultIntact();
  });

  test('a cross-origin iframe content-script world gets nothing, not even the content-only messages', async () => {
    const tabId = await openSite(https('example.test'));
    await web.evaluate((src) => new Promise<void>((resolve) => {
      const f = document.createElement('iframe');
      f.src = src;
      f.onload = () => resolve();
      document.body.appendChild(f);
    }), https('evil.test'));
    const frames = await fromContentWorld(tabId, [{ type: 'ext-form-detected', hasUsername: true, hasPassword: true }, { type: 'getItem', id: ids.A }], true);
    const sub = frames.filter((f) => !f.top);
    expect(sub.length).toBe(1);
    expect(sub[0].origin).toBe(origin('evil.test'));
    expect(sub[0].replies).toEqual([{ ok: false, error: FORBIDDEN }, { ok: false, error: FORBIDDEN }]);
  });

  test('the web page itself cannot reach the background, the extension pages or the fill listener', async () => {
    await openSite(https('example.test'));
    expect(await bg({ type: 'fill', id: ids.A })).toEqual({ ok: true, filled: true }); // content.js now present
    await web.fill('#user', '');
    await web.fill('#pass', '');
    const probe = await web.evaluate(async (id) => {
      const c = (globalThis as unknown as { chrome?: { runtime?: { sendMessage?: unknown } } }).chrome;
      let fetched = 'allowed';
      try {
        await fetch(`chrome-extension://${id}/popup/index.html`);
      } catch (e) {
        fetched = String(e);
      }
      window.postMessage({ type: 'ext-fill', username: 'mallory', password: 'page-chosen', origin: location.origin }, '*');
      await new Promise((r) => setTimeout(r, 300));
      return { sendMessage: typeof c?.runtime?.sendMessage, fetched };
    }, extId);
    expect(probe.sendMessage).toBe('undefined');
    expect(probe.fetched).toContain('TypeError');
    expect(await values()).toEqual({ user: '', pass: '' });
  });

  test('another extension can neither message nor connect to the background', async () => {
    const res = await hostile.evaluate(async (id) => {
      let message: string;
      try {
        message = JSON.stringify(await chrome.runtime.sendMessage(id, { type: 'listAll' }));
      } catch (e) {
        message = String(e);
      }
      const connect = await new Promise<string>((resolve) => {
        const port = chrome.runtime.connect(id);
        port.onDisconnect.addListener(() => resolve(`disconnected: ${chrome.runtime.lastError?.message ?? ''}`));
        port.postMessage({ type: 'listAll' });
        port.onMessage.addListener((m) => resolve(`message: ${JSON.stringify(m)}`));
      });
      return { message, connect };
    }, extId);
    expect(res.message).toContain('Could not establish connection');
    expect(res.connect).toMatch(/^disconnected: /);
    await vaultIntact();
  });

  test('the content-script world receives exactly one credential: the one chosen, for its origin', async () => {
    const tabId = await openSite(https('example.test'));
    await installSpy(tabId);
    expect(await bg({ type: 'fill', id: ids.A })).toEqual({ ok: true, filled: true });
    const seen = await readSpy(tabId);
    expect(seen).toEqual([{ type: 'ext-fill', username: 'alice', password: PW_A, origin: origin('example.test') }]);
    const text = JSON.stringify(seen);
    for (const other of [PW_B, TOTP_B, 'bob', ids.B, PASSPHRASE, recoveryKey]) expect(text).not.toContain(other);
  });

  // ---- Fill only the intended fields (hostile markup from fixtures.ts) ----

  /** Values of every trap-* input in the top document (must all stay empty). */
  const trapValues = () =>
    web.evaluate(() => Object.fromEntries(Array.from(document.querySelectorAll<HTMLInputElement>('input[id^="trap-"]')).map((el) => [el.id, el.value])));
  const frameValues = async (selector: string) => ({
    user: await web.frameLocator(selector).locator('#user').inputValue(),
    pass: await web.frameLocator(selector).locator('#pass').inputValue(),
  });

  test('hidden, off-screen, transparent, tiny, read-only and disabled fields are never filled', async () => {
    await openSite(https('example.test', '/honeypot'));
    expect(await bg({ type: 'fill', id: ids.A })).toEqual({ ok: true, filled: true });
    expect(await values()).toEqual({ user: 'alice', pass: PW_A });
    const traps = await trapValues();
    expect(Object.keys(traps).length).toBe(8);
    for (const value of Object.values(traps)) expect(value).toBe('');
  });

  test('only the login form is filled: not the newsletter, sign-up or search form', async () => {
    await openSite(https('example.test', '/two-forms'));
    expect(await bg({ type: 'fill', id: ids.A })).toEqual({ ok: true, filled: true });
    expect(await values()).toEqual({ user: 'alice', pass: PW_A });
    expect(await trapValues()).toEqual({ 'trap-news': '', 'trap-su-user': '', 'trap-su-pass': '', 'trap-q': '' });
  });

  test('form-less page: username is the nearest visible field before the password, never one after it', async () => {
    await openSite(https('example.test', '/formless'));
    expect(await bg({ type: 'fill', id: ids.A })).toEqual({ ok: true, filled: true });
    expect(await values()).toEqual({ user: 'alice', pass: PW_A });
    expect(await trapValues()).toEqual({ 'trap-search': '', 'trap-after': '' });
  });

  for (const page of ['/hidden-only', '/new-password-only']) {
    test(`refuses when there is no visible login password field (${page})`, async () => {
      await openSite(https('example.test', page));
      expect(await bg({ type: 'fill', id: ids.A })).toEqual({ ok: false, error: 'No visible password field to fill on this page.' });
      expect(await values()).toEqual({ user: '', pass: '' });
      for (const value of Object.values(await trapValues())) expect(value).toBe('');
    });
  }

  test('a login form inside a cross-origin iframe is never filled', async () => {
    await openSite(https('example.test', '/iframe-only'));
    expect(await bg({ type: 'fill', id: ids.A })).toEqual({ ok: false, error: 'No visible password field to fill on this page.' });
    expect(await frameValues('#cross')).toEqual({ user: '', pass: '' });
  });

  test('top-frame form is filled; cross-origin and same-origin iframe forms are not', async () => {
    const tabId = await openSite(https('example.test', '/iframe-and-form'));
    expect(await bg({ type: 'fill', id: ids.A })).toEqual({ ok: true, filled: true });
    expect(await values()).toEqual({ user: 'alice', pass: PW_A });
    expect(await frameValues('#cross')).toEqual({ user: '', pass: '' });
    expect(await frameValues('#same')).toEqual({ user: '', pass: '' });
    // content.js was injected into the top frame only: no sub-frame has it.
    const loaded = await worker().evaluate(async (tabId) => {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => ({ top: window.top === window, loaded: (window as unknown as { __mySecrectContentLoaded?: boolean }).__mySecrectContentLoaded === true }),
      });
      return results.map((r) => r.result as { top: boolean; loaded: boolean });
    }, tabId);
    expect(loaded.filter((f) => f.top)).toEqual([{ top: true, loaded: true }]);
    expect(loaded.filter((f) => !f.top)).toEqual([{ top: false, loaded: false }, { top: false, loaded: false }]);
  });
});
