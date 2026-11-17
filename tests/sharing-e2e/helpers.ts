import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { API_BASE, RP_ID, WEB_ORIGIN } from './api-harness.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Error thrown for a failed worker command; keeps the worker-side error name and HTTP status. */
export class WorkerError extends Error {
  constructor(message: string, readonly errorName: string, readonly status?: number) {
    super(message);
  }
}

/** One user device = one user-worker.ts process. */
export class UserDevice {
  private child!: ChildProcess;
  private seq = 0;
  private pending = new Map<number, (m: any) => void>();
  private ready!: Promise<void>;

  constructor(readonly name: string) {}

  start(): this {
    this.child = spawn(process.execPath, ['--import', 'tsx', path.join(here, 'user-worker.ts')], {
      env: { ...process.env, WEBAUTHN_ORIGIN: WEB_ORIGIN, WEBAUTHN_RP_ID: RP_ID, API_BASE },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    let resolveReady!: () => void;
    this.ready = new Promise((r) => (resolveReady = r));
    createInterface({ input: this.child.stdout! }).on('line', (line) => {
      const m = JSON.parse(line);
      if (m.ready) return resolveReady();
      this.pending.get(m.seq)?.(m);
      this.pending.delete(m.seq);
    });
    return this;
  }

  async call<T = any>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    await this.ready;
    const seq = ++this.seq;
    const reply = new Promise<any>((r) => this.pending.set(seq, r));
    this.child.stdin!.write(JSON.stringify({ seq, cmd, args }) + '\n');
    const m = await reply;
    if (!m.ok) throw new WorkerError(`${this.name}.${cmd}: ${m.error}`, m.name, m.status);
    return m.result as T;
  }

  async kill(): Promise<void> {
    if (!this.child || this.child.exitCode !== null) return;
    await new Promise<void>((r) => { this.child.once('exit', () => r()); this.child.kill('SIGKILL'); });
  }
}

/** Assert that `p` rejects with a worker error of this name (and HTTP status, if given). */
export async function rejectsWith(p: Promise<unknown>, errorName: string, status?: number): Promise<WorkerError> {
  try {
    await p;
  } catch (e) {
    if (!(e instanceof WorkerError)) throw e;
    if (e.errorName !== errorName || (status !== undefined && e.status !== status)) {
      throw new Error(`expected ${errorName}${status ? ` ${status}` : ''}, got ${e.errorName} ${e.status ?? ''}: ${e.message}`);
    }
    return e;
  }
  throw new Error(`expected ${errorName}, but the call succeeded`);
}
