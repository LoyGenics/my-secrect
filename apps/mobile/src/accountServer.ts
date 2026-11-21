import type AsyncStorage from '@react-native-async-storage/async-storage';
import { LS_ACCOUNT_EMAIL, LS_API_TOKEN, LS_API_TOKEN_EXPIRES_AT, clearSessionToken, getValidToken, readStoredToken, type TokenStore } from '../../../packages/sdk/src/security';
import { apiStatus } from './utils/stepUp';

export const API_BASE_URL_KEY = 'my-secrect:api-base-url';
export const SHARE_WEB_ORIGIN_KEY = 'my-secrect:share-web-origin';
export const HOSTED_API_BASE_URL = 'https://my.msecret.app/api';

type Storage = Pick<typeof AsyncStorage, 'getItem' | 'multiRemove' | 'setItem'>;

export async function loadAccountServer(storage: Storage, useHostedOnly: boolean, developmentUrl?: string): Promise<string> {
  const saved = (await storage.getItem(API_BASE_URL_KEY))?.trim().replace(/\/+$/, '') ?? '';
  const target = useHostedOnly ? HOSTED_API_BASE_URL : developmentUrl?.trim().replace(/\/+$/, '') || saved || HOSTED_API_BASE_URL;
  if (saved !== target) {
    // A bearer session belongs to the server that issued it.
    await storage.multiRemove([LS_API_TOKEN, LS_API_TOKEN_EXPIRES_AT, LS_ACCOUNT_EMAIL, SHARE_WEB_ORIGIN_KEY]);
    await storage.setItem(API_BASE_URL_KEY, target);
  }
  return target;
}

async function hasKnownExpiry(store: TokenStore): Promise<boolean> {
  try { return /^\d+$/.test((await store.getItem(LS_API_TOKEN_EXPIRES_AT)) ?? ''); } catch { return false; }
}

export type VaultEntry = 'signin' | 'revoked' | 'unverified' | 'locked' | 'onboarding';

/**
 * No vault without an account session. A token with a known, unexpired
 * expiry may unlock offline; one without a stored expiry is checked with the
 * server first (`checkSession`, any authenticated call): 401 signs out
 * ('revoked'), and no answer keeps the user on sign-in ('unverified').
 * A local expiry is plain 'signin'.
 */
export async function resolveVaultEntry(store: TokenStore, vaultExists: () => Promise<boolean>, checkSession: () => Promise<unknown>): Promise<VaultEntry> {
  if (!await getValidToken(store)) return 'signin';
  if (!await hasKnownExpiry(store)) {
    try {
      await checkSession();
    } catch (error) {
      if (apiStatus(error) !== 401) return 'unverified';
      await clearSessionToken(store);
      return 'revoked';
    }
  }
  return (await vaultExists()) ? 'locked' : 'onboarding';
}

export type OnlineSession = 'confirmed' | 'signin' | 'revoked' | 'offline';

/**
 * Creating or restoring a vault needs the server to confirm the session
 * now: a known expiry is not enough offline ('offline': stay put and ask
 * for a connection). Unlocking an existing vault keeps resolveVaultEntry's
 * offline rule. 'revoked' (401) leaves the token for the caller's
 * unauthorized handling (endSessionAfterUnauthorized).
 */
export async function confirmSessionOnline(store: TokenStore, checkSession: () => Promise<unknown>): Promise<OnlineSession> {
  if (!await getValidToken(store)) return 'signin';
  try {
    await checkSession();
    return 'confirmed';
  } catch (error) {
    return apiStatus(error) === 401 ? 'revoked' : 'offline';
  }
}

/**
 * After a 401: a token still stored means the server refused one this
 * device considered valid (revoked / invalid), so `endSession` runs (drop
 * biometric unlock and autofill). A token already gone expired locally,
 * which only returns to sign-in. The token is cleared either way.
 */
export async function endSessionAfterUnauthorized(store: TokenStore, endSession: () => Promise<void>): Promise<void> {
  try {
    if (await readStoredToken(store)) await endSession().catch(() => undefined);
  } finally {
    await clearSessionToken(store);
  }
}
