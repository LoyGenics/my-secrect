/**
 * CSV import (desktop) — turn validated CsvDrafts from
 * packages/import-export into VaultItems ready for upsertItem.
 *
 * Rules:
 *  - Every draft becomes a `login` item. Import only TOTP secrets and
 *    authenticator settings compatible with the vault's generator.
 *  - Folder (Bitwarden) becomes a tag, so imports stay organised.
 *  - Ids are CSPRNG (crypto.getRandomValues). Created/updated timestamps
 *    are set here; the vault re-stamps updated_at on write.
 *  - Duplicate detection lives in packages/import-export
 *    (detectCsvDuplicates) and runs BEFORE this step — this file never
 *    decides what is a duplicate.
 */
import type { ItemType, VaultItem } from '../../../../packages/core/src/types';
import type { CsvDraft } from '../../../../packages/import-export/src/index';
import { isValidBase32Secret, TOTP_DIGITS, TOTP_PERIOD_SECONDS } from './totp';

function newItemId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return 'item_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function importTotpSecret(value: string): string | undefined {
  let secret = value;
  if (/^otpauth:/i.test(value)) {
    try {
      const uri = new URL(value);
      const params = uri.searchParams;
      if (uri.hostname !== 'totp' ||
          (params.get('algorithm') ?? 'SHA1').toUpperCase() !== 'SHA1' ||
          (params.get('digits') ?? String(TOTP_DIGITS)) !== String(TOTP_DIGITS) ||
          (params.get('period') ?? String(TOTP_PERIOD_SECONDS)) !== String(TOTP_PERIOD_SECONDS)) return;
      secret = params.get('secret') ?? '';
    } catch {
      return;
    }
  }
  const clean = secret.replace(/\s/g, '').toUpperCase();
  return isValidBase32Secret(clean) ? clean : undefined;
}

export function csvDraftToLoginItem(draft: CsvDraft): VaultItem {
  const fields: Record<string, unknown> = {
    username: draft.username,
    password: draft.password,
    url: draft.url,
  };
  const secret = draft.totp && importTotpSecret(draft.totp);
  if (secret) fields.totp_secret = secret;
  if (draft.notes) fields.notes = draft.notes;
  if (draft.archived) fields.archived = true;
  const tags = [...(draft.tags ?? [])];
  if (draft.folder) tags.push(draft.folder);
  return newImportedItem('login', draft.title, fields, tags, draft.favorite);
}

export function newImportedItem(type: ItemType, title: string, fields: Record<string, unknown>, tags: string[] = [], favorite = false): VaultItem {
  const now = new Date().toISOString();
  return {
    id: newItemId(),
    type,
    schema_version: 1,
    title,
    fields,
    tags: [...new Set(['imported', ...tags])],
    relations: [],
    attachments: [],
    favorite,
    created_at: now,
    updated_at: now,
  };
}
