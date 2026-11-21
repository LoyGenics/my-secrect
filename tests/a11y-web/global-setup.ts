import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStack } from '../e2e-web/stack';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Real Rails API for the sign-in step (the vault needs an account). Its own
 *  `*_e2eauth` database, recreated on every run; mail goes to files the spec
 *  reads (see ../e2e-web/stack.ts). The built web app reaches it through the
 *  vite preview proxy at its default same-origin `/api`. */
export default async function globalSetup() {
  const logDir = path.join(here, '.logs');
  const stack = await startStack({
    apiPort: Number(process.env.A11Y_API_PORT ?? 3121),
    webPort: Number(process.env.A11Y_WEB_PORT ?? 5314),
    dbName: process.env.A11Y_DB_NAME ?? 'vault_a11y_e2eauth',
    logDir,
    mailDir: path.join(logDir, 'mail'),
  }, { web: false });
  process.env.E2E_MAIL_DIR = stack.config.mailDir;
  return async () => { await stack.stop(); };
}
