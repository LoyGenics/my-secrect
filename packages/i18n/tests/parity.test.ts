/**
 * English and Vietnamese must ship the same key set. TypeScript already
 * forces vi.ts to match en.ts's shape; this test also catches what the
 * type system cannot: empty strings, untranslated copies of long English
 * sentences, placeholder ({0}) mismatches and malformed plural entries.
 *
 * Run: npx tsx --test packages/i18n/tests/parity.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { en, vi, plural, format, detectLocale, normalizeLocale } from '../src/index';

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(path, value);
    else for (const [k, v] of flatten(value, path)) out.set(k, v);
  }
  return out;
}

const enFlat = flatten(en as unknown as Tree);
const viFlat = flatten(vi as unknown as Tree);

const placeholders = (s: string) => [...s.matchAll(/\{(\d+)\}/g)].map((m) => m[1]).sort().join(',');

test('en and vi have identical key sets', () => {
  const missingInVi = [...enFlat.keys()].filter((k) => !viFlat.has(k));
  const extraInVi = [...viFlat.keys()].filter((k) => !enFlat.has(k));
  assert.deepEqual(missingInVi, [], `keys missing in vi: ${missingInVi.join(', ')}`);
  assert.deepEqual(extraInVi, [], `keys only in vi: ${extraInVi.join(', ')}`);
});

test('no empty or whitespace-padded strings', () => {
  for (const [lang, flat] of [['en', enFlat], ['vi', viFlat]] as const) {
    for (const [key, value] of flat) {
      assert.ok(value.trim().length > 0, `${lang}.${key} is empty`);
      assert.equal(value, value.trim(), `${lang}.${key} has leading/trailing whitespace`);
    }
  }
});

test('placeholders match between en and vi', () => {
  for (const [key, value] of enFlat) {
    assert.equal(placeholders(viFlat.get(key) ?? ''), placeholders(value), `placeholder mismatch at ${key}`);
  }
});

test('plural entries are exactly { one, other }', () => {
  const pluralParents = new Set([...enFlat.keys()].filter((k) => /\.(one|other)$/.test(k)).map((k) => k.replace(/\.(one|other)$/, '')));
  for (const parent of pluralParents) {
    for (const flat of [enFlat, viFlat]) {
      assert.ok(flat.has(`${parent}.one`) && flat.has(`${parent}.other`), `${parent} needs one + other`);
    }
  }
});

test('Vietnamese is translated (sentences are not English copies)', () => {
  // Identical values are fine for proper nouns, codes and short technical terms
  // (My Secret, URL, SHA-256, Passkey, Watchtower, VND…). Anything with 4+ words must differ.
  const copies = [...enFlat].filter(([key, value]) => value.split(/\s+/).length >= 4 && viFlat.get(key) === value).map(([k]) => k);
  assert.deepEqual(copies, [], `untranslated vi strings: ${copies.join(', ')}`);
});

test('plural() picks English one/other and Vietnamese other', () => {
  assert.equal(plural('en', en.health.itemsChecked, 1), '1 item checked');
  assert.equal(plural('en', en.health.itemsChecked, 3), '3 items checked');
  assert.equal(plural('vi', vi.health.itemsChecked, 1), 'Đã kiểm tra 1 mục');
  assert.equal(format(en.itemDetail.copied, 30), 'Copied · clears in 30s');
});

test('detectLocale never throws and normalizes tags', () => {
  assert.ok(['en', 'vi'].includes(detectLocale()));
  assert.equal(normalizeLocale('vi-VN'), 'vi');
  assert.equal(normalizeLocale('fr-FR'), 'en');
});

test('English is the default even on a Vietnamese device; an explicit choice still wins', () => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'vi-VN' } });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null } });
    assert.equal(detectLocale(), 'en');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => 'vi' } });
    assert.equal(detectLocale(), 'vi');
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    else Reflect.deleteProperty(globalThis, 'navigator');
    if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
