import type AsyncStorage from '@react-native-async-storage/async-storage';
import { LS_ACCOUNT_EMAIL, LS_API_TOKEN, LS_API_TOKEN_EXPIRES_AT, getValidToken, type TokenStore } from '../../../packages/sdk/src/security';

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

export async function resolveVaultEntry(store: TokenStore, vaultExists: () => Promise<boolean>) {
  if (!await getValidToken(store)) return 'signin';
  return (await vaultExists()) ? 'locked' : 'onboarding';
}
