import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LS_ACCOUNT_EMAIL, LS_API_TOKEN, LS_API_TOKEN_EXPIRES_AT } from '../../../packages/sdk/src/security';
import { API_BASE_URL_KEY, HOSTED_API_BASE_URL, SHARE_WEB_ORIGIN_KEY, loadAccountServer, resolveVaultEntry } from '../src/accountServer';

function memoryStorage(entries: [string, string][] = []) {
  const values = new Map(entries);
  return {
    values,
    async getItem(key: string) { return values.get(key) ?? null; },
    async setItem(key: string, value: string) { values.set(key, value); },
    async removeItem(key: string) { values.delete(key); },
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

test('a development build defaults to the hosted service', async () => {
  const storage = memoryStorage();
  assert.equal(await loadAccountServer(storage, false), HOSTED_API_BASE_URL);
  assert.equal(storage.values.get(API_BASE_URL_KEY), HOSTED_API_BASE_URL);
});

test('a development build with a saved blank URL moves to the hosted service', async () => {
  const storage = memoryStorage([
    [API_BASE_URL_KEY, ''],
    [SHARE_WEB_ORIGIN_KEY, 'https://self-hosted.test'],
  ]);
  assert.equal(await loadAccountServer(storage, false), HOSTED_API_BASE_URL);
  assert.equal(storage.values.has(SHARE_WEB_ORIGIN_KEY), false);
});

test('a development build keeps its configured custom server', async () => {
  const storage = memoryStorage([[API_BASE_URL_KEY, 'http://localhost:3221/api/'], [LS_API_TOKEN, 'dev-session']]);
  assert.equal(await loadAccountServer(storage, false), 'http://localhost:3221/api');
  assert.equal(storage.values.get(LS_API_TOKEN), 'dev-session');
});

test('the hosted endpoint is not selected if clearing a previous session fails', async () => {
  const storage = memoryStorage([[API_BASE_URL_KEY, 'https://self-hosted.test/api']]);
  await assert.rejects(loadAccountServer({
    ...storage,
    async multiRemove() { throw new Error('storage unavailable'); },
  }, true), /storage unavailable/);
  assert.equal(storage.values.get(API_BASE_URL_KEY), 'https://self-hosted.test/api');
});

test('a development override can be used before sign-in and clears the previous server session', async () => {
  const storage = memoryStorage([[API_BASE_URL_KEY, HOSTED_API_BASE_URL], [LS_API_TOKEN, 'hosted-session']]);
  const devUrl = 'http://localhost:3221/api';
  assert.equal(await loadAccountServer(storage, false, ` ${devUrl}/ `), devUrl);
  assert.equal(storage.values.get(API_BASE_URL_KEY), devUrl);
  assert.equal(storage.values.has(LS_API_TOKEN), false);
  assert.equal(await loadAccountServer(storage, true, devUrl), HOSTED_API_BASE_URL);
});

test('vault entry requires a session before checking for a new or existing vault', async () => {
  const storage = memoryStorage();
  async function vaultExists() { assert.fail('a signed-out vault must not be opened'); }
  assert.equal(await resolveVaultEntry(storage, vaultExists), 'signin');

  await storage.setItem(LS_API_TOKEN, 'expired-session');
  await storage.setItem(LS_API_TOKEN_EXPIRES_AT, '1');
  assert.equal(await resolveVaultEntry(storage, vaultExists), 'signin');
  assert.equal(storage.values.has(LS_API_TOKEN), false);

  await storage.setItem(LS_API_TOKEN, 'active-session');
  await storage.setItem(LS_API_TOKEN_EXPIRES_AT, String(Date.now() + 60_000));
  assert.equal(await resolveVaultEntry(storage, async () => false), 'onboarding');
  assert.equal(await resolveVaultEntry(storage, async () => true), 'locked');
});
