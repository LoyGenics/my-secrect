/**
 * @my-secrect/sdk — device key storage for web + desktop (WebView).
 * specs/device-identity.md §8.1.
 *
 * One Ed25519 device key per (API base URL, account email), kept in
 * IndexedDB (database 'my-secrect-device-keys', store 'devices'):
 *
 *  - Preferred: WebCrypto Ed25519 generated NON-EXTRACTABLE
 *    (generateKey(..., false, ['sign', 'verify'])). The CryptoKeyPair is
 *    stored as-is (structured clone keeps the private key
 *    non-extractable): script on this origin can ask it to sign, but can
 *    never read the private bytes.
 *  - Fallback when the runtime has no WebCrypto Ed25519: libsodium
 *    crypto_sign_keypair, with the 64-byte secret key stored as raw bytes
 *    in the same store. WEAKER: any script on the origin can read it.
 *    The record says which backend it uses (`storage`).
 *
 * The key is deliberately NOT wrapped by the vault key: sign-in (where
 * the session is bound) happens before the vault is unlocked, and the
 * device key grants no vault access. It never leaves this origin; only
 * the public key and signatures are sent to the server.
 *
 * Nothing here logs keys, signatures or challenges.
 */
import sodium from 'libsodium-wrappers-sumo';
import {
  deviceMessage,
  enrollPayload,
  sessionBindPayload,
  toBase64UrlNoPad,
  type SignInDeviceProof,
} from './device-identity';

const DB_NAME = 'my-secrect-device-keys';
const STORE = 'devices';

export type DeviceKeyStorage = 'webcrypto' | 'libsodium';

interface StoredDeviceKey {
  scope: string;
  alg: 'ed25519';
  storage: DeviceKeyStorage;
  publicKey: Uint8Array;
  /** WebCrypto: non-extractable private CryptoKey. */
  privateKey?: CryptoKey;
  /** libsodium fallback: 64-byte secret key. */
  secretKey?: Uint8Array;
  /** Server device id once enrolled; null until the server confirmed it. */
  deviceId: string | null;
  createdAt: string;
}

/** Records are scoped to one server and one account (spec §2). */
export function deviceKeyScope(apiBaseUrl: string, email: string): string {
  return `${apiBaseUrl.replace(/\/+$/, '')}|${email.trim().toLowerCase()}`;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'scope' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = run(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error ?? new Error('indexedDB transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('indexedDB transaction aborted'));
    });
  } finally {
    db.close();
  }
}

async function readRecord(scope: string): Promise<StoredDeviceKey | null> {
  const rec = await withStore<StoredDeviceKey | undefined>('readonly', (s) => s.get(scope));
  return rec ?? null;
}

async function writeRecord(rec: StoredDeviceKey): Promise<void> {
  await withStore('readwrite', (s) => s.put(rec));
}

/** Forget this scope's device key (e.g. after the server rejected it). */
export async function removeDeviceKey(scope: string): Promise<void> {
  await withStore('readwrite', (s) => s.delete(scope));
}

/** Non-extractable WebCrypto Ed25519 pair, or null when unsupported. */
async function generateWebCryptoKey(): Promise<{ publicKey: Uint8Array; privateKey: CryptoKey } | null> {
  try {
    const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])) as CryptoKeyPair;
    if (pair.privateKey.extractable) return null; // never accept an exportable private key
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    if (raw.length !== 32) return null;
    return { publicKey: raw, privateKey: pair.privateKey };
  } catch {
    return null; // NotSupportedError etc. -> libsodium fallback
  }
}

async function createRecord(scope: string): Promise<StoredDeviceKey> {
  const createdAt = new Date().toISOString();
  const web = await generateWebCryptoKey();
  if (web) {
    return { scope, alg: 'ed25519', storage: 'webcrypto', publicKey: web.publicKey, privateKey: web.privateKey, deviceId: null, createdAt };
  }
  await sodium.ready;
  const seed = sodium.randombytes_buf(32);
  const kp = sodium.crypto_sign_seed_keypair(seed);
  seed.fill(0);
  return { scope, alg: 'ed25519', storage: 'libsodium', publicKey: kp.publicKey, secretKey: kp.privateKey, deviceId: null, createdAt };
}

async function sign(rec: StoredDeviceKey, message: Uint8Array): Promise<Uint8Array> {
  if (rec.storage === 'webcrypto' && rec.privateKey) {
    return new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, rec.privateKey, new Uint8Array(message)));
  }
  if (rec.storage === 'libsodium' && rec.secretKey) {
    await sodium.ready;
    return sodium.crypto_sign_detached(message, rec.secretKey);
  }
  throw new Error('device key record is incomplete');
}

/** A device proof for a passkey sign-in, plus what to do with the answer. */
export interface PreparedDeviceProof {
  proof: SignInDeviceProof;
  storage: DeviceKeyStorage;
  /** Call with the verify response's device_id once a session was issued. */
  confirm(deviceId: string | null | undefined): Promise<void>;
  /** Call when the server answered device_verification_failed. */
  reject(): Promise<void>;
}

/**
 * Build the `device` field for POST /v1/auth/passkeys/verify, signed over
 * `challenge` (the WebAuthn challenge of the ceremony being verified):
 * a bind proof when this scope already has an enrolled device, otherwise an
 * enrol proof for this scope's key (created now if missing).
 */
export async function prepareSignInDeviceProof(scope: string, challenge: string, platform?: string): Promise<PreparedDeviceProof> {
  let rec = await readRecord(scope);
  if (!rec) {
    rec = await createRecord(scope);
    await writeRecord(rec);
  }
  const current = rec;
  let proof: SignInDeviceProof;
  if (current.deviceId) {
    const sig = await sign(current, deviceMessage('session-bind', sessionBindPayload(challenge, current.deviceId)));
    proof = { id: current.deviceId, signature: toBase64UrlNoPad(sig) };
  } else {
    const publicKey = toBase64UrlNoPad(current.publicKey);
    const sig = await sign(current, deviceMessage('enroll', enrollPayload(challenge, publicKey)));
    proof = { public_key: publicKey, signature: toBase64UrlNoPad(sig), ...(platform ? { platform } : {}) };
  }
  return {
    proof,
    storage: current.storage,
    async confirm(deviceId) {
      if (deviceId && deviceId !== current.deviceId) await writeRecord({ ...current, deviceId });
    },
    async reject() {
      await removeDeviceKey(scope);
    },
  };
}
