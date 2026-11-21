import type { ReactNode } from 'react';
import ghostMark from '../../../../packages/ui/assets/brand/ghost-mark.webp';
import { Icon, type IconName } from './icons';

/** Item type -> label, icon and stamp family (the seven Pocket Ledger families). */
const TYPES: Record<string, { label: string; icon: IconName; fam: string }> = {
  login: { label: 'Login', icon: 'key-round', fam: 'access' },
  passkey: { label: 'Passkey', icon: 'fingerprint', fam: 'access' },
  card: { label: 'Card', icon: 'credit-card', fam: 'money' },
  bank_account: { label: 'Bank account', icon: 'landmark', fam: 'money' },
  identity: { label: 'Identity', icon: 'id-card', fam: 'id' },
  secure_note: { label: 'Secure note', icon: 'notebook-text', fam: 'note' },
  document: { label: 'Document', icon: 'file-text', fam: 'file' },
  media: { label: 'Photo & video', icon: 'image', fam: 'file' },
  ssh_key: { label: 'SSH key', icon: 'square-terminal', fam: 'dev' },
  api_key: { label: 'API key', icon: 'braces', fam: 'dev' },
  collection: { label: 'Collection', icon: 'boxes', fam: 'group' },
  custom: { label: 'Custom', icon: 'shapes', fam: 'group' },
};
const typeOf = (type: string) => TYPES[type] ?? { label: type, icon: 'shapes' as IconName, fam: 'group' };
export const typeLabel = (type: string) => typeOf(type).label;

export function Stamp({ type, big }: { type: string; big?: boolean }) {
  const t = typeOf(type);
  return <span className={`stamp${big ? ' big' : ''} st-${t.fam}`} aria-hidden="true"><Icon name={t.icon} /></span>;
}

export function SiteStamp({ host }: { host: string }) {
  return <span className="stamp big letter site-stamp" aria-hidden="true">{(host.replace(/^www\./, '')[0] ?? '?').toUpperCase()}</span>;
}

export function Star() {
  return <><span className="sr">, favorite</span><Icon name="star" className="star" /></>;
}

export function Topbar({ onLock }: { onLock: () => void }) {
  return (
    <div className="topbar">
      <span className="brand"><img src={ghostMark} alt="" />My Secret</span>
      <button className="pill" type="button" onClick={onLock}><Icon name="lock" />Lock</button>
    </div>
  );
}

export type Tab = 'site' | 'all' | 'gen' | 'settings';
const DOCK: [Tab, string, IconName][] = [
  ['site', 'This site', 'globe'],
  ['all', 'All items', 'list'],
  ['gen', 'Generate', 'dices'],
  ['settings', 'Settings', 'settings'],
];

export function Dock({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void }) {
  return (
    <>
      <div className="dockfade" aria-hidden="true" />
      <nav className="dock" aria-label="Sections">
        {DOCK.map(([id, label, icon]) => (
          <button key={id} type="button" aria-current={tab === id ? 'page' : undefined} onClick={() => onTab(id)}>
            <Icon name={icon} /><span>{label}</span>
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
