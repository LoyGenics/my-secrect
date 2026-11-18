// Lists the REPLACE-ME values still empty in src/site.config.ts and any [[KEY]] the copy uses
// that the config does not define. `--strict` exits 1 when anything is left (use it in CI before publishing).
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const config = readFileSync(join(root, 'site.config.ts'), 'utf8');
const defined = [...config.matchAll(/^\s+([A-Z_]+): (null|'[^']*') as string \| null/gm)].map((m) => ({ key: m[1], empty: m[2] === 'null' }));
const used = new Set();
for (const f of readdirSync(join(root, 'content'))) {
  for (const m of readFileSync(join(root, 'content', f), 'utf8').matchAll(/\[\[([A-Z_]+)\]\]/g)) used.add(m[1]);
}
used.delete('ASOF');
const unknown = [...used].filter((k) => !defined.some((d) => d.key === k));
const empty = defined.filter((d) => d.empty);
console.log(`placeholders in src/site.config.ts: ${defined.length - empty.length} filled, ${empty.length} empty`);
for (const d of empty) console.log(`  empty  ${d.key}${used.has(d.key) ? '' : '  (not used in the copy)'}`);
for (const k of unknown) console.log(`  UNKNOWN [[${k}]] is used in the copy but not defined in site.config.ts`);
if ((empty.length || unknown.length) && process.argv.includes('--strict')) process.exit(1);
