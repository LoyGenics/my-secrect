/**
 * One REAL client device, as a separate process: the real desktop vault
 * (apps/desktop/src/vault.ts), the real media pipeline (apps/desktop/src/
 * utils/media.ts -> packages/storage), the real SDK and real libsodium.
 * The only host shim is what a browser provides: a FILE-BACKED localStorage
 * (DEVICE_STATE), so a respawned process is the same app restarted with its
 * persisted state, and a process with a new state file is a fresh device.
 *
 *   npx tsx tests/media-e2e/device.mts <command> '<json args>'
 *
 * stdout: one JSON line per event ({"event":"part","n":3}, {"event":"retry",..},
 * {"event":"chunk","done":4,"total":16}) and a final {"ok":true,"result":..}
 * or {"ok":false,"error":".."}. Env: DEVICE_STATE, E2E_API, E2E_TOKEN.
 */
import { existsSync, openAsBlob, readFileSync, writeFileSync } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const stateFile = process.env.DEVICE_STATE!;
const store: Record<string, string> = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
const persist = () => writeFileSync(stateFile, JSON.stringify(store));
(globalThis as any).localStorage = {
  getItem: (k: string) => (k in store ? store[k] : null),
  setItem: (k: string, v: string) => { store[k] = String(v); persist(); },
  removeItem: (k: string) => { delete store[k]; persist(); },
  key: (i: number) => Object.keys(store)[i] ?? null,
  get length() { return Object.keys(store).length; },
};

// Count the PUTs that actually leave this process (instrumentation only: the real fetch runs).
let puts = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: any, init?: RequestInit) => {
  if (init?.method === 'PUT') puts++;
  return realFetch(input, init);
}) as typeof fetch;

const emit = (o: unknown) => process.stdout.write(JSON.stringify(o) + '\n');

// Memory while a transfer runs, sampled every 25 ms:
//  - rss: what the OS sees (includes garbage not yet collected and allocator slack);
//  - live: heapUsed + external right after a forced GC (needs --expose-gc) =
//    what the process actually still holds.
const MiBf = (n: number) => +(n / 2 ** 20).toFixed(1);
const live = () => { (globalThis as any).gc?.(); const m = process.memoryUsage(); return m.heapUsed + m.external; };
const sampler = () => {
  const rss0 = process.memoryUsage().rss;
  const live0 = live();
  let rssPeak = rss0;
  let livePeak = live0;
  const t = setInterval(() => {
    rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
    livePeak = Math.max(livePeak, live());
  }, 25);
  return () => {
    clearInterval(t);
    return {
      gcForced: typeof (globalThis as any).gc === 'function',
      rssBaselineMiB: MiBf(rss0), rssPeakMiB: MiBf(rssPeak), rssGrowthMiB: MiBf(rssPeak - rss0),
      liveBaselineMiB: MiBf(live0), livePeakMiB: MiBf(livePeak), liveGrowthMiB: MiBf(livePeak - live0),
    };
  };
};

async function main() {
  const [cmd, rawArgs] = process.argv.slice(2);
  const args = JSON.parse(rawArgs ?? '{}');
  const vault = await import('../../apps/desktop/src/vault.ts');
  const media = await import('../../apps/desktop/src/utils/media.ts');
  const storage = await import('../../packages/storage/src/upload.ts');
  const { libsodiumAdapter } = await import('../../packages/crypto-adapters/src/index.ts');
  const { VaultApiClient } = await import('../../packages/sdk/src/index.ts');
  const api = new VaultApiClient({ baseUrl: process.env.E2E_API!, getToken: async () => process.env.E2E_TOKEN! });
  const transfer = {
    concurrency: args.concurrency ?? 4,
    attempts: args.attempts ?? 3,
    backoffMs: args.backoffMs ?? 300,
    onPartUploaded: (n: number) => emit({ event: 'part', n }),
    onRetry: (r: unknown) => emit({ event: 'retry', ...(r as object) }),
  };
  const unlock = async () => { if (!(await vault.unlockVault(args.passphrase))) throw new Error('wrong passphrase'); };

  switch (cmd) {
    case 'create-vault': {
      await vault.createVault(args.passphrase);
      return { backup: vault.exportEncrypted() };
    }
    case 'restore': {
      if (vault.hasVault()) throw new Error('not a fresh device');
      await vault.restoreEncrypted(args.backup, { passphrase: args.passphrase });
      return { restored: true };
    }
    case 'upload': {
      await unlock();
      const blob = await openAsBlob(args.path, { type: args.mime });
      const file = new File([blob], args.name, { type: args.mime });
      const stop = sampler();
      const t0 = performance.now();
      const r = await media.uploadMediaFile({
        api, file, withVaultKey: vault.withVaultKey,
        resumeStore: storage.webStorageResumeStore(localStorage),
        makeEncryptedMetadataB64: () => vault.encryptWithVaultKey(JSON.stringify({ name: 'My vault' })),
        transfer,
      });
      const ms = performance.now() - t0;
      await vault.upsertItem(r.item);
      return { item: r.item, resumedParts: r.resumedParts, puts, ms: Math.round(ms), memory: stop() };
    }
    case 'download': {
      // The app path: verified chunks assembled in memory, released only when everything checked.
      await unlock();
      const got = await media.downloadMediaItem({ api, item: args.item, withVaultKey: vault.withVaultKey, transfer: { ...transfer, onProgress: (done: number, total: number) => emit({ event: 'chunk', done, total }) } });
      const bytes = new Uint8Array(await got.blob.arrayBuffer());
      writeFileSync(args.out, bytes);
      return { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), sha256Matches: got.sha256Matches, fileName: got.fileName };
    }
    case 'download-stream': {
      // Streaming to disk with bounded memory: verified plaintext goes to <out>.partial,
      // renamed to <out> only after every check passed; deleted on any failure.
      await unlock();
      const info = media.mediaInfoFromItem(args.item)!;
      const tmp = `${args.out}.partial`;
      const fh = await open(tmp, 'w', 0o600);
      const hash = createHash('sha256');
      let size = 0;
      const stop = sampler();
      const t0 = performance.now();
      try {
        await vault.withVaultKey((vaultKey) => storage.downloadToSink(api, info.blob_id, vaultKey, libsodiumAdapter, {
          write: async (c) => { hash.update(c); size += c.length; await fh.write(c); },
          abort: async () => { await fh.close(); await rm(tmp, { force: true }); },
        }, { ...transfer, onProgress: (done, total) => emit({ event: 'chunk', done, total }) }));
      } catch (e) {
        await rm(tmp, { force: true });
        throw e;
      }
      const ms = performance.now() - t0;
      await fh.close();
      await rename(tmp, args.out);
      return { size, sha256: hash.digest('hex'), ms: Math.round(ms), memory: stop() };
    }
    case 'resume-records': {
      return { keys: Object.keys(store).filter((k) => k.startsWith(storage.RESUME_KEY_PREFIX)), raw: Object.entries(store).filter(([k]) => k.startsWith(storage.RESUME_KEY_PREFIX)).map(([, v]) => v) };
    }
    default:
      throw new Error(`unknown command ${cmd}`);
  }
}

main().then(
  (result) => { emit({ ok: true, result }); process.exit(0); },
  (err) => { emit({ ok: false, error: err instanceof Error ? err.message : String(err) }); process.exit(1); },
);
