/**
 * WCAG 2.2 AA contrast for every Pocket Ledger foreground/background pair in
 * both themes: text >= 4.5:1 (1.4.3), control and field edges and the focus
 * ring >= 3:1 (1.4.11). A failure means the token is wrong, not the test.
 *
 * Run: npx tsx --test packages/ui/tests/contrast.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { darkTheme, itemTypes, lightTheme, stampFamilies, type ThemeTokens } from '../src/tokens';

function luminance(color: string): number {
  assert.match(color, /^#[0-9a-f]{6}$/i, `${color} is not an opaque #rrggbb colour`);
  const weights = [0.2126, 0.7152, 0.0722];
  return [1, 3, 5].reduce((total, start, index) => {
    const channel = parseInt(color.slice(start, start + 2), 16) / 255;
    const linear = channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    return total + weights[index] * linear;
  }, 0);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

type Pair = readonly [label: string, fg: string, bg: string, minimum: number];

function pairs(t: ThemeTokens): Pair[] {
  const text: Pair[] = [];
  const add = (label: string, fg: string, bg: string, minimum = 4.5) => text.push([label, fg, bg, minimum]);
  const paper = { base: t.background.base, surface: t.background.surface };

  for (const [name, bg] of Object.entries(paper)) {
    add(`text.primary on ${name}`, t.text.primary, bg);
    add(`text.secondary on ${name}`, t.text.secondary, bg);
    add(`text.muted on ${name}`, t.text.muted, bg);
    add(`plum on ${name}`, t.plum, bg);
    add(`text.link on ${name}`, t.text.link, bg);
    add(`danger.softText on ${name}`, t.danger.softText, bg);
    add(`success.text on ${name}`, t.success.text, bg);
    add(`warning.text on ${name}`, t.warning.text, bg);
    add(`border.control on ${name}`, t.border.control, bg, 3);
    add(`focus.ring on ${name}`, t.focus.ring, bg, 3);
  }
  add('text.muted on sunken', t.text.muted, t.background.sunken);
  add('text.muted on input', t.text.muted, t.background.input);
  add('border.control on input', t.border.control, t.background.input, 3);

  add('cover.ink on cover.bg', t.cover.ink, t.cover.bg);
  add('cover.inkSecondary on cover.bg', t.cover.inkSecondary, t.cover.bg);
  add('cover.ink on cover.chip', t.cover.ink, t.cover.chip);
  add('cover.onChipSelected on cover.chipSelected', t.cover.onChipSelected, t.cover.chipSelected);
  add('plum on cover.bg', t.plum, t.cover.bg);
  add('cover.fieldEdge on cover.bg', t.cover.fieldEdge, t.cover.bg, 3);
  add('focus.ring on cover.bg', t.focus.ring, t.cover.bg, 3);

  add('onSelected on selected', t.onSelected, t.selected);
  add('plum on dock.selected', t.plum, t.dock.selected);
  add('text.secondary on dock.bg', t.text.secondary, t.dock.bg);

  add('accent.ink on accent', t.accent.ink, t.accent.DEFAULT);
  add('text.onBrand on brand', t.text.onBrand, t.brand.DEFAULT);
  add('text.onBrand on brand.hover', t.text.onBrand, t.brand.hover);
  add('text.onBrand on brand.active', t.text.onBrand, t.brand.active);
  add('text.onDanger on danger', t.text.onDanger, t.danger.DEFAULT);
  add('text.onDanger on danger.hover', t.text.onDanger, t.danger.hover);

  for (const family of stampFamilies) add(`stamp.${family} ink on bg`, t.stamp[family].ink, t.stamp[family].bg);
  for (const type of itemTypes) add(`text.onModule on itemType.${type}`, t.text.onModule, t.itemType[type]);
  return text;
}

for (const theme of [lightTheme, darkTheme]) {
  test(`${theme.colorScheme}: every Pocket Ledger pair meets WCAG AA`, () => {
    const failures = pairs(theme)
      .map(([label, fg, bg, minimum]) => ({ label, minimum, ratio: contrast(fg, bg) }))
      .filter(({ ratio, minimum }) => ratio < minimum)
      .map(({ label, ratio, minimum }) => `${label}: ${ratio.toFixed(2)}:1 < ${minimum}:1`);
    assert.deepEqual(failures, []);
  });
}

test('the orange primary action carries dark ink, never white', () => {
  for (const theme of [lightTheme, darkTheme]) {
    assert.equal(theme.accent.ink, '#2a1205');
    assert.equal(theme.text.onBrand, theme.accent.ink);
    assert.equal(theme.brand.DEFAULT, theme.accent.DEFAULT);
  }
  assert.deepEqual([lightTheme.accent.DEFAULT, darkTheme.accent.DEFAULT], ['#ff7a3d', '#ff8a52']);
});
