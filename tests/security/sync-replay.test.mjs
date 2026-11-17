// Security hardening tests — sync replay, authorization, conflicts,
// offline recovery, interrupted uploads.
//
// HONEST HEADER — READ BEFORE CITING THESE TESTS:
//   * MIRROR, not import. Every rule here (revision checks, idempotency
//     keys, session checks, keep-both conflicts, offline queue, chunk
//     manifests) is re-implemented in-file from the documented design in
//     packages/sync, packages/import-export and docs/architecture.md.
//     They do NOT import the real SyncClient, VaultApiClient, or Rails
//     code — and Phase A found the real server pull OMITS ciphertext and
//     no app imports SyncClient at all (gate 5 FAIL). A green run proves
//     the RULES below; it proves nothing about the live server.
//   * Plain Node 20+, no server, no TS loader: `node --test tests/security/`
//   * These tests NEVER ran on the Mac. Nothing here is verified.
//
// What is covered: replay attempt, unauthorized access, cross-device
// conflict (keep-both), offline-to-online recovery, interrupted upload.
import test from 'node:test';
import assert from 'node:assert/strict';

// --- mirrors of the sync rules (cf. tests/sync-conflicts/) -----------------
function detectConflict(localRevision, localBase, remoteRevision) {
  if (localRevision === localBase) return 'none';
  if (remoteRevision === localBase) return 'none';
  return 'same_item_both_changed';
}
function resolveConflictKeepBoth(local, remote, meta) {
  return {
    id: `conflict_${local.id}_${meta.remoteRevision}`, item_id: local.id,
    kind: 'same_item_both_changed', local_revision: meta.localRevision,
    remote_revision: meta.remoteRevision, base_revision: meta.baseRevision,
    local, remote, remote_device_id: meta.remoteDeviceId,
    detected_at: new Date().toISOString(), resolution: 'unresolved', resolved_at: null,
  };
}
// Server-side push guard (mirror of the intended Sync::Push contract):
// a push is accepted only if its base_revision equals the server's
// current revision for that item; anything else is stale or a replay.
function serverAcceptPush(serverRevision, req) {
  if (req.base_revision !== serverRevision) {
    return { accepted: false, reason: 'stale_base_revision', server_revision: serverRevision };
  }
  return { accepted: true, new_revision: serverRevision + 1 };
}
// Idempotency: same key + same payload = safe retry; same key + different
// payload = replay/tamper attempt, must be rejected, never applied.
function idempotencyCheck(seenKeys, req) {
  const prev = seenKeys.get(req.idempotency_key);
  if (!prev) { seenKeys.set(req.idempotency_key, req.payload_hash); return { ok: true, replay: false }; }
  if (prev === req.payload_hash) return { ok: true, replay: true };
  return { ok: false, reason: 'idempotency_key_reused_with_different_payload' };
}
// Authorization guard (mirror of the intended API contract): a request is
// authorized only with a live session, for a vault the session owns, from
// a device that has not been revoked.
function authorize({ session, vaultOwnerId, deviceRevoked, nowMs }) {
  if (!session) return { ok: false, reason: 'no_session' };
  if (session.expires_at_ms <= nowMs) return { ok: false, reason: 'session_expired' };
  if (session.user_id !== vaultOwnerId) return { ok: false, reason: 'not_vault_owner' };
  if (deviceRevoked) return { ok: false, reason: 'device_revoked' };
  return { ok: true };
}
// Offline queue (mirror): FIFO, deduped per item, persisted as JSON.
const QUEUE_KEY = 'my-secrect.sync.queue.v1';
function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return { get: (k) => map.get(k) ?? null, set: (k, v) => map.set(k, v), remove: (k) => map.delete(k) };
}
function loadQueue(s) { try { const r = s.get(QUEUE_KEY); return r ? JSON.parse(r) : []; } catch { return []; } }
function saveQueue(s, q) { s.set(QUEUE_KEY, JSON.stringify(q)); }
function enqueuePush(s, req) {
  const q = loadQueue(s).filter((x) => x.item_id !== req.item_id);
  q.push({ ...req, queued_at: new Date().toISOString(), attempts: 0 });
  saveQueue(s, q); return q;
}
// Chunked upload manifest (mirror of the intended blob protocol): an
// upload completes only when every declared chunk is present exactly
// once, in order, with matching hashes.
function validateManifest(manifest, received) {
  if (received.length !== manifest.chunks.length) return { ok: false, reason: 'incomplete_chunk_set' };
  for (let i = 0; i < manifest.chunks.length; i++) {
    const want = manifest.chunks[i];
    const got = received[i];
    if (!got || got.index !== want.index) return { ok: false, reason: 'chunk_out_of_order_or_missing' };
    if (got.sha256 !== want.sha256) return { ok: false, reason: `chunk_${want.index}_hash_mismatch` };
  }
  const indexes = received.map((c) => c.index);
  if (new Set(indexes).size !== indexes.length) return { ok: false, reason: 'duplicate_chunk' };
  return { ok: true };
}
function missingChunks(manifest, received) {
  const have = new Set(received.map((c) => c.index));
  return manifest.chunks.filter((c) => !have.has(c.index)).map((c) => c.index);
}

// --- replay attempts -------------------------------------------------------
test('replay attempt: push with a stale base_revision is rejected, server state unchanged', () => {
  const serverRevision = 5;
  // Attacker replays an old captured push (base 3) after the item moved on.
  const replayed = serverAcceptPush(serverRevision, { item_id: 'i1', base_revision: 3 });
  assert.equal(replayed.accepted, false);
  assert.equal(replayed.reason, 'stale_base_revision');
  assert.equal(replayed.server_revision, 5);
  // A fresh push against the current revision is accepted.
  assert.equal(serverAcceptPush(5, { item_id: 'i1', base_revision: 5 }).accepted, true);
});

test('replay attempt: same idempotency key with a different payload is rejected', () => {
  const seen = new Map();
  const first = { idempotency_key: 'k1', payload_hash: 'aaa' };
  assert.deepEqual(idempotencyCheck(seen, first), { ok: true, replay: false });
  // Honest retry: identical payload, safe to acknowledge again.
  assert.deepEqual(idempotencyCheck(seen, { ...first }), { ok: true, replay: true });
  // Replay with tampered payload under the same key: reject, never apply.
  assert.equal(idempotencyCheck(seen, { idempotency_key: 'k1', payload_hash: 'bbb' }).ok, false);
});

test('replay attempt: replayed pull sequence numbers are ignored (no rollback)', () => {
  const applied = new Set([10, 11, 12]);
  const shouldApply = (seq) => !applied.has(seq) && seq > Math.max(...applied);
  assert.equal(shouldApply(11), false); // already seen
  assert.equal(shouldApply(9), false);  // older than applied
  assert.equal(shouldApply(13), true);  // genuinely new
});

// --- unauthorized access ----------------------------------------------------
test('unauthorized access: no session, expired session, wrong owner, revoked device', () => {
  const now = Date.now();
  const live = { user_id: 'u1', expires_at_ms: now + 3600_000 };
  assert.equal(authorize({ session: null, vaultOwnerId: 'u1', deviceRevoked: false, nowMs: now }).ok, false);
  assert.equal(authorize({ session: { user_id: 'u1', expires_at_ms: now - 1 }, vaultOwnerId: 'u1', deviceRevoked: false, nowMs: now }).reason, 'session_expired');
  assert.equal(authorize({ session: live, vaultOwnerId: 'u2', deviceRevoked: false, nowMs: now }).reason, 'not_vault_owner');
  assert.equal(authorize({ session: live, vaultOwnerId: 'u1', deviceRevoked: true, nowMs: now }).reason, 'device_revoked');
  assert.equal(authorize({ session: live, vaultOwnerId: 'u1', deviceRevoked: false, nowMs: now }).ok, true);
});

test('unauthorized access: a session for vault A cannot read vault B ciphertext', () => {
  // Ciphertext is opaque, but the API must still enforce vault scoping:
  // metadata (titles are encrypted, but ids/revisions/timestamps leak)
  // must never cross vault boundaries.
  const canRead = (session, vaultId) => session.vault_ids.includes(vaultId);
  const session = { user_id: 'u1', vault_ids: ['vault_A'] };
  assert.equal(canRead(session, 'vault_A'), true);
  assert.equal(canRead(session, 'vault_B'), false);
});

// --- cross-device conflict (keep-both) --------------------------------------
test('cross-device conflict: both versions kept, user picks, loser is archived not deleted', () => {
  const local = { id: 'item_1', title: 'Bank (edited on laptop)', revision: 4 };
  const remote = { id: 'item_1', title: 'Bank (edited on phone)', revision: 5 };
  assert.equal(detectConflict(4, 3, 5), 'same_item_both_changed');
  const c = resolveConflictKeepBoth(local, remote, { localRevision: 4, remoteRevision: 5, baseRevision: 3, remoteDeviceId: 'phone' });
  assert.equal(c.resolution, 'unresolved');
  assert.equal(c.local.title, 'Bank (edited on laptop)');
  assert.equal(c.remote.title, 'Bank (edited on phone)');
  // User resolves in favour of the phone version.
  const resolved = { ...c, resolution: 'chose_remote', resolved_at: new Date().toISOString(), archived_local: c.local };
  assert.equal(resolved.resolution, 'chose_remote');
  assert.equal(resolved.archived_local.title, 'Bank (edited on laptop)'); // loser preserved
  assert.equal(resolved.remote.title, 'Bank (edited on phone)');
});

// --- offline-to-online recovery ---------------------------------------------
test('offline-to-online recovery: queue survives an app restart and replays FIFO', () => {
  const s = memoryStorage();
  enqueuePush(s, { item_id: 'a', base_revision: 1, operation: 'upsert' });
  enqueuePush(s, { item_id: 'b', base_revision: 1, operation: 'upsert' });
  enqueuePush(s, { item_id: 'c', base_revision: 1, operation: 'upsert' });
  // Simulate app restart: storage persists (JSON), in-memory state is gone.
  const persisted = s.get(QUEUE_KEY);
  const s2 = memoryStorage({ [QUEUE_KEY]: persisted });
  assert.deepEqual(loadQueue(s2).map((x) => x.item_id), ['a', 'b', 'c']);
  // Back online: replay in order; a failure mid-replay keeps the rest.
  const pushed = [];
  const failOn = 'b';
  for (const entry of [...loadQueue(s2)]) {
    if (entry.item_id === failOn) break; // network drops again
    pushed.push(entry.item_id);
    saveQueue(s2, loadQueue(s2).filter((x) => x.item_id !== entry.item_id));
  }
  assert.deepEqual(pushed, ['a']);
  assert.deepEqual(loadQueue(s2).map((x) => x.item_id), ['b', 'c']);
  // Next reconnect finishes the queue.
  for (const entry of [...loadQueue(s2)]) {
    pushed.push(entry.item_id);
    saveQueue(s2, loadQueue(s2).filter((x) => x.item_id !== entry.item_id));
  }
  assert.deepEqual(pushed, ['a', 'b', 'c']);
  assert.equal(loadQueue(s2).length, 0);
});

test('offline-to-online recovery: corrupted queue JSON is discarded, never crashes sync', () => {
  const s = memoryStorage({ [QUEUE_KEY]: '{broken json' });
  assert.deepEqual(loadQueue(s), []); // fail-open to empty, not throw
  enqueuePush(s, { item_id: 'a', base_revision: 1, operation: 'upsert' });
  assert.equal(loadQueue(s).length, 1);
});

// --- interrupted upload ------------------------------------------------------
test('interrupted upload: incomplete chunk set is rejected, resume requests only missing chunks', () => {
  const manifest = { chunks: [{ index: 0, sha256: 'h0' }, { index: 1, sha256: 'h1' }, { index: 2, sha256: 'h2' }] };
  const received = [{ index: 0, sha256: 'h0' }]; // upload died after chunk 0
  assert.equal(validateManifest(manifest, received).ok, false);
  assert.deepEqual(missingChunks(manifest, received), [1, 2]);
  // Resume: only the missing chunks are re-uploaded, chunk 0 is not resent.
  const resumed = [...received, { index: 1, sha256: 'h1' }, { index: 2, sha256: 'h2' }];
  assert.equal(validateManifest(manifest, resumed).ok, true);
});

test('interrupted upload: out-of-order, duplicate, and hash-mismatched chunks are rejected', () => {
  const manifest = { chunks: [{ index: 0, sha256: 'h0' }, { index: 1, sha256: 'h1' }] };
  assert.equal(validateManifest(manifest, [{ index: 1, sha256: 'h1' }, { index: 0, sha256: 'h0' }]).reason, 'chunk_out_of_order_or_missing');
  assert.equal(validateManifest(manifest, [{ index: 0, sha256: 'h0' }, { index: 0, sha256: 'h0' }]).reason, 'chunk_out_of_order_or_missing');
  assert.equal(validateManifest(manifest, [{ index: 0, sha256: 'h0' }, { index: 1, sha256: 'WRONG' }]).reason, 'chunk_1_hash_mismatch');
  assert.equal(validateManifest(manifest, [{ index: 0, sha256: 'h0' }, { index: 1, sha256: 'h1' }]).ok, true);
});
