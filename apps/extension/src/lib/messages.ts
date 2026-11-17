/**
 * Message protocol between popup / options / content script / background.
 *
 * Security boundary: the background is the ONLY place that holds the vault
 * key and decrypts items. The popup asks for ONE item at a time and only
 * displays it; the content script receives ONLY the single username/password
 * the user explicitly chose to fill — never the vault, never any key, never
 * the item list. Every message below is extension-internal (chrome.runtime
 * messaging); nothing here is sent to any web page.
 *
 * Sender rules (enforced in background.ts): ExtRequest is accepted only from
 * this extension's popup and options pages. A content script may send only
 * ContentMessage, only from the top frame of a tab, and the background takes
 * the page origin from the browser-provided sender, never from the message.
 */
import type { VaultItem } from '../../../../packages/core/src/types';
import type { ExtSettings } from './settings';

export interface LoginMeta {
  id: string;
  title: string;
  username: string;
  url: string;
  hasTotp: boolean;
  favorite: boolean;
}

export interface ItemMeta {
  id: string;
  type: string;
  title: string;
  tags: string[];
  favorite: boolean;
  updatedAt: string;
}

export interface HealthSummary {
  score: number;
  total: number;
  weakCount: number;
  reusedCount: number;
}

export interface PendingForm {
  origin: string;
  hasUsername: boolean;
  hasPassword: boolean;
  detectedAt: number;
}

export type ExtRequest =
  | { type: 'getStatus' }
  | { type: 'unlock'; passphrase: string }
  | { type: 'unlockRecovery'; recoveryKey: string }
  | { type: 'createVault'; passphrase: string }
  | { type: 'lock' }
  | { type: 'listLogins'; origin: string }
  | { type: 'listAll' }
  | { type: 'getItem'; id: string }
  | { type: 'getHealth' }
  | { type: 'fill'; id: string; confirmed?: boolean }
  | { type: 'saveLogin'; item: VaultItem }
  | { type: 'deleteItem'; id: string }
  | { type: 'getSettings' }
  | { type: 'saveSettings'; settings: ExtSettings }
  | { type: 'exportEncrypted' }
  | { type: 'changePassphrase'; oldPassphrase: string; newPassphrase: string }
  | { type: 'wipeVault' }
  | { type: 'restoreBackup'; json: string; passphrase?: string; recoveryKey?: string }
  | { type: 'generatePassword'; length?: number; symbols?: boolean; numbers?: boolean }
  | { type: 'getPendingForm' };

export type ExtResponse =
  | { ok: true; status: { locked: boolean; vaultExists: boolean } }
  | { ok: true; unlocked: boolean; error?: string }
  | { ok: true; recoveryKey: string }
  | { ok: true; logins: LoginMeta[] }
  | { ok: true; items: ItemMeta[] }
  | { ok: true; item: VaultItem | null }
  | { ok: true; health: HealthSummary }
  | { ok: true; filled: boolean; needsConfirmation?: string }
  | { ok: true; id: string }
  | { ok: true; settings: ExtSettings }
  | { ok: true; json: string }
  | { ok: true; changed: boolean; error?: string }
  | { ok: true; password: string }
  | { ok: true; restoredCount: number }
  | { ok: true; pending: PendingForm | null }
  | { ok: false; error: string; needsConfirmation?: string };

/** Message the background sends to an injected content script. */
export interface FillMessage {
  type: 'ext-fill';
  username: string;
  password: string;
  origin: string;
}

/** A content script reports that a login form exists. Values are NEVER included. */
export interface FormDetectedMessage {
  type: 'ext-form-detected';
  hasUsername: boolean;
  hasPassword: boolean;
}

export type ContentMessage = FormDetectedMessage;
