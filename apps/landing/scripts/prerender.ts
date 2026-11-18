/**
 * After `vite build`: writes one HTML file per route (/en/pricing/index.html ...)
 * with that page's <title>, description and <html lang>, so every URL answers on a
 * plain static host and link previews show the right text. The page itself is
 * still rendered by the client bundle.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { en } from '../src/content/en';
import { vi } from '../src/content/vi';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const template = readFileSync(join(dist, 'index.html'), 'utf8');
const pages = ['home', 'pricing', 'security', 'privacy', 'terms', 'support'] as const;
const copies = { en, vi };

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
let count = 0;
for (const [lang, copy] of Object.entries(copies)) {
  for (const page of pages) {
    const m = copy.meta[page];
    const html = template
      .replace(/<html lang="[^"]*"/, `<html lang="${copy.htmlLang}"`)
      .replace(/<title>[^<]*<\/title>/, `<title>${esc(m.title)}</title>`)
      .replace(/(<meta name="description" content=")[^"]*(")/, `$1${esc(m.description)}$2`)
      .replace('<div id="root"></div>', `<div id="root"></div>\n    <noscript><p style="padding:24px;font-family:system-ui,sans-serif">${esc(copy.meta.home.title)}. Please enable JavaScript.</p></noscript>`);
    const out = page === 'home' ? join(dist, lang, 'index.html') : join(dist, lang, page, 'index.html');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, html);
    count += 1;
  }
}
writeFileSync(join(dist, '404.html'), template);
writeFileSync(join(dist, 'robots.txt'), 'User-agent: *\nAllow: /\n');
console.log(`prerender: wrote ${count} route pages, 404.html, robots.txt`);
