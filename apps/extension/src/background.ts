/**
 * Background service worker — the ONLY privileged context.
 *
 * It holds the vault key in memory (via lib/vault-ext) and decrypts ONLY
 * the single item the user explicitly chose. It never writes keys or
 * plaintext to chrome.storage, never sends the vault or any key to the
 * popup, the options page, or any web page, and never sends more than one
 * credential to a content script.
 *
 * MV3 note: Chrome may terminate this worker at any time. When it restarts,
 * the in-memory session is gone and the vault reports locked — the user
 * unlocks again. That is correct behaviour, not a bug.
 */
import * as vault from './lib/vault-ext';
import { checkFillAllowed, originOf, hostOf, domainsMatch } from './lib/domain';
import { loadSettings, saveSettings, isOriginBlocked, DEFAULT_SETTINGS } from './lib/settings';
import type { ExtRequest, ExtResponse, LoginMeta, ItemMeta, PendingForm } from './lib/messages';
import type { VaultItem } from '../../../packages/core/src/types';

const AUTOLOCK_ALARM = 'my-secrect-autolock';
let pendingForm: PendingForm | null = null;

async function resetAutoLock(): Promise<void> {
  await chrome.alarms.clear(AUTOLOCK_ALARM);
  const settings = await loadSettings();
  if (settings.autoLockMinutes > 0 && vault.isUnlocked()) {
    await chrome.alarms.create(AUTOLOCK_ALARM, { delayInMinutes: settings.autoLockMinutes });
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTOLOCK_ALARM) vault.lockVault();
});

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await loadSettings();
  await saveSettings(settings); // writes defaults if nothing stored yet
});

function loginMeta(item: VaultItem): LoginMeta {
  const fields = item.fields as Record<string, unknown>;
  return {
    id: item.id,
    title: item.title,
    username: typeof fields['username'] === 'string' ? (fields['username'] as string) : '',
    url: typeof fields['url'] === 'string' ? (fields['url'] as string) : '',
    hasTotp: typeof fields['totp_secret'] === 'string' && (fields['totp_secret'] as string).length > 0,
    favorite: item.favorite === true,
  };
}

function itemMeta(item: VaultItem): ItemMeta {
  return {
    id: item.id,
    type: item.type,
    title: item.title,
    tags: item.tags ?? [],
    favorite: item.favorite === true,
    updatedAt: item.updated_at,
  };
}

function generatePassword(length = 16, symbols = true, numbers = true): string {
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const upper = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  const digits = '23456789';
  const syms = '!@#$%^&*()-_=+[]{}';
  let pool = lower + upper;
  if (numbers) pool += digits;
  if (symbols) pool += syms;
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  const chars = Array.from(bytes, (b) => pool[b % pool.length]);
  // Guarantee at least one of each selected class.
  chars[0] = lower[bytes[0] % lower.length];
  chars[1] = upper[bytes[1] % upper.length];
  if (numbers) chars[2] = digits[bytes[2] % digits.length];
  if (symbols) chars[3] = syms[bytes[3] % syms.length];
  return chars.join('');
}

function computeHealth(items: VaultItem[]): { score: number; total: number; weakCount: number; reusedCount: number } {
  const live = items.filter((i) => !i.deleted_at);
  const passwords = new Map<string, number>();
  let weak = 0;
  for (const item of live) {
    const pw = (item.fields as Record<string, unknown>)['password'];
    if (typeof pw !== 'string' || pw.length === 0) continue;
    if (pw.length < 12) weak += 1;
    passwords.set(pw, (passwords.get(pw) ?? 0) + 1);
  }
  let reusedGroups = 0;
  for (const count of passwords.values()) if (count > 1) reusedGroups += 1;
  const score = Math.max(0, Math.min(100, 100 - 15 * weak - 20 * reusedGroups));
  return { score, total: live.length, weakCount: weak, reusedCount: reusedGroups };
}

async function handleFill(id: string, confirmed: boolean | undefined): Promise<ExtResponse> {
  if (!vault.isUnlocked()) return { ok: false, error: 'Vault is locked. Unlock it first.' };
  const item = await vault.getDecryptedItem(id);
  if (!item) return { ok: false, error: 'Item not found.' };
  const fields = item.fields as Record<string, unknown>;
  const username = typeof fields['username'] === 'string' ? fields['username'] : '';
  const password = typeof fields['password'] === 'string' ? fields['password'] : '';
  const itemUrl = typeof fields['url'] === 'string' ? fields['url'] : '';
  if (!password) return { ok: false, error: 'This item has no password to fill.' };
  if (!itemUrl) return { ok: false, error: 'This item has no URL, so the extension cannot verify the site.' };
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) return { ok: false, error: 'No active tab to fill into.' };
  const settings = await loadSettings();
  const origin = originOf(tab.url);
  if (!origin) return { ok: false, error: 'Could not determine the tab origin.' };
  if (isOriginBlocked(origin, settings)) {
    return { ok: false, error: `Filling is blocked for ${origin} in extension settings.` };
  }
  const check = checkFillAllowed(tab.url, itemUrl, item.type, settings);
  if (!check.allowed) return { ok: false, error: check.reason };
  if ('needsConfirmation' in check && check.needsConfirmation && !confirmed) {
    return { ok: false, error: check.needsConfirmation, needsConfirmation: check.needsConfirmation };
  }
  // On-demand injection: no broad host permissions, no persistent content
  // script. The script is injected into THIS tab only, for THIS fill.
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
  } catch (e) {
    return { ok: false, error: `Could not inject the fill script: ${e instanceof Error ? e.message : String(e)}` };
  }
  await chrome.tabs.sendMessage(tab.id, { type: 'ext-fill', username, password, origin });
  await resetAutoLock();
  return { ok: true, filled: true };
}

async function handle(req: ExtRequest): Promise<ExtResponse> {
  switch (req.type) {
    case 'getStatus': {
      return { ok: true, status: { locked: !vault.isUnlocked(), vaultExists: await vault.hasVault() } };
    }
    case 'unlock': {
      const ok = await vault.unlockVault(req.passphrase);
      if (ok) await resetAutoLock();
      return { ok: true, unlocked: ok, error: ok ? undefined : 'Wrong passphrase.' };
    }
    case 'unlockRecovery': {
      const ok = await vault.unlockWithRecoveryKey(req.recoveryKey);
      if (ok) await resetAutoLock();
      return { ok: true, unlocked: ok, error: ok ? undefined : 'That recovery key did not unlock the vault.' };
    }
    case 'createVault': {
      const { recoveryKey } = await vault.createVault(req.passphrase);
      await resetAutoLock();
      return { ok: true, recoveryKey };
    }
    case 'lock': {
      vault.lockVault();
      await chrome.alarms.clear(AUTOLOCK_ALARM);
      return { ok: true, unlocked: false };
    }
    case 'listLogins': {
      if (!vault.isUnlocked()) return { ok: false, error: 'Vault is locked.' };
      const pageHost = hostOf(req.origin);
      const logins = vault
        .listUnlockedItems()
        .filter((i) => !i.deleted_at && (i.type === 'login' || i.type === 'passkey'))
        .filter((i) => {
          const url = (i.fields as Record<string, unknown>)['url'];
          if (typeof url !== 'string' || !url || !pageHost) return false;
          const itemHost = hostOf(url);
          return itemHost !== null && domainsMatch(pageHost, itemHost);
        })
        .map(loginMeta);
      return { ok: true, logins };
    }
    case 'listAll': {
      if (!vault.isUnlocked()) return { ok: false, error: 'Vault is locked.' };
      return { ok: true, items: vault.listUnlockedItems().filter((i) => !i.deleted_at).map(itemMeta) };
    }
    case 'getItem': {
      if (!vault.isUnlocked()) return { ok: false, error: 'Vault is locked.' };
      const item = await vault.getDecryptedItem(req.id);
      return { ok: true, item };
    }
    case 'getHealth': {
      if (!vault.isUnlocked()) return { ok: false, error: 'Vault is locked.' };
      return { ok: true, health: computeHealth(vault.listUnlockedItems()) };
    }
    case 'fill': {
      return handleFill(req.id, req.confirmed);
    }
    case 'saveLogin': {
      if (!vault.isUnlocked()) return { ok: false, error: 'Vault is locked.' };
      await vault.upsertItem(req.item);
      await resetAutoLock();
      return { ok: true, id: req.item.id };
    }
    case 'deleteItem': {
      if (!vault.isUnlocked()) return { ok: false, error: 'Vault is locked.' };
      await vault.softDeleteItem(req.id);
      return { ok: true, id: req.id };
    }
    case 'getSettings': {
      return { ok: true, settings: await loadSettings() };
    }
    case 'saveSettings': {
      await saveSettings(req.settings);
      await resetAutoLock();
      return { ok: true, settings: req.settings };
    }
    case 'exportEncrypted': {
      if (!vault.isUnlocked()) return { ok: false, error: 'Vault is locked.' };
      return { ok: true, json: await vault.exportEncrypted() };
    }
    case 'changePassphrase': {
      if (!vault.isUnlocked()) return { ok: false, error: 'Vault is locked.' };
      const changed = await vault.changePassphrase(req.oldPassphrase, req.newPassphrase);
      return { ok: true, changed, error: changed ? undefined : 'Old passphrase was wrong.' };
    }
    case 'wipeVault': {
      await vault.wipeVault();
      await chrome.alarms.clear(AUTOLOCK_ALARM);
      return { ok: true, unlocked: false };
    }
    case 'generatePassword': {
      return { ok: true, password: generatePassword(req.length ?? 16, req.symbols ?? true, req.numbers ?? true) };
    }
    case 'getPendingForm': {
      const fresh = pendingForm && Date.now() - pendingForm.detectedAt < 5 * 60_000 ? pendingForm : null;
      if (!fresh) pendingForm = null;
      return { ok: true, pending: fresh };
    }
    default:
      return { ok: false, error: 'Unknown request.' };
  }
}

chrome.runtime.onMessage.addListener(
  (message: ExtRequest | { type: 'ext-form-detected'; origin: string; hasUsername: boolean; hasPassword: boolean }, _sender, sendResponse: (r: ExtResponse | { ok: boolean }) => void) => {
    if (message.type === 'ext-form-detected') {
      // Values are NEVER sent by the content script — only that a login
      // form exists on this origin, so the popup can offer to save one.
      pendingForm = {
        origin: message.origin,
        hasUsername: message.hasUsername,
        hasPassword: message.hasPassword,
        detectedAt: Date.now(),
      };
      sendResponse({ ok: true });
      return false;
    }
    handle(message as ExtRequest)
      .then(sendResponse)
      .catch((e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    return true; // async response
  },
);

// Keep the default settings in place even if the worker restarts.
void loadSettings().then((s) => saveSettings(s)).catch(() => undefined);
