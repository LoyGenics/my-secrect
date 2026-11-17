import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';
import { cn } from '../utils';
import { itemTypeColorVar } from '../tokens-css';
import { MODULE_VIEWBOX, isItemTypeKey, moduleIcon, moduleSilhouette } from '../modules';
import { typeArt } from '../illustrations';
import { Icon } from './Icon';

// ---------------------------------------------------------------------------
// LED, LED strip, readout, badge, kbd
// ---------------------------------------------------------------------------

export type LedTone = 'off' | 'ok' | 'attention' | 'danger' | 'active';

/** Status LED dot. Colour is signal only: always pair it with text (the LED is aria-hidden). */
export function Led({ tone = 'off', className }: { tone?: LedTone; className?: string }) {
  return <span className={cn('ms-led', tone !== 'off' && `ms-led--${tone}`, className)} aria-hidden="true" />;
}

export type LedStripState = 'off' | 'locked' | 'working' | 'error' | 'turn' | 'open';

/**
 * Four-segment LED strip on the device face. locked = amber, working =
 * amber pulse (KDF running), error = red, turn = the unlock sweep (amber →
 * orange → green, staggered), open = green. Decorative: the state is also
 * stated in text next to it.
 */
export function LedStrip({ state, className }: { state: LedStripState; className?: string }) {
  return (
    <span className={cn('ms-led-strip', className)} data-state={state} aria-hidden="true">
      <span className="ms-led-strip__seg" />
      <span className="ms-led-strip__seg" />
      <span className="ms-led-strip__seg" />
      <span className="ms-led-strip__seg" />
    </span>
  );
}

/** LCD-style tabular readout (counts, scores). Pass `label` when the number has no visible context. */
export function Readout({ value, label, size = 'md', className }: { value: ReactNode; label?: string; size?: 'md' | 'lg'; className?: string }) {
  return (
    <span className={cn('ms-readout', size === 'lg' && 'ms-readout--lg', className)} aria-label={label} role={label ? 'img' : undefined}>
      {value}
    </span>
  );
}

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  /** `legend` prints it as an uppercase tracked legend (type names, states). */
  legend?: boolean;
}

/** Small hairline chip for tags and type legends. Not interactive — use a Button for actions. */
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
 * The item type's module: its own silhouette filled with its muted code
 * colour, the Lucide glyph printed on top. Identical in rail, list, detail
 * and mobile (same path data, same colour tokens).
 */
export function TypeModule({ type, size = 'md', label, className }: TypeModuleProps) {
  const key = isItemTypeKey(type) ? type : 'custom';
  const style = { '--module-fill': `var(${itemTypeColorVar(key)})` } as CSSProperties;
  return (
    <span
      className={cn('ms-module', size !== 'md' && `ms-module--${size}`, className)}
      style={style}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <svg className="ms-module__shape" viewBox={MODULE_VIEWBOX} aria-hidden="true" focusable="false">
        <path d={moduleSilhouette[key]} fill="var(--module-fill)" />
      </svg>
      <Icon name={moduleIcon[key]} size={size === 'lg' ? 'lg' : size === 'sm' ? 'xs' : 'sm'} />
    </span>
  );
}

/**
 * Item-type art slot (detail header, rail): the type's rendered object from
 * `typeArt` when one exists, otherwise the vector module. Decorative unless
 * `label` is given.
 */
export function ItemTypeArt({ type, size = 'lg', label, className }: TypeModuleProps) {
  const key = isItemTypeKey(type) ? type : 'custom';
  const src = typeArt[key];
  if (!src) return <TypeModule type={key} size={size} label={label} className={className} />;
  const px = size === 'lg' ? 48 : size === 'sm' ? 24 : 32;
  return (
    <img
      className={cn('ms-module', size !== 'md' && `ms-module--${size}`, className)}
      src={src}
      width={px}
      height={px}
      alt={label ?? ''}
      loading="lazy"
      decoding="async"
    />
  );
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

/** Inline notice plate: LED + text. Colour is the LED and the title ink only — no tinted slabs, no side stripes. */
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
// Dial (Watchtower)
// ---------------------------------------------------------------------------

export interface DialProps {
  /** 0–100. */
  value: number;
  /** Accessible name, e.g. "Vault health 72 of 100". */
  label: string;
  /** Legend printed under the readout (e.g. "/ 100"). */
  legend?: string;
  size?: number;
  className?: string;
}

/**
 * One instrument dial: a 240° scale with ticks, the score as the needle arc
 * (LED colour by band: <50 danger, <80 attention, else ok) and an LCD
 * readout. role="meter" with aria-valuenow so the number is the content.
 */
export function Dial({ value, label, legend, size = 200, className }: DialProps) {
  const v = Math.max(0, Math.min(100, Math.round(value)));
  const tone = v >= 80 ? 'ok' : v >= 50 ? 'attention' : 'danger';
  const r = 80;
  const sweep = 240;
  const circumference = 2 * Math.PI * r;
  const arc = (circumference * sweep) / 360;
  const ticks = Array.from({ length: 11 }, (_, i) => {
    const angle = ((150 + (sweep * i) / 10) * Math.PI) / 180;
    return { x1: 100 + Math.cos(angle) * 92, y1: 100 + Math.sin(angle) * 92, x2: 100 + Math.cos(angle) * 98, y2: 100 + Math.sin(angle) * 98 };
  });
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
      {ticks.map((t, i) => (
        <line key={i} className="ms-dial__tick" x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} />
      ))}
      <circle
        className="ms-dial__track"
        cx="100"
        cy="100"
        r={r}
        strokeWidth="12"
        strokeDasharray={`${arc} ${circumference}`}
        transform="rotate(150 100 100)"
      />
      <circle
        className={`ms-dial__value ms-dial__value--${tone}`}
        cx="100"
        cy="100"
        r={r}
        strokeWidth="12"
        strokeDasharray={`${arc} ${circumference}`}
        strokeDashoffset={arc - (arc * v) / 100}
        transform="rotate(150 100 100)"
      />
      <text className="ms-dial__readout" x="100" y="108" textAnchor="middle" fontSize="44">
        {v}
      </text>
      {legend && (
        <text className="ms-dial__legend" x="100" y="134" textAnchor="middle" fontSize="11">
          {legend}
        </text>
      )}
    </svg>
  );
}
