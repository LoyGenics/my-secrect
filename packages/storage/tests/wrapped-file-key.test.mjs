// Wrapped File Key tests — self-contained, plain Node 20+ (node --test).
// Mirrors packages/storage/src/upload.ts (same manifest rules).
// They do NOT import .ts files, so they run without a TS loader.
// Rule under test (Phase C, H8): a download is decryptable from stored
// data alone ONLY when the manifest carries the Vault-Key-wrapped File
// Key. A manifest without it must fail loudly, never silently.
import test from 'node:test';
import assert from 'node:assert/strict';

// --- mirrors of packages/storage/src/upload.ts ---
const MANIFEST_VERSION = 1;
function requireWrappedFileKey(manifest) {
  if (!manifest.wrapped_file_key?.nonce_b64 || !manifest.wrapped_file_key?.wrapped_b64) {
    throw new Error('manifest has no wrapped_file_key — this blob cannot be decrypted on download (pre-Phase C upload?)');
  }
  return manifest.wrapped_file_key;
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
function fakeWrappedKey() {
  return { nonce_b64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', wrapped_b64: 'd3JhcHBlZC1maWxlLWtleQ==', encryption_version: 1 };
}
function manifest({ withKey = true } = {}) {
  const m = {
    format_version: 1, blob_id: 'blob_1', plaintext_size: 3, chunk_size: 1024 * 1024,
    mime_type: 'text/plain',
    chunks: [{ part_number: 1, byte_start: 0, byte_end: 3, nonce_b64: 'n', ciphertext_size: 19, ciphertext_sha256_b64: 'h' }],
  };
  if (withKey) m.wrapped_file_key = fakeWrappedKey();
  return m;
}

test('manifest WITH wrapped File Key passes both manifest + key checks', () => {
  const m = manifest({ withKey: true });
  verifyManifest(m);
  assert.equal(requireWrappedFileKey(m).encryption_version, 1);
});

test('manifest WITHOUT wrapped File Key still parses (old blobs) but fails the download gate', () => {
  const m = manifest({ withKey: false });
  verifyManifest(m); // structural check is unchanged for old manifests
  assert.throws(() => requireWrappedFileKey(m), /no wrapped_file_key/);
});

test('wrapped key with an empty nonce or ciphertext is rejected', () => {
  const m = manifest({ withKey: true });
  m.wrapped_file_key = { nonce_b64: '', wrapped_b64: 'eA==', encryption_version: 1 };
  assert.throws(() => requireWrappedFileKey(m), /no wrapped_file_key/);
  m.wrapped_file_key = { nonce_b64: 'AA==', wrapped_b64: '', encryption_version: 1 };
  assert.throws(() => requireWrappedFileKey(m), /no wrapped_file_key/);
});

test('download needs manifest + chunks + wrapped key together — any piece missing fails', () => {
  const downloadable = (m, chunks) => {
    verifyManifest(m);
    requireWrappedFileKey(m);
    assert.equal(chunks.length, m.chunks.length, 'chunk count must match manifest');
    return true;
  };
  assert.equal(downloadable(manifest({ withKey: true }), ['chunk-1-bytes']), true);
  assert.throws(() => downloadable(manifest({ withKey: false }), ['chunk-1-bytes']), /no wrapped_file_key/);
  assert.throws(() => downloadable(manifest({ withKey: true }), []), /chunk count must match/);
});
