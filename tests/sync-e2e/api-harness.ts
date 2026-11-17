/**
 * Boots the REAL Rails API (puma, development env) against a fresh Postgres
 * database and exposes `psql` for inspecting what the server actually stored.
 * Ports/DB: API 3102, database vault_e2e_sync (override with SYNC_E2E_PORT).
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(here, '../../apps/api');

export const PORT = Number(process.env.SYNC_E2E_PORT ?? 3102);
export const DB = process.env.SYNC_E2E_DB ?? 'vault_e2e_sync';
export const WEB_ORIGIN = process.env.SYNC_E2E_WEB_ORIGIN ?? 'http://localhost:5202';
export const RP_ID = 'localhost';
// Action Mailer :file delivery target (development env honours MAIL_FILE_DIR):
// clients read the sign-up code from here, exactly as a user reads their inbox.
export const MAIL_DIR = process.env.SYNC_E2E_MAIL_DIR ?? path.join(here, '.out', `mail-${PORT}`);
// Local default: the Homebrew Postgres unix socket in /tmp. CI sets
// POSTGRES_HOST=localhost (TCP, trust auth) and POSTGRES_USER.
const PG_HOST = process.env.POSTGRES_HOST ?? '/tmp';
const PG_PORT = process.env.POSTGRES_PORT ?? '5432';
function pgUser(): string { return process.env.POSTGRES_USER ?? execFileSync('whoami').toString().trim(); }
function pgArgs(): string[] { return ['-h', PG_HOST, '-p', PG_PORT, '-U', pgUser(), '-d', DB]; }

function railsEnv(): NodeJS.ProcessEnv {
  const user = pgUser();
  return {
    ...process.env,
    RBENV_VERSION: process.env.RBENV_VERSION ?? '3.3.6',
    POSTGRES_USER: user,
    POSTGRES_HOST: PG_HOST,
    RAILS_ENV: 'development',
    DATABASE_URL: PG_HOST.startsWith('/')
      ? `postgresql:///${DB}?host=${PG_HOST}`
      : `postgresql://${user}@${PG_HOST}:${PG_PORT}/${DB}`,
    WEBAUTHN_ORIGIN: WEB_ORIGIN,
    WEBAUTHN_RP_ID: RP_ID,
    CORS_ORIGINS: WEB_ORIGIN,
    MAIL_FILE_DIR: MAIL_DIR,
  };
}

export function psql(sql: string): string {
  return execFileSync('psql', [...pgArgs(), '-At', '-F', '|', '-c', sql], { encoding: 'utf8' }).trim();
}

/** Full data-only dump: grep this for plaintext markers. */
export function pgDump(): string {
  return execFileSync('pg_dump', [...pgArgs(), '--data-only', '--inserts'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

export interface RunningApi { baseUrl: string; apiBase: string; logPath: string; stop(): Promise<void> }

export async function bootApi(): Promise<RunningApi> {
  rmSync(MAIL_DIR, { recursive: true, force: true });
  mkdirSync(MAIL_DIR, { recursive: true });
  const env = railsEnv();
  execFileSync('bundle', ['exec', 'rake', 'db:drop', 'db:create', 'db:schema:load'], { cwd: apiDir, env: { ...env, DISABLE_DATABASE_ENVIRONMENT_CHECK: '1' }, stdio: 'pipe' });
  // Rack::Attack counters live in Rails.cache (FileStore in dev): reset them so reruns inside
  // the 60s window are not throttled. Keep tmp/cache/bootsnap (the boot cache, not state).
  const cacheDir = path.join(apiDir, 'tmp', 'cache');
  if (existsSync(cacheDir)) {
    for (const entry of readdirSync(cacheDir)) {
      if (entry !== 'bootsnap') rmSync(path.join(cacheDir, entry), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }
  mkdirSync(path.join(here, '.out'), { recursive: true });
  const logPath = path.join(here, '.out', `api-${PORT}.log`);
  const log = createWriteStream(logPath);
  const child: ChildProcess = spawn('bundle', ['exec', 'puma', '-p', String(PORT), '-e', 'development'], { cwd: apiDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  const baseUrl = `http://127.0.0.1:${PORT}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) break;
    } catch { /* not up yet */ }
    if (child.exitCode !== null) throw new Error(`API exited early (code ${child.exitCode}); see ${logPath}`);
    if (Date.now() > deadline) throw new Error(`API did not become healthy within 60s; see ${logPath}`);
    await new Promise((r) => setTimeout(r, 300));
  }
  return {
    baseUrl,
    apiBase: `${baseUrl}/api`,
    logPath,
    stop: () => new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', () => resolve());
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }),
  };
}
