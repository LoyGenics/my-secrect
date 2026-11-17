/**
 * Writes tests/crypto-vectors/chain-ts.json: one encrypted backup
 * (format_version 2, item encryption v1) from EACH real TypeScript vault
 * writer — desktop, extension, mobile — plus one v2 (AD-bound) item from
 * the adapter's v2 primitives. native/crypto-core/tests/cross_impl.rs
 * opens every layer of it with the Rust crate (KEK -> AMK -> Vault Key ->
 * Item Key -> item JSON, and the recovery-key path).
 *
 * Run from the repo root:  npx tsx packages/crypto-adapters/scripts/gen-chain-vectors.ts
 *
 * Keys and nonces are random: every run changes every value. Never
 * hand-edit the output — if Rust disagrees, an implementation is wrong.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ITEM_ENCRYPTION_V2,
  encryptItemPayloadV2,
  fromBase64,
  libsodiumAdapter,
  sodiumReady,
  toBase64,
  wrapItemKeyV2,
} from '../src/index.ts';
import { loadAppVaults } from '../tests/support/app-vaults.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const outFile = path.join(repoRoot, 'tests/crypto-vectors/chain-ts.json');

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

function item(id: string, title: string, password: string) {
  return {
    id,
    type: 'login' as const,
    schema_version: 1,
    title,
    fields: { username: 'ada', password, url: 'https://example.test' },
    tags: ['cross-impl'],
    relations: [],
    attachments: [],
    favorite: false,
    created_at: '2026-11-17T00:00:00.000Z',
    updated_at: '2026-11-17T00:00:00.000Z',
  };
}

// Passphrases differ in Unicode shape on purpose. The desktop one is NFD
// (decomposed): if either side ever normalises passphrases and the other
// does not, Rust derives a different KEK and the fixture stops opening.
const PASSPHRASES = {
  desktop: 'Mật khẩu desktop TS→Rust'.normalize('NFD'),
  extension: 'extension ascii passphrase 2026',
  mobile: 'Mobile 📱 mật khẩu NFC'.normalize('NFC'),
} as const;

async function main() {
  await sodiumReady;
  const vaults = await loadAppVaults();
  const apps: Record<string, unknown> = {};

  // Each app's own create / upsert / export code; only storage is shimmed.
  const runs = [
    {
      name: 'desktop',
      create: (p: string) => vaults.desktop.createVault(p),
      upsert: (i: ReturnType<typeof item>) => vaults.desktop.upsertItem(i),
      list: () => vaults.desktop.listItems(true),
      exportEncrypted: async () => vaults.desktop.exportEncrypted(),
      lockAndWipe: async () => { vaults.desktop.lockVault(); vaults.desktop.wipeVault(); },
    },
    {
      name: 'extension',
      create: (p: string) => vaults.extension.createVault(p),
      upsert: (i: ReturnType<typeof item>) => vaults.extension.upsertItem(i),
      list: () => vaults.extension.listUnlockedItems(),
      exportEncrypted: () => vaults.extension.exportEncrypted(),
      lockAndWipe: async () => { vaults.extension.lockVault(); await vaults.extension.wipeVault(); },
    },
    {
      name: 'mobile',
      create: (p: string) => vaults.mobile.createVault(p),
      upsert: (i: ReturnType<typeof item>) => vaults.mobile.upsertItem(i),
      list: () => vaults.mobile.listItems(true),
      exportEncrypted: () => vaults.mobile.exportEncrypted(),
      lockAndWipe: async () => { vaults.mobile.lockVault(); await vaults.mobile.wipeVault(); },
    },
  ] as const;

  for (const run of runs) {
    const passphrase = PASSPHRASES[run.name];
    const { recoveryKey } = await run.create(passphrase);
    await run.upsert(item(`item_${run.name}_01`, `${run.name} login`, `${run.name}-secret-1`));
    await run.upsert(item(`item_${run.name}_02`, `${run.name} — mục thứ hai ✓`, `${run.name}-secret-2 ✓`));
    const exported = JSON.parse(await run.exportEncrypted());
    // KEK via the adapter (not app code) so Rust can compare it byte-for-byte.
    const kek = await libsodiumAdapter.deriveKek(passphrase, fromBase64(exported.keys.salt));
    apps[run.name] = {
      passphrase,
      recovery_key: recoveryKey,
      kek_hex: hex(kek),
      export: exported,
      // The decrypted items as the app holds them = exactly what it encrypted.
      expected_items: run.list(),
    };
    kek.fill(0);
    await run.lockAndWipe();
  }

  // v2 primitives: no app writes v2, so this comes straight from the adapter.
  const vaultKey = libsodiumAdapter.randomBytes(32);
  const itemKey = libsodiumAdapter.randomBytes(32);
  const binding = { vaultId: 'vault_ts_v2', itemId: 'item_ts_v2', revision: 3 };
  const v2Item = item(binding.itemId, 'TS-written v2 item', 'ts-v2-secret');
  const payload = await encryptItemPayloadV2(itemKey, new TextEncoder().encode(JSON.stringify(v2Item)), binding);
  const wrapped = await wrapItemKeyV2(vaultKey, itemKey, binding);
  const join = (a: Uint8Array, b: Uint8Array) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };

  const fixture = {
    _comment: 'Cross-implementation fixture written by the REAL TypeScript vault code: apps/desktop/src/vault.ts, apps/extension/src/lib/vault-ext.ts and apps/mobile/src/vault.ts (createVault + upsertItem + exportEncrypted, storage shimmed in memory), over packages/crypto-adapters (libsodium-wrappers-sumo). Opened layer by layer by native/crypto-core/tests/cross_impl.rs and re-checked by packages/crypto-adapters/tests/cross-impl.test.ts. `v2` comes from the adapter v2 primitives.',
    _generated: 'npx tsx packages/crypto-adapters/scripts/gen-chain-vectors.ts (repo root). Random keys and nonces: regenerating changes every value. NEVER hand-edit; if a reader disagrees, an implementation is wrong.',
    generator: 'packages/crypto-adapters + apps/{desktop,extension,mobile} vault modules',
    apps,
    v2: {
      binding: { vault_id: binding.vaultId, item_id: binding.itemId, revision: binding.revision },
      vault_key_hex: hex(vaultKey),
      item_key_hex: hex(itemKey),
      encrypted_payload: toBase64(join(payload.nonce, payload.ciphertext)),
      encrypted_item_key: toBase64(join(wrapped.nonce, wrapped.wrapped)),
      encryption_version: ITEM_ENCRYPTION_V2,
      plaintext: v2Item,
    },
  };
  writeFileSync(outFile, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`wrote ${outFile}`);
}

await main();
