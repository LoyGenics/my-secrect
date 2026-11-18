import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';
import { cn } from '../utils';
import { itemTypeColorVar } from '../tokens-css';
import { isItemTypeKey, moduleIcon } from '../modules';
import { typeArt } from '../illustrations';
import { Icon } from './Icon';

// ---------------------------------------------------------------------------
// Status dot, lock-card dot, count, badge, kbd
// ---------------------------------------------------------------------------

export type LedTone = 'off' | 'ok' | 'attention' | 'danger' | 'active';

/** Small status dot. Colour is signal only: always pair it with text (the dot is aria-hidden). */
export function Led({ tone = 'off', className }: { tone?: LedTone; className?: string }) {
  return <span className={cn('ms-led', tone !== 'off' && `ms-led--${tone}`, className)} aria-hidden="true" />;
}

export type LedStripState = 'off' | 'locked' | 'working' | 'error' | 'turn' | 'open';

/**
 * Lock-card status dot. locked = amber, working = soft amber pulse (key
 * derivation running), error = red, turn = the unlock moment (amber → green),
 * open = green. Decorative: the state is also stated in text next to it.
 */
export function LedStrip({ state, className }: { state: LedStripState; className?: string }) {
  return <span className={cn('ms-status-dot', className)} data-state={state} aria-hidden="true" />;
}

/** Quiet tabular count (rail counts, scores). Pass `label` when the number has no visible context. */
export function Readout({ value, label, size = 'md', className }: { value: ReactNode; label?: string; size?: 'md' | 'lg'; className?: string }) {
  return (
    <span className={cn('ms-readout', size === 'lg' && 'ms-readout--lg', className)} aria-label={label} role={label ? 'img' : undefined}>
      {value}
    </span>
  );
}

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  /** `legend` prints it in the small label style (type names, states). */
  legend?: boolean;
}

/** Small soft chip for tags and type names. Not interactive — use a Button for actions. */
export function Badge({ legend, className, children, ...rest }: BadgeProps) {
  return (
    <span className={cn('ms-badge', legend && 'ms-badge--legend', className)} {...rest}>
      {children}
    </span>
  );
}

/** Keyboard legend (⌘K, Esc, Enter). */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="ms-kbd">{children}</kbd>;
}

// ---------------------------------------------------------------------------
// Item-type module
// ---------------------------------------------------------------------------

export interface TypeModuleProps {
  /** VaultItem `type`. Unknown types render the `custom` module. */
  type: string;
  size?: 'sm' | 'md' | 'lg';
  /** Accessible name (e.g. the localized type). Omit when the type is written next to it. */
  label?: string;
  className?: string;
}

/**
 * The item type's tile: a rounded square in the type's pastel colour with its
 * 3D picture on it (`md` list rows, `lg` detail header). `sm` is a small
 * swatch with the Lucide glyph (sidebar, palette, health lists), where the
 * picture would be unreadable. Same pastel tokens on every surface.
 */
export function TypeModule({ type, size = 'md', label, className }: TypeModuleProps) {
  const key = isItemTypeKey(type) ? type : 'custom';
  const style = { '--module-fill': `var(${itemTypeColorVar(key)})` } as CSSProperties;
  const art = size === 'sm' ? undefined : typeArt[key];
  return (
    <span
      className={cn('ms-module', size !== 'md' && `ms-module--${size}`, className)}
      style={style}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {art ? (
        <img className="ms-module__art" src={art} alt="" loading="lazy" decoding="async" />
      ) : (
        <Icon name={moduleIcon[key]} size={size === 'lg' ? 'lg' : size === 'sm' ? 'xs' : 'sm'} />
      )}
    </span>
  );
}

/** The detail header's large tile (the same tile as the list, drawn bigger). */
export function ItemTypeArt({ type, size = 'lg', label, className }: TypeModuleProps) {
  return <TypeModule type={type} size={size} label={label} className={className} />;
}

// ---------------------------------------------------------------------------
// Alert
// ---------------------------------------------------------------------------

export type AlertTone = 'info' | 'success' | 'warning' | 'danger';

export interface AlertProps {
  tone?: AlertTone;
  title?: ReactNode;
  children?: ReactNode;
  /**
   * Announce it: danger -> role="alert" (assertive), others -> role="status"
   * (polite). Leave false for notices that are part of the page on load.
   */
  announce?: boolean;
  /** Trailing control (e.g. a dismiss IconButton). */
  action?: ReactNode;
  className?: string;
}

const ALERT_LED: Record<AlertTone, LedTone> = { info: 'off', success: 'ok', warning: 'attention', danger: 'danger' };

/** Inline notice: status dot + text. Colour is the dot and the title ink only — no tinted slabs, no side stripes. */
export function Alert({ tone = 'info', title, children, announce = false, action, className }: AlertProps) {
  const role = announce ? (tone === 'danger' ? 'alert' : 'status') : undefined;
  return (
    <div className={cn('ms-alert', `ms-alert--${tone}`, className)} role={role}>
      <Led tone={ALERT_LED[tone]} />
      <div className="ms-alert__body">
        {title && <strong className="ms-alert__title">{title}</strong>}
        {children}
      </div>
      {action && <div className="ms-alert__action">{action}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Countdown ring (TOTP)
// ---------------------------------------------------------------------------

export interface RingProps {
  /** Remaining share, 0–100 (the arc that is still drawn). */
  value: number;
  /** Accessible name, e.g. "Code refreshes". */
  label: string;
  /** Spoken value, e.g. "12 seconds left". */
  valueText?: string;
  tone?: 'success' | 'warning' | 'danger';
  /** Diameter in px (default 32). */
  size?: number;
  className?: string;
}

/** A thin countdown ring: role="progressbar", the arc shrinks as time runs out. */
export function Ring({ value, label, valueText, tone = 'success', size = 32, className }: RingProps) {
  const v = Math.max(0, Math.min(100, value));
  const stroke = 4;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <svg
      className={cn('ms-ring', className)}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v)}
      aria-valuetext={valueText}
    >
      <circle className="ms-ring__track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} />
      <circle
        className={`ms-ring__value ms-ring__value--${tone}`}
        cx={size / 2}
        cy={size / 2}
        r={r}
        strokeWidth={stroke}
        strokeDasharray={c}
        strokeDashoffset={c - (c * v) / 100}
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Dial (vault health)
// ---------------------------------------------------------------------------

export interface DialProps {
  /** 0–100. */
  value: number;
  /** Accessible name, e.g. "Vault health 72 of 100". */
  label: string;
  /** Text under the score (e.g. "/ 100"). */
  legend?: string;
  size?: number;
  className?: string;
}

/**
 * Score dial: a soft 240° arc with the score inside (colour by band: <50
 * danger, <80 attention, else ok). role="meter" with aria-valuenow so the
 * number is the content.
 */
export function Dial({ value, label, legend, size = 200, className }: DialProps) {
  const v = Math.max(0, Math.min(100, Math.round(value)));
  const tone = v >= 80 ? 'ok' : v >= 50 ? 'attention' : 'danger';
  const r = 80;
  const sweep = 240;
  const circumference = 2 * Math.PI * r;
  const arc = (circumference * sweep) / 360;
  return (
    <svg
      className={cn('ms-dial', className)}
      viewBox="0 0 200 176"
      width={size}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={v}
    >
      <circle
        className="ms-dial__track"
        cx="100"
        cy="100"
        r={r}
        strokeWidth="14"
        strokeDasharray={`${arc} ${circumference}`}
        transform="rotate(150 100 100)"
      />
      <circle
        className={`ms-dial__value ms-dial__value--${tone}`}
        cx="100"
        cy="100"
        r={r}
        strokeWidth="14"
        strokeDasharray={`${arc} ${circumference}`}
        strokeDashoffset={arc - (arc * v) / 100}
        transform="rotate(150 100 100)"
      />
      <text className="ms-dial__readout" x="100" y="108" textAnchor="middle" fontSize="44">
        {v}
      </text>
      {legend && (
        <text className="ms-dial__legend" x="100" y="134" textAnchor="middle" fontSize="12">
          {legend}
        </text>
      )}
    </svg>
  );
}
