/** Rewrites src/tokens.css from tokens.ts. Run: npm --workspace @my-secrect/ui run tokens */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderTokensCss } from '../src/tokens-css';

const target = fileURLToPath(new URL('../src/tokens.css', import.meta.url));
writeFileSync(target, renderTokensCss());
console.log(`wrote ${target}`);
