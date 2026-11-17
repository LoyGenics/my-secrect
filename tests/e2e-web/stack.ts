/**
 * Boots a REAL local stack for browser e2e: Rails API (real Postgres, real
 * WebAuthn verification) + the Vite web dev server. Nothing here mocks or
 * skips authentication.
 *
 * Honest notes about what differs from production:
 *  - RAILS_ENV=test is used for the API process. Its only relevant effect is
 *    that Rack::Attack throttles are disabled (a full spec run drives far
 *    more than 10 passkey calls/min from one IP). Throttling is NOT covered
 *    by these specs. Authentication, WebAuthn verification, sessions and
 *    step-up are the production code paths.
 *  - S3_* point at a placeholder (127.0.0.1:9, the discard port). Auth specs
 *    never touch blobs; any blob call would fail loudly.
 *  - The database is DROPPED and recreated on every startStack(); the name
 *    must end in `_e2eauth` (enforced) so a dev database can never be wiped.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '../..');
const apiDir = path.join(repoRoot, 'apps/api');
const webDir = path.join(repoRoot, 'apps/web');

export interface StackConfig {
  apiPort: number;
  webPort: number;
  dbName: string;
  logDir: string;
}

export interface Stack {
  apiUrl: string;
  webUrl: string;
  config: StackConfig;
  stop(): Promise<void>;
}

export function stackConfigFromEnv(env = process.env): StackConfig {
  return {
    apiPort: Number(env.E2E_API_PORT ?? 3101),
    webPort: Number(env.E2E_WEB_PORT ?? 5201),
    dbName: env.E2E_DB_NAME ?? 'vault_e2eauth',
    logDir: env.E2E_LOG_DIR ?? path.join(here, '.logs'),
  };
}

function railsEnv(cfg: StackConfig): NodeJS.ProcessEnv {
  const user = process.env.POSTGRES_USER ?? userInfo().username;
  const host = process.env.POSTGRES_HOST ?? 'localhost';
  const port = process.env.POSTGRES_PORT ?? '5432';
  const webOrigin = `http://localhost:${cfg.webPort}`;
  return {
    ...process.env,
    RBENV_VERSION: process.env.RBENV_VERSION ?? '3.3.6',
    RAILS_ENV: 'test',
    POSTGRES_USER: user,
    DATABASE_URL: `postgresql://${user}@${host}:${port}/${cfg.dbName}`,
    PORT: String(cfg.apiPort),
    WEBAUTHN_RP_ID: 'localhost',
    WEBAUTHN_ORIGIN: webOrigin,
    CORS_ORIGINS: webOrigin,
    // Placeholder storage: required by StorageProvider (no defaults), unused by auth specs.
    S3_ENDPOINT: 'http://127.0.0.1:9',
    S3_REGION: 'us-east-1',
    S3_BUCKET: 'e2e-placeholder',
    S3_ACCESS_KEY: 'e2e-placeholder',
    S3_SECRET_KEY: 'e2e-placeholder',
  };
}

async function waitFor(url: string, label: string, child: ChildProcess, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${label} exited early with code ${child.exitCode}; see logs`);
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${label} did not become ready at ${url} within ${timeoutMs}ms`);
}

async function assertPortFree(port: number, label: string): Promise<void> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
  } catch {
    return; // connection refused / timed out: free enough
  }
  throw new Error(`${label} port ${port} is already in use; refusing to reuse an unknown server`);
}

function killTree(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.pid === undefined) return resolve();
    child.once('exit', () => resolve());
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      resolve();
    }
    setTimeout(() => {
      try { if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
      resolve();
    }, 5000).unref();
  });
}

export async function startStack(partial: Partial<StackConfig> = {}): Promise<Stack> {
  const cfg = { ...stackConfigFromEnv(), ...partial };
  if (!cfg.dbName.endsWith('_e2eauth')) {
    throw new Error(`E2E database name must end with _e2eauth (got ${cfg.dbName}); refusing to drop it`);
  }
  mkdirSync(cfg.logDir, { recursive: true });
  await assertPortFree(cfg.apiPort, 'API');
  await assertPortFree(cfg.webPort, 'web');
  const env = railsEnv(cfg);

  // Fresh, migrated schema (db:schema:load = the committed schema.rb).
  execFileSync('bundle', ['exec', 'rake', 'db:drop', 'db:create', 'db:schema:load'], {
    cwd: apiDir, env, stdio: ['ignore', openSync(path.join(cfg.logDir, 'db.log'), 'w'), 'inherit'],
  });

  const apiLog = openSync(path.join(cfg.logDir, 'api.log'), 'w');
  const api = spawn('bundle', ['exec', 'puma', '-C', 'config/puma.rb'], {
    cwd: apiDir, env, detached: true, stdio: ['ignore', apiLog, apiLog],
  });
  const webLog = openSync(path.join(cfg.logDir, 'web.log'), 'w');
  const web = spawn('npx', ['vite', '--host', 'localhost', '--port', String(cfg.webPort), '--strictPort'], {
    cwd: webDir, env: process.env, detached: true, stdio: ['ignore', webLog, webLog],
  });
  const stop = async () => { await Promise.all([killTree(api), killTree(web)]); };
  try {
    await Promise.all([
      waitFor(`http://localhost:${cfg.apiPort}/health`, 'API', api),
      waitFor(`http://localhost:${cfg.webPort}/`, 'web', web),
    ]);
  } catch (err) {
    await stop();
    throw err;
  }
  return { apiUrl: `http://localhost:${cfg.apiPort}`, webUrl: `http://localhost:${cfg.webPort}`, config: cfg, stop };
}
