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
import { buildExtension, signInViaMessages, startMockApi, startServers, writeHostileExtension, type MockApi, type Servers } from './fixtures';

// Test fixtures only (not real secrets).
const PASSPHRASE = 'hardening-Passphrase-Not-A-Real-Secret-2';
const PW_A = 'pw-A-hardening-fixture-3Rt8';
const PW_B = 'pw-B-hardening-fixture-7Wq1';
const TOTP_B = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const FORBIDDEN = 'Forbidden: only the my-secrect popup and options page may make this request.';
const STORAGE_DENIED = 'Access to storage is not allowed from this context.';

let servers: Servers;
let mockApi: MockApi;
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

/** Send each request from the content-script world of the tab's top frame, every frame, or sub-frames only. */
async function fromContentWorld(tabId: number, requests: Msg[], frames: 'top' | 'all' | 'sub' = 'top') {
  return worker().evaluate(
    async ({ tabId, requests, frames }) => {
      const results = await chrome.scripting.executeScript({
        target: frames === 'top' ? { tabId } : { tabId, allFrames: true },
        args: [requests, frames === 'sub'],
        func: async (reqs: Record<string, unknown>[], subOnly: boolean) => {
          const replies: unknown[] = [];
          if (subOnly && window.top === window) return { top: true, origin: location.origin, replies };
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
    { tabId, requests, frames },
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
    { type: 'armActiveTab' },
    { type: 'getSaveOffer' },
    { type: 'resolveSaveOffer', accept: true },
    { type: 'lock' },
    { type: 'wipeVault' },
    { type: 'getAccount' },
    { type: 'getAuthProviders' },
    { type: 'setApiBaseUrl', url: 'https://evil.test/api' },
    { type: 'requestEmailCode', email: 'mallory@evil.test' },
    { type: 'verifyEmailCode', code: '123456' },
    { type: 'verifyMfa', code: '123456' },
    { type: 'signInWithGoogle' },
    { type: 'cancelSignIn' },
    { type: 'signOut' },
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
  expect(((await bg({ type: 'getAccount' })).account as { step: string; apiBaseUrl: string })).toMatchObject({ step: 'signed-in', apiBaseUrl: mockApi.base });
}

/**
 * chrome.storage.session holds exactly the account record: server, email and
 * the session token. No vault key, passphrase or item; the token is never in
 * chrome.storage.local.
 */
async function sessionStorageIsAccountOnly(w: Worker, secrets: string[]): Promise<void> {
  const session = (await w.evaluate(() => chrome.storage.session.get(null))) as Record<string, { session?: { token?: string } }>;
  expect(Object.keys(session)).toEqual(['my-secrect.ext.account.v1']);
  const record = session['my-secrect.ext.account.v1'];
  expect(Object.keys(record).sort()).toEqual(['apiBaseUrl', 'email', 'session']);
  const token = String(record.session?.token);
  expect(mockApi.sessions.has(token)).toBe(true);
  const sessionText = JSON.stringify(session);
  for (const secret of secrets) expect(sessionText).not.toContain(secret);
  expect(JSON.stringify(await w.evaluate(() => chrome.storage.local.get(null)))).not.toContain(token);
}

test.describe.serial('extension hardening in real Chromium', () => {
  test.beforeAll(async () => {
    const dist = buildExtension();
    const hostileDir = writeHostileExtension();
    servers = await startServers();
    mockApi = await startMockApi();
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

    await signInViaMessages(bg, mockApi.base);
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
    await mockApi?.close();
  });

  test('options page with a vault: restore never overwrites, and it says sync is not available yet', async () => {
    await admin.reload();
    await expect(admin.getByText('A vault already exists in this extension')).toBeVisible();
    await expect(admin.getByTestId('restore-sync-note')).toContainText('Restoring an encrypted backup is the supported way');
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
    const frames = await fromContentWorld(tabId, [{ type: 'ext-form-detected', hasUsername: true, hasPassword: true }, { type: 'getItem', id: ids.A }], 'all');
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

  // ---- Save / update after a real login submission ----

  const PW_NEW = 'pw-new-site-fixture-5Jx2';
  const PW_A2 = 'pw-A-rotated-fixture-8Np4';
  const PW_DECLINED = 'pw-declined-fixture-2Kc9';
  const itemCount = async () => ((await bg({ type: 'listAll' })).items as unknown[]).length;
  const currentOffer = async () => (await bg({ type: 'getSaveOffer' })).offer ?? null;
  const badge = () => worker().evaluate(() => chrome.action.getBadgeText({}));
  const storageText = async () => JSON.stringify(await admin.evaluate(() => chrome.storage.local.get(null)));
  /** Negative checks need the async capture path to have run; it is one storage read. */
  const settle = () => web.waitForTimeout(1_000);

  async function waitForOffer(): Promise<Reply> {
    await expect.poll(currentOffer, { timeout: 10_000 }).not.toBeNull();
    return (await currentOffer()) as Reply;
  }

  /** What the popup does on open (armActiveTab), then a real typed sign-in that navigates. */
  async function signIn(host: string, username: string, password: string): Promise<void> {
    await openSite(https(host, '/signin'));
    expect(await bg({ type: 'armActiveTab' })).toEqual({ ok: true, armed: true });
    await web.fill('#user', username);
    await web.fill('#pass', password);
    await Promise.all([web.waitForURL('**/welcome'), web.click('#go')]);
  }

  async function openPopup(): Promise<Page> {
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup/index.html`);
    return popup;
  }

  test('save new: a real https sign-in is offered in the popup and stored encrypted only on "Save"', async () => {
    const before = await itemCount();
    await signIn('newsite.test', 'zoe', PW_NEW);
    expect(await waitForOffer()).toEqual({ mode: 'new', origin: origin('newsite.test'), username: 'zoe' });
    expect(await badge()).toBe('1');
    expect(await itemCount()).toBe(before); // never auto-saved

    const popup = await openPopup();
    const card = popup.getByRole('region', { name: 'Save login offer' });
    await expect(card).toContainText('zoe');
    await expect(card).toContainText(origin('newsite.test'));
    expect(await popup.content()).not.toContain(PW_NEW); // the popup never receives the password
    await card.getByRole('button', { name: 'Save this login' }).click();
    await expect(popup.getByRole('status')).toHaveText('Login saved.');
    await popup.close();

    expect(await itemCount()).toBe(before + 1);
    const saved = ((await bg({ type: 'listAll' })).items as { id: string; title: string }[]).find((i) => i.title === 'newsite.test')!;
    ids.NEW = saved.id;
    const item = (await bg({ type: 'getItem', id: saved.id })).item as { type: string; fields: Record<string, unknown> };
    expect(item.type).toBe('login');
    expect(item.fields).toEqual({ username: 'zoe', password: PW_NEW, url: origin('newsite.test') });
    expect(await storageText()).not.toContain(PW_NEW); // ciphertext only
    expect(await currentOffer()).toBeNull();
    expect(await badge()).toBe('');

    await openSite(https('newsite.test'));
    expect(await bg({ type: 'fill', id: saved.id })).toEqual({ ok: true, filled: true });
    expect(await values()).toEqual({ user: 'zoe', pass: PW_NEW });
  });

  test('update existing: a new password for a saved username updates that item, no duplicate', async () => {
    const before = await itemCount();
    await signIn('example.test', 'alice', PW_A2);
    expect(await waitForOffer()).toEqual({ mode: 'update', origin: origin('example.test'), username: 'alice', itemId: ids.A, title: 'Example' });

    const popup = await openPopup();
    const card = popup.getByRole('region', { name: 'Save login offer' });
    await expect(card).toContainText('Example');
    expect(await popup.content()).not.toContain(PW_A2);
    await card.getByRole('button', { name: 'Update password' }).click();
    await expect(popup.getByRole('status')).toHaveText('Password updated.');
    await popup.close();

    expect(await itemCount()).toBe(before);
    const a = (await bg({ type: 'getItem', id: ids.A })).item as { fields: Record<string, unknown> };
    expect(a.fields).toEqual({ username: 'alice', password: PW_A2, url: origin('example.test') + '/' });
    expect(await storageText()).not.toContain(PW_A2);

    // Signing in again with the password now saved offers nothing.
    await signIn('example.test', 'alice', PW_A2);
    await settle();
    expect(await currentOffer()).toBeNull();
    expect(await badge()).toBe('');
  });

  test('decline: "Not now" saves nothing and drops the captured password', async () => {
    const before = await itemCount();
    await signIn('declined.test', 'yan', PW_DECLINED);
    expect(await waitForOffer()).toEqual({ mode: 'new', origin: origin('declined.test'), username: 'yan' });

    const popup = await openPopup();
    const card = popup.getByRole('region', { name: 'Save login offer' });
    await card.getByRole('button', { name: 'Not now' }).click();
    await expect(card).toHaveCount(0);
    await popup.close();

    expect(await itemCount()).toBe(before);
    expect(await currentOffer()).toBeNull();
    expect(await bg({ type: 'resolveSaveOffer', accept: true })).toEqual({ ok: false, error: 'There is no login waiting to be saved.' });
    expect(await itemCount()).toBe(before);
    expect(await badge()).toBe('');
    expect(await storageText()).not.toContain(PW_DECLINED);
  });

  test('no offer from plain http, sub-frames or page-dispatched submits; a forged origin is ignored; lock drops the offer', async () => {
    // Plain http (not localhost): not armed, and even a submission from its content-script world is dropped.
    const httpUrl = `http://example.test:${servers.httpPort}/signin`;
    const httpTab = await openSite(httpUrl);
    expect(await bg({ type: 'armActiveTab' })).toEqual({ ok: true, armed: false });
    const [httpTop] = await fromContentWorld(httpTab, [{ type: 'ext-login-submitted', username: 'alice', password: 'pw-http-fixture' }]);
    expect(httpTop.replies).toEqual([{ ok: true }]); // bare acknowledgement: the page learns nothing
    await settle();
    expect(await currentOffer()).toBeNull();

    // A cross-origin and a same-origin iframe submit: refused (top frame only).
    const frameTab = await openSite(https('example.test', '/iframe-and-form'));
    const subs = (await fromContentWorld(frameTab, [{ type: 'ext-login-submitted', username: 'alice', password: 'pw-frame-fixture' }], 'sub')).filter((f) => !f.top);
    expect(subs.map((f) => f.replies)).toEqual([[{ ok: false, error: FORBIDDEN }], [{ ok: false, error: FORBIDDEN }]]);
    await settle();
    expect(await currentOffer()).toBeNull();

    // Page script dispatching a synthetic submit event: not a user submission.
    await openSite(https('example.test', '/signin'));
    expect(await bg({ type: 'armActiveTab' })).toEqual({ ok: true, armed: true });
    await web.fill('#user', 'alice');
    await web.fill('#pass', 'pw-synthetic-fixture');
    await web.evaluate(() => document.getElementById('f')!.dispatchEvent(new Event('submit', { cancelable: true })));
    await settle();
    expect(await currentOffer()).toBeNull();
    expect(await badge()).toBe('');

    // A content message naming another origin is attributed to the real sender origin.
    const evilTab = await openSite(https('evil.test', '/signin'));
    await fromContentWorld(evilTab, [{ type: 'ext-login-submitted', origin: origin('example.test'), username: 'alice', password: 'pw-phished-fixture' }]);
    expect(await waitForOffer()).toEqual({ mode: 'new', origin: origin('evil.test'), username: 'alice' });

    // Locking forgets the pending capture.
    await bg({ type: 'lock' });
    expect(await badge()).toBe('');
    expect(await bg({ type: 'unlock', passphrase: PASSPHRASE })).toMatchObject({ ok: true, unlocked: true });
    expect(await currentOffer()).toBeNull();
  });

  // ---- Service worker lifecycle (last: leaves the vault locked) ----

  test('worker killed and restarted: locked, offer gone, alarm kept, storage still restricted, nothing plaintext at rest; auto-lock fires in the new worker', async () => {
    test.setTimeout(240_000);
    const AUTOLOCK = 'my-secrect-autolock';
    const PW_PENDING = 'pw-pending-fixture-4Tb6';
    const settings = (await bg({ type: 'getSettings' })).settings as Record<string, unknown>;
    await bg({ type: 'saveSettings', settings: { ...settings, autoLockMinutes: 1 } }); // re-arms the alarm (unlocked)
    await signIn('pending.test', 'pat', PW_PENDING);
    expect(await waitForOffer()).toMatchObject({ mode: 'new', username: 'pat' });
    expect(await badge()).toBe('1');
    const alarmBefore = await worker().evaluate((n) => chrome.alarms.get(n), AUTOLOCK);
    expect(alarmBefore?.scheduledTime).toBeGreaterThan(Date.now());
    await sessionStorageIsAccountOnly(worker(), [PASSPHRASE, recoveryKey, PW_A, PW_B, TOTP_B, PW_PENDING]);
    await worker().evaluate(() => { (globalThis as unknown as { __e2eMarker: string }).__e2eMarker = 'before-restart'; });

    // Stop the worker as Chrome does when it is idle (DevTools protocol).
    const cdp = await ctx.newCDPSession(admin);
    const versions = new Map<string, { versionId: string; scriptURL: string; runningStatus: string }>();
    cdp.on('ServiceWorker.workerVersionUpdated', (e) => {
      for (const v of e.versions) versions.set(v.versionId, v);
    });
    await cdp.send('ServiceWorker.enable');
    const ours = () => [...versions.values()].find((v) => v.scriptURL === `chrome-extension://${extId}/background.js`);
    await expect.poll(() => ours()?.runningStatus).toBe('running');
    await cdp.send('ServiceWorker.stopWorker', { versionId: ours()!.versionId });
    await expect.poll(() => ours()?.runningStatus).toBe('stopped');

    // The next message starts a fresh worker: a new JS realm with no keys.
    expect((await bg({ type: 'getStatus' })).status).toEqual({ locked: true, vaultExists: true });
    expect(await worker().evaluate(() => (globalThis as unknown as { __e2eMarker?: string }).__e2eMarker)).toBeUndefined();
    expect(await bg({ type: 'listAll' })).toEqual({ ok: false, error: 'Vault is locked.' });
    expect(await bg({ type: 'getItem', id: ids.A })).toEqual({ ok: false, error: 'Vault is locked.' });
    await openSite(https('example.test'));
    expect(await bg({ type: 'fill', id: ids.A })).toEqual({ ok: false, error: 'Vault is locked. Unlock it first.' });
    expect(await values()).toEqual({ user: '', pass: '' });
    expect(await badge()).toBe(''); // the capture died with the old worker

    // Alarms are browser state: the pre-restart auto-lock alarm is still scheduled.
    expect(await worker().evaluate((n) => chrome.alarms.get(n), AUTOLOCK)).toEqual(alarmBefore);

    // The new worker re-applied the storage restriction before anything else.
    const evilTab = await openSite(https('evil.test'));
    expect(await contentWorldStorage(evilTab)).toEqual({ localGet: STORAGE_DENIED, localSet: STORAGE_DENIED, sessionGet: STORAGE_DENIED });

    // At rest: wrapped keys and ciphertext only. Session storage: the account record only.
    const raw = await storageText();
    for (const secret of [PASSPHRASE, recoveryKey, PW_A, PW_A2, PW_B, TOTP_B, PW_NEW, PW_DECLINED, PW_PENDING]) expect(raw).not.toContain(secret);
    await sessionStorageIsAccountOnly(worker(), [PASSPHRASE, recoveryKey, PW_A, PW_A2, PW_B, TOTP_B, PW_NEW, PW_DECLINED, PW_PENDING]);

    // Unlock in the new worker: no stale offer; auto-lock is re-armed and fires HERE.
    expect(await bg({ type: 'unlock', passphrase: PASSPHRASE })).toMatchObject({ ok: true, unlocked: true });
    expect(await currentOffer()).toBeNull();
    await worker().evaluate(() => { (globalThis as unknown as { __e2eMarker: string }).__e2eMarker = 'after-restart'; });
    const rearmed = await worker().evaluate((n) => chrome.alarms.get(n), AUTOLOCK);
    expect(rearmed!.scheduledTime).toBeGreaterThan(alarmBefore!.scheduledTime);
    await expect
      .poll(async () => ((await bg({ type: 'getStatus' })).status as { locked: boolean }).locked, { timeout: 100_000, intervals: [2_000] })
      .toBe(true);
    // Locked by the alarm in this worker, not by yet another restart.
    expect(await worker().evaluate(() => (globalThis as unknown as { __e2eMarker?: string }).__e2eMarker)).toBe('after-restart');
    await bg({ type: 'saveSettings', settings });
  });
});
