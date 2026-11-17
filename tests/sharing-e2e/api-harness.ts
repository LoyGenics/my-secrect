/**
 * Boots the REAL Rails API (puma) against a fresh Postgres database for the
 * sharing e2e, and exposes psql / pg_dump to inspect what the server stored.
 *
 * RAILS_ENV=test (as tests/e2e-web/stack.ts): its only relevant effect is
 * that Rack::Attack throttles are off, so three passkey registrations and
 * sign-ins do not hit the 10/min limit. Authentication, WebAuthn
 * verification and every sharing endpoint are the production code paths.
 *
 * Defaults: API port 3221, database vault_sharing_e2e_agent10 (dropped and
 * recreated; the name must end in _agent10 so no other database is touched).
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(here, '../../apps/api');

export const PORT = Number(process.env.SHARING_E2E_PORT ?? 3221);
export const DB = process.env.SHARING_E2E_DB ?? 'vault_sharing_e2e_agent10';
export const WEB_ORIGIN = process.env.SHARING_E2E_WEB_ORIGIN ?? 'http://localhost:5321';
export const RP_ID = 'localhost';
export const API_BASE = `http://127.0.0.1:${PORT}/api`;

const pgUser = process.env.POSTGRES_USER ?? userInfo().username;
const pgHost = process.env.POSTGRES_HOST ?? 'localhost';
const railsLog = path.join(apiDir, 'log', 'test.log');

function railsEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    RBENV_VERSION: process.env.RBENV_VERSION ?? '3.3.6',
    RAILS_ENV: 'test',
    POSTGRES_USER: pgUser,
    DATABASE_URL: `postgresql://${pgUser}@${pgHost}:5432/${DB}`,
    PORT: String(PORT),
    WEBAUTHN_ORIGIN: WEB_ORIGIN,
    WEBAUTHN_RP_ID: RP_ID,
    CORS_ORIGINS: WEB_ORIGIN,
    // Placeholder storage (required by StorageProvider, never called here).
    S3_ENDPOINT: 'http://127.0.0.1:9',
    S3_REGION: 'us-east-1',
    S3_BUCKET: 'e2e-placeholder',
    S3_ACCESS_KEY: 'e2e-placeholder',
    S3_SECRET_KEY: 'e2e-placeholder',
  };
}

export function psql(sql: string): string {
  return execFileSync('psql', ['-h', pgHost, '-U', pgUser, '-d', DB, '-At', '-F', '|', '-c', sql], { encoding: 'utf8' }).trim();
}

/** Full data-only dump: grep this for plaintext markers. */
export function pgDump(): string {
  return execFileSync('pg_dump', ['-h', pgHost, '-U', pgUser, '-d', DB, '--data-only', '--inserts'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

export interface RunningApi {
  /** Everything the API process wrote to log/test.log during this run. */
  railsLogSinceBoot(): string;
  stop(): Promise<void>;
}

async function assertPortFree(): Promise<void> {
  try {
    await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(1000) });
  } catch {
    return;
  }
  throw new Error(`port ${PORT} is already in use; refusing to reuse an unknown server`);
}

export async function bootApi(): Promise<RunningApi> {
  if (!DB.endsWith('_agent10')) throw new Error(`refusing to drop ${DB}: the sharing e2e database name must end in _agent10`);
  await assertPortFree();
  const env = railsEnv();
  execFileSync('bundle', ['exec', 'rake', 'db:drop', 'db:create', 'db:schema:load'], { cwd: apiDir, env, stdio: 'pipe' });
  mkdirSync(path.join(here, '.out'), { recursive: true });
  const logOffset = existsSync(railsLog) ? statSync(railsLog).size : 0;
  const out = openSync(path.join(here, '.out', `api-${PORT}.log`), 'w');
  const child: ChildProcess = spawn('bundle', ['exec', 'puma', '-C', 'config/puma.rb'], { cwd: apiDir, env, detached: true, stdio: ['ignore', out, out] });
  const stop = () => new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.pid === undefined) return resolve();
    child.once('exit', () => resolve());
    try { process.kill(-child.pid, 'SIGTERM'); } catch { resolve(); }
    setTimeout(() => {
      try { if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
      resolve();
    }, 5000).unref();
  });
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break;
    } catch { /* not up yet */ }
    if (child.exitCode !== null) throw new Error(`API exited early (code ${child.exitCode}); see tests/sharing-e2e/.out/api-${PORT}.log`);
    if (Date.now() > deadline) {
      await stop();
      throw new Error('API did not become healthy within 90s');
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return {
    railsLogSinceBoot: () => (existsSync(railsLog) ? readFileSync(railsLog).subarray(logOffset).toString('utf8') : ''),
    stop,
  };
}
