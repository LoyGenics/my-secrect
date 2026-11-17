// Real-crypto tests for the chunked encrypted upload/download pipeline.
//
// Uses the REAL libsodium adapter (XChaCha20-Poly1305 v1) and the REAL
// packages/storage code. The only stand-in is the network edge: an
// in-memory object store + a BlobApi that mimics the Rails contract
// (stores the opaque manifest, hands out URLs). Nothing here mocks the code
// under test. The real API + real MinIO round trip is tests/media-e2e.
//
//   npx tsx --test packages/storage/tests/upload.real.test.mts
import test from 'node:test';
import assert from 'node:assert/strict';
import { libsodiumAdapter, sodiumReady, toBase64 } from '../../crypto-adapters/src/index';
import {
  CHUNK_SIZE,
  BlobUploadError,
  prepareUpload,
  runUpload,
  uploadFile,
  downloadFile,
  decryptChunks,
  decryptManifest,
  parseEncryptedManifest,
  verifyManifest,
  type BlobApi,
  type FetchLike,
} from '../src/upload';

await sodiumReady;

function fakeStack() {
  const objects = new Map<string, Uint8Array>();
  const blobs = new Map<string, { manifest: string; parts: number; sizes: number[]; complete: boolean }>();
  const api: BlobApi & { downloadOverride?: (s: any) => any } = {
    async createBlobUploadSession(_v, body) {
      blobs.set(body.blob_id, { manifest: body.encrypted_manifest, parts: body.part_count, sizes: [], complete: false });
      return { blob_id: body.blob_id, parts: Array.from({ length: body.part_count }, (_, i) => ({ part_number: i + 1, url: `mem://${body.blob_id}/${i + 1}` })) };
    },
    async completeBlobUpload(id, parts) {
      const b = blobs.get(id)!;
      assert.equal(parts.length, b.parts);
      for (const p of parts) assert.equal(objects.get(`${id}/${p.part_number}`)?.length, p.ciphertext_size, 'server-side size check');
      b.complete = true;
    },
    async createBlobDownloadSession(id) {
      const b = blobs.get(id);
      if (!b?.complete) throw new Error('API 404');
      const s = { blob_id: id, encrypted_manifest: b.manifest, parts: Array.from({ length: b.parts }, (_, i) => ({ part_number: i + 1, ciphertext_size: objects.get(`${id}/${i + 1}`)!.length, url: `mem://${id}/${i + 1}` })) };
      return api.downloadOverride ? api.downloadOverride(s) : s;
    },
  };
  const fetchImpl: FetchLike = async (url, init) => {
    const key = url.replace('mem://', '');
    if (init?.method === 'PUT') { objects.set(key, new Uint8Array(init.body as Uint8Array)); return new Response(null, { status: 200 }); }
    const o = objects.get(key);
    return o ? new Response(o as unknown as BodyInit, { status: 200 }) : new Response(null, { status: 404 });
  };
  return { api, objects, blobs, fetchImpl };
}

const vaultKey = libsodiumAdapter.randomBytes(32);
const otherVaultKey = libsodiumAdapter.randomBytes(32);
function sample(size: number): Uint8Array {
  const d = new Uint8Array(size);
  for (let off = 0; off < size; off += 65536) crypto.getRandomValues(d.subarray(off, Math.min(off + 65536, size)));
  return d;
}
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function pngLike(size: number): Uint8Array { const d = sample(size); d.set(PNG, 0); d.set(new TextEncoder().encode('SECRET-MARKER-PLAINTEXT'), 100); return d; }
function includes(hay: Uint8Array, needle: Uint8Array): boolean { return Buffer.from(hay).includes(Buffer.from(needle)); }

async function up(data: Uint8Array, stack = fakeStack()) {
  const r = await uploadFile({ api: stack.api, vaultId: 'v1', vaultKey, crypto: libsodiumAdapter, data, fileName: 'holiday.png', mimeType: 'image/png' }, { fetchImpl: stack.fetchImpl, backoffMs: 1 });
  return { stack, ...r };
}

test('multi-chunk round trip (2.5 MiB, 3 chunks) restores exact bytes + metadata', async () => {
  const data = pngLike(Math.floor(2.5 * CHUNK_SIZE));
  const { stack, blobId, manifest } = await up(data);
  assert.equal(manifest.chunks.length, 3);
  const got = await downloadFile(stack.api, blobId, vaultKey, libsodiumAdapter, { fetchImpl: stack.fetchImpl });
  assert.deepEqual(Buffer.from(got.bytes), Buffer.from(data));
  assert.equal(got.manifest.file_name, 'holiday.png');
  assert.equal(got.manifest.mime_type, 'image/png');
  assert.equal(got.manifest.plaintext_size, data.length);
});

test('stored objects and manifest are ciphertext: no plaintext marker / PNG magic anywhere', async () => {
  const data = pngLike(2 * CHUNK_SIZE + 10);
  const { stack, blobId } = await up(data);
  for (const [, obj] of stack.objects) {
    assert.ok(!includes(obj, new TextEncoder().encode('SECRET-MARKER-PLAINTEXT')));
    assert.ok(!includes(obj, PNG), 'PNG magic must not appear in stored bytes');
  }
  const stored = Buffer.from(stack.blobs.get(blobId)!.manifest, 'base64');
  for (const needle of ['holiday', 'image/png', 'file_name', 'wrapped_file_key']) assert.ok(!stored.includes(needle), `manifest leaks ${needle}`);
});

test('empty file and exact-chunk-multiple file round trip', async () => {
  for (const size of [0, 1, CHUNK_SIZE, 2 * CHUNK_SIZE]) {
    const data = sample(size);
    const { stack, blobId } = await up(data);
    const got = await downloadFile(stack.api, blobId, vaultKey, libsodiumAdapter, { fetchImpl: stack.fetchImpl });
    assert.deepEqual(Buffer.from(got.bytes), Buffer.from(data), `size ${size}`);
  }
});

test('every chunk has a unique nonce; each file has a distinct File Key (wrapped blobs differ)', async () => {
  const data = sample(3 * CHUNK_SIZE);
  const a = await up(data);
  const b = await up(data);
  assert.equal(new Set(a.manifest.chunks.map((c) => c.nonce_b64)).size, 3);
  assert.notEqual(a.manifest.wrapped_file_key!.wrapped_b64, b.manifest.wrapped_file_key!.wrapped_b64);
  assert.notEqual(a.manifest.chunks[0].ciphertext_sha256_b64, b.manifest.chunks[0].ciphertext_sha256_b64);
});

test('thumbnail is encrypted inside the manifest and decrypts client-side', async () => {
  const stack = fakeStack();
  const thumb = new TextEncoder().encode('THUMB-PLAINTEXT-BYTES');
  const r = await uploadFile({ api: stack.api, vaultId: 'v1', vaultKey, crypto: libsodiumAdapter, data: sample(100), fileName: 'a.png', mimeType: 'image/png', thumbnail: { mimeType: 'image/jpeg', bytes: thumb } }, { fetchImpl: stack.fetchImpl });
  assert.ok(!Buffer.from(stack.blobs.get(r.blobId)!.manifest, 'base64').includes('THUMB-PLAINTEXT'));
  assert.ok(!Buffer.from(JSON.stringify(r.manifest.thumbnail)).includes('THUMB-PLAINTEXT'));
  const got = await downloadFile(stack.api, r.blobId, vaultKey, libsodiumAdapter, { fetchImpl: stack.fetchImpl });
  assert.deepEqual(Buffer.from(got.thumbnail!.bytes), Buffer.from(thumb));
});

test('TAMPER: flipped ciphertext byte in a stored chunk is rejected, no plaintext returned', async () => {
  const { stack, blobId } = await up(sample(2 * CHUNK_SIZE + 5));
  const k = `${blobId}/2`;
  const o = new Uint8Array(stack.objects.get(k)!); o[100] ^= 1; stack.objects.set(k, o);
  await assert.rejects(downloadFile(stack.api, blobId, vaultKey, libsodiumAdapter, { fetchImpl: stack.fetchImpl }), /chunk 2 hash mismatch/);
});

test('TAMPER: swapped chunk order is rejected', async () => {
  const { stack, blobId } = await up(sample(3 * CHUNK_SIZE));
  const k1 = `${blobId}/1`, k2 = `${blobId}/2`;
  const t = stack.objects.get(k1)!; stack.objects.set(k1, stack.objects.get(k2)!); stack.objects.set(k2, t);
  await assert.rejects(downloadFile(stack.api, blobId, vaultKey, libsodiumAdapter, { fetchImpl: stack.fetchImpl }), /hash mismatch|size/);
});

test('TAMPER: duplicated chunk (part 2 replaced by a copy of part 1, same size) is rejected', async () => {
  const { stack, blobId } = await up(sample(3 * CHUNK_SIZE));
  stack.objects.set(`${blobId}/2`, new Uint8Array(stack.objects.get(`${blobId}/1`)!));
  await assert.rejects(downloadFile(stack.api, blobId, vaultKey, libsodiumAdapter, { fetchImpl: stack.fetchImpl }), /chunk 2 hash mismatch/);
});

test('TAMPER: truncated last chunk is rejected', async () => {
  const { stack, blobId } = await up(sample(2 * CHUNK_SIZE + 500));
  stack.objects.set(`${blobId}/3`, stack.objects.get(`${blobId}/3`)!.slice(0, 100));
  await assert.rejects(downloadFile(stack.api, blobId, vaultKey, libsodiumAdapter, { fetchImpl: stack.fetchImpl }), /size/);
});

test('TAMPER: server drops the last part from the session (truncation by omission) is rejected', async () => {
  const { stack, blobId } = await up(sample(3 * CHUNK_SIZE));
  stack.api.downloadOverride = (s) => ({ ...s, parts: s.parts.slice(0, 2) });
  await assert.rejects(downloadFile(stack.api, blobId, vaultKey, libsodiumAdapter, { fetchImpl: stack.fetchImpl }), /truncated or padded/);
});

test('TAMPER: server appends an extra part is rejected', async () => {
  const { stack, blobId } = await up(sample(2 * CHUNK_SIZE));
  stack.api.downloadOverride = (s) => ({ ...s, parts: [...s.parts, { ...s.parts[1], part_number: 3 }] });
  await assert.rejects(downloadFile(stack.api, blobId, vaultKey, libsodiumAdapter, { fetchImpl: stack.fetchImpl }), /truncated or padded/);
});

test('TAMPER: server reorders its part list (URLs swapped between part numbers) is rejected', async () => {
  const { stack, blobId } = await up(sample(2 * CHUNK_SIZE));
  stack.api.downloadOverride = (s) => ({ ...s, parts: [{ ...s.parts[0], url: s.parts[1].url }, { ...s.parts[1], url: s.parts[0].url }] });
  await assert.rejects(downloadFile(stack.api, blobId, vaultKey, libsodiumAdapter, { fetchImpl: stack.fetchImpl }), /hash mismatch/);
});

test('TAMPER: manifest swapped for another blob\'s manifest is rejected', async () => {
  const a = await up(sample(1000));
  const stack = a.stack;
  const b = await up(sample(1000), stack);
  stack.blobs.get(b.blobId)!.manifest = stack.blobs.get(a.blobId)!.manifest;
  await assert.rejects(downloadFile(stack.api, b.blobId, vaultKey, libsodiumAdapter, { fetchImpl: stack.fetchImpl }), /different blob/);
});

test('TAMPER: edited manifest ciphertext fails authentication (loud, not ignored)', async () => {
  const { stack, blobId } = await up(sample(1000));
  const env = parseEncryptedManifest(stack.blobs.get(blobId)!.manifest);
  const raw = Buffer.from(env.ciphertext_b64, 'base64'); raw[5] ^= 1;
  env.ciphertext_b64 = raw.toString('base64');
  stack.blobs.get(blobId)!.manifest = Buffer.from(JSON.stringify(env)).toString('base64');
  await assert.rejects(downloadFile(stack.api, blobId, vaultKey, libsodiumAdapter, { fetchImpl: stack.fetchImpl }));
});

test('wrong Vault Key cannot read manifest or file', async () => {
  const { stack, blobId } = await up(sample(1000));
  await assert.rejects(downloadFile(stack.api, blobId, otherVaultKey, libsodiumAdapter, { fetchImpl: stack.fetchImpl }));
});

test('manifest without a wrapped File Key is refused, not silently undecryptable', async () => {
  const { stack, blobId, manifest } = await up(sample(1000));
  const m = { ...manifest }; delete m.wrapped_file_key;
  const { buildEncryptedManifest, serializeEncryptedManifest } = await import('../src/upload');
  stack.blobs.get(blobId)!.manifest = serializeEncryptedManifest(await buildEncryptedManifest(m, vaultKey, libsodiumAdapter));
  await assert.rejects(downloadFile(stack.api, blobId, vaultKey, libsodiumAdapter, { fetchImpl: stack.fetchImpl }), /no wrapped_file_key/);
});

test('decryptChunks alone rejects a nonce that differs from the manifest', async () => {
  const stack = fakeStack();
  const prepared = await prepareUpload({ api: stack.api, vaultId: 'v', vaultKey, crypto: libsodiumAdapter, data: sample(500), fileName: 'f', mimeType: 'x/y' });
  const chunks = prepared.chunks.map((c) => ({ ...c, nonce: libsodiumAdapter.randomBytes(24) }));
  const fileKeyWrapped = prepared.manifest.wrapped_file_key!;
  const { unwrapFileKey } = await import('../src/upload');
  const fileKey = await unwrapFileKey(fileKeyWrapped, vaultKey, libsodiumAdapter);
  await assert.rejects(decryptChunks(chunks, prepared.manifest, fileKey, libsodiumAdapter), /nonce does not match/);
});

test('verifyManifest rejects malformed / inconsistent manifests', async () => {
  const stack = fakeStack();
  const { manifest } = await up(sample(2 * CHUNK_SIZE), stack);
  const clone = () => JSON.parse(JSON.stringify(manifest));
  const cases: Array<[string, (m: any) => void, RegExp]> = [
    ['reordered chunks', (m) => m.chunks.reverse(), /out of order/],
    ['duplicate nonce', (m) => { m.chunks[1].nonce_b64 = m.chunks[0].nonce_b64; }, /reuses a nonce/],
    ['short nonce', (m) => { m.chunks[0].nonce_b64 = toBase64(new Uint8Array(12)); }, /nonce must be 24/],
    ['bad hash', (m) => { m.chunks[0].ciphertext_sha256_b64 = toBase64(new Uint8Array(5)); }, /SHA-256/],
    ['wrong total', (m) => { m.plaintext_size += 1; }, /does not match chunk ranges/],
    ['gap', (m) => { m.chunks[1].byte_start += 1; }, /not contiguous/],
    ['ciphertext size lie', (m) => { m.chunks[0].ciphertext_size += 1; }, /ciphertext_size/],
    ['no chunks', (m) => { m.chunks = []; }, /no chunks/],
  ];
  for (const [name, mut, re] of cases) { const m = clone(); mut(m); assert.throws(() => verifyManifest(m), re, name); }
});

test('upload failure is loud and resumable: only missing parts are re-sent', async () => {
  const stack = fakeStack();
  const data = sample(3 * CHUNK_SIZE);
  const prepared = await prepareUpload({ api: stack.api, vaultId: 'v', vaultKey, crypto: libsodiumAdapter, data, fileName: 'f.bin', mimeType: 'application/octet-stream' });
  const puts: Record<string, number> = {};
  const flaky: FetchLike = async (url, init) => {
    puts[url] = (puts[url] ?? 0) + 1;
    if (url.endsWith('/2')) return new Response(null, { status: 503 }); // always failing for part 2
    return stack.fetchImpl(url, init);
  };
  await assert.rejects(runUpload(stack.api, prepared, { fetchImpl: flaky, attempts: 2, backoffMs: 1 }), (e: unknown) => {
    assert.ok(e instanceof BlobUploadError);
    assert.deepEqual((e as BlobUploadError).missingParts, [2]);
    assert.match((e as Error).message, /part 2 failed/);
    assert.match((e as Error).message, /HTTP 503/);
    return true;
  });
  assert.equal(stack.blobs.get(prepared.blobId)!.complete, false, 'complete must not be called after a failure');
  const before = { ...puts };
  await runUpload(stack.api, prepared, { fetchImpl: stack.fetchImpl, backoffMs: 1 });
  assert.equal(before[`mem://${prepared.blobId}/1`], 1, 'part 1 was not re-sent in the resume');
  const got = await downloadFile(stack.api, prepared.blobId, vaultKey, libsodiumAdapter, { fetchImpl: stack.fetchImpl });
  assert.deepEqual(Buffer.from(got.bytes), Buffer.from(data));
});

test('expired/forged presigned URL (HTTP 403) fails immediately with a clear message, no blind retries', async () => {
  const stack = fakeStack();
  const prepared = await prepareUpload({ api: stack.api, vaultId: 'v', vaultKey, crypto: libsodiumAdapter, data: sample(100), fileName: 'f', mimeType: 'x/y' });
  let calls = 0;
  const f: FetchLike = async () => { calls++; return new Response(null, { status: 403 }); };
  await assert.rejects(runUpload(stack.api, prepared, { fetchImpl: f, attempts: 5, backoffMs: 1 }), /expired or rejected/);
  assert.equal(calls, 1);
});

test('download failure on a missing object is loud', async () => {
  const { stack, blobId } = await up(sample(2 * CHUNK_SIZE));
  stack.objects.delete(`${blobId}/2`);
  await assert.rejects(downloadFile(stack.api, blobId, vaultKey, libsodiumAdapter, { fetchImpl: stack.fetchImpl, backoffMs: 1 }), /HTTP 404|server part|undefined/);
});

test('decryptManifest rejects an unsupported encryption_version', async () => {
  const { stack, blobId } = await up(sample(10));
  const env = parseEncryptedManifest(stack.blobs.get(blobId)!.manifest);
  await assert.rejects(decryptManifest({ ...env, encryption_version: 2 }, vaultKey, libsodiumAdapter), /encryption_version/);
});
