/** Extension settings — stored in chrome.storage.local, never secrets. */

export type AutoLockMinutes = 1 | 5 | 15 | 0; // 0 = never

export interface ExtSettings {
  autoLockMinutes: AutoLockMinutes;
  requireConfirmForBank: boolean;
  requireConfirmForPunycode: boolean;
  /** Origins the user explicitly allows filling on. Empty = all https allowed (subject to domain match). */
  allowedOrigins: string[];
  /** Origins the user explicitly blocks. Blocked wins over allowed. */
  blockedOrigins: string[];
}

export const DEFAULT_SETTINGS: ExtSettings = {
  autoLockMinutes: 5,
  requireConfirmForBank: true,
  requireConfirmForPunycode: true,
  allowedOrigins: [],
  blockedOrigins: [],
};

const SETTINGS_KEY = 'my-secrect.ext.settings.v1';

export async function loadSettings(): Promise<ExtSettings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const raw = stored[SETTINGS_KEY] as Partial<ExtSettings> | undefined;
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_SETTINGS };
  return {
    autoLockMinutes: [1, 5, 15, 0].includes(raw.autoLockMinutes as number)
      ? (raw.autoLockMinutes as AutoLockMinutes)
      : DEFAULT_SETTINGS.autoLockMinutes,
    requireConfirmForBank: raw.requireConfirmForBank !== false,
    requireConfirmForPunycode: raw.requireConfirmForPunycode !== false,
    allowedOrigins: Array.isArray(raw.allowedOrigins) ? raw.allowedOrigins : [],
    blockedOrigins: Array.isArray(raw.blockedOrigins) ? raw.blockedOrigins : [],
  };
}

export async function saveSettings(settings: ExtSettings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

export function isOriginBlocked(origin: string, settings: ExtSettings): boolean {
  if (settings.blockedOrigins.includes(origin)) return true;
  if (settings.allowedOrigins.length > 0 && !settings.allowedOrigins.includes(origin)) {
    return true;
  }
  return false;
}
