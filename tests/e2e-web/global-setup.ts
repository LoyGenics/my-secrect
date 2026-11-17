import { startStack } from './stack';

/** Boots the real stack once per run; workers read the URLs from env. */
export default async function globalSetup() {
  const stack = await startStack();
  process.env.E2E_API_URL = stack.apiUrl;
  process.env.E2E_WEB_URL = stack.webUrl;
  return async () => { await stack.stop(); };
}
