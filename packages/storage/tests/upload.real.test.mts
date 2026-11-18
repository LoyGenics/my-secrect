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
  SourceChangedError,
  prepareUpload,
  runUpload,
  resumeUpload,
  findResumableUpload,
  uploadFile,
  downloadFile,
  downloadToSink,
  decryptChunks,
  decryptManifest,
  encryptChunks,
  parseEncryptedManifest,
  serializeEncryptedManifest,
  buildEncryptedManifest,
  bytesSource,
  verifyManifest,
  unwrapFileKey,
  webStorageResumeStore,
  type BlobApi,
  type ChunkSource,
  type FetchLike,
  type RetryInfo,
} from '../src/upload';

await sodiumReady;

// Mirrors the Rails contract: exact part sizes from part_size, resume of the
// same blob_id + manifest reports `stored` parts, complete checks storage.
function fakeStack() {
  const objects = new Map<string, Uint8Array>();
  const blobs = new Map<string, { manifest: string; parts: number; sizes: number[]; complete: boolean }>();
  let sessions = 0;
  const api: BlobApi & { downloadOverride?: (s: any) => any; sessionCalls: () => number } = {
    sessionCalls: () => sessions,
    async createBlobUploadSession(_v, body) {
      sessions++;
      const last = body.ciphertext_size - (body.part_count - 1) * body.part_size;
      assert.ok(last >= 1 && last <= body.part_size, 'part layout');
      const sizes = [...Array(body.part_count - 1).fill(body.part_size), last];
      const existing = blobs.get(body.blob_id);
      if (existing) assert.equal(existing.manifest, body.encrypted_manifest, 'resume must send the same manifest');
      else blobs.set(body.blob_id, { manifest: body.encrypted_manifest, parts: body.part_count, sizes, complete: false });
      return {
        blob_id: body.blob_id,
        resumed: !!existing,
        parts: sizes.map((size, i) => ({ part_number: i + 1, ciphertext_size: size, stored: !!existing && objects.get(`${body.blob_id}/${i + 1}`)?.length === size, url: `mem://${body.blob_id}/${i + 1}` })),
      };
    },
    async completeBlobUpload(id, parts) {
      const b = blobs.get(id)!;
      assert.equal(parts.length, b.parts);
      for (const p of parts) assert.equal(objects.get(`${id}/${p.part_number}`)?.length, b.sizes[p.part_number - 1], 'server-side size check');
      b.complete = true;
    },
    async createBlobDownloadSession(id) {
      const b = blobs.get(id);
      if (!b?.complete) throw new Error('API 404');
      const s = { blob_id: id, encrypted_manifest: b.manifest, parts: Array.from({ length: b.parts }, (_, i) => ({ part_number: i + 1, ciphertext_size: objects.get(`${id}/${i + 1}`)!.length, url: `mem://${id}/${i + 1}` })) };
      return api.downloadOverride ? api.downloadOverride(s) : s;
    },
  };
  const log: Array<{ method: string; url: string }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const key = url.replace('mem://', '');
    log.push({ method: init?.method ?? 'GET', url });
    if (init?.method === 'PUT') { objects.set(key, new Uint8Array(init.body as Uint8Array)); return new Response(null, { status: 200 }); }
    const o = objects.get(key);
    return o ? new Response(o as unknown as BodyInit, { status: 200 }) : new Response(null, { status: 404 });
  };
  return { api, objects, blobs, fetchImpl, log };
}

/** A Web Storage stand-in (Map-backed) — what localStorage is in the browser. */
function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
    dump: () => [...m.values()].join('\n'),
  };
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

const keys = { vaultKey, crypto: libsodiumAdapter };

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

test('API requests and direct storage transfers disclose no file metadata or decryption keys', async () => {
  const stack = fakeStack();
  const calls: unknown[] = [];
  const api: BlobApi = {
    createBlobUploadSession: async (id, body) => {
      calls.push({ id, body });
      assert.deepEqual(Object.keys(body).sort(), ['blob_id', 'ciphertext_size', 'encrypted_manifest', 'part_count', 'part_size']);
      return stack.api.createBlobUploadSession(id, body);
    },
    completeBlobUpload: async (id, parts) => {
      calls.push({ id, parts });
      for (const part of parts) assert.deepEqual(Object.keys(part).sort(), ['ciphertext_sha256_b64', 'ciphertext_size', 'part_number']);
      return stack.api.completeBlobUpload(id, parts);
    },
    createBlobDownloadSession: async (id) => {
      calls.push({ id });
      return stack.api.createBlobDownloadSession(id);
    },
  };
  const transfers: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    assert.deepEqual(headers, init?.method === 'PUT' ? { 'content-type': 'application/octet-stream' } : {});
    transfers.push({ url, headers, body: init?.body ? Buffer.from(init.body as Uint8Array).toString('base64') : '' });
    return stack.fetchImpl(url, init);
  };
  const data = pngLike(CHUNK_SIZE + 128);
  const prepared = await prepareUpload({ api, vaultId: 'opaque-vault-id', vaultKey, crypto: libsodiumAdapter,
    data, fileName: 'private-family-photo.png', mimeType: 'image/png' });
  const fileKey = await unwrapFileKey(prepared.manifest.wrapped_file_key!, vaultKey, libsodiumAdapter);
  try {
    await runUpload(api, prepared, keys, { fetchImpl });
    const got = await downloadFile(api, prepared.blobId, vaultKey, libsodiumAdapter, { fetchImpl });
    assert.deepEqual(Buffer.from(got.bytes), Buffer.from(data));
    const wire = JSON.stringify({ calls, transfers });
    for (const secret of ['private-family-photo.png', 'image/png', toBase64(vaultKey), toBase64(fileKey),
      Buffer.from(vaultKey).toString('hex'), Buffer.from(fileKey).toString('hex')]) {
      assert.ok(!wire.includes(secret), 'plaintext metadata and raw keys must stay on the client');
    }
  } finally { fileKey.fill(0); }
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

test('legacy manifest with an embedded thumbnail (encrypted with the File Key) stays readable', async () => {
  const { stack, blobId, manifest } = await up(sample(100));
  const { unwrapFileKey } = await import('../src/upload');
  const fileKey = await unwrapFileKey(manifest.wrapped_file_key!, vaultKey, libsodiumAdapter);
  const thumb = new TextEncoder().encode('THUMB-PLAINTEXT-BYTES');
  const t = await libsodiumAdapter.encrypt(fileKey, thumb);
  const legacy = { ...manifest, thumbnail: { mime_type: 'image/jpeg', nonce_b64: toBase64(t.nonce), ciphertext_b64: toBase64(t.ciphertext) } };
  stack.blobs.get(blobId)!.manifest = serializeEncryptedManifest(await buildEncryptedManifest(legacy, vaultKey, libsodiumAdapter));
  assert.ok(!Buffer.from(stack.blobs.get(blobId)!.manifest, 'base64').includes('THUMB-PLAINTEXT'));
  const got = await downloadFile(stack.api, blobId, vaultKey, libsodiumAdapter, { fetchImpl: stack.fetchImpl });
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

test('TAMPER: server answers a request for blob B with the whole of blob A (manifest + parts, ids rewritten) — rejected', async () => {
  const a = await up(sample(2 * CHUNK_SIZE));
  const stack = a.stack;
  const b = await up(sample(2 * CHUNK_SIZE), stack);
  stack.api.downloadOverride = (s) => (s.blob_id === b.blobId ? { ...s, encrypted_manifest: stack.blobs.get(a.blobId)!.manifest, parts: s.parts.map((p: any) => ({ ...p, url: p.url.replace(b.blobId, a.blobId) })) } : s);
  const written: number[] = [];
  await assert.rejects(downloadToSink(stack.api, b.blobId, vaultKey, libsodiumAdapter, { write: (c) => { written.push(c.length); } }, { fetchImpl: stack.fetchImpl }), /manifest belongs to a different blob/);
  assert.deepEqual(written, [], 'not one byte of the substituted file reached the sink');
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
  const fileKey = libsodiumAdapter.randomBytes(32);
  const { chunks, manifest } = await encryptChunks(sample(500), fileKey, 'b', 'x/y', libsodiumAdapter);
  const swapped = chunks.map((c) => ({ ...c, nonce: libsodiumAdapter.randomBytes(24) }));
  await assert.rejects(decryptChunks(swapped, manifest, fileKey, libsodiumAdapter), /nonce does not match/);
  assert.equal((await decryptChunks(chunks, manifest, fileKey, libsodiumAdapter)).length, 500);
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
  await assert.rejects(runUpload(stack.api, prepared, keys, { fetchImpl: flaky, attempts: 2, backoffMs: 1 }), (e: unknown) => {
    assert.ok(e instanceof BlobUploadError);
    assert.deepEqual((e as BlobUploadError).missingParts, [2]);
    assert.match((e as Error).message, /part 2 failed/);
    assert.match((e as Error).message, /HTTP 503/);
    return true;
  });
  assert.equal(stack.blobs.get(prepared.blobId)!.complete, false, 'complete must not be called after a failure');
  const before = { ...puts };
  await runUpload(stack.api, prepared, keys, { fetchImpl: stack.fetchImpl, backoffMs: 1 });
  assert.equal(before[`mem://${prepared.blobId}/1`], 1, 'part 1 was not re-sent in the resume');
  const got = await downloadFile(stack.api, prepared.blobId, vaultKey, libsodiumAdapter, { fetchImpl: stack.fetchImpl });
  assert.deepEqual(Buffer.from(got.bytes), Buffer.from(data));
});

test('expired/forged presigned URL (HTTP 403) fails immediately with a clear message, no blind retries', async () => {
  const stack = fakeStack();
  const prepared = await prepareUpload({ api: stack.api, vaultId: 'v', vaultKey, crypto: libsodiumAdapter, data: sample(100), fileName: 'f', mimeType: 'x/y' });
  let calls = 0;
  const f: FetchLike = async () => { calls++; return new Response(null, { status: 403 }); };
  await assert.rejects(runUpload(stack.api, prepared, keys, { fetchImpl: f, attempts: 5, backoffMs: 1 }), /expired or rejected/);
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

// --- streaming, resume, retry, fail-closed sink ----------------------------

/** A ChunkSource over bytes that records every read (to prove chunk-sized reads). */
function countingSource(data: Uint8Array) {
  const reads: number[] = [];
  const src: ChunkSource = { size: data.length, read: async (s, e) => { reads.push(e - s); return data.slice(s, e); } };
  return { src, reads };
}

test('streaming upload reads the source one chunk at a time (two passes) and the sink gets verified chunks in order', async () => {
  const stack = fakeStack();
  const data = sample(5 * CHUNK_SIZE + 123);
  const { src, reads } = countingSource(data);
  const r = await uploadFile({ api: stack.api, vaultId: 'v', vaultKey, crypto: libsodiumAdapter, source: src, fileName: 'big.bin', mimeType: 'application/octet-stream' }, { fetchImpl: stack.fetchImpl, backoffMs: 1 });
  assert.equal(reads.length, 12, 'pass 1 + pass 2 = 2 reads per chunk');
  assert.ok(reads.every((n) => n <= CHUNK_SIZE), 'never more than one chunk per read');
  assert.ok(r.manifest.plaintext_sha256_b64, 'manifest records the plaintext SHA-256');
  const written: number[] = [];
  const out: Uint8Array[] = [];
  await downloadToSink(stack.api, r.blobId, vaultKey, libsodiumAdapter, { write: (c) => { written.push(c.length); out.push(c); } }, { fetchImpl: stack.fetchImpl });
  assert.deepEqual(written, [CHUNK_SIZE, CHUNK_SIZE, CHUNK_SIZE, CHUNK_SIZE, CHUNK_SIZE, 123]);
  assert.deepEqual(Buffer.concat(out), Buffer.from(data));
});

test('download read-ahead is bounded by `concurrency`', async () => {
  const { stack, blobId } = await up(sample(9 * CHUNK_SIZE));
  let inflight = 0;
  let peak = 0;
  const slow: FetchLike = async (url, init) => {
    inflight++;
    peak = Math.max(peak, inflight);
    await new Promise((r) => setTimeout(r, 5));
    try { return await stack.fetchImpl(url, init); } finally { inflight--; }
  };
  await downloadToSink(stack.api, blobId, vaultKey, libsodiumAdapter, { write: () => {} }, { fetchImpl: slow, concurrency: 3 });
  assert.equal(peak, 3);
});

test('source changed between pass 1 and pass 2: SourceChangedError, NOTHING is sent for that part, resume record dropped', async () => {
  const stack = fakeStack();
  const store = webStorageResumeStore(memoryStorage());
  const data = sample(3 * CHUNK_SIZE);
  const prepared = await prepareUpload({ api: stack.api, vaultId: 'v', vaultKey, crypto: libsodiumAdapter, source: bytesSource(data), fileName: 'f', mimeType: 'x/y', resumeStore: store });
  assert.equal(store.list().length, 1);
  data[CHUNK_SIZE + 10] ^= 0xff; // edit chunk 2 in place
  await assert.rejects(runUpload(stack.api, prepared, keys, { fetchImpl: stack.fetchImpl, concurrency: 1 }), (e: unknown) => e instanceof SourceChangedError && (e as SourceChangedError).partNumber === 2);
  const puts = stack.log.filter((l) => l.method === 'PUT').map((l) => l.url);
  assert.deepEqual(puts, [`mem://${prepared.blobId}/1`], 'part 2 (and later parts) never left the device');
  assert.equal(stack.blobs.get(prepared.blobId)!.complete, false);
  assert.equal(store.list().length, 0);
});

test('resume from a NEW process: only the ResumeState survives; storage-confirmed parts are skipped, the rest sent, result decrypts', async () => {
  const stack = fakeStack();
  const storage = memoryStorage();
  const data = sample(6 * CHUNK_SIZE + 77);
  {
    // Process 1: the connection dies after 3 parts.
    const prepared = await prepareUpload({ api: stack.api, vaultId: 'v', vaultKey, crypto: libsodiumAdapter, source: bytesSource(data), fileName: 'clip.mp4', mimeType: 'video/mp4', resumeStore: webStorageResumeStore(storage) });
    let sent = 0;
    const dying: FetchLike = async (url, init) => { if (++sent > 3) throw new TypeError('fetch failed (connection reset)'); return stack.fetchImpl(url, init); };
    await assert.rejects(runUpload(stack.api, prepared, keys, { fetchImpl: dying, concurrency: 1, attempts: 1 }), BlobUploadError);
  }
  assert.ok(!storage.dump().includes('clip.mp4') && !storage.dump().includes('video/mp4'), 'resume record holds no plaintext metadata');
  // Process 2: nothing in memory but the store and the file.
  const store = webStorageResumeStore(storage);
  const src = bytesSource(data);
  assert.equal(await findResumableUpload({ store, source: bytesSource(sample(data.length)), fileName: 'clip.mp4', mimeType: 'video/mp4', vaultKey, crypto: libsodiumAdapter }), null, 'a different file of the same size does not match');
  assert.equal(await findResumableUpload({ store, source: src, fileName: 'clip.mp4', mimeType: 'video/mp4', vaultKey: otherVaultKey, crypto: libsodiumAdapter }), null, 'another vault cannot read the record');
  const state = await findResumableUpload({ store, source: src, fileName: 'clip.mp4', mimeType: 'video/mp4', vaultKey, crypto: libsodiumAdapter });
  assert.ok(state);
  const resumed = await resumeUpload({ api: stack.api, vaultKey, crypto: libsodiumAdapter, source: src, state, resumeStore: store });
  assert.equal(resumed.resumed, true);
  assert.deepEqual(resumed.tracker.missingParts(), [4, 5, 6, 7]);
  const before = stack.log.length;
  await runUpload(stack.api, resumed, keys, { fetchImpl: stack.fetchImpl });
  const putsAfter = stack.log.slice(before).filter((l) => l.method === 'PUT').map((l) => Number(l.url.split('/').pop())).sort((a, b) => a - b);
  assert.deepEqual(putsAfter, [4, 5, 6, 7], 'only the parts storage did not hold were sent');
  assert.equal(store.list().length, 0, 'record removed after complete');
  const got = await downloadFile(stack.api, state.blob_id, vaultKey, libsodiumAdapter, { fetchImpl: stack.fetchImpl });
  assert.deepEqual(Buffer.from(got.bytes), Buffer.from(data));
});

test('a failing part is retried with exponential backoff, then succeeds', async () => {
  const stack = fakeStack();
  const prepared = await prepareUpload({ api: stack.api, vaultId: 'v', vaultKey, crypto: libsodiumAdapter, data: sample(2 * CHUNK_SIZE), fileName: 'f', mimeType: 'x/y' });
  let failures = 0;
  const flaky: FetchLike = async (url, init) => (url.endsWith('/2') && failures++ < 2 ? new Response(null, { status: 503 }) : stack.fetchImpl(url, init));
  const retries: RetryInfo[] = [];
  await runUpload(stack.api, prepared, keys, { fetchImpl: flaky, attempts: 3, backoffMs: 5, onRetry: (r) => retries.push(r) });
  assert.deepEqual(retries.map((r) => [r.op, r.partNumber, r.attempt, r.delayMs]), [['upload', 2, 1, 5], ['upload', 2, 2, 10]]);
  assert.match(retries[0].error, /HTTP 503/);
  assert.equal(stack.blobs.get(prepared.blobId)!.complete, true);
});

test('fail closed: a tampered chunk mid-download aborts the sink; the caller gets an error, never the bytes', async () => {
  const { stack, blobId } = await up(sample(4 * CHUNK_SIZE));
  const o = new Uint8Array(stack.objects.get(`${blobId}/3`)!); o[7] ^= 1; stack.objects.set(`${blobId}/3`, o);
  const events: string[] = [];
  const sink = { write: (c: Uint8Array) => { events.push(`write ${c.length}`); }, abort: (e: Error) => { events.push(`abort: ${e.message}`); } };
  await assert.rejects(downloadToSink(stack.api, blobId, vaultKey, libsodiumAdapter, sink, { fetchImpl: stack.fetchImpl }), /chunk 3 hash mismatch/);
  assert.deepEqual(events, [`write ${CHUNK_SIZE}`, `write ${CHUNK_SIZE}`, 'abort: chunk 3 hash mismatch — tampered, reordered or substituted']);
});

test('fail closed: whole-file SHA-256 in the manifest is checked after the last chunk', async () => {
  const { stack, blobId, manifest } = await up(sample(2 * CHUNK_SIZE));
  const forged = { ...manifest, plaintext_sha256_b64: toBase64(new Uint8Array(32)) }; // only a Vault Key holder can write this
  stack.blobs.get(blobId)!.manifest = serializeEncryptedManifest(await buildEncryptedManifest(forged, vaultKey, libsodiumAdapter));
  let aborted = false;
  await assert.rejects(downloadToSink(stack.api, blobId, vaultKey, libsodiumAdapter, { write: () => {}, abort: () => { aborted = true; } }, { fetchImpl: stack.fetchImpl }), /does not match the SHA-256 recorded in its manifest/);
  assert.equal(aborted, true);
});

test('runs without WebCrypto (Hermes has no crypto.subtle / crypto.randomUUID): SHA-256 and ids come from libsodium', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto')!;
  const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
  Object.defineProperty(globalThis, 'crypto', { value: { getRandomValues }, configurable: true, writable: true });
  try {
    assert.equal((globalThis.crypto as any).subtle, undefined);
    const stack = fakeStack();
    const data = sample(2 * CHUNK_SIZE + 9);
    const r = await uploadFile({ api: stack.api, vaultId: 'v', vaultKey, crypto: libsodiumAdapter, data, fileName: 'f', mimeType: 'x/y' }, { fetchImpl: stack.fetchImpl });
    assert.match(r.blobId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const got = await downloadFile(stack.api, r.blobId, vaultKey, libsodiumAdapter, { fetchImpl: stack.fetchImpl });
    assert.deepEqual(Buffer.from(got.bytes), Buffer.from(data));
  } finally {
    Object.defineProperty(globalThis, 'crypto', original);
  }
});
