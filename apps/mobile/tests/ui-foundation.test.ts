import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  APP_PREFERENCES_KEY, createPreferenceWriter, DEFAULT_APP_PREFERENCES, loadAppPreferences, resolveAppearance,
} from '../src/ui/preferences';
import { getButtonState, getPageGutter, mobileDarkRoles, mobileLightRoles, radius, size, space, stampFamilies, textStyle } from '../src/ui/tokens';

test('page gutters and sizes follow the Pocket Ledger layout contract', () => {
  assert.deepEqual([320, 359, 360, 390, 430, 599, 600, 768, 1024].map(getPageGutter), [16, 16, 16, 16, 16, 16, 24, 24, 24]);
  assert.deepEqual([size.formWidth, size.listWidth], [720, 840]);
  assert.deepEqual([size.action, size.touch, size.androidTouch, size.field, size.chip, size.settingsRow, size.itemRow, size.detailRow, size.chooserRow, size.dock],
    [52, 44, 48, 48, 44, 48, 56, 56, 60, 60]);
  assert.deepEqual([size.marginLetter, size.stamp, size.marginLetter + size.stamp + space[3]], [40, 32, 84]);
  assert.deepEqual([radius.chip, radius.button, radius.dock, radius.sheet, radius.keyCell, radius.coverField, radius.search], [22, 26, 30, 20, 12, 12, 24]);
  assert.deepEqual([space[1], space[2], space[3], space[4], space[5], space[6], space[8]], [4, 8, 12, 16, 20, 24, 32]);
});

test('type roles sit on the 4 pt grid, name a Be Vietnam Pro face and stay at 12 pt or larger', () => {
  const sans = ['display', 'title', 'strong', 'value', 'body', 'control', 'caption', 'label', 'micro'] as const;
  assert.deepEqual(sans.map(role => [textStyle[role].fontSize, textStyle[role].lineHeight]),
    [[30, 36], [22, 28], [16, 24], [16, 24], [16, 24], [15, 20], [14, 20], [13, 16], [12, 16]]);
  for (const role of sans) {
    assert.match(textStyle[role].fontFamily, /^BeVietnamPro-(Regular|Medium|SemiBold|Bold)$/);
    assert.equal('fontWeight' in textStyle[role], false, `${role} must not synthesise a weight`);
  }
  assert.deepEqual([textStyle.secret, textStyle.key, textStyle.code].map(role => [role.fontSize, role.lineHeight]), [[16, 24], [18, 24], [24, 32]]);
  for (const role of Object.values(textStyle)) {
    assert.ok(role.fontSize >= 12);
    assert.equal(role.lineHeight % 4, 0);
  }
});

test('buttons retain their baseline while loading and reserve accessible touch dimensions', () => {
  const idle = getButtonState('default', false, true, false, false);
  const loading = getButtonState('default', false, true, false, true);
  assert.deepEqual(idle, { iconOnly: false, compact: false, minHeight: 52, width: undefined, busy: false, inactive: false });
  assert.deepEqual(loading, { ...idle, busy: true, inactive: true });
  assert.equal(getButtonState('default', false, false, true, false).inactive, true);
  assert.equal(getButtonState('default', true, false, false, false).minHeight, 44);
  assert.deepEqual(getButtonState('icon', false, true, false, false), {
    iconOnly: true, compact: true, minHeight: 48, width: 48, busy: false, inactive: false,
  });
});

function luminance(color: string) {
  assert.match(color, /^#[0-9a-f]{6}$/i);
  const weights = [0.2126, 0.7152, 0.0722];
  return [color.slice(1, 3), color.slice(3, 5), color.slice(5, 7)].reduce((total, part, index) => {
    const channel = parseInt(part, 16) / 255;
    const linear = channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    return total + weights[index] * linear;
  }, 0);
}

function contrast(ink: string, background: string) {
  const values = [luminance(ink), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

for (const [name, colors] of Object.entries({ light: mobileLightRoles, dark: mobileDarkRoles })) {
  test(`${name} text, action, input and focus roles meet AA contrast pairs`, () => {
    type Color = keyof typeof colors;
    type Flat = Exclude<Color, 'stamp'>;
    const pairs: ReadonlyArray<readonly [Flat, Flat, number]> = [
      ['text', 'canvas', 4.5], ['text', 'surface', 4.5], ['secondaryText', 'surface', 4.5], ['mutedText', 'canvas', 4.5],
      ['primaryTextLink', 'canvas', 4.5], ['primaryTextLink', 'surface', 4.5], ['mutedText', 'inputSurface', 4.5],
      ['onPrimary', 'primaryFill', 4.5], ['onPrimary', 'primaryPressed', 4.5],
      ['onDanger', 'danger', 4.5], ['onDanger', 'dangerPressed', 4.5], ['mutedText', 'sunken', 4.5], ['text', 'sunken', 4.5],
      ['dangerText', 'surface', 4.5], ['successText', 'surface', 4.5], ['warningText', 'surface', 4.5],
      ['onCover', 'cover', 4.5], ['onCoverSecondary', 'cover', 4.5], ['onCover', 'coverChip', 4.5],
      ['onCoverChipSelected', 'coverChipSelected', 4.5], ['onSelected', 'selected', 4.5], ['plum', 'selection', 4.5],
      ['text', 'dock', 4.5], ['plum', 'dockSelected', 4.5], ['canvas', 'plum', 4.5],
      ['controlBorder', 'inputSurface', 3], ['controlBorder', 'canvas', 3], ['coverFieldEdge', 'surface', 3], ['focus', 'surface', 3],
    ];
    for (const [fg, bg, minimum] of pairs) {
      const ratio = contrast(colors[fg], colors[bg]);
      assert.ok(ratio >= minimum, `${fg} on ${bg} is ${ratio.toFixed(2)}:1 (minimum ${minimum}:1)`);
    }
    for (const family of stampFamilies) {
      const ratio = contrast(colors.stamp[family].ink, colors.stamp[family].bg);
      assert.ok(ratio >= 4.5, `${family} stamp glyph is ${ratio.toFixed(2)}:1`);
    }
  });
}

test('preferences default safely, persist forced theme and off auto-lock, and follow device in System', async () => {
  const records = new Map<string, string>();
  const store = {
    getItem: async (key: string) => records.get(key) ?? null,
    setItem: async (key: string, value: string) => { records.set(key, value); },
  };
  const write = createPreferenceWriter(store);
  assert.deepEqual(await loadAppPreferences(store), DEFAULT_APP_PREFERENCES);
  await write({ appearance: 'dark', autoLock: 0 });
  const coldStart = await loadAppPreferences(store);
  assert.deepEqual(coldStart, { appearance: 'dark', autoLock: 0 });
  assert.equal(resolveAppearance(coldStart.appearance, 'light'), 'dark');
  assert.equal(resolveAppearance('light', 'dark'), 'light');
  await write({ appearance: 'system', autoLock: 15 });
  const system = await loadAppPreferences(store);
  assert.equal(resolveAppearance(system.appearance, 'dark'), 'dark');
  assert.equal(resolveAppearance(system.appearance, 'light'), 'light');
  assert.equal(system.autoLock, 15);
  records.set(APP_PREFERENCES_KEY, '{"appearance":"sepia","autoLock":120}');
  assert.deepEqual(await loadAppPreferences(store), DEFAULT_APP_PREFERENCES);
  records.set(APP_PREFERENCES_KEY, '{broken');
  assert.deepEqual(await loadAppPreferences(store), DEFAULT_APP_PREFERENCES);
});

test('quick preference changes stay ordered even when a write fails', async () => {
  const observed: string[] = [];
  let finishFirst: () => void = () => undefined;
  const firstFinished = new Promise<void>((resolve) => { finishFirst = resolve; });
  const write = createPreferenceWriter({
    getItem: async () => null,
    setItem: async (_key, value) => {
      const appearance = JSON.parse(value).appearance;
      observed.push(appearance);
      if (appearance === 'dark') {
        await firstFinished;
        throw new Error('disk full');
      }
    },
  });
  const first = write({ appearance: 'dark', autoLock: 5 });
  const second = write({ appearance: 'light', autoLock: 1 });
  const third = write({ appearance: 'system', autoLock: 0 });
  await Promise.resolve();
  assert.deepEqual(observed, ['dark']);
  finishFirst();
  await assert.rejects(first, /disk full/);
  await Promise.all([second, third]);
  assert.deepEqual(observed, ['dark', 'light', 'system']);
});
