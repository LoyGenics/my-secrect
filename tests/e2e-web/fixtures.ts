/**
 * Shared fixtures + helpers for web e2e specs. See README.md.
 *
 * Everything drives the REAL app in Chromium against the REAL API
 * (see stack.ts). Passkeys use Chromium's CDP virtual authenticator, so
 * the browser performs genuine WebAuthn ceremonies and the Rails server
 * verifies genuine attestations/assertions. Nothing here bypasses auth.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test as base, expect, type CDPSession, type Page } from '@playwright/test';

export { expect };
export { startStack, stackConfigFromEnv, type Stack, type StackConfig } from './stack';

/** localStorage key under which the app stores the API base URL. */
export const LS_API_BASE_URL = 'my-secrect:api-base-url';
/** localStorage key under which the app stores the Bearer session token. */
export const LS_API_TOKEN_KEY = 'my-secrect:api-token';

export const DEFAULT_PASSPHRASE = 'correct horse battery staple 42!';

// ---------------------------------------------------------------- authenticators

export interface VirtualAuthenticator {
  authenticatorId: string;
  cdp: CDPSession;
  /** Credentials currently stored in the authenticator. */
  credentials(): Promise<Array<{ credentialId: string; signCount: number; isResidentCredential: boolean }>>;
  /** Forget every credential (simulates a device with no passkey). */
  clearCredentials(): Promise<void>;
  /** Raw credential records (incl. private keys) — only for cloning into another virtual authenticator. */
  exportCredentials(): Promise<any[]>;
  /** Import credential records exported from another virtual authenticator (a "synced passkey"). */
  importCredentials(credentials: any[]): Promise<void>;
  /** Toggle whether the authenticator reports user verification as successful. */
  setUserVerified(isUserVerified: boolean): Promise<void>;
  /** Toggle automatic presence simulation (false = ceremonies hang until timeout). */
  setAutomaticPresence(enabled: boolean): Promise<void>;
  remove(): Promise<void>;
}

/**
 * Attach a CTAP2 / internal / resident-key / user-verifying virtual
 * authenticator to `page`'s browser target. Call BEFORE the first
 * WebAuthn ceremony on that page. One per page; the authenticator (and
 * its credentials) survives reloads and in-page navigations.
 */
export async function newVirtualAuthenticator(
  page: Page,
  opts: { isUserVerified?: boolean; automaticPresenceSimulation?: boolean } = {},
): Promise<VirtualAuthenticator> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: opts.isUserVerified ?? true,
      automaticPresenceSimulation: opts.automaticPresenceSimulation ?? true,
    },
  });
  return {
    authenticatorId,
    cdp,
    async credentials() {
      const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
      return credentials.map((c: any) => ({
        credentialId: c.credentialId, signCount: c.signCount, isResidentCredential: c.isResidentCredential,
      }));
    },
    async exportCredentials() {
      const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
      return credentials;
    },
    async importCredentials(credentials: any[]) {
      for (const credential of credentials) await cdp.send('WebAuthn.addCredential', { authenticatorId, credential });
    },
    async clearCredentials() { await cdp.send('WebAuthn.clearCredentials', { authenticatorId }); },
    async setUserVerified(isUserVerified: boolean) {
      await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified });
    },
    async setAutomaticPresence(enabled: boolean) {
      await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled });
    },
    async remove() { await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId }); },
  };
}

// ---------------------------------------------------------------- fixtures

export interface E2eFixtures {
  apiUrl: string;
  webUrl: string;
  /** Page with the API base URL preconfigured and a virtual authenticator attached. */
  authenticator: VirtualAuthenticator;
}

export const test = base.extend<E2eFixtures>({
  apiUrl: async ({}, use) => {
    if (!process.env.E2E_API_URL) throw new Error('E2E_API_URL missing: run via playwright.config.ts (global-setup boots the stack)');
    await use(process.env.E2E_API_URL);
  },
  webUrl: async ({}, use) => {
    if (!process.env.E2E_WEB_URL) throw new Error('E2E_WEB_URL missing: run via playwright.config.ts');
    await use(process.env.E2E_WEB_URL);
  },
  page: async ({ page, apiUrl }, use) => {
    // Pure configuration: tells the web client which API to talk to (the
    // same thing a user does under Settings -> API base URL).
    // The client appends /v1/... itself, and the Rails routes live under /api.
    await page.addInitScript(([key, url]) => {
      try { if (localStorage.getItem(key) === null) localStorage.setItem(key, url); } catch { /* ignore */ }
    }, [LS_API_BASE_URL, `${apiUrl}/api`]);
    await use(page);
  },
  authenticator: async ({ page }, use) => {
    const auth = await newVirtualAuthenticator(page);
    await use(auth);
  },
});

// ---------------------------------------------------------------- UI helpers

export function uniqueEmail(prefix = 'e2e'): string {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}@example.test`;
}

// ---------------------------------------------------------------- mail (inbox)

/** Everything the API mailed to `email` (Action Mailer :file delivery, see stack.ts). */
export function mailText(email: string): string {
  const dir = process.env.E2E_MAIL_DIR;
  if (!dir) throw new Error('E2E_MAIL_DIR missing: run via playwright.config.ts (global-setup boots the stack)');
  try {
    return readFileSync(path.join(dir, email), 'utf8');
  } catch {
    return '';
  }
}

/** Every sign-up code mailed to `email`, oldest first. */
export function mailCodes(email: string): string[] {
  return [...mailText(email).matchAll(/verification code is (\d{6})/g)].map((m) => m[1]);
}

/** Wait until more than `seen` codes were mailed to `email`; return the newest. */
export async function waitForMailCode(email: string, seen = 0, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const codes = mailCodes(email);
    if (codes.length > seen) return codes[codes.length - 1];
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no new verification code was mailed to ${email}`);
}

/** Account registration on the sign-in gate: email -> code from the
 *  mailed message -> signed in WITHOUT a passkey (stops at the vault
 *  onboarding screen). A passkey is added later: addPasskeyViaUi. */
export async function registerAccountViaUi(page: Page, email: string): Promise<void> {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Create account' }).click();
  await page.getByLabel('Account email').fill(email);
  const seen = mailCodes(email).length;
  await page.getByRole('button', { name: 'Email me a code' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await page.getByLabel('Verification code').fill(await waitForMailCode(email, seen));
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'My Secret', level: 1 })).toBeVisible();
}

/** Add the first passkey from the Security Center. The account has no
 *  passkey and no MFA yet, so the step-up is a code mailed to the account. */
export async function addPasskeyViaUi(page: Page, email: string): Promise<void> {
  await openSecurityCenter(page);
  const seen = mailCodes(email).length;
  await page.getByRole('button', { name: 'Add passkey', exact: true }).click();
  const dialog = stepUpDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Email me a code' }).click();
  await dialog.getByLabel('Verification code').fill(await waitForMailCode(email, seen));
  await dialog.getByRole('button', { name: 'Verify it’s you' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(/Passkey added/)).toBeVisible();
}

/** Vault onboarding: passphrase + confirm -> recovery key screen -> acknowledge -> open. Returns the recovery key. */
export async function createVaultViaUi(page: Page, passphrase = DEFAULT_PASSPHRASE): Promise<string> {
  await page.getByLabel('Master passphrase', { exact: true }).fill(passphrase);
  await page.getByLabel('Confirm passphrase').fill(passphrase);
  await page.getByRole('button', { name: 'Create vault' }).click();
  const keyBox = page.locator('div.font-mono').first();
  await expect(keyBox).toBeVisible();
  const recoveryKey = (await keyBox.innerText()).trim();
  await page.getByLabel('I have saved my recovery key somewhere safe.').check();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Open vault' }).click();
  await expect(page.getByRole('button', { name: /Lock vault/ })).toBeVisible();
  return recoveryKey;
}

/** Account sign-in with a passkey from the sign-in gate. */
export async function signInWithPasskeyViaUi(page: Page, email: string): Promise<void> {
  await page.getByRole('tab', { name: 'Sign in' }).click();
  await page.getByLabel('Account email').fill(email);
  await page.getByRole('button', { name: 'Continue with passkey' }).click();
}

/** Unlock the vault from the lock screen with the master passphrase. */
export async function unlockVaultViaUi(page: Page, passphrase = DEFAULT_PASSPHRASE): Promise<void> {
  await page.getByLabel('Master passphrase').fill(passphrase);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
}

/** Security Center lives in the Settings tab's spine (Settings index). */
export async function openSecurityCenterTab(page: Page): Promise<void> {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /Security Center/ }).first().click();
}

export async function openSecurityCenter(page: Page): Promise<void> {
  await openSecurityCenterTab(page);
  await expect(page.getByRole('heading', { name: 'Security Center', level: 2 })).toBeVisible();
  // Wait for the first load to settle (loading text gone) so specs act on real server state.
  await expect(page.getByText('Loading…')).toHaveCount(0);
}

/** Account sign-out (Security Center button): revokes the server session and locks the vault. */
export async function signOutViaUi(page: Page): Promise<void> {
  await openSecurityCenter(page);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to your account' })).toBeVisible();
}

/** Current Bearer session token as stored by the app (null when signed out). */
export async function storedToken(page: Page): Promise<string | null> {
  return page.evaluate((k) => {
    const raw = localStorage.getItem(k);
    if (!raw) return null;
    try { const p = JSON.parse(raw); return typeof p === 'string' ? p : (p?.token ?? raw); } catch { return raw; }
  }, LS_API_TOKEN_KEY);
}

/** Raw API call (Node side) with an explicit token — for asserting server state independent of the UI. */
export async function apiFetch(
  apiUrl: string, token: string | null, method: string, route: string, body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${apiUrl}${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, json };
}

// ---------------------------------------------------------------- TOTP (independent)

function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of input.replace(/=+$/, '').toUpperCase()) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

/** RFC 6238 / RFC 4226 (HMAC-SHA1, 6 digits, 30 s) via node:crypto — independent of app and server code. */
export function totpAtStep(secretBase32: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32Decode(secretBase32)).update(counter).digest();
  const o = h[h.length - 1] & 0x0f;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}

export const TOTP_STEP_SECONDS = 30;

/**
 * Server rejects a TOTP step <= the last accepted one (replay protection)
 * and accepts +-1 step of drift. This returns a valid code for the
 * smallest step strictly greater than `lastStep` that the server will
 * accept, waiting for the clock when necessary. Returns {code, step};
 * pass `step` back as `lastStep` for the next call.
 */
export async function nextTotp(secretBase32: string, lastStep: number | null): Promise<{ code: string; step: number }> {
  const nowStep = () => Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS);
  const wanted = Math.max(lastStep === null ? -Infinity : lastStep + 1, nowStep() - 1);
  while (wanted > nowStep() + 1) await new Promise((r) => setTimeout(r, 1000));
  return { code: totpAtStep(secretBase32, wanted), step: wanted };
}


// ---------------------------------------------------------------- composite flows

/** Register an account, create the vault, add a passkey, land in the unlocked shell on the Security Center. */
export async function signedInWithVault(page: Page, opts: { passphrase?: string; email?: string } = {}) {
  const email = opts.email ?? uniqueEmail();
  const passphrase = opts.passphrase ?? DEFAULT_PASSPHRASE;
  await registerAccountViaUi(page, email);
  const recoveryKey = await createVaultViaUi(page, passphrase);
  await addPasskeyViaUi(page, email);
  // Adding the passkey left a fresh email step-up on this session. Sign in
  // again with the passkey so the specs start from a session without one.
  await signOutViaUi(page);
  await signInWithPasskeyViaUi(page, email);
  await expect(page.getByText('Your vault is locked')).toBeVisible();
  await unlockVaultViaUi(page, passphrase);
  await openSecurityCenter(page);
  return { email, passphrase, recoveryKey };
}

/**
 * A second, independent browser (own context => own localStorage and own
 * virtual authenticator) that holds a copy of `from`'s passkeys, like a
 * synced passkey on another device. Caller closes `context`.
 */
export async function secondBrowser(browser: import('@playwright/test').Browser, apiUrl: string, from: VirtualAuthenticator) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(([key, url]) => {
    try { if (localStorage.getItem(key) === null) localStorage.setItem(key, url); } catch { /* ignore */ }
  }, [LS_API_BASE_URL, `${apiUrl}/api`]);
  const authenticator = await newVirtualAuthenticator(page);
  await authenticator.importCredentials(await from.exportCredentials());
  return { context, page, authenticator };
}

/**
 * Model a passkey provider that syncs a credential between two devices:
 * copy `from`'s credentials (including the advanced signCount) over `to`.
 * Without this the two virtual authenticators' counters diverge and the
 * server's clone-detection (WebAuthn signCount must increase) correctly
 * rejects the lagging one.
 */
export async function syncCredentials(from: VirtualAuthenticator, to: VirtualAuthenticator): Promise<void> {
  const creds = await from.exportCredentials();
  await to.clearCredentials();
  await to.importCredentials(creds);
}

/** The server-verified step-up dialog (Security Center). */
export function stepUpDialog(page: Page) {
  return page.getByRole('dialog');
}

export async function stepUpWithPasskey(page: Page): Promise<void> {
  const dialog = stepUpDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.getByRole('radio', { name: 'Use a passkey' }).check();
  await dialog.getByRole('button', { name: 'Use a passkey' }).click();
  await expect(dialog).toBeHidden();
}

export async function stepUpWithTotp(page: Page, code: string): Promise<void> {
  const dialog = stepUpDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.getByRole('radio', { name: 'Authenticator code' }).check();
  await dialog.getByRole('textbox', { name: 'Authenticator code' }).fill(code);
  await dialog.getByRole('button', { name: 'Verify it’s you' }).click();
}

export const SESSIONS_API = '/api/v1/auth/sessions';
