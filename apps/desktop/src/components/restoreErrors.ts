/**
 * Map restoreEncrypted() failures to specific user-facing messages.
 *
 * restoreEncrypted throws `restore: <reason>` (or `restore: <validation
 * errors>`) and writes nothing on any failure. This only chooses the
 * wording; it never swallows an error and never turns one into success.
 * Messages never include key material or file contents.
 */
export type RestoreErrorKind =
  | 'wrong-passphrase'
  | 'wrong-recovery-key'
  | 'bad-recovery-key'
  | 'tampered'
  | 'unsupported-version'
  | 'not-a-backup'
  | 'duplicate-ids'
  | 'existing-vault'
  | 'unknown';

export interface RestoreErrorInfo {
  kind: RestoreErrorKind;
  message: string;
}

export function describeRestoreError(err: unknown): RestoreErrorInfo {
  const raw = err instanceof Error ? err.message : String(err);
  const has = (s: string) => raw.includes(s);
  if (has('vault storage is not empty') || has('lock and wipe the vault')) {
    return {
      kind: 'existing-vault',
      message:
        'A vault already exists on this device. Restore never overwrites it, and nothing was changed. ' +
        'To bring a backup into it, unlock the vault and use Import (merge). ' +
        'To replace it, first erase it deliberately from Settings, then restore.',
    };
  }
  if (has('with this passphrase')) {
    return {
      kind: 'wrong-passphrase',
      message:
        'Could not open the backup with this passphrase. Check it and try again. ' +
        '(A damaged key section in the file looks the same as a wrong passphrase.) Nothing was restored.',
    };
  }
  if (has('with this recovery key')) {
    return {
      kind: 'wrong-recovery-key',
      message:
        'Could not open the backup with this recovery key. Check it and try again. ' +
        '(A damaged key section in the file looks the same as a wrong key.) Nothing was restored.',
    };
  }
  if (has('recovery key must be 32 bytes')) {
    return {
      kind: 'bad-recovery-key',
      message: 'That is not a valid recovery key (expected the 43-character key shown when the vault was created).',
    };
  }
  if (has('passphrase must not be empty')) {
    return { kind: 'wrong-passphrase', message: 'Enter the passphrase for this backup.' };
  }
  if (has('could not decrypt item') || has('does not match item_id') || has('could not unwrap the vault key')) {
    return {
      kind: 'tampered',
      message:
        'This backup is corrupted or has been tampered with: at least one item failed decryption or verification. ' +
        'Nothing was restored. Do not trust this file; use another copy.',
    };
  }
  if (has('newer version') || has('Unsupported export version') || has('format_version 1')) {
    return {
      kind: 'unsupported-version',
      message: `Unsupported backup version. ${raw.replace(/^restore:\s*/, '')} Nothing was restored.`,
    };
  }
  if (has('duplicate "item_id"')) {
    return {
      kind: 'duplicate-ids',
      message: `The backup lists the same item id more than once, so it cannot be trusted. ${raw.replace(/^restore:\s*/, '')} Nothing was restored.`,
    };
  }
  if (has('not valid JSON') || has('Not a my-secrect') || has('missing') || has('"kdf') || has('relations_included') || has('not an object')) {
    return {
      kind: 'not-a-backup',
      message: `This file is not a valid, complete backup. ${raw.replace(/^restore:\s*/, '')} Nothing was restored.`,
    };
  }
  return {
    kind: 'unknown',
    message: `Restore failed and nothing was changed. ${raw.replace(/^restore:\s*/, '')}`,
  };
}
