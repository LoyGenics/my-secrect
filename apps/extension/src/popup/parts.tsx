import type { ReactNode } from 'react';
import ghostMark from '../../../../packages/ui/assets/brand/ghost-mark.webp';
import type { Dictionary } from '../../../../packages/i18n/src/index';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { Icon, type IconName } from './icons';

/** Item type -> icon and stamp family (the seven Pocket Ledger families). */
const TYPES: Record<string, { icon: IconName; fam: string }> = {
  login: { icon: 'key-round', fam: 'access' },
  passkey: { icon: 'fingerprint', fam: 'access' },
  card: { icon: 'credit-card', fam: 'money' },
  bank_account: { icon: 'landmark', fam: 'money' },
  identity: { icon: 'id-card', fam: 'id' },
  secure_note: { icon: 'notebook-text', fam: 'note' },
  document: { icon: 'file-text', fam: 'file' },
  media: { icon: 'image', fam: 'file' },
  ssh_key: { icon: 'square-terminal', fam: 'dev' },
  api_key: { icon: 'braces', fam: 'dev' },
  collection: { icon: 'boxes', fam: 'group' },
  custom: { icon: 'shapes', fam: 'group' },
};
const typeOf = (type: string) => TYPES[type] ?? { icon: 'shapes' as IconName, fam: 'group' };
export const typeLabel = (dict: Dictionary, type: string): string => (dict.itemTypes as Record<string, string>)[type] ?? type;

export function Stamp({ type, big }: { type: string; big?: boolean }) {
  const t = typeOf(type);
  return <span className={`stamp${big ? ' big' : ''} st-${t.fam}`} aria-hidden="true"><Icon name={t.icon} /></span>;
}

export function SiteStamp({ host }: { host: string }) {
  return <span className="stamp big letter site-stamp" aria-hidden="true">{(host.replace(/^www\./, '')[0] ?? '?').toUpperCase()}</span>;
}

export function Star() {
  const x = useTranslation().dict.extension;
  return <><span className="sr">{x.favoriteSr}</span><Icon name="star" className="star" /></>;
}

export function Topbar({ onLock }: { onLock: () => void }) {
  const x = useTranslation().dict.extension;
  return (
    <div className="topbar">
      <span className="brand"><img src={ghostMark} alt="" />{x.brand}</span>
      <button className="pill" type="button" onClick={onLock}><Icon name="lock" />{x.lock}</button>
    </div>
  );
}

export type Tab = 'site' | 'all' | 'gen' | 'settings';
const DOCK: [Tab, 'thisSite' | 'allItems' | 'generate' | 'settings', IconName][] = [
  ['site', 'thisSite', 'globe'],
  ['all', 'allItems', 'list'],
  ['gen', 'generate', 'dices'],
  ['settings', 'settings', 'settings'],
];

export function Dock({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void }) {
  const x = useTranslation().dict.extension;
  return (
    <>
      <div className="dockfade" aria-hidden="true" />
      <nav className="dock" aria-label={x.sections}>
        {DOCK.map(([id, label, icon]) => (
          <button key={id} type="button" aria-current={tab === id ? 'page' : undefined} onClick={() => onTab(id)}>
            <Icon name={icon} /><span>{x[label]}</span>
          </button>
        ))}
      </nav>
    </>
  );
}

export function Seg<T extends string | number>({ label, value, options, onChange, disabled }: {
  label: string; value: T; options: [T, string, IconName?][]; onChange: (v: T) => void; disabled?: boolean;
}) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map(([v, text, icon]) => (
        <button key={String(v)} type="button" role="radio" aria-checked={v === value} disabled={disabled} onClick={() => onChange(v)}>
          {icon && <Icon name={icon} />}{text}
        </button>
      ))}
    </div>
  );
}

export function Switch({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button className="sw" type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}>
      <span className="k">{label}</span><span className="switch" aria-hidden="true" />
    </button>
  );
}

export function OtpRing({ left }: { left: number }) {
  const c = 2 * Math.PI * 6;
  return (
    <svg className="otp-ring" viewBox="0 0 16 16" aria-hidden="true">
      <circle className="trk" cx="8" cy="8" r="6" />
      <circle className="val" cx="8" cy="8" r="6" strokeDasharray={c.toFixed(2)} strokeDashoffset={(c * (1 - left / 30)).toFixed(2)} />
    </svg>
  );
}

/** "284913" -> two halves with a visual gap; innerText stays the bare code. */
export function Code({ code }: { code: string }) {
  const h = Math.ceil(code.length / 2);
  return <><span className="code-half">{code.slice(0, h)}</span><span className="code-half">{code.slice(h)}</span></>;
}

/** Digits in plum, symbols muted, as in the prototype. */
export function Colorized({ text }: { text: string }) {
  const out: ReactNode[] = [];
  for (const [i, ch] of Array.from(text).entries()) {
    if (/[0-9]/.test(ch)) out.push(<span key={i} className="dg">{ch}</span>);
    else if (/[^A-Za-z]/.test(ch)) out.push(<span key={i} className="sy">{ch}</span>);
    else out.push(ch);
  }
  return <>{out}</>;
}

export function Msg({ icon, children, className }: { icon: IconName; children: ReactNode; className?: string }) {
  return <p className={`msg${className ? ` ${className}` : ''}`}><Icon name={icon} /><span>{children}</span></p>;
}
