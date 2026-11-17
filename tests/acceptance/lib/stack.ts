/**
 * Real stack for acceptance tests: Rails API (puma, real Postgres, real
 * WebAuthn verification, RAILS_ENV=test only so Rack::Attack throttling is
 * off), the apps/web Vite dev server, and — when a test needs object
 * storage — a throwaway MinIO container. Nothing here mocks the API.
 *
 * Safety rails: the database name must end in `_a15_e2eauth` (it is dropped
 * and recreated); docker resources are named `a15-accept-*` and removed on
 * stop; only processes started here are ever killed.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '../../..');
const apiDir = path.join(repoRoot, 'apps/api');
const webDir = path.join(repoRoot, 'apps/web');
export const logDir = path.join(repoRoot, 'tests/acceptance/.logs');

export interface S3Config { endpoint: string; bucket: string; accessKey: string; secretKey: string }

export interface ApiOptions { port: number; db: string; webOrigin: string; s3?: S3Config }

export interface RunningApi {
  url: string; // http://localhost:PORT
  apiBase: string; // .../api (what clients use)
  db: string;
  /** Action Mailer :file delivery target: one file per recipient address. */
  mailDir: string;
  psql(sql: string): string;
  stop(): Promise<void>;
}

function pgUser(): string { return process.env.POSTGRES_USER ?? userInfo().username; }
function dbUrl(db: string): string {
  const host = process.env.POSTGRES_HOST ?? 'localhost';
  const port = process.env.POSTGRES_PORT ?? '5432';
  return `postgresql://${pgUser()}@${host}:${port}/${db}`;
}

export function psqlOn(db: string, sql: string): string {
  return execFileSync('psql', [dbUrl(db), '-At', '-F', '|', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' }).trim();
}

async function waitFor(url: string, label: string, child: ChildProcess, ms = 90_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${label} exited early (${child.exitCode}); see ${logDir}`);
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${label} not ready at ${url} within ${ms}ms`);
}

async function assertPortFree(port: number, label: string): Promise<void> {
  try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) }); } catch { return; }
  throw new Error(`${label} port ${port} already in use; refusing to talk to an unknown server`);
}

function killTree(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.pid === undefined) return resolve();
    child.once('exit', () => resolve());
    try { process.kill(-child.pid, 'SIGTERM'); } catch { resolve(); }
    setTimeout(() => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } resolve(); }, 5000).unref();
  });
}

export async function startApi(o: ApiOptions): Promise<RunningApi> {
  if (!o.db.endsWith('_a15_e2eauth')) throw new Error(`acceptance DB must end with _a15_e2eauth (got ${o.db})`);
  mkdirSync(logDir, { recursive: true });
  await assertPortFree(o.port, 'API');
  const mailDir = path.join(logDir, `mail-${o.port}`);
  rmSync(mailDir, { recursive: true, force: true });
  mkdirSync(mailDir, { recursive: true });
  const s3 = o.s3 ?? { endpoint: 'http://127.0.0.1:9', bucket: 'placeholder', accessKey: 'placeholder', secretKey: 'placeholder' };
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RBENV_VERSION: process.env.RBENV_VERSION ?? '3.3.6',
    RAILS_ENV: 'test',
    POSTGRES_USER: pgUser(),
    DATABASE_URL: dbUrl(o.db),
    PORT: String(o.port),
    WEBAUTHN_RP_ID: 'localhost',
    WEBAUTHN_ORIGIN: o.webOrigin,
    CORS_ORIGINS: o.webOrigin,
    // Sign-up codes are written to files the tests read (Action Mailer :file).
    MAIL_FILE_DIR: mailDir,
    S3_ENDPOINT: s3.endpoint,
    S3_PUBLIC_ENDPOINT: s3.endpoint,
    S3_REGION: 'us-east-1',
    S3_BUCKET: s3.bucket,
    S3_ACCESS_KEY: s3.accessKey,
    S3_SECRET_KEY: s3.secretKey,
  };
  execFileSync('bundle', ['exec', 'rake', 'db:drop', 'db:create', 'db:schema:load'], {
    cwd: apiDir, env, stdio: ['ignore', openSync(path.join(logDir, `db-${o.db}.log`), 'w'), 'inherit'],
  });
  const log = openSync(path.join(logDir, `api-${o.port}.log`), 'w');
  const child = spawn('bundle', ['exec', 'puma', '-C', 'config/puma.rb'], { cwd: apiDir, env, detached: true, stdio: ['ignore', log, log] });
  try {
    await waitFor(`http://localhost:${o.port}/health`, 'API', child);
  } catch (e) { await killTree(child); throw e; }
  return {
    url: `http://localhost:${o.port}`,
    apiBase: `http://localhost:${o.port}/api`,
    db: o.db,
    mailDir,
    psql: (sql) => psqlOn(o.db, sql),
    stop: () => killTree(child),
  };
}

export async function startWeb(port: number): Promise<{ url: string; stop(): Promise<void> }> {
  mkdirSync(logDir, { recursive: true });
  await assertPortFree(port, 'web');
  const log = openSync(path.join(logDir, `web-${port}.log`), 'w');
  const child = spawn(path.join(repoRoot, 'node_modules/.bin/vite'), ['--host', 'localhost', '--port', String(port), '--strictPort'], {
    cwd: webDir, env: process.env, detached: true, stdio: ['ignore', log, log],
  });
  try {
    await waitFor(`http://localhost:${port}/`, 'web', child);
  } catch (e) { await killTree(child); throw e; }
  return { url: `http://localhost:${port}`, stop: () => killTree(child) };
}

// ---------------------------------------------------------------- MinIO (optional)

const MINIO_IMAGE = process.env.MINIO_IMAGE ?? 'cgr.dev/chainguard/minio:latest';
const MC_IMAGE = process.env.MC_IMAGE ?? 'cgr.dev/chainguard/minio-client:latest';

export interface RunningMinio extends S3Config { listKeys(): string[]; stop(): Promise<void> }

function docker(args: string[], opts: { allowFail?: boolean } = {}): string {
  try {
    return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    if (opts.allowFail) return '';
    throw e;
  }
}

/** Returns null when docker or the image is unavailable (the caller records the gap). */
export async function startMinio(hostPort: number, corsOrigin: string): Promise<RunningMinio | null> {
  try { docker(['image', 'inspect', MINIO_IMAGE]); docker(['image', 'inspect', MC_IMAGE]); } catch { return null; }
  const name = `a15-accept-minio-${hostPort}`;
  const net = `a15-accept-net-${hostPort}`;
  const accessKey = `a15${Math.random().toString(36).slice(2, 10)}`;
  const secretKey = `s${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  const bucket = 'a15-accept-blobs';
  docker(['rm', '-f', name], { allowFail: true });
  docker(['network', 'rm', net], { allowFail: true });
  docker(['network', 'create', net]);
  docker(['run', '-d', '--name', name, '--network', net, '-p', `127.0.0.1:${hostPort}:9000`,
    '-e', `MINIO_ROOT_USER=${accessKey}`, '-e', `MINIO_ROOT_PASSWORD=${secretKey}`,
    '-e', `MINIO_API_CORS_ALLOW_ORIGIN=${corsOrigin}`, MINIO_IMAGE, 'server', '/data']);
  const mcEnv = `MC_HOST_local=http://${accessKey}:${secretKey}@${name}:9000`;
  const mc = (...args: string[]) => docker(['run', '--rm', '--network', net, '-e', mcEnv, MC_IMAGE, ...args]);
  const stop = async () => { docker(['rm', '-f', name], { allowFail: true }); docker(['network', 'rm', net], { allowFail: true }); };
  for (let i = 0; ; i++) {
    try { mc('mb', '--ignore-existing', `local/${bucket}`); break; } catch (e) {
      if (i > 30) { await stop(); throw e; }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return {
    endpoint: `http://localhost:${hostPort}`, bucket, accessKey, secretKey,
    listKeys: () => mc('ls', '--recursive', `local/${bucket}`).split('\n').filter(Boolean).map((l) => l.trim().split(/\s+/).pop()!),
    stop,
  };
}

// ---------------------------------------------------------------- mail (sign-up codes)

/** Every sign-up code mailed to `email`, oldest first. */
export function mailCodes(mailDir: string, email: string): string[] {
  try { return [...readFileSync(path.join(mailDir, email), 'utf8').matchAll(/verification code is (\d{6})/g)].map((m) => m[1]); }
  catch { return []; }
}

/** Wait until more than `seen` codes were mailed to `email`; return the newest. */
export async function waitForMailCode(mailDir: string, email: string, seen = 0, ms = 15_000): Promise<string> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const codes = mailCodes(mailDir, email);
    if (codes.length > seen) return codes[codes.length - 1];
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no sign-up code was mailed to ${email}`);
}
