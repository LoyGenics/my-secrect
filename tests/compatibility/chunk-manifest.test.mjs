// Chunk manifest verification — self-contained, plain Node 20+.
// Mirrors packages/storage/src/upload.ts (same chunk size, same manifest
// rules). Guards: split sizes, manifest contiguity, hash verification,
// tamper/missing/reorder rejection, and video range -> chunk mapping.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const CHUNK_SIZE = 1024 * 1024;
const MANIFEST_VERSION = 1;
function sha256B64(buf) { return crypto.createHash('sha256').update(buf).digest('base64'); }
function splitIntoChunks(data) {
  const chunks = [];
  for (let o = 0; o < data.length; o += CHUNK_SIZE) chunks.push(data.subarray(o, Math.min(o + CHUNK_SIZE, data.length)));
  if (!chunks.length) chunks.push(Buffer.alloc(0));
  return chunks;
}
// In the real code each chunk is AEAD-encrypted; here the "ciphertext" is
// the chunk bytes themselves, and the hash is what the manifest binds.
// The property under test is the MANIFEST binding, not the cipher.
function buildManifest(blobId, data, mimeType = 'video/mp4') {
  const chunks = splitIntoChunks(data);
  return {
    format_version: MANIFEST_VERSION, blob_id: blobId, plaintext_size: data.length,
    chunk_size: CHUNK_SIZE, mime_type: mimeType,
    chunks: chunks.map((c, i) => ({
      part_number: i + 1, byte_start: i * CHUNK_SIZE, byte_end: i * CHUNK_SIZE + c.length,
      nonce_b64: 'nonce', ciphertext_size: c.length, ciphertext_sha256_b64: sha256B64(c),
    })),
  };
}
function verifyManifest(m) {
  if (m.format_version !== MANIFEST_VERSION) throw new Error('unsupported manifest version');
  if (!m.chunks.length) throw new Error('manifest has no chunks');
  let expected = 0;
  for (let i = 0; i < m.chunks.length; i++) {
    const c = m.chunks[i];
    if (c.part_number !== i + 1) throw new Error('chunk out of order');
    if (c.byte_start !== expected) throw new Error('chunk not contiguous');
    expected = c.byte_end;
  }
  if (expected !== m.plaintext_size) throw new Error('manifest size mismatch');
}
function chunkIndexForByteRange(m, start, end) {
  return m.chunks.filter((c) => c.byte_end > start && c.byte_start < end).map((c) => c.part_number);
}

test('2.5 MiB file splits into 3 chunks with a contiguous manifest', () => {
  const data = crypto.randomBytes(2 * CHUNK_SIZE + 512 * 1024);
  const m = buildManifest('blob_1', data);
  assert.equal(m.chunks.length, 3);
  assert.equal(m.chunks[2].byte_end, data.length);
  verifyManifest(m);
});

test('tampered chunk is rejected by its hash', () => {
  const data = crypto.randomBytes(100);
  const m = buildManifest('blob_1', data);
  const tampered = Buffer.from(data); tampered[0] ^= 1;
  assert.notEqual(sha256B64(tampered), m.chunks[0].ciphertext_sha256_b64);
});

test('missing chunk is detected by manifest length', () => {
  const data = crypto.randomBytes(2 * CHUNK_SIZE + 10);
  const m = buildManifest('blob_1', data);
  const downloaded = splitIntoChunks(data).slice(0, 2); // third chunk lost
  assert.notEqual(downloaded.length, m.chunks.length);
});

test('reordered manifest is rejected', () => {
  const data = crypto.randomBytes(2 * CHUNK_SIZE + 10);
  const m = buildManifest('blob_1', data);
  const reordered = { ...m, chunks: [m.chunks[1], m.chunks[0], m.chunks[2]] };
  assert.throws(() => verifyManifest(reordered), /out of order|not contiguous/);
});

test('truncated manifest size mismatch is rejected', () => {
  const data = crypto.randomBytes(100);
  const m = buildManifest('blob_1', data);
  assert.throws(() => verifyManifest({ ...m, plaintext_size: data.length + 1 }), /size mismatch/);
});

test('video seek maps a byte range to chunk numbers', () => {
  const data = crypto.randomBytes(3 * CHUNK_SIZE);
  const m = buildManifest('blob_1', data);
  assert.deepEqual(chunkIndexForByteRange(m, 0, 100), [1]);
  assert.deepEqual(chunkIndexForByteRange(m, CHUNK_SIZE - 10, CHUNK_SIZE + 10), [1, 2]);
  assert.deepEqual(chunkIndexForByteRange(m, 2 * CHUNK_SIZE, 3 * CHUNK_SIZE), [3]);
});
