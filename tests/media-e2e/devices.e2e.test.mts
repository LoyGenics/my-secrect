// Real-stack media tests with REAL client processes (tests/media-e2e/device.mts:
// real desktop vault + media pipeline + SDK + libsodium, file-backed
// localStorage). Run via tests/media-e2e/run.sh, which boots the compose stack.
//
//  - two devices: A uploads, B (fresh process restored from A's encrypted
//    vault backup — the same Vault Key, no other shared state) decrypts;
//  - kill mid-upload (SIGKILL) and resume from a new process;
//  - storage restarted mid-upload: parts retry with backoff and finish;
//  - storage gone mid-download: fails closed, nothing written; works again after;
//  - large file (E2E_LARGE_MIB, default 96 MiB) streamed both ways with
//    bounded memory and recorded timings.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, mkdtempSync, openSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { s3Admin } from './s3-admin.mts';
import { libsodiumAdapter } from '../../packages/crypto-adapters/src/index';
import { VaultApiClient } from '../../packages/sdk/src/index';
import { prepareUpload, runUpload, BlobUploadError, type FetchLike } from '../../packages/storage/src/upload';

const here = path.dirname(fileURLToPath(import.meta.url));
const need = (n: string) => { const v = process.env[n]; if (!v) throw new Error(`${n} is required (run via tests/media-e2e/run.sh)`); return v; };
need('E2E_API'); need('E2E_TOKEN');
const VAULT = need('E2E_VAULT_ID');
const MINIO = need('E2E_MINIO_CONTAINER');
const DB = need('E2E_DB_CONTAINER');
const REDIS = need('E2E_REDIS_CONTAINER');
const WORKER = need('E2E_WORKER_CONTAINER');
const PASS = 'correct horse battery staple 9';
const MiB = 1024 * 1024;
const dir = mkdtempSync(path.join(tmpdir(), 'media-devices-'));
const stateA = path.join(dir, 'device-a.json');

type Event = Record<string, any>;
interface Run { events: Event[]; result?: any; error?: string; code: number | null; signal: NodeJS.Signals | null }

/** Spawn a device process; `onEvent` may return 'kill' to SIGKILL it right there. */
function device(state: string, cmd: string, args: object, onEvent?: (e: Event) => 'kill' | void): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--expose-gc', '--import', 'tsx', path.join(here, 'device.mts'), cmd, JSON.stringify(args)], {
      env: { ...process.env, DEVICE_STATE: state }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const run: Run = { events: [], code: null, signal: null };
    let buf = '';
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const e = JSON.parse(line);
        if ('ok' in e) { if (e.ok) run.result = e.result; else run.error = e.error; continue; }
        run.events.push(e);
        if (onEvent?.(e) === 'kill') child.kill('SIGKILL');
      }
    });
    child.on('exit', (code, signal) => {
      run.code = code; run.signal = signal;
      if (code !== 0 && !signal && !run.error) run.error = stderr.slice(-2000);
      resolve(run);
    });
  });
}
const ok = (r: Run, what: string) => { assert.equal(r.error, undefined, `${what}: ${r.error}`); assert.equal(r.code, 0, what); return r.result; };

/** A random file streamed to disk (never held whole in this process either). */
function makeFile(name: string, size: number): { path: string; sha256: string } {
  const p = path.join(dir, name);
  const fd = openSync(p, 'w');
  const h = createHash('sha256');
  for (let off = 0; off < size; off += MiB) {
    const b = randomBytes(Math.min(MiB, size - off));
    if (off === 0) b.write('PLAINTEXT-MARKER-0001', 64); // something recognisable at a known place
    h.update(b); writeSync(fd, b);
  }
  closeSync(fd);
  return { path: p, sha256: h.digest('hex') };
}
async function sha256File(p: string): Promise<string> {
  const h = createHash('sha256');
  for await (const c of createReadStream(p)) h.update(c as Buffer);
  return h.digest('hex');
}
const docker = (...a: string[]) => execFileSync('docker', a, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
async function minioHealthy() {
  for (let i = 0; i < 60; i++) {
    try { await s3Admin().list('vaults/'); return; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  throw new Error('minio did not come back');
}

let joinBackup = ''; // A's encrypted backup of its (empty) vault = the key envelope a second device joins with
before(async () => {
  joinBackup = ok(await device(stateA, 'create-vault', { passphrase: PASS }), 'A creates its vault').backup;
});

test('two devices: B, restored from A\'s encrypted backup, downloads and decrypts a file A uploaded', async () => {
  const f = makeFile('two-devices.bin', 5 * MiB + 321);
  const up = ok(await device(stateA, 'upload', { passphrase: PASS, path: f.path, name: 'passport-scan.pdf', mime: 'application/pdf' }), 'A uploads');
  assert.equal(up.resumedParts, 0);
  assert.equal(up.puts, 6, '6 chunk PUTs (no thumbnail for a PDF)');
  const item = up.item;
  assert.match(item.fields.blob_id, /^[0-9a-f-]{36}$/);
  assert.equal(item.fields.sha256, f.sha256, 'item records the plaintext SHA-256 from the manifest');

  // What the server holds says nothing about the file: opaque manifest, ciphertext parts.
  const stored = await s3Admin().list(`vaults/${VAULT}/blobs/${item.fields.blob_id}/`);
  assert.equal(stored.length, 6);
  const first = await s3Admin().get(stored[0].key);
  assert.ok(!Buffer.from(first!).includes('PLAINTEXT-MARKER-0001'), 'stored part 1 is ciphertext');

  // Device B: a NEW process with an EMPTY state file. Its only link to A is the encrypted
  // vault backup + passphrase (how a second device joins, as in the sync e2e) and the item
  // (which sync carries, encrypted, in normal use).
  const stateB = path.join(dir, 'device-b.json');
  assert.ok(!existsSync(stateB));
  ok(await device(stateB, 'restore', { backup: joinBackup, passphrase: PASS }), 'B restores');
  const out = path.join(dir, 'b-download.pdf');
  const got = ok(await device(stateB, 'download', { passphrase: PASS, item, out }), 'B downloads');
  assert.equal(got.sha256, f.sha256, 'B decrypted exactly the bytes A uploaded');
  assert.equal(got.sha256Matches, true);
  assert.equal(got.fileName, 'passport-scan.pdf');

  // A device with a different vault (different Vault Key) cannot open it.
  const stateC = path.join(dir, 'device-c.json');
  ok(await device(stateC, 'create-vault', { passphrase: PASS }), 'C creates its own vault');
  const c = await device(stateC, 'download', { passphrase: PASS, item, out: path.join(dir, 'c.pdf') });
  assert.ok(c.error, 'a different vault cannot decrypt');
  assert.ok(!existsSync(path.join(dir, 'c.pdf')));
});

test('SIGKILL mid-upload, then a NEW process resumes: only the parts storage lacks are sent', async () => {
  const f = makeFile('killed.mov', 24 * MiB + 1000);
  const first = await device(stateA, 'upload', { passphrase: PASS, path: f.path, name: 'holiday.mov', mime: 'video/quicktime', concurrency: 1 },
    (e) => (e.event === 'part' && e.n === 8 ? 'kill' : undefined));
  assert.equal(first.signal, 'SIGKILL', 'the uploading process was killed');
  const sentBeforeKill = first.events.filter((e) => e.event === 'part').length;
  assert.ok(sentBeforeKill >= 8 && sentBeforeKill < 25, `killed mid-way (${sentBeforeKill} parts confirmed)`);

  // The only thing left behind on the device: a resume record with no plaintext metadata.
  const rec = ok(await device(stateA, 'resume-records', {}), 'records');
  assert.equal(rec.keys.length, 1);
  assert.ok(!rec.raw[0].includes('holiday.mov') && !rec.raw[0].includes('video/quicktime'), 'resume record holds no file name or type');
  const blobId = JSON.parse(rec.raw[0]).blob_id;
  const inStorage = (await s3Admin().list(`vaults/${VAULT}/blobs/${blobId}/`)).length;
  assert.ok(inStorage >= 8 && inStorage < 25, `${inStorage} parts in storage before resume`);

  const second = ok(await device(stateA, 'upload', { passphrase: PASS, path: f.path, name: 'holiday.mov', mime: 'video/quicktime' }), 'resume');
  assert.equal(second.item.fields.blob_id, blobId, 'same blob, not a new upload');
  assert.equal(second.resumedParts, inStorage, 'server-confirmed parts were skipped');
  assert.equal(second.puts, 25 - inStorage, 'only the missing parts were PUT');
  assert.deepEqual(ok(await device(stateA, 'resume-records', {}), 'records').keys, [], 'record removed after complete');
  const got = ok(await device(stateA, 'download', { passphrase: PASS, item: second.item, out: path.join(dir, 'resumed.mov') }), 'download');
  assert.equal(got.sha256, f.sha256);
  console.log(`[kill+resume] killed after ${sentBeforeKill} confirmed parts; storage held ${inStorage}; resume sent ${second.puts} of 25`);
});

test('storage restarted mid-upload: failed parts are retried with backoff and the upload completes', async () => {
  const f = makeFile('retry.bin', 16 * MiB);
  let restarted = false;
  const run = await device(stateA, 'upload', { passphrase: PASS, path: f.path, name: 'retry.bin', mime: 'application/octet-stream', concurrency: 2, attempts: 8, backoffMs: 400 },
    (e) => { if (e.event === 'part' && e.n >= 4 && !restarted) { restarted = true; docker('restart', '-t', '0', MINIO); } });
  const r = ok(run, 'upload across a storage restart');
  const retries = run.events.filter((e) => e.event === 'retry');
  assert.ok(restarted);
  assert.ok(retries.length > 0, 'at least one part failed and was retried');
  for (const x of retries) assert.equal(x.delayMs, 400 * 2 ** (x.attempt - 1), 'exponential backoff');
  await minioHealthy();
  const got = ok(await device(stateA, 'download', { passphrase: PASS, item: r.item, out: path.join(dir, 'retry.out') }), 'download');
  assert.equal(got.sha256, f.sha256);
  console.log(`[retry] ${retries.length} retries during the restart: ${retries.map((x) => `part ${x.partNumber} attempt ${x.attempt} (${x.error.slice(0, 40)}) +${x.delayMs}ms`).join('; ')}`);
});

test('storage gone mid-download: fails closed with a clear error, nothing is written; works again once storage is back', async () => {
  const f = makeFile('gone.bin', 16 * MiB);
  const up = ok(await device(stateA, 'upload', { passphrase: PASS, path: f.path, name: 'gone.bin', mime: 'application/octet-stream' }), 'upload');
  const out = path.join(dir, 'gone.out');
  let stopped = false;
  try {
    const r = await device(stateA, 'download-stream', { passphrase: PASS, item: up.item, out, concurrency: 1, attempts: 2, backoffMs: 200 },
      (e) => { if (e.event === 'chunk' && e.done === 4 && !stopped) { stopped = true; docker('stop', '-t', '0', MINIO); } });
    assert.ok(stopped);
    assert.ok(r.error, 'download must fail');
    assert.match(r.error!, /download part \d+ failed — attempt 1: .*; attempt 2: /);
    assert.ok(!existsSync(out), 'no output file');
    assert.ok(!existsSync(`${out}.partial`), 'partial plaintext removed');
    console.log(`[download-cut] after ${r.events.filter((e) => e.event === 'chunk').length} verified chunks: ${r.error}`);
  } finally {
    docker('start', MINIO);
    await minioHealthy();
  }
  const again = ok(await device(stateA, 'download-stream', { passphrase: PASS, item: up.item, out }), 'download again');
  assert.equal(again.sha256, f.sha256);
});

test('tampered chunk in storage: streaming download fails closed, nothing written', async () => {
  const f = makeFile('tamper.bin', 6 * MiB);
  const up = ok(await device(stateA, 'upload', { passphrase: PASS, path: f.path, name: 'tamper.bin', mime: 'application/octet-stream' }), 'upload');
  const key = `vaults/${VAULT}/blobs/${up.item.fields.blob_id}/part-00005`;
  const obj = await s3Admin().get(key);
  const bad = new Uint8Array(obj!); bad[99] ^= 1;
  await s3Admin().put(key, bad);
  const out = path.join(dir, 'tamper.out');
  const r = await device(stateA, 'download-stream', { passphrase: PASS, item: up.item, out });
  assert.match(r.error!, /chunk 5 hash mismatch/);
  assert.equal(r.events.filter((e) => e.event === 'chunk').length, 4, 'chunks 1-4 verified, then stop');
  assert.ok(!existsSync(out) && !existsSync(`${out}.partial`), 'nothing left on disk');
});

test(`large file (${process.env.E2E_LARGE_MIB ?? 96} MiB) streams through the real stack with bounded memory`, async () => {
  const mem = (m: any) => `live (post-GC heap+external) ${m.liveBaselineMiB} -> ${m.livePeakMiB} MiB (+${m.liveGrowthMiB}); RSS ${m.rssBaselineMiB} -> ${m.rssPeakMiB} MiB (+${m.rssGrowthMiB})`;
  const roundTrip = async (mibWanted: number) => {
    const size = mibWanted * MiB + 12345;
    const f = makeFile(`large-${mibWanted}.bin`, size);
    const up = ok(await device(stateA, 'upload', { passphrase: PASS, path: f.path, name: `large-${mibWanted}.bin`, mime: 'application/octet-stream' }), 'upload');
    const out = path.join(dir, `large-${mibWanted}.out`);
    const down = ok(await device(stateA, 'download-stream', { passphrase: PASS, item: up.item, out }), 'download');
    assert.equal(down.size, size);
    assert.equal(await sha256File(out), f.sha256, 'bytes identical after the round trip');
    const mib = size / MiB;
    console.log(`[large] ${mib.toFixed(1)} MiB (${Math.ceil(size / MiB)} parts)`);
    console.log(`[large]   upload   ${up.ms} ms = ${(mib / (up.ms / 1000)).toFixed(1)} MiB/s (two local encrypt passes + PUTs); ${mem(up.memory)}`);
    console.log(`[large]   download ${down.ms} ms = ${(mib / (down.ms / 1000)).toFixed(1)} MiB/s (verify + decrypt + write to disk); ${mem(down.memory)}`);
    assert.ok(up.memory.gcForced && down.memory.gcForced, 'device ran with --expose-gc');
    return { mib, up: up.memory, down: down.memory };
  };
  const small = await roundTrip(24);
  const large = await roundTrip(Number(process.env.E2E_LARGE_MIB ?? 96));
  // Bounded = memory does not grow with the file. What the process holds after
  // GC is a few chunks in flight; quadrupling the file must not move it by more
  // than a few chunks (holding the file whole would add >= 72 MiB here).
  // RSS also carries garbage not yet collected and allocator slack: reported,
  // and only checked to stay below the file size.
  for (const dir of ['up', 'down'] as const) {
    assert.ok(large[dir].liveGrowthMiB - small[dir].liveGrowthMiB < 12, `${dir}: live growth ${small[dir].liveGrowthMiB} -> ${large[dir].liveGrowthMiB} MiB must not scale with size`);
    assert.ok(large[dir].liveGrowthMiB < large.mib / 2, `${dir}: live growth ${large[dir].liveGrowthMiB} MiB`);
    assert.ok(large[dir].rssGrowthMiB < large.mib, `${dir}: RSS growth ${large[dir].rssGrowthMiB} MiB below the file size`);
  }
});

test('the worker schedules the hourly orphan sweep at boot; the sweep deletes an abandoned session\'s objects from real MinIO', async () => {
  // Sidekiq's scheduled set holds the first run the worker enqueued at boot (config/initializers/sidekiq.rb).
  let scheduled = '';
  for (let i = 0; i < 40 && !scheduled.includes('OrphanBlobCleanupJob'); i++) {
    scheduled = docker('exec', REDIS, 'redis-cli', 'ZRANGE', 'schedule', '0', '-1');
    if (!scheduled.includes('OrphanBlobCleanupJob')) await new Promise((r) => setTimeout(r, 500));
  }
  assert.match(scheduled, /OrphanBlobCleanupJob/, 'worker scheduled the sweep');
  assert.match(docker('exec', REDIS, 'redis-cli', 'GET', 'my-secrect:production:orphan_blob_cleanup:next_run'), /^\d+$/, 'chain claim present');

  // An upload abandoned after 2 of 3 parts…
  const api = new VaultApiClient({ baseUrl: process.env.E2E_API!, getToken: async () => process.env.E2E_TOKEN! });
  const vaultKey = libsodiumAdapter.randomBytes(32);
  const p = await prepareUpload({ api, vaultId: VAULT, vaultKey, crypto: libsodiumAdapter, data: randomBytes(2 * MiB + 5), fileName: 'a', mimeType: 'x/y' });
  const dropPart3: FetchLike = (url, init) => (url.includes('part-00003') ? Promise.reject(new TypeError('network down')) : fetch(url, init));
  await assert.rejects(runUpload(api, p, { vaultKey, crypto: libsodiumAdapter }, { fetchImpl: dropPart3, attempts: 1 }), BlobUploadError);
  const prefix = `vaults/${VAULT}/blobs/${p.blobId}/`;
  assert.equal((await s3Admin().list(prefix)).length, 2);
  // …whose session has expired (24 h, shortened here in the DB).
  docker('exec', DB, 'psql', '-U', 'vault', '-d', 'vault_production', '-qtAc', `UPDATE blobs SET upload_expires_at = now() - interval '1 minute' WHERE id = '${p.blobId}'`);
  const out = docker('exec', WORKER, 'bundle', 'exec', 'rake', 'blobs:cleanup');
  const summary = JSON.parse(out.split('\n').filter((l) => l.startsWith('{')).pop()!);
  assert.equal(summary.expired_blobs, 1);
  assert.equal(summary.deleted_keys, 3, 'two stored parts + the never-uploaded part 3 key (idempotent delete)');
  assert.deepEqual(await s3Admin().list(prefix), [], 'objects deleted from MinIO');
  assert.equal(docker('exec', DB, 'psql', '-U', 'vault', '-d', 'vault_production', '-qtAc', `SELECT count(*) FROM blobs WHERE id = '${p.blobId}'`), '0');
  console.log(`[cleanup] worker schedule has OrphanBlobCleanupJob; rake blobs:cleanup in the worker container -> ${JSON.stringify(summary)}`);
});
