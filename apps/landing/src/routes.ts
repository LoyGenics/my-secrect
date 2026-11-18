export const LANGS = ['en', 'vi'] as const;
export const PAGES = ['home', 'pricing', 'security', 'black-friday', 'privacy', 'terms', 'support'] as const;

export type Lang = (typeof LANGS)[number];
export type Page = (typeof PAGES)[number];
export type Route = { lang: Lang; page: Page };

export function href(lang: Lang, page: Page): string {
  if (page === 'home') return lang === 'en' ? '/' : '/vi/';
  return `/${lang}/${page}/`;
}

export function parsePath(pathname: string): Route | null {
  const path = pathname.replace(/(?:\/index\.html|\/)$/, '');
  if (path === '') return { lang: 'en', page: 'home' };
  for (const lang of LANGS) {
    if (path === `/${lang}`) return { lang, page: 'home' };
    for (const page of PAGES) {
      if (page !== 'home' && path === `/${lang}/${page}`) return { lang, page };
    }
  }
  return null;
}
