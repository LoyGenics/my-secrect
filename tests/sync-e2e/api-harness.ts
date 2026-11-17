/**
 * Boots the REAL Rails API (puma, development env) against a fresh Postgres
 * database and exposes `psql` for inspecting what the server actually stored.
 * Ports/DB: API 3102, database vault_e2e_sync (override with SYNC_E2E_PORT).
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(here, '../../apps/api');

export const PORT = Number(process.env.SYNC_E2E_PORT ?? 3102);
export const DB = process.env.SYNC_E2E_DB ?? 'vault_e2e_sync';
export const WEB_ORIGIN = process.env.SYNC_E2E_WEB_ORIGIN ?? 'http://localhost:5202';
export const RP_ID = 'localhost';

function railsEnv(): NodeJS.ProcessEnv {
  const user = process.env.POSTGRES_USER ?? execFileSync('whoami').toString().trim();
  return {
    ...process.env,
    RBENV_VERSION: process.env.RBENV_VERSION ?? '3.3.6',
    POSTGRES_USER: user,
    POSTGRES_HOST: '/tmp',
    RAILS_ENV: 'development',
    DATABASE_URL: `postgresql:///${DB}?host=/tmp`,
    WEBAUTHN_ORIGIN: WEB_ORIGIN,
    WEBAUTHN_RP_ID: RP_ID,
    CORS_ORIGINS: WEB_ORIGIN,
  };
}

export function psql(sql: string): string {
  return execFileSync('psql', ['-h', '/tmp', '-d', DB, '-At', '-F', '|', '-c', sql], { encoding: 'utf8' }).trim();
}

/** Full data-only dump: grep this for plaintext markers. */
export function pgDump(): string {
  return execFileSync('pg_dump', ['-h', '/tmp', '-d', DB, '--data-only', '--inserts'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

export interface RunningApi { baseUrl: string; apiBase: string; logPath: string; stop(): Promise<void> }

export async function bootApi(): Promise<RunningApi> {
  const env = railsEnv();
  // Rack::Attack counters live in Rails.cache (FileStore in dev): reset so reruns inside the 60s window are not throttled.
  rmSync(path.join(apiDir, 'tmp/cache'), { recursive: true, force: true });
  execFileSync('bundle', ['exec', 'rake', 'db:drop', 'db:create', 'db:schema:load'], { cwd: apiDir, env: { ...env, DISABLE_DATABASE_ENVIRONMENT_CHECK: '1' }, stdio: 'pipe' });
  // Rack::Attack counters live in the (file) Rails cache; start every run with clean throttles.
  rmSync(path.join(apiDir, 'tmp', 'cache'), { recursive: true, force: true });
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
