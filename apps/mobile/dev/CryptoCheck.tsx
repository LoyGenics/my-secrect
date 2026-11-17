/**
 * DEV-ONLY crypto check, never in a release bundle: index.js mounts it only
 * when `__DEV__` and EXPO_PUBLIC_CRYPTO_CHECK=1 (release builds fold the
 * branch away). It runs the shared known-answer vectors in
 * tests/crypto-vectors/*.json (whichever exist in this checkout) through
 * the same libsodium the app uses on this device ('libsodium-wrappers-sumo'
 * -> native shim via metro.config.js), plus main's self-test rule.
 * "Restore desktop backup" wipes this device's vault and restores
 * dev/fixtures/desktop-backup.json (local only, made by
 * apps/desktop/src/vault.ts exportEncrypted()).
 *
 *   EXPO_PUBLIC_CRYPTO_CHECK=1 npx expo start --port 8091
 */
import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text } from 'react-native';
import { Buffer } from 'buffer';
import libsodium from 'libsodium-wrappers-sumo';
import type { SodiumShim } from '../src/crypto/libsodium-shim';
import { libsodiumAdapter } from '../../../packages/crypto-adapters/src/index';
import { listItems, lockVault, restoreEncrypted, unlockVault, unlockWithRecoveryKey, wipeVault } from '../src/vault';

type Line = { ok: boolean | null; text: string };
// Imported by its package name so Metro's alias is what gets tested; typed as the shim.
const sodium = libsodium as unknown as SodiumShim;
const hex = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));
const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const utf8 = (s: string) => Uint8Array.from(Buffer.from(s, 'utf8'));

// @ts-expect-error require.context is Metro-only
const vectorFiles = require.context('../../../tests/crypto-vectors', false, /\.json$/);
// @ts-expect-error require.context is Metro-only
const fixtureFiles = require.context('./fixtures', false, /\.json$/);
function vectorFile<T>(name: string): T | null {
  return (vectorFiles.keys() as string[]).includes(`./${name}`) ? (vectorFiles(`./${name}`) as T) : null;
}

async function runVectors(add: (l: Line) => void): Promise<void> {
  const t0 = Date.now();
  try { await sodium.ready; add({ ok: true, text: 'native libsodium installed' }); }
  catch (e) { add({ ok: false, text: `sodium.ready: ${String(e)}` }); return; }

  // Same rule as packages/crypto-adapters libsodiumSelfTest on main (84e71c2).
  const kat = sodium.to_hex(sodium.crypto_generichash(32, sodium.from_string('my-secrect/self-test/v1')));
  add({ ok: kat === '27f3f413ffd07bde022640dcc0a79e9781fb296df32c7f068ea5b6ad4fcfdd89', text: 'self-test BLAKE2b KAT' });
  const seen = new Set<string>([kat]); let distinct = true;
  for (let i = 0; i < 4; i++) {
    const r = sodium.randombytes_buf(32); const h = sodium.to_hex(r);
    if (r.every((b: number) => b === 0) || seen.has(h)) distinct = false;
    seen.add(h);
  }
  add({ ok: distinct, text: 'self-test: 4 random draws non-zero and distinct' });

  add({ ok: toHex(sodium.crypto_hash_sha256(utf8('abc'))) === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', text: 'SHA-256 "abc" (FIPS 180-2)' });
  add({ ok: toHex(sodium.crypto_auth_hmacsha256(utf8('what do ya want for nothing?'), utf8('Jefe'))) === '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843', text: 'HMAC-SHA256 RFC 4231 #2' });
  const kp = sodium.crypto_sign_seed_keypair(hex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'));
  add({ ok: toHex(kp.publicKey) === 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'
    && toHex(sodium.crypto_sign_detached(new Uint8Array(0), kp.privateKey)) === 'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
  text: 'Ed25519 RFC 8032 test 1' });

  const v1 = vectorFile<{ argon2id: { opslimit: number; memlimit: number; vectors: Array<{ id: string; passphrase: string; salt_hex: string; kek_hex: string }> }; xchacha20poly1305_ietf: { vectors: Array<{ id: string; key_hex: string; nonce_hex: string; plaintext: string; ciphertext_hex: string }> } }>('argon2id-vectors.json');
  if (!v1) add({ ok: false, text: 'argon2id-vectors.json missing' });
  else {
    add({ ok: v1.argon2id.opslimit === sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE && v1.argon2id.memlimit === sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE, text: `Argon2id params ops=${sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE} mem=${sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE}` });
    for (const v of v1.argon2id.vectors) {
      const t = Date.now();
      const kek = toHex(await libsodiumAdapter.deriveKek(v.passphrase, hex(v.salt_hex)));
      add({ ok: kek === v.kek_hex, text: `argon2id ${v.id} (${Date.now() - t} ms)` });
    }
    for (const v of v1.xchacha20poly1305_ietf.vectors) {
      const ct = toHex(sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(utf8(v.plaintext), null, null, hex(v.nonce_hex), hex(v.key_hex)));
      const blob = hex(v.nonce_hex + v.ciphertext_hex);
      const pt = Buffer.from(await libsodiumAdapter.decrypt(hex(v.key_hex), blob.subarray(0, 24), blob.subarray(24))).toString('utf8');
      add({ ok: ct === v.ciphertext_hex && pt === v.plaintext, text: `xchacha ${v.id}` });
    }
  }

  const hk = vectorFile<{ ikm_hex: string; vectors: Array<{ id: string; info: string; length: number; okm_hex: string }> }>('hkdf-vectors.json');
  if (!hk) add({ ok: null, text: 'hkdf-vectors.json not in this checkout' });
  else for (const v of hk.vectors) {
    add({ ok: toHex(await libsodiumAdapter.hkdf(hex(hk.ikm_hex), v.info, v.length)) === v.okm_hex, text: `hkdf ${v.id}` });
  }

  const v2 = vectorFile<{ item_key_hex: string; vault_key_hex: string; vectors: Array<Record<string, string>> }>('item-v2-vectors.json');
  if (!v2) add({ ok: null, text: 'item-v2-vectors.json not in this checkout' });
  else for (const v of v2.vectors) {
    try {
      const itemKey = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, hex(v.wrapped_item_key_hex), hex(v.key_wrap_ad_hex), hex(v.key_wrap_nonce_hex), hex(v2.vault_key_hex));
      const pt = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, hex(v.payload_ciphertext_hex), hex(v.payload_ad_hex), hex(v.payload_nonce_hex), itemKey);
      const ct = toHex(sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(utf8(v.plaintext), hex(v.payload_ad_hex), null, hex(v.payload_nonce_hex), hex(v2.item_key_hex)));
      add({ ok: toHex(itemKey) === v2.item_key_hex && Buffer.from(pt).toString('utf8') === v.plaintext && ct === v.payload_ciphertext_hex, text: `item-v2 ${v.id}` });
    } catch (e) {
      const closed = /bytes >= 0x80/.test(String(e));
      add({ ok: closed ? null : false, text: `item-v2 ${v.id}: ${closed ? 'UNSUPPORTED by the native binding (AD bytes >= 0x80), failed closed' : String(e)}` });
    }
  }
  add({ ok: null, text: `vectors done in ${Date.now() - t0} ms` });
}

async function restoreDesktopBackup(add: (l: Line) => void): Promise<void> {
  if (!(fixtureFiles.keys() as string[]).includes('./desktop-backup.json')) { add({ ok: null, text: 'no dev/fixtures/desktop-backup.json' }); return; }
  const backup = JSON.stringify(fixtureFiles('./desktop-backup.json'));
  const meta = fixtureFiles('./desktop-backup.meta.json') as { passphrase: string; recoveryKey: string; items: string[] };
  const has = () => meta.items.every((t) => listItems().some((i) => i.title === t));
  await wipeVault();
  await restoreEncrypted(backup, { passphrase: meta.passphrase });
  add({ ok: has(), text: `desktop backup restored with passphrase: ${listItems().map((i) => i.title).join(', ')}` });
  lockVault();
  add({ ok: (await unlockWithRecoveryKey(meta.recoveryKey)) && has(), text: 'locked, then unlocked with the desktop recovery key' });
  lockVault();
  add({ ok: (await unlockVault(meta.passphrase)) && has(), text: 'locked, then unlocked with the desktop passphrase' });
  lockVault();
}

export default function CryptoCheck() {
  const [lines, setLines] = useState<Line[]>([]);
  const [summary, setSummary] = useState('running…');
  const add = (l: Line) => { console.log(`[CRYPTO-CHECK] ${l.ok === null ? 'INFO' : l.ok ? 'PASS' : 'FAIL'} ${l.text}`); setLines((p) => [...p, l]); };
  const run = (name: string, fn: (a: (l: Line) => void) => Promise<void>) => {
    setSummary('running…');
    const local: Line[] = [];
    fn((l) => { local.push(l); add(l); })
      .catch((e) => { local.push({ ok: false, text: String(e) }); add({ ok: false, text: String(e) }); })
      .finally(() => {
        const fail = local.filter((l) => l.ok === false).length; const pass = local.filter((l) => l.ok === true).length;
        const s = `${name}: ${fail === 0 ? 'ALL PASS' : 'FAILURES'} pass=${pass} fail=${fail}`;
        console.log(`[CRYPTO-CHECK] ${s}`); setSummary(s);
      });
  };
  useEffect(() => { run('vectors', runVectors); }, []);
  return (
    <ScrollView style={{ backgroundColor: '#000' }} contentContainerStyle={{ padding: 16, paddingTop: 64 }}>
      <Text testID="check-summary" style={{ color: '#fff', fontSize: 16, fontWeight: '700', marginBottom: 8 }}>{summary}</Text>
      <Pressable testID="check-restore" onPress={() => run('restore', restoreDesktopBackup)} style={{ backgroundColor: '#334', padding: 12, marginBottom: 12 }}>
        <Text style={{ color: '#fff' }}>Restore desktop backup (wipes this device's vault)</Text>
      </Pressable>
      {lines.map((l, i) => (
        <Text key={i} style={{ color: l.ok === false ? '#f55' : l.ok ? '#5f5' : '#aaa', fontSize: 12, marginBottom: 2 }}>
          {l.ok === null ? 'INFO' : l.ok ? 'PASS' : 'FAIL'} {l.text}
        </Text>
      ))}
    </ScrollView>
  );
}
