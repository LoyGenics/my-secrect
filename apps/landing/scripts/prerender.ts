import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';
import { en } from '../src/content/en';
import { vi } from '../src/content/vi';
import { href, LANGS, PAGES, type Route } from '../src/routes';
import { site } from '../src/site.config';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
const template = readFileSync(join(dist, 'index.html'), 'utf8');
const modules = join(root, 'node_modules');
mkdirSync(modules, { recursive: true });
const temporary = mkdtempSync(join(modules, '.prerender-'));

try {
  await build({
    root,
    publicDir: false,
    build: { ssr: 'src/entry-server.tsx', outDir: temporary, emptyOutDir: true },
  });
  const { render, isIndexable, pageUrl } = await import(pathToFileURL(join(temporary, 'entry-server.js')).href) as typeof import('../src/entry-server');
  function writePage(file: string, route: Route | null) {
    const { head, body } = render(route);
    const html = template
      .replace('<html lang="en">', `<html lang="${route?.lang ?? 'en'}">`)
      .replace(/<title>[^<]*<\/title>\s*<meta name="description"[^>]*>/, () => head)
      .replace('<div id="root"></div>', () => `<div id="root">${body}</div>`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, html);
  }

  const urls: string[] = [];
  for (const lang of LANGS) {
    for (const page of PAGES) {
      writePage(join(dist, href(lang, page), 'index.html'), { lang, page });
      if (isIndexable(page)) urls.push(pageUrl(lang, page));
    }
  }
  // Preserve the old English landing URL with the canonical URL set to the root.
  writePage(join(dist, 'en', 'index.html'), { lang: 'en', page: 'home' });
  writePage(join(dist, '404.html'), null);
  copyFileSync(join(root, '../web/public/icon-512.png'), join(dist, 'my-secret.png'));

  writeFileSync(join(dist, 'sitemap.xml'), [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map((url) => `  <url><loc>${url}</loc></url>`),
    '</urlset>',
    '',
  ].join('\n'));
  writeFileSync(join(dist, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${site.origin}/sitemap.xml\n`);
  writeFileSync(join(dist, 'llms.txt'), [
    '# My Secret',
    '',
    `> ${en.meta.home.description}`,
    '',
    '## English',
    '',
    `- [My Secret](${pageUrl('en', 'home')}): ${en.home.hero.sub}`,
    `- [Security](${pageUrl('en', 'security')}): On-device encryption, keys, recovery and security limits.`,
    `- [Plans](${pageUrl('en', 'pricing')}): Free vault, proposed paid plans and feature comparisons.`,
    `- [Black Friday 2026](${pageUrl('en', 'black-friday')}): ${en.blackFriday.intro} ${en.blackFriday.details}`,
    '',
    '## Tiếng Việt',
    '',
    `- [My Secret](${pageUrl('vi', 'home')}): ${vi.home.hero.sub}`,
    `- [Bảo mật](${pageUrl('vi', 'security')}): Mã hóa trên thiết bị, khóa, khôi phục và giới hạn bảo mật.`,
    `- [Bảng giá](${pageUrl('vi', 'pricing')}): Két miễn phí, các gói trả phí dự kiến và bảng so sánh.`,
    `- [Black Friday 2026](${pageUrl('vi', 'black-friday')}): ${vi.blackFriday.intro} ${vi.blackFriday.details}`,
    '',
  ].join('\n'));
  console.log(`prerender: wrote ${LANGS.length * PAGES.length} routes, English alias, 404 and crawler files (${urls.length} sitemap URLs)`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
