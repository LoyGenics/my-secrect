/**
 * CSV import (desktop) — turn validated CsvDrafts from
 * packages/import-export into VaultItems ready for upsertItem.
 *
 * Rules:
 *  - Every draft becomes a `login` item. TOTP secrets are stored only
 *    when they look like Base32; anything else is moved into `notes`
 *    with a warning instead of being silently dropped or stored as a
 *    bogus secret that would show an "Invalid TOTP" error forever.
 *  - Folder (Bitwarden) becomes a tag, so imports stay organised.
 *  - Ids are CSPRNG (crypto.getRandomValues). Created/updated timestamps
 *    are set here; the vault re-stamps updated_at on write.
 *  - Duplicate detection lives in packages/import-export
 *    (detectCsvDuplicates) and runs BEFORE this step — this file never
 *    decides what is a duplicate.
 */
import type { VaultItem } from '../../../../packages/core/src/types';
import type { CsvDraft } from '../../../../packages/import-export/src/index';
import { isValidBase32Secret } from './totp';

function newItemId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return 'item_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function csvDraftToLoginItem(draft: CsvDraft): VaultItem {
  const now = new Date().toISOString();
  const notes: string[] = [];
  if (draft.notes) notes.push(draft.notes);
  const fields: Record<string, unknown> = {
    username: draft.username,
    password: draft.password,
    url: draft.url,
  };
  if (draft.totp) {
    const clean = draft.totp.replace(/\s+/g, '');
    if (isValidBase32Secret(clean)) {
      fields.totp_secret = clean;
    } else {
      notes.push(`TOTP from import (not valid Base32, kept as text): ${draft.totp}`);
    }
  }
  if (notes.length > 0) fields.notes = notes.join('\n');
  const tags: string[] = ['imported'];
  if (draft.folder) tags.push(draft.folder);
  return {
    id: newItemId(),
    type: 'login',
    schema_version: 1,
    title: draft.title,
    fields,
    tags,
    relations: [],
    attachments: [],
    favorite: draft.favorite ?? false,
    created_at: now,
    updated_at: now,
  };
}
