// Builds a demo vault with the REAL desktop vault code and writes an encrypted
// backup (format v3) plus a README with the throwaway demo passphrase.
// Usage: npx tsx tests/demo/make-demo-backup.mts <out-dir>
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const mem = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
    key: (i: number) => [...mem.keys()][i] ?? null,
    get length() { return mem.size; },
  },
  configurable: true, writable: true,
});

const outDir = process.argv[2];
if (!outDir) throw new Error('usage: make-demo-backup <out-dir>');
const { createVault, upsertItem, listItems, exportEncrypted } = await import('../../apps/desktop/src/vault');
const { buildExampleItems } = await import('../../apps/desktop/src/utils/exampleData');

const words = ['amber', 'harbor', 'lantern', 'meadow', 'orbit', 'pepper', 'quartz', 'ripple', 'saffron', 'tundra', 'velvet', 'willow'];
const pick = () => words[randomBytes(1)[0] % words.length];
const passphrase = `demo-${pick()}-${pick()}-${pick()}-${randomBytes(2).toString('hex')}`;
const { recoveryKey } = await createVault(passphrase);

const now = new Date().toISOString();
for (const item of buildExampleItems()) await upsertItem(item);
// Extra fake logins so search, favourites and Watchtower (weak + reused) have something to show.
const reused = 'Summer2024!';
const extras: Array<[string, string, string, string]> = [
  ['Demo Mail', 'https://mail.example.org', 'me@example.org', 'kX9#tq2Lw!vR7pZ4'],
  ['Demo Shop', 'https://shop.example.net', 'me@example.org', reused],
  ['Demo Forum', 'https://forum.example.com', 'demo_user', reused],
  ['Demo Bank Portal', 'https://bank.example.com', 'customer-0042', 'Gq7!mWz2#Lp9Vd3s'],
  ['Demo Streaming', 'https://tv.example.org', 'me@example.org', '123456'],
  ['Demo Cloud Storage', 'https://cloud.example.net', 'me@example.org', 'r8N$e3Qw!Zt6yUb1'],
];
for (const [title, url, username, password] of extras) {
  await upsertItem({
    id: `demo-${title.toLowerCase().replace(/[^a-z]+/g, '-')}`,
    type: 'login', schema_version: 1, title,
    fields: { username, password, url, notes: 'DEMO DATA — fake account for trying the app.' },
    tags: ['demo'], relations: [], attachments: [], favorite: title === 'Demo Mail',
    created_at: now, updated_at: now,
  } as any);
}
const backup = await exportEncrypted();
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'my-secret-demo-backup.json'), backup);
writeFileSync(path.join(outDir, 'DEMO-README.txt'), [
  'My Secret — demo vault (fake data only)',
  '',
  'How to use: open the app link -> "Restore from backup" -> choose my-secret-demo-backup.json',
  '-> choose "Passphrase" and enter the passphrase below -> Restore -> unlock with the same passphrase.',
  '',
  `Demo passphrase:  ${passphrase}`,
  `Demo recovery key: ${recoveryKey}`,
  '',
  `Items: ${listItems().length} (12 example items, one per type, + ${extras.length} demo logins incl. weak and reused passwords for Watchtower).`,
  'All values are fake. Do not store real secrets in this demo vault.',
].join('\n'));
console.log('items', listItems().length, 'backup bytes', backup.length, 'format', JSON.parse(backup).format_version);
