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
 * unlocks again. That is correct behaviour, not a bug. Keys are deliberately
 * NOT kept in chrome.storage.session: that would outlive the worker and be
 * readable by every extension page, for a convenience (no re-unlock after an
 * idle restart) that a password vault should not buy.
 */
import * as vault from './lib/vault-ext';
import { checkFillAllowed, checkPageAllowed, originOf, hostOf, domainsMatch } from './lib/domain';
import { loadSettings, saveSettings, isOriginBlocked, DEFAULT_SETTINGS } from './lib/settings';
import { generatePassword } from './lib/password';
import type { ExtRequest, ExtResponse, LoginMeta, ItemMeta, PendingForm, ContentMessage, LoginSubmittedMessage, SaveOffer } from './lib/messages';
import type { VaultItem } from '../../../packages/core/src/types';

const AUTOLOCK_ALARM = 'my-secrect-autolock';
const FORBIDDEN = 'Forbidden: only the my-secrect popup and options page may make this request.';
const SAVE_OFFER_TTL_MS = 5 * 60_000;
let pendingForm: PendingForm | null = null;

/**
 * The last login the user submitted in a top frame. Worker memory ONLY:
 * never written to chrome.storage, never sent to a page or to the popup (the
 * popup sees a SaveOffer without the password). Dropped on accept, decline,
 * lock, wipe, after 5 minutes, or when the worker dies.
 */
interface SaveCapture {
  origin: string;
  username: string;
  password: string;
  capturedAt: number;
}
let saveCapture: SaveCapture | null = null;
let saveCaptureTimer: ReturnType<typeof setTimeout> | undefined;

// A badge left by a previous worker lifetime points at a capture that died with it.
void chrome.action.setBadgeText({ text: '' });

function clearSaveCapture(): void {
  saveCapture = null;
  clearTimeout(saveCaptureTimer);
  void chrome.action.setBadgeText({ text: '' });
}

function freshSaveCapture(): SaveCapture | null {
  if (saveCapture && Date.now() - saveCapture.capturedAt >= SAVE_OFFER_TTL_MS) clearSaveCapture();
  return saveCapture;
}

function stringField(item: VaultItem, key: string): string {
  const value = (item.fields as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

/**
 * What to offer for a capture: update the saved login with the same username
 * for this site (domain match, as for fill), save a new one, or nothing when
 * the vault already has exactly this password. Needs the vault unlocked.
 */
function computeSaveOffer(capture: SaveCapture): SaveOffer | null {
  const pageHost = hostOf(capture.origin);
  if (!pageHost) return null;
  const forSite = vault.listUnlockedItems().filter((i) => {
    const itemHost = hostOf(stringField(i, 'url'));
    return !i.deleted_at && i.type === 'login' && itemHost !== null && domainsMatch(pageHost, itemHost);
  });
  // No username on the form (e.g. a change-password page): only an
  // unambiguous single login for the site can be updated.
  const sameUser = capture.username
    ? forSite.filter((i) => stringField(i, 'username') === capture.username)
    : forSite.length === 1 ? forSite : [];
  if (sameUser.some((i) => stringField(i, 'password') === capture.password)) return null;
  const target = sameUser[0];
  if (target) {
    return { mode: 'update', origin: capture.origin, username: stringField(target, 'username'), itemId: target.id, title: target.title };
  }
  return capture.username ? { mode: 'new', origin: capture.origin, username: capture.username } : null;
}

async function captureSubmission(message: LoginSubmittedMessage, page: { origin: string }): Promise<void> {
  const { username, password } = message;
  if (typeof username !== 'string' || typeof password !== 'string') return;
  if (!password || password.length > 4096 || username.length > 1024) return;
  // Same page gate as fill: https (or localhost dev), never a raw IP, not blocked.
  if (!checkPageAllowed(page.origin).allowed) return;
  if (isOriginBlocked(page.origin, await loadSettings())) return;
  const capture: SaveCapture = { origin: page.origin, username: username.trim(), password, capturedAt: Date.now() };
  if (vault.isUnlocked() && !computeSaveOffer(capture)) return; // already saved exactly like this
  clearSaveCapture();
  saveCapture = capture;
  saveCaptureTimer = setTimeout(clearSaveCapture, SAVE_OFFER_TTL_MS);
  void chrome.action.setBadgeText({ text: '1' });
}

async function resolveSaveOffer(accept: boolean): Promise<ExtResponse> {
  if (!vault.isUnlocked()) return { ok: false, error: 'Vault is locked.' };
  const capture = freshSaveCapture();
  const offer = capture ? computeSaveOffer(capture) : null;
  clearSaveCapture();
  if (!capture || !offer) return { ok: false, error: 'There is no login waiting to be saved.' };
  if (!accept) return { ok: true, saved: false };
  const now = new Date().toISOString();
  let item: VaultItem;
  if (offer.mode === 'update') {
    const existing = await vault.getDecryptedItem(offer.itemId);
    if (!existing) return { ok: false, error: 'Item not found.' };
    item = { ...existing, fields: { ...existing.fields, password: capture.password }, updated_at: now };
  } else {
    item = {
      id: crypto.randomUUID(), type: 'login', schema_version: 1, title: hostOf(capture.origin) ?? capture.origin,
      fields: { username: capture.username, password: capture.password, url: capture.origin },
      tags: [], relations: [], attachments: [], created_at: now, updated_at: now,
    };
  }
  await vault.upsertItem(item); // encrypted with a fresh item key, like every save
  await resetAutoLock();
  return { ok: true, saved: true, id: item.id };
}

// chrome.storage.local is readable AND writable from content scripts by
// default (verified in Chromium: an injected script read the settings key and
// wrote a new one). It holds the wrapped keys, ciphertext rows and the fill
// settings, so restrict it to extension pages and this worker. Every content
// script injection waits for this and fails closed if the browser refused.
const storageRestricted: Promise<boolean> = (async () => {
  try {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    return true;
  } catch {
    return false;
  }
})();

const EXTENSION_ORIGIN = new URL(chrome.runtime.getURL('/')).origin;
const EXTENSION_PAGES = new Set(['/popup/index.html', '/options/index.html']);

/** This extension's popup or options page — never a web page, content script or other extension. */
function isOwnExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id || !sender.url) return false;
  let url: URL;
  try {
    url = new URL(sender.url);
  } catch {
    return false;
  }
  if (url.origin !== EXTENSION_ORIGIN || !EXTENSION_PAGES.has(url.pathname)) return false;
  return sender.origin === undefined || sender.origin === EXTENSION_ORIGIN;
}

/** Our content script in the TOP frame of a tab; the origin is the one the browser reports. */
function contentScriptPage(sender: chrome.runtime.MessageSender): { tabId: number; origin: string } | null {
  if (sender.id !== chrome.runtime.id || sender.tab?.id === undefined || sender.frameId !== 0) return null;
  const origin = sender.origin ?? (sender.url ? originOf(sender.url) : null);
  if (!origin || origin === 'null' || origin === EXTENSION_ORIGIN) return null;
  return { tabId: sender.tab.id, origin };
}

/**
 * Inject content.js into the top frame of `tabId`, then re-read the tab: if
 * it navigated away from `origin` meanwhile, refuse. Returns the document the
 * script landed in so the caller can address exactly that document.
 */
async function injectContentScript(
  tabId: number,
  origin: string,
): Promise<{ ok: true; documentId: string | undefined } | { ok: false; error: string }> {
  if (!(await storageRestricted)) {
    return { ok: false, error: 'Refusing to inject: this browser would let page scripts read extension storage.' };
  }
  let documentId: string | undefined;
  try {
    const [result] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['content.js'] });
    documentId = result?.documentId;
  } catch (e) {
    return { ok: false, error: `Could not inject the fill script: ${e instanceof Error ? e.message : String(e)}` };
  }
  const now = await chrome.tabs.get(tabId);
  if (!now.url || originOf(now.url) !== origin) {
    return { ok: false, error: 'The page changed before the fill could be delivered.' };
  }
  return { ok: true, documentId };
}

async function resetAutoLock(): Promise<void> {
  await chrome.alarms.clear(AUTOLOCK_ALARM);
  const settings = await loadSettings();
  if (settings.autoLockMinutes > 0 && vault.isUnlocked()) {
    await chrome.alarms.create(AUTOLOCK_ALARM, { delayInMinutes: settings.autoLockMinutes });
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== AUTOLOCK_ALARM) return;
  vault.lockVault();
  clearSaveCapture();
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
  // script. The script is injected into THIS tab's top frame only, for THIS
  // fill, and the credential is addressed to that exact document.
  const injected = await injectContentScript(tab.id, origin);
  if (!injected.ok) return { ok: false, error: injected.error };
  // Phase F fix: the content script can refuse the fill (iframe, origin
  // mismatch, no password field) via its reply. The old code ignored that
  // reply and reported success anyway. Check it before claiming a fill.
  let fillResult: unknown;
  try {
    fillResult = await chrome.tabs.sendMessage(
      tab.id,
      { type: 'ext-fill', username, password, origin },
      injected.documentId ? { frameId: 0, documentId: injected.documentId } : { frameId: 0 },
    );
  } catch (e) {
    return { ok: false, error: `Could not deliver the fill to the page: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!fillResult || typeof fillResult !== 'object' || (fillResult as { ok?: unknown }).ok !== true) {
    const reason =
      fillResult && typeof fillResult === 'object' && typeof (fillResult as { error?: unknown }).error === 'string'
        ? (fillResult as { error: string }).error
        : 'The page refused the fill.';
    return { ok: false, error: reason };
  }
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
    case 'restoreBackup': {
      // restoreEncrypted needs empty storage, decrypts every item before any
      // write and throws (writing nothing) otherwise; errors reach the caller
      // through the generic handler as { ok:false, error }.
      const hasPass = typeof req.passphrase === 'string';
      const itemList = await vault.restoreEncrypted(
        req.json,
        hasPass ? { passphrase: req.passphrase as string } : { recoveryKey: req.recoveryKey ?? '' },
      );
      const restoredCount = vault.listUnlockedItems().filter((i) => !i.deleted_at).length;
      vault.lockVault(); // a normal unlock is required after restore
      return { ok: true, restoredCount, itemList };
    }
    case 'lock': {
      vault.lockVault();
      clearSaveCapture();
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
      clearSaveCapture();
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
    case 'armActiveTab': {
      // Popup opened on this tab (activeTab granted by that click): inject
      // the content script so a login submitted here can be offered for
      // saving. Same page gate as fill; no page data is read now.
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const origin = tab?.url ? originOf(tab.url) : null;
      if (tab?.id === undefined || !tab.url || !origin) return { ok: true, armed: false };
      if (!checkPageAllowed(tab.url).allowed || isOriginBlocked(origin, await loadSettings())) return { ok: true, armed: false };
      const injected = await injectContentScript(tab.id, origin);
      return injected.ok ? { ok: true, armed: true } : { ok: true, armed: false, error: injected.error };
    }
    case 'getSaveOffer': {
      if (!vault.isUnlocked()) return { ok: false, error: 'Vault is locked.' };
      const capture = freshSaveCapture();
      const offer = capture ? computeSaveOffer(capture) : null;
      if (capture && !offer) clearSaveCapture();
      return { ok: true, offer };
    }
    case 'resolveSaveOffer': {
      return resolveSaveOffer(req.accept === true);
    }
    default:
      return { ok: false, error: 'Unknown request.' };
  }
}

/** The only requests a content script may make. Replies carry no vault data. */
function handleContentMessage(message: ContentMessage, page: { tabId: number; origin: string }): ExtResponse | { ok: true } {
  if (message.type === 'ext-form-detected') {
    // Values are NEVER sent by the content script — only that a login
    // form exists on this origin, so the popup can offer to save one.
    pendingForm = {
      origin: page.origin,
      hasUsername: message.hasUsername === true,
      hasPassword: message.hasPassword === true,
      detectedAt: Date.now(),
    };
    return { ok: true };
  }
  if (message.type === 'ext-login-submitted') {
    // Same bare acknowledgement whether or not the submission is kept.
    void captureSubmission(message, page);
    return { ok: true };
  }
  return { ok: false, error: FORBIDDEN };
}

chrome.runtime.onMessage.addListener(
  (message: unknown, sender, sendResponse: (r: ExtResponse | { ok: boolean }) => void) => {
    if (!message || typeof message !== 'object' || typeof (message as { type?: unknown }).type !== 'string') {
      sendResponse({ ok: false, error: 'Malformed request.' });
      return false;
    }
    if (isOwnExtensionPage(sender)) {
      handle(message as ExtRequest)
        .then(sendResponse)
        .catch((e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
      return true; // async response
    }
    // Content scripts run inside the web page's renderer: treat them as the
    // page. Sub-frames, other extensions and anything else get nothing.
    const page = contentScriptPage(sender);
    sendResponse(page ? handleContentMessage(message as ContentMessage, page) : { ok: false, error: FORBIDDEN });
    return false;
  },
);

// Keep the default settings in place even if the worker restarts.
void loadSettings().then((s) => saveSettings(s)).catch(() => undefined);
