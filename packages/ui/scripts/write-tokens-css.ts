/**
 * Rewrites src/tokens.css from tokens.ts, and each app's pre-paint
 * public/theme-init.js from theme.ts. Run: npm --workspace @my-secrect/ui run tokens
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderTokensCss } from '../src/tokens-css';
import { themeInitScript } from '../src/theme';

const write = (relative: string, content: string) => {
  const target = fileURLToPath(new URL(relative, import.meta.url));
  writeFileSync(target, content);
  console.log(`wrote ${target}`);
};

write('../src/tokens.css', renderTokensCss());
for (const app of ['desktop', 'web']) write(`../../../apps/${app}/public/theme-init.js`, themeInitScript);
