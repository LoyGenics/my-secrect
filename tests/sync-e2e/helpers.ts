import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { PORT, RP_ID, WEB_ORIGIN } from './api-harness.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

export class Client {
  private child!: ChildProcess;
  private seq = 0;
  private pending = new Map<number, (m: any) => void>();
  private ready!: Promise<void>;
  constructor(readonly name: string, readonly stateFile: string) {}
  start(env: Record<string, string> = {}) {
    this.child = spawn(process.execPath, ['--import', 'tsx', path.join(here, 'client-worker.ts')], {
      env: { ...process.env, CLIENT_STATE_FILE: this.stateFile, WEBAUTHN_ORIGIN: WEB_ORIGIN, WEBAUTHN_RP_ID: RP_ID, API_BASE: `http://127.0.0.1:${PORT}/api`, ...env },
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
    if (!m.ok) throw Object.assign(new Error(`${this.name}.${cmd}: ${m.error}`), { status: m.status });
    return m.result as T;
  }
  async kill() {
    if (this.child.exitCode !== null) return;
    await new Promise<void>((r) => { this.child.once('exit', () => r()); this.child.kill('SIGKILL'); });
  }
  titles = async () => (await this.call<any[]>('list')).filter((i) => !i.deleted_at).map((i) => i.title).sort();
  find = async (title: string) => (await this.call<any[]>('list')).find((i) => i.title === title);
}
