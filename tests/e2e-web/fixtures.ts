/**
 * Shared fixtures + helpers for web e2e specs. See README.md.
 *
 * Everything drives the REAL app in Chromium against the REAL API
 * (see stack.ts). Passkeys use Chromium's CDP virtual authenticator, so
 * the browser performs genuine WebAuthn ceremonies and the Rails server
 * verifies genuine attestations/assertions. Nothing here bypasses auth.
 */
import { createHmac, randomBytes } from 'node:crypto';
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

/** Account registration with a passkey on the sign-in gate (stops at the vault onboarding screen). */
export async function registerAccountViaUi(page: Page, email: string): Promise<void> {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Create account' }).click();
  await page.getByLabel('Account email').fill(email);
  await page.getByRole('button', { name: 'Create account with passkey' }).click();
  await expect(page.getByRole('heading', { name: 'my-secrect' })).toBeVisible();
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

export async function openSecurityCenter(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Security Center/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Security Center' })).toBeVisible();
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
