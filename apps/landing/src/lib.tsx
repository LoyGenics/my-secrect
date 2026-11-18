import { Fragment, useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { en, type Copy } from './content/en';
import { vi } from './content/vi';
import { asOf, site, type PlaceholderKey } from './site.config';

export type Lang = 'en' | 'vi';
export type Page = 'home' | 'pricing' | 'security' | 'privacy' | 'terms' | 'support';
export const LANGS: Lang[] = ['en', 'vi'];
const PAGES: Page[] = ['pricing', 'security', 'privacy', 'terms', 'support'];
const LANG_KEY = 'ms-lang';

export const copyFor = (lang: Lang): Copy => (lang === 'vi' ? vi : en);

export function href(lang: Lang, page: Page): string {
  return page === 'home' ? `/${lang}/` : `/${lang}/${page}/`;
}

export function parsePath(pathname: string): { lang: Lang; page: Page } | null {
  const parts = pathname.split('/').filter(Boolean);
  const lang = parts[0] as Lang | undefined;
  if (!lang || !LANGS.includes(lang)) return null;
  if (parts.length === 1) return { lang, page: 'home' };
  const page = parts[1] as Page;
  return parts.length === 2 && PAGES.includes(page) ? { lang, page } : null;
}

function detectLang(): Lang {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === 'en' || saved === 'vi') return saved;
  } catch { /* private mode */ }
  return 'en';
}

export function navigate(to: string) {
  if (to === location.pathname) return;
  history.pushState(null, '', to);
  window.dispatchEvent(new Event('ms:nav'));
  window.scrollTo({ top: 0 });
}

/** Current route. `/` and unknown paths redirect to the visitor's language home. */
export function useRoute(): { lang: Lang; page: Page } {
  const read = () => parsePath(location.pathname);
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener('popstate', on);
    window.addEventListener('ms:nav', on);
    return () => { window.removeEventListener('popstate', on); window.removeEventListener('ms:nav', on); };
  }, []);
  useEffect(() => {
    if (!route) { history.replaceState(null, '', href(detectLang(), 'home')); setRoute(read()); }
  }, [route]);
  return route ?? { lang: detectLang(), page: 'home' };
}

export function rememberLang(lang: Lang) {
  try { localStorage.setItem(LANG_KEY, lang); } catch { /* ignore */ }
}

export function Link({ to, className, children, ...rest }: { to: string; className?: string; children: ReactNode } & Record<string, unknown>) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
  return <a href={to} className={className} onClick={onClick} {...rest}>{children}</a>;
}

const LABELS: Record<PlaceholderKey, string> = {
  COMPANY_NAME: 'COMPANY NAME', COMPANY_ADDRESS: 'COMPANY ADDRESS', COUNTRY: 'COUNTRY', SUPPORT_EMAIL: 'SUPPORT EMAIL',
  SECURITY_EMAIL: 'SECURITY EMAIL', PRIVACY_EMAIL: 'PRIVACY EMAIL', EMAIL_PROVIDER: 'EMAIL PROVIDER', PAYMENT_PROVIDER: 'PAYMENT PROVIDER',
  BACKUP_RETENTION_DAYS: 'BACKUP RETENTION DAYS', SESSION_PURGE_DAYS: 'SESSION PURGE DAYS', REFUND_DAYS: 'REFUND DAYS',
};

/** Replaces `[[KEY]]` with its value, or a highlighted [REPLACE KEY] while the value is still empty. */
export function fill(text: string, lang: Lang): ReactNode {
  const out: ReactNode[] = [];
  const re = /\[\[([A-Z_]+)\]\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    out.push(text.slice(last, m.index));
    const key = m[1];
    if (key === 'ASOF') out.push(asOf[lang]);
    else {
      const value = site.placeholders[key as PlaceholderKey];
      out.push(value ? value : <mark key={i++} className="ph" title="Replace this in src/site.config.ts">[{LABELS[key as PlaceholderKey] ?? key}]</mark>);
    }
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return <Fragment>{out}</Fragment>;
}

/** Where "Get early access" goes: a prefilled email once the support address exists, else the support page. */
export function earlyAccessHref(lang: Lang): string {
  const mail = site.placeholders.SUPPORT_EMAIL;
  return mail ? `mailto:${mail}?subject=${encodeURIComponent(copyFor(lang).cta.earlySubject)}` : href(lang, 'support');
}

export function slug(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
