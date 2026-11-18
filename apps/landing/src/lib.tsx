import { Fragment, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { en, type Copy } from './content/en';
import { vi } from './content/vi';
import { asOf, site, type PlaceholderKey } from './site.config';
import type { Lang } from './routes';

export { href, LANGS, type Lang, type Page } from './routes';

export const copyFor = (lang: Lang): Copy => (lang === 'vi' ? vi : en);

export function Link({ to, ...props }: Omit<ComponentPropsWithoutRef<'a'>, 'href'> & { to: string }) {
  return <a href={to} {...props} />;
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

/** Use the signup flow while the support inbox is being set up. */
export function earlyAccessHref(lang: Lang): string {
  const mail = site.placeholders.SUPPORT_EMAIL;
  return mail ? `mailto:${mail}?subject=${encodeURIComponent(copyFor(lang).cta.earlySubject)}` : site.appUrl;
}

export function slug(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
