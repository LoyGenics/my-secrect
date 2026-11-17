/**
 * Renders tokens.css from tokens.ts. tokens.ts is the ONE place to change a
 * palette, shadow, type scale, radius or motion value; then run
 *   npm --workspace @my-secrect/ui run tokens
 * to rewrite src/tokens.css. tests/tokens-sync.test.ts fails when the
 * committed CSS is stale. Pure function, no DOM — safe to import anywhere.
 */
import {
  darkTheme,
  density,
  fontFamily,
  legendTracking,
  lightTheme,
  motion,
  radii,
  spacing,
  textScale,
  type ThemeTokens,
} from './tokens';

const GROUP_PREFIX: Record<string, string> = { background: 'bg', itemType: 'type' };

const kebab = (key: string) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`).replace(/_/g, '-');

/** CSS variable holding an item type's code colour, e.g. `--ms-color-type-bank-account`. */
export function itemTypeColorVar(type: string): string {
  return `--ms-color-type-${kebab(type)}`;
}

/** Lowercase hex, `rgba(1, 2, 3, 0.2)` spacing, no trailing decimal zeros. */
export function normalizeColor(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s*,\s*/g, ', ')
    .replace(/(\d)\.(\d*?)0+\)/g, (_m, a: string, b: string) => (b ? `${a}.${b})` : `${a})`));
}

/** `--ms-color-*` and `--ms-shadow-*` declarations for one theme, in a stable order. */
export function themeVariables(theme: ThemeTokens): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [group, values] of Object.entries(theme)) {
    if (group === 'colorScheme') continue;
    for (const [key, value] of Object.entries(values as Record<string, string>)) {
      if (group === 'focus' && (key === 'width' || key === 'offset')) continue; // scale vars
      if (group === 'shadow') {
        out.push([`--ms-shadow-${kebab(key)}`, normalizeColor(value)]);
        continue;
      }
      const prefix = GROUP_PREFIX[group] ?? group;
      const name = key === 'DEFAULT' ? `--ms-color-${prefix}` : `--ms-color-${prefix}-${kebab(key)}`;
      out.push([name, normalizeColor(value)]);
    }
  }
  return out;
}

function block(selector: string, theme: ThemeTokens, indent = ''): string {
  const lines = [
    `${indent}${selector} {`,
    `${indent}  color-scheme: ${theme.colorScheme};`,
    `${indent}  --ms-color-scheme: ${theme.colorScheme};`,
    ...themeVariables(theme).map(([name, value]) => `${indent}  ${name}: ${value};`),
    `${indent}}`,
  ];
  return lines.join('\n');
}

function scaleBlock(): string {
  const lines: string[] = [
    `  --ms-font-sans: ${fontFamily.sans};`,
    `  --ms-font-legend: ${fontFamily.legend};`,
    `  --ms-font-mono: ${fontFamily.mono};`,
    `  --ms-legend-tracking: ${legendTracking};`,
  ];
  for (const [step, [size, leading]] of Object.entries(textScale)) {
    lines.push(`  --ms-text-${step}: ${size}px;`, `  --ms-leading-${step}: ${leading}px;`);
  }
  for (const [key, value] of Object.entries(radii)) lines.push(`  --ms-radius-${key}: ${value}px;`);
  for (const [key, value] of Object.entries(spacing)) {
    if (Number(key) > 0) lines.push(`  --ms-space-${key}: ${value}px;`);
  }
  for (const [key, value] of Object.entries(motion.duration)) lines.push(`  --ms-duration-${key}: ${value}ms;`);
  for (const [key, value] of Object.entries(motion.easing)) lines.push(`  --ms-easing-${key}: ${value};`);
  lines.push(
    `  --ms-control-height: ${density.comfortable.controlHeight}px;`,
    `  --ms-control-height-sm: ${density.compact.controlHeight}px;`,
    `  --ms-control-padding-x: ${density.comfortable.controlPaddingX}px;`,
    `  --ms-control-height-touch: ${density.comfortable.controlHeightTouch}px;`,
    `  --ms-focus-width: ${darkTheme.focus.width};`,
    `  --ms-focus-offset: ${darkTheme.focus.offset};`,
  );
  return [':root {', ...lines, '}'].join('\n');
}

export function renderTokensCss(): string {
  return `/*
 * GENERATED from tokens.ts by src/tokens-css.ts — do not edit by hand.
 * Change tokens.ts, then: npm --workspace @my-secrect/ui run tokens
 *
 * Theme selection (see src/theme.ts):
 * - No attribute, or data-theme="dark"   -> dark (default).
 * - data-theme="light"                    -> light.
 * - data-theme="system" + prefers-color-scheme: light -> light.
 */

${block(":root,\n[data-theme='dark']", darkTheme)}

${block("[data-theme='light']", lightTheme)}

/* System mode: plain CSS cannot share a block between a selector and a
 * media query, so the light values are emitted twice. */
@media (prefers-color-scheme: light) {
${block("[data-theme='system']", lightTheme, '  ')}
}

/* Theme-independent scales. */
${scaleBlock()}

/* Global focus mark: orange 2px ring at 2px offset, with an ink band inside
 * it on the light finish (orange alone is 2.44:1 on aluminium). WCAG 2.4.7 /
 * 1.4.11. components.css refines it per component; this is the safety net. */
:focus-visible {
  outline: var(--ms-focus-width) solid var(--ms-color-focus-ring);
  outline-offset: var(--ms-focus-offset);
  box-shadow: 0 0 0 var(--ms-focus-offset) var(--ms-color-focus-outline);
}

/* Browser surfaces carry the palette too. */
::selection {
  background: var(--ms-color-brand-soft);
  color: var(--ms-color-text-primary);
}

/* Reduced motion: components define their own alternative (opacity
 * crossfade instead of movement, no decorative loops) in components.css;
 * this only stops smooth scrolling. */
@media (prefers-reduced-motion: reduce) {
  html {
    scroll-behavior: auto;
  }
}
`;
}
