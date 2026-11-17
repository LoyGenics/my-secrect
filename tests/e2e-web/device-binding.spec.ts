/**
 * Device proof-of-possession in the real browser (specs/device-identity.md):
 * the web client signs each passkey sign-in's challenge with its Ed25519
 * device key and the real API verifies it before binding the session.
 */
import type { Page } from '@playwright/test';
import {
  test, expect, registerAccountViaUi, createVaultViaUi, uniqueEmail, signOutViaUi, signInWithPasskeyViaUi,
  storedToken, apiFetch, openSecurityCenter, unlockVaultViaUi, SESSIONS_API,
} from './fixtures';

interface DeviceKeyRecord {
  storage: string;
  deviceId: string | null;
  extractable: boolean | null;
  algorithm: string | null;
  exportable: boolean;
  publicKeyLength: number;
  hasSecretKey: boolean;
}

/** What the app stored in IndexedDB — read the way any page script could. */
async function deviceKeyRecords(page: Page): Promise<DeviceKeyRecord[]> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('my-secrect-device-keys');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const records = await new Promise<any[]>((resolve, reject) => {
      const req = db.transaction('devices', 'readonly').objectStore('devices').getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    const out = [];
    for (const r of records) {
      let exportable = false;
      if (r.privateKey) {
        try { await crypto.subtle.exportKey('pkcs8', r.privateKey); exportable = true; } catch { exportable = false; }
      }
      out.push({
        storage: r.storage, deviceId: r.deviceId, extractable: r.privateKey ? r.privateKey.extractable : null,
        algorithm: r.privateKey ? r.privateKey.algorithm.name : null, exportable,
        publicKeyLength: r.publicKey.length, hasSecretKey: !!r.secretKey,
      });
    }
    return out;
  });
}

async function currentSessionDeviceId(apiUrl: string, token: string | null): Promise<string | null> {
  const res = await apiFetch(apiUrl, token, 'GET', SESSIONS_API);
  expect(res.status).toBe(200);
  return res.json.sessions.find((s: any) => s.current).device_id;
}

test.describe('device binding', () => {
  test('sign-up enrols this browser with a non-extractable WebCrypto key and binds the session to it', async ({ page, authenticator, apiUrl }) => {
    await registerAccountViaUi(page, uniqueEmail('dev'));
    const token = await storedToken(page);
    const deviceId = await currentSessionDeviceId(apiUrl, token);
    expect(deviceId).toBeTruthy();

    const devices = await apiFetch(apiUrl, token, 'GET', '/api/v1/devices');
    expect(devices.json.devices.map((d: any) => d.id)).toEqual([deviceId]);

    const [record] = await deviceKeyRecords(page);
    expect(record).toMatchObject({
      storage: 'webcrypto', deviceId, extractable: false, algorithm: 'Ed25519', exportable: false,
      publicKeyLength: 32, hasSecretKey: false,
    });
  });

  test('sign-in binds the new session to the same device; a revoked device is replaced by a fresh enrolment', async ({ page, authenticator, apiUrl }) => {
    const email = uniqueEmail('rebind');
    await registerAccountViaUi(page, email);
    await createVaultViaUi(page);
    const firstDevice = await currentSessionDeviceId(apiUrl, await storedToken(page));

    await signOutViaUi(page);
    await signInWithPasskeyViaUi(page, email);
    await expect(page.getByText('Your vault is locked')).toBeVisible();
    expect(await currentSessionDeviceId(apiUrl, await storedToken(page))).toBe(firstDevice);
    expect((await deviceKeyRecords(page))[0].deviceId).toBe(firstDevice);

    // Revoke this browser's device from the Security Center: the session it owns ends.
    const tokenBeforeRevoke = await storedToken(page);
    await unlockVaultViaUi(page);
    await openSecurityCenter(page);
    const devicesSection = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Trusted devices', exact: true }) });
    await devicesSection.getByRole('button', { name: 'Revoke', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Sign in to your account' })).toBeVisible();
    expect((await apiFetch(apiUrl, tokenBeforeRevoke, 'GET', SESSIONS_API)).status).toBe(401);

    // Next sign-in: the server rejects the revoked device; the client drops
    // the key, retries once and enrols a new device.
    await signInWithPasskeyViaUi(page, email);
    await expect(page.getByRole('heading', { name: 'Sign in to your account' })).toHaveCount(0);
    const token = await storedToken(page);
    const secondDevice = await currentSessionDeviceId(apiUrl, token);
    expect(secondDevice).toBeTruthy();
    expect(secondDevice).not.toBe(firstDevice);
    const devices = (await apiFetch(apiUrl, token, 'GET', '/api/v1/devices')).json.devices;
    expect(devices.find((d: any) => d.id === firstDevice).revoked_at).toBeTruthy();
    expect(devices.find((d: any) => d.id === secondDevice).revoked_at).toBeNull();
    const records = await deviceKeyRecords(page);
    expect(records).toHaveLength(1);
    expect(records[0].deviceId).toBe(secondDevice);
  });

  test('without WebCrypto Ed25519 the libsodium fallback enrols and binds (and says so in the record)', async ({ page, authenticator, apiUrl }) => {
    // Model an older runtime: WebCrypto exists but has no Ed25519.
    await page.addInitScript(() => {
      const original = SubtleCrypto.prototype.generateKey;
      SubtleCrypto.prototype.generateKey = function (algorithm: any, ...rest: any[]) {
        const name = typeof algorithm === 'string' ? algorithm : algorithm?.name;
        if (name === 'Ed25519') return Promise.reject(new DOMException('Ed25519 unsupported', 'NotSupportedError'));
        return (original as any).call(this, algorithm, ...rest);
      } as typeof original;
    });
    const email = uniqueEmail('sodium');
    await registerAccountViaUi(page, email);
    await createVaultViaUi(page);
    const deviceId = await currentSessionDeviceId(apiUrl, await storedToken(page));
    expect(deviceId).toBeTruthy();
    const [record] = await deviceKeyRecords(page);
    expect(record).toMatchObject({ storage: 'libsodium', deviceId, hasSecretKey: true, publicKeyLength: 32 });

    await signOutViaUi(page);
    await signInWithPasskeyViaUi(page, email);
    await expect(page.getByText('Your vault is locked')).toBeVisible();
    expect(await currentSessionDeviceId(apiUrl, await storedToken(page))).toBe(deviceId);
  });
});
