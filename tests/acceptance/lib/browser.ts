/**
 * Real-Chromium helpers for the web app (apps/web -> desktop App).
 * Passkeys use Chromium's CDP virtual authenticator, so the browser performs
 * genuine WebAuthn ceremonies verified by the Rails API. A credential minted
 * by the Node SoftwareAuthenticator (tests/sync-e2e) can be imported, which
 * models "the same passkey on another device" or a device-specific passkey
 * that was added to the account through the real add-passkey API.
 */
import { createHash } from 'node:crypto';
import type { Browser, BrowserContext, CDPSession, Page } from 'playwright';
import type { ExportedCredential } from '../../sync-e2e/software-authenticator.ts';
import { mailCodes, waitForMailCode } from './stack.ts';

export const LS_API_BASE_URL = 'my-secrect:api-base-url';
export const LS_API_TOKEN = 'my-secrect:api-token';
export const LS_VAULT_ROWS = 'my-secrect.local-vault.v1';
export const LS_VAULT_KEYS = 'my-secrect.local-vault.v1.keys';

export interface VirtualAuthenticator {
  id: string;
  cdp: CDPSession;
  importSoftware(c: ExportedCredential): Promise<void>;
  exportAll(): Promise<any[]>;
  importAll(creds: any[]): Promise<void>;
  clear(): Promise<void>;
}

export async function addVirtualAuthenticator(page: Page): Promise<VirtualAuthenticator> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId: id } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  return {
    id,
    cdp,
    async importSoftware(c) {
      const der = c.privateKeyPem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
      await cdp.send('WebAuthn.addCredential', {
        authenticatorId: id,
        credential: { credentialId: Buffer.from(c.id, 'base64url').toString('base64'), isResidentCredential: false, rpId: 'localhost', privateKey: der, signCount: c.signCount },
      });
    },
    async exportAll() { return (await cdp.send('WebAuthn.getCredentials', { authenticatorId: id })).credentials; },
    async importAll(creds) { for (const credential of creds) await cdp.send('WebAuthn.addCredential', { authenticatorId: id, credential }); },
    async clear() { await cdp.send('WebAuthn.clearCredentials', { authenticatorId: id }); },
  };
}

/** A fresh profile (own localStorage) pointed at the API, with a virtual authenticator. */
export async function freshDevice(browser: Browser, apiBase: string): Promise<{ ctx: BrowserContext; page: Page; auth: VirtualAuthenticator }> {
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(([k, v]) => { try { if (localStorage.getItem(k) === null) localStorage.setItem(k, v); } catch { /* ignore */ } }, [LS_API_BASE_URL, apiBase]);
  const page = await ctx.newPage();
  page.setDefaultTimeout(30_000);
  const auth = await addVirtualAuthenticator(page);
  return { ctx, page, auth };
}

/** Sign-up on the gate: email -> code from the mailed message -> passkey
 *  (the app enrols this browser's device key in the same ceremony). */
export async function registerViaUi(page: Page, webUrl: string, email: string, mailDir: string): Promise<void> {
  await page.goto(webUrl);
  await page.getByRole('tab', { name: 'Create account' }).click();
  await page.getByLabel('Account email').fill(email);
  const seen = mailCodes(mailDir, email).length;
  await page.getByRole('button', { name: 'Email me a code' }).click();
  await page.getByRole('heading', { name: 'Check your email' }).waitFor();
  await page.getByLabel('Verification code').fill(await waitForMailCode(mailDir, email, seen));
  await page.getByRole('button', { name: 'Create account with passkey' }).click();
  await page.getByText('Create your local vault').waitFor();
}

/** Sign-up on the gate with an email code only (no passkey); stops at the
 *  vault onboarding. The account is mandatory before any vault exists. */
export async function signUpWithEmailCodeViaUi(page: Page, email: string, mailDir: string): Promise<void> {
  await page.getByRole('tab', { name: 'Create account' }).click();
  await page.getByLabel('Account email').fill(email);
  const seen = mailCodes(mailDir, email).length;
  await page.getByRole('button', { name: 'Email me a code' }).click();
  await page.getByRole('heading', { name: 'Check your email' }).waitFor();
  await page.getByLabel('Verification code').fill(await waitForMailCode(mailDir, email, seen));
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByRole('heading', { name: 'Create passphrase', level: 1 }).waitFor();
}

export async function signInViaUi(page: Page, email: string): Promise<void> {
  await page.getByRole('tab', { name: 'Sign in' }).click();
  await page.getByLabel('Account email').fill(email);
  await page.getByRole('button', { name: 'Continue with passkey' }).click();
}

export async function createVaultViaUi(page: Page, passphrase: string): Promise<string> {
  await page.getByLabel('Master passphrase', { exact: true }).fill(passphrase);
  await page.getByLabel('Confirm passphrase').fill(passphrase);
  await page.getByRole('button', { name: 'Create vault' }).click();
  const keyBox = page.locator('div.font-mono').first();
  await keyBox.waitFor({ timeout: 60_000 });
  const recoveryKey = (await keyBox.innerText()).trim();
  await page.getByLabel('I have saved my recovery key somewhere safe.').check();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Open vault' }).click();
  await page.getByRole('button', { name: /Lock vault/ }).waitFor();
  return recoveryKey;
}

export async function restoreViaUi(page: Page, backupJson: string, secret: { passphrase: string } | { recoveryKey: string }): Promise<string> {
  await page.getByRole('button', { name: 'Restore from backup' }).click();
  await page.getByTestId('restore-backup').waitFor();
  await page.setInputFiles('#restore-file', { name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(backupJson) });
  const isPass = 'passphrase' in secret;
  await page.getByRole('radio', { name: isPass ? 'Passphrase' : 'Recovery key' }).click();
  await page.locator('#restore-secret').fill(isPass ? secret.passphrase : secret.recoveryKey);
  await page.getByRole('button', { name: 'Restore backup', exact: true }).click();
  await page.getByTestId('restore-success').waitFor({ timeout: 60_000 });
  const msg = (await page.getByTestId('restore-success').textContent()) ?? '';
  await page.getByRole('button', { name: 'Continue to unlock' }).click();
  return msg;
}

export async function unlockViaUi(page: Page, passphrase: string): Promise<void> {
  await page.getByText('Your vault is locked').waitFor();
  await page.locator('#lock-passphrase').fill(passphrase);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await page.getByRole('button', { name: /Lock vault/ }).waitFor({ timeout: 60_000 });
}

export async function storedToken(page: Page): Promise<string | null> {
  return page.evaluate((k) => {
    const raw = localStorage.getItem(k);
    if (!raw) return null;
    try { const p = JSON.parse(raw); return typeof p === 'string' ? p : (p?.token ?? raw); } catch { return raw; }
  }, LS_API_TOKEN);
}

export const tokenDigest = (raw: string) => createHash('sha256').update(raw).digest('hex');

export async function apiStatus(apiBase: string, token: string | null, method: string, route: string, body?: unknown): Promise<number> {
  const res = await fetch(`${apiBase}${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  await res.arrayBuffer();
  return res.status;
}
