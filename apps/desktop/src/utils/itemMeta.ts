/**
 * Per-item metadata kept INSIDE the encrypted item fields, so it is
 * encrypted with the item itself — never in plaintext localStorage.
 *
 *  - `archived` (boolean field): hides the item from All Items /
 *    categories / search until it is unarchived. Trash is separate.
 *  - `password_history`: previous login passwords, most recent first,
 *    max 5. Only the previous value is kept on each change — this is
 *    the user's own vault, so the old passwords stay encrypted here.
 *    Never log them, never export them separately from the item.
 *  - `revisions`: previous secure-note bodies, most recent first,
 *    max 10. Lets a note be restored after a bad edit.
 *
 * History/revisions are stored as JSON values inside `fields`, so the
 * form code must carry them through edits explicitly (the form only
 * edits string fields). See ItemForm.tsx.
 */
import type { VaultItem } from '../../../../packages/core/src/types';

export interface PasswordHistoryEntry {
  password: string;
  changed_at: string; // ISO 8601
}

export interface NoteRevision {
  body: string;
  saved_at: string; // ISO 8601
}

export const MAX_PASSWORD_HISTORY = 5;
export const MAX_NOTE_REVISIONS = 10;

export function isArchived(item: VaultItem): boolean {
  return item.fields?.archived === true;
}

export function getPasswordHistory(item: VaultItem): PasswordHistoryEntry[] {
  const raw = item.fields?.password_history;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is PasswordHistoryEntry =>
      typeof e === 'object' && e !== null &&
      typeof (e as PasswordHistoryEntry).password === 'string' &&
      typeof (e as PasswordHistoryEntry).changed_at === 'string')
    .slice(0, MAX_PASSWORD_HISTORY);
}

/** Prepend `oldPassword` to the history (most recent first, capped). */
export function appendPasswordHistory(
  history: PasswordHistoryEntry[],
  oldPassword: string,
  now = new Date().toISOString(),
): PasswordHistoryEntry[] {
  if (!oldPassword) return history;
  const next = [{ password: oldPassword, changed_at: now }, ...history.filter((e) => e.password !== oldPassword)];
  return next.slice(0, MAX_PASSWORD_HISTORY);
}

export function getNoteRevisions(item: VaultItem): NoteRevision[] {
  const raw = item.fields?.revisions;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is NoteRevision =>
      typeof e === 'object' && e !== null &&
      typeof (e as NoteRevision).body === 'string' &&
      typeof (e as NoteRevision).saved_at === 'string')
    .slice(0, MAX_NOTE_REVISIONS);
}

/** Prepend `oldBody` to the revision list (most recent first, capped). */
export function appendNoteRevision(
  revisions: NoteRevision[],
  oldBody: string,
  now = new Date().toISOString(),
): NoteRevision[] {
  if (!oldBody) return revisions;
  const next = [{ body: oldBody, saved_at: now }, ...revisions];
  return next.slice(0, MAX_NOTE_REVISIONS);
}
