import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LS_ACCOUNT_EMAIL, LS_API_TOKEN, LS_API_TOKEN_EXPIRES_AT } from '../../../packages/sdk/src/security';
import { API_BASE_URL_KEY, HOSTED_API_BASE_URL, SHARE_WEB_ORIGIN_KEY, loadAccountServer } from '../src/accountServer';

function memoryStorage(entries: [string, string][] = []) {
  const values = new Map(entries);
  return {
    values,
    async getItem(key: string) { return values.get(key) ?? null; },
    async setItem(key: string, value: string) { values.set(key, value); },
    async multiRemove(keys: readonly string[]) { keys.forEach(key => values.delete(key)); },
  };
}

test('a new release install uses the hosted service without a saved URL', async () => {
  const storage = memoryStorage();
  assert.equal(await loadAccountServer(storage, true), HOSTED_API_BASE_URL);
  assert.equal(storage.values.get(API_BASE_URL_KEY), HOSTED_API_BASE_URL);
});

test('moving to the hosted service drops the previous server session and share origin', async () => {
  const storage = memoryStorage([
    [API_BASE_URL_KEY, 'https://self-hosted.test/api'],
    [SHARE_WEB_ORIGIN_KEY, 'https://self-hosted.test'],
    [LS_API_TOKEN, 'previous-session'],
    [LS_API_TOKEN_EXPIRES_AT, '9999999999999'],
    [LS_ACCOUNT_EMAIL, 'user@example.test'],
    ['vault-setting', 'preserved'],
  ]);
  assert.equal(await loadAccountServer(storage, true), HOSTED_API_BASE_URL);
  assert.deepEqual(storage.values, new Map([
    [API_BASE_URL_KEY, HOSTED_API_BASE_URL],
    ['vault-setting', 'preserved'],
  ]));
});

test('an existing hosted session survives release startup', async () => {
  const storage = memoryStorage([[API_BASE_URL_KEY, `${HOSTED_API_BASE_URL}/`], [LS_API_TOKEN, 'hosted-session']]);
  assert.equal(await loadAccountServer(storage, true), HOSTED_API_BASE_URL);
  assert.equal(storage.values.get(LS_API_TOKEN), 'hosted-session');
});

test('a development build can use a custom server or run locally', async () => {
  const storage = memoryStorage();
  assert.equal(await loadAccountServer(storage, false), '');
  await storage.setItem(API_BASE_URL_KEY, 'http://localhost:3221/api/');
  assert.equal(await loadAccountServer(storage, false), 'http://localhost:3221/api');
});

test('the hosted endpoint is not selected if clearing a previous session fails', async () => {
  const storage = memoryStorage([[API_BASE_URL_KEY, 'https://self-hosted.test/api']]);
  await assert.rejects(loadAccountServer({
    ...storage,
    async multiRemove() { throw new Error('storage unavailable'); },
  }, true), /storage unavailable/);
  assert.equal(storage.values.get(API_BASE_URL_KEY), 'https://self-hosted.test/api');
});
