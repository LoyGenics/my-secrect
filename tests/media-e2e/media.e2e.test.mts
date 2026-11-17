// REAL end-to-end media test: real libsodium crypto, real packages/storage
// pipeline, real Rails API, real MinIO, all reached through the PUBLIC
// endpoints (Caddy -> api, Caddy -> s3.<site> presigned URLs) from outside
// the compose network. Run via tests/media-e2e/run.sh (boots the stack).
//
// Tamper tests modify the bytes that are actually stored in MinIO by
// re-PUTting to the (still valid, 5 min) presigned upload URLs, then
// download through the normal client path and require a loud rejection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { libsodiumAdapter, sodiumReady } from '../../packages/crypto-adapters/src/index';
import { VaultApiClient } from '../../packages/sdk/src/index';
import { CHUNK_SIZE, prepareUpload, runUpload, downloadFile, type PreparedUpload } from '../../packages/storage/src/upload';

const need = (n: string) => { const v = process.env[n]; if (!v) throw new Error(`${n} is required (run via tests/media-e2e/run.sh)`); return v; };
const API = need('E2E_API'), ORIGIN = need('E2E_ORIGIN'), TOKEN = need('E2E_TOKEN'), VAULT = need('E2E_VAULT_ID');
await sodiumReady;
const api = new VaultApiClient({ baseUrl: API, getToken: async () => TOKEN });
const vaultKey = libsodiumAdapter.randomBytes(32);
const MARKER = new TextEncoder().encode('TOP-SECRET-PLAINTEXT-MARKER-0123456789');
const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function fileBytes(size: number): Uint8Array {
  const d = new Uint8Array(size);
  for (let o = 0; o < size; o += 65536) crypto.getRandomValues(d.subarray(o, Math.min(o + 65536, size)));
  d.set(PNG_MAGIC, 0);
  // marker at the start of EVERY chunk so any plaintext leak is certain to show up
  for (let o = 64; o < size; o += CHUNK_SIZE) d.set(MARKER, o);
  return d;
}
const has = (hay: Uint8Array, needle: Uint8Array) => Buffer.from(hay).includes(Buffer.from(needle));
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

async function put(url: string, body: Uint8Array) {
  const r = await fetch(url, { method: 'PUT', body: body as unknown as BodyInit, headers: { Origin: ORIGIN } });
  assert.equal(r.status, 200, `PUT ${r.status}`);
}
async function rawObjects(blobId: string): Promise<Uint8Array[]> {
  const s = await api.createBlobDownloadSession(blobId);
  return Promise.all(s.parts.map(async (p) => new Uint8Array(await (await fetch(p.url)).arrayBuffer())));
}
async function upload(data: Uint8Array, name = 'photo.png'): Promise<PreparedUpload> {
  const prepared = await prepareUpload({ api, vaultId: VAULT, vaultKey, crypto: libsodiumAdapter, data, fileName: name, mimeType: 'image/png' });
  await runUpload(api, prepared);
  return prepared;
}
const dl = (id: string, key = vaultKey) => downloadFile(api, id, key, libsodiumAdapter);

test('presigned URLs are public (s3.<site>), never the internal minio host', async () => {
  const p = await prepareUpload({ api, vaultId: VAULT, vaultKey, crypto: libsodiumAdapter, data: fileBytes(1000), fileName: 'u.png', mimeType: 'image/png' });
  for (const u of p.urls.values()) {
    const url = new URL(u);
    assert.equal(url.hostname, 's3.localhost');
    assert.ok(!u.includes('minio'));
  }
});

test('10 MiB multi-chunk file round-trips through real API + real MinIO; stored bytes are ciphertext', async () => {
  const data = fileBytes(10 * 1024 * 1024);
  const prepared = await upload(data);
  assert.equal(prepared.manifest.chunks.length, 10);
  const stored = await rawObjects(prepared.blobId);
  assert.equal(stored.length, 10);
  for (let i = 0; i < stored.length; i++) {
    assert.equal(stored[i].length, CHUNK_SIZE + 16, `part ${i + 1} is chunk + AEAD tag`);
    assert.ok(!has(stored[i], MARKER), `part ${i + 1} contains plaintext marker`);
    assert.ok(!has(stored[i], PNG_MAGIC), `part ${i + 1} contains PNG magic`);
  }
  assert.equal(new Set(stored.map((s) => Buffer.from(s.subarray(0, 64)).toString('hex'))).size, 10, 'chunk ciphertexts are distinct');
  // The manifest the server holds is opaque (no file name / mime visible).
  const session = await api.createBlobDownloadSession(prepared.blobId);
  const m = Buffer.from(session.encrypted_manifest, 'base64');
  for (const n of ['photo.png', 'image/png', 'wrapped_file_key', 'file_name']) assert.ok(!m.includes(n), `server-visible manifest leaks ${n}`);

  const got = await dl(prepared.blobId);
  assert.ok(sameBytes(got.bytes, data), 'downloaded bytes equal original');
  assert.equal(got.manifest.file_name, 'photo.png');
});

test('wrong Vault Key cannot open a stored blob (loud failure)', async () => {
  const p = await upload(fileBytes(CHUNK_SIZE + 5));
  await assert.rejects(dl(p.blobId, libsodiumAdapter.randomBytes(32)));
});

test('TAMPER in MinIO: flipped byte in a stored chunk is rejected', async () => {
  const p = await upload(fileBytes(3 * CHUNK_SIZE));
  const objs = await rawObjects(p.blobId);
  const bad = new Uint8Array(objs[1]); bad[1234] ^= 0x01;
  await put(p.urls.get(2)!, bad);
  await assert.rejects(dl(p.blobId), /chunk 2 hash mismatch/);
});

test('TAMPER in MinIO: swapped chunk order is rejected', async () => {
  const p = await upload(fileBytes(3 * CHUNK_SIZE));
  const objs = await rawObjects(p.blobId);
  await put(p.urls.get(1)!, objs[2]);
  await put(p.urls.get(3)!, objs[0]);
  await assert.rejects(dl(p.blobId), /chunk 1 hash mismatch/);
});

test('TAMPER in MinIO: duplicated chunk is rejected', async () => {
  const p = await upload(fileBytes(3 * CHUNK_SIZE));
  const objs = await rawObjects(p.blobId);
  await put(p.urls.get(3)!, objs[0]);
  await assert.rejects(dl(p.blobId), /chunk 3 hash mismatch/);
});

test('TAMPER in MinIO: truncated chunk is rejected', async () => {
  const p = await upload(fileBytes(2 * CHUNK_SIZE + 700));
  const objs = await rawObjects(p.blobId);
  await put(p.urls.get(3)!, objs[2].subarray(0, objs[2].length - 100));
  await assert.rejects(dl(p.blobId), /size/);
});

test('TAMPER in MinIO: chunk replaced by a chunk of ANOTHER file (same key space, valid ciphertext) is rejected', async () => {
  const a = await upload(fileBytes(2 * CHUNK_SIZE));
  const b = await upload(fileBytes(2 * CHUNK_SIZE));
  const bObjs = await rawObjects(b.blobId);
  await put(a.urls.get(1)!, bObjs[0]);
  await assert.rejects(dl(a.blobId), /chunk 1 hash mismatch/);
});

test('API refuses an upload session without an encrypted manifest and a complete with a lying size', async () => {
  await assert.rejects(api.createBlobUploadSession(VAULT, { blob_id: crypto.randomUUID(), part_count: 1, ciphertext_size: 100, encrypted_manifest: '' }), /422/);
  const p = await prepareUpload({ api, vaultId: VAULT, vaultKey, crypto: libsodiumAdapter, data: fileBytes(500), fileName: 'x', mimeType: 'x/y' });
  for (const [n, u] of p.urls) await put(u, p.chunks[n - 1].ciphertext);
  await assert.rejects(api.completeBlobUpload(p.blobId, [{ part_number: 1, ciphertext_size: p.chunks[0].ciphertext.length + 1, ciphertext_sha256_b64: p.manifest.chunks[0].ciphertext_sha256_b64 }]), /422/);
});
