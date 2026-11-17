import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Clipboard from 'expo-clipboard';
import sodium from 'libsodium-wrappers-sumo';
import Field from '../components/Field';
import { colors, styles } from '../theme';
import { useTranslation } from '../../../../packages/i18n/src/react';
// NOTE (import depth): from apps/mobile/src/screens/ the repo root is four
// levels up — '../../../../packages/...' — the same depth TrashScreen uses
// for packages/core. A three-level import would resolve inside apps/.
// The SDK client (packages/sdk/src/security.ts) is owned by the desktop agent;
// this screen only calls its public methods, never re-implements them.
// Method names follow the SDK as landed (mfaEnroll, mfaConfirm, mfaDisable, mfaRecoveryCodes). Do not “fix” it by inlining a client here.
import { SecurityApiClient, clearSessionToken, getValidToken, isUnauthorized } from '../../../../packages/sdk/src/security';
import { fromBase64Url, sha256, toBase64 } from '../../../../packages/crypto-adapters/src/index';
import { decryptWithVaultKey, encryptWithVaultKey } from '../vault';
import { apiStatus, isNetworkError, isStepUpFresh, isStepUpRequired } from '../utils/stepUp';

/**
 * Security Center (mobile) — account security ONLY. This screen never
 * touches vault content: account auth (passkeys / MFA / sessions /
 * devices) stays separate from vault unlock (passphrase / recovery key),
 * and the server never sees vault content, only ciphertext + opaque ids.
 *
 * Honest-state rules followed here (same as SharesScreen):
 * - No server configured (AsyncStorage 'my-secrect:api-base-url' empty)
 *   -> not-configured state, never fake data, never a crash.
 * - Offline -> offline state + retry. Server errors -> error + retry.
 * - Passkeys: list + Remove work server-side. ADD does not: React Native
 *   / Expo Go has no WebAuthn browser API, and expo-local-authentication
 *   is NOT WebAuthn — so there is no Add button, only an honest notice
 *   that a passkey must be added from Desktop or Web. Nothing is faked.
 * - Account MFA codes are typed in by the user and verified server-side;
 *   this screen never generates a TOTP code (utils/totp.ts is for vault
 *   items only). Biometrics remain presence-only and are not used here.
 * - Step-up: sensitive actions run through runWithStepUp(); a step-up
 *   stays valid for 10 minutes (see utils/stepUp.ts). A 403
 *   step_up_required re-prompts, it never proceeds.
 * - Secrets (MFA secret, recovery codes) are shown once, kept in memory
 *   only, and cleared on Done / success. Never stored, never logged.
 * - Revoking a session/device invalidates the SERVER session only. It
 *   does NOT erase secrets already downloaded / offline on that device.
 *
 * Sign-in (17 Nov 2026): mobile has a SignInScreen (recovery-key
 * challenge — passkeys cannot run here, see that screen). Its token
 * lands in LS_API_TOKEN via saveSessionToken(), so this screen loads
 * for real after sign-in. A 401 from every load means the session
 * died server-side: App sends the user back to SignIn (via the
 * onUnauthorized prop) instead of showing a dead-end error.
 */

export const API_BASE_URL_KEY = 'my-secrect:api-base-url';

/** AsyncStorage-backed token store (same LS_API_TOKEN key as
 *  desktop/web — one token store, not one per platform). */
export const asyncTokenStore = {
  getItem: (k: string) => AsyncStorage.getItem(k),
  setItem: (k: string, v: string) => AsyncStorage.setItem(k, v),
  removeItem: (k: string) => AsyncStorage.removeItem(k),
};

/**
 * Account token lookup, shared with desktop (packages/sdk/src/security.ts
 * LS_API_TOKEN). Populated by the mobile SignInScreen (recovery-key
 * sign-in) via saveSessionToken(). Expiry-aware: an expired token
 * reads as null, so server calls never go out with a stale token —
 * the server would answer 401, which the App surfaces as a
 * re-sign-in prompt, never as fake data.
 */
export async function getApiToken(): Promise<string | null> {
  return getValidToken(asyncTokenStore);
}

interface PasskeyRow { id: string; credential_id_prefix: string; sign_count: number; created_at: string; }
interface SessionRow { id: string; device_id?: string; user_agent?: string; ip_address?: string; created_at?: string; expires_at?: string; current?: boolean; }
interface DeviceRow {
  id: string; device_id?: string; name?: string | null; name_encrypted?: string | null;
  trusted?: boolean; created_at?: string | null; last_seen_at?: string | null;
  /** Resolved display name (see resolveDeviceLabels). Never rendered from ciphertext. */
  displayName?: string;
}
interface ActivityRow { event_type: string; device_id?: string; created_at?: string; }

type MfaState = 'unknown' | 'enabled' | 'disabled';

function rows<T>(res: unknown, key: string): T[] {
  if (Array.isArray(res)) return res as T[];
  if (typeof res === 'object' && res !== null) {
    const v = (res as Record<string, unknown>)[key];
    if (Array.isArray(v)) return v as T[];
  }
  return [];
}
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
function fmtDate(raw?: string): string {
  if (!raw) return '';
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? raw : d.toLocaleString();
}

export default function SecurityScreen({ onClose, onSignedOut, onUnauthorized }: {
  onClose: () => void;
  /** Sign-out completed (server session revoked, token cleared,
   *  vault locked): App shows the sign-in gate again. */
  onSignedOut?: () => void;
  /** Every server call answered 401: the session is gone
   *  server-side. App clears the token and shows SignIn. */
  onUnauthorized?: () => void;
}) {
  const { t } = useTranslation();
  const [baseUrl, setBaseUrl] = useState<string | null>(null); // null = not loaded yet
  const [loading, setLoading] = useState(false);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [passkeys, setPasskeys] = useState<PasskeyRow[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mfaState, setMfaState] = useState<MfaState>('unknown');
  const [mfaEnroll, setMfaEnroll] = useState<{ otpauthUrl: string; secret: string } | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [recoveryKeyInput, setRecoveryKeyInput] = useState('');
  const [verifierFingerprint, setVerifierFingerprint] = useState<string | null>(null);
  // Server step-up (10-minute window, see utils/stepUp.ts).
  const [lastStepUpAt, setLastStepUpAt] = useState<number | null>(null);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [stepUpCode, setStepUpCode] = useState('');
  const [stepUpError, setStepUpError] = useState('');
  const [stepUpBusy, setStepUpBusy] = useState(false);
  const pendingStepUpAction = useRef<(() => Promise<void>) | null>(null);

  const client = useMemo(
    () => (baseUrl ? new SecurityApiClient({ baseUrl, getToken: getApiToken, tokenStore: asyncTokenStore }) : null),
    [baseUrl],
  );

  function describeError(e: unknown): string {
    if (isNetworkError(e)) return t('security.offline');
    const status = apiStatus(e);
    return status !== null ? `${t('security.error')} (${status})` : t('security.error');
  }

  async function loadAll(c: SecurityApiClient) {
    setLoading(true); setError(''); setOffline(false);
    const results = await Promise.allSettled([c.listPasskeys(), c.listSessions(), c.listDevices(), c.listActivity()]);
    const [pk, sess, dev, act] = results;
    if (pk.status === 'fulfilled') setPasskeys(rows<PasskeyRow>(pk.value, 'authenticators'));
    if (sess.status === 'fulfilled') setSessions(rows<SessionRow>(sess.value, 'sessions'));
    if (dev.status === 'fulfilled') setDevices(await resolveDeviceLabels(rows<DeviceRow>(dev.value, 'devices')));
    if (act.status === 'fulfilled') setActivity(rows<ActivityRow>(act.value, 'events'));
    const anyOk = results.some((r) => r.status === 'fulfilled');
    const anyNetwork = results.some((r) => r.status === 'rejected' && isNetworkError(r.reason));
    const allUnauthorized = results.every((r) => r.status === 'rejected' && isUnauthorized(r.reason));
    if (!anyOk && anyNetwork) setOffline(true);
    else if (!anyOk) setError(t('security.error'));
    setLoaded(true); setLoading(false);
    // Every call answered 401: the session is gone server-side
    // (revoked or expired). Hand back to SignIn via App; never
    // silently retry with the same stale token.
    if (!anyOk && allUnauthorized) onUnauthorized?.();
  }

  useEffect(() => {
    void (async () => {
      const raw = await AsyncStorage.getItem(API_BASE_URL_KEY);
      const url = (raw ?? '').trim();
      setBaseUrl(url);
      if (url) {
        const c = new SecurityApiClient({ baseUrl: url, getToken: getApiToken, tokenStore: asyncTokenStore });
        await loadAll(c);
      } else {
        setLoaded(true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Run a sensitive server action behind step-up. Returns true when the
   * action ran now, false when the step-up panel was opened instead.
   * Throws non-step-up errors for the caller to display. A 403
   * step_up_required re-prompts (with the expired message) and never
   * proceeds. Step-up via passkey is not offered on mobile (no WebAuthn
   * here) — TOTP only; stepUpPasskey stays a desktop/web flow.
   */
  async function runWithStepUp(action: () => Promise<void>): Promise<boolean> {
    if (!client) return false;
    if (isStepUpFresh(lastStepUpAt, Date.now())) {
      try { await action(); return true; }
      catch (e) {
        if (isStepUpRequired(e)) {
          pendingStepUpAction.current = action;
          setStepUpError(t('security.stepUpExpired')); setStepUpCode(''); setStepUpOpen(true);
          return false;
        }
        throw e;
      }
    }
    pendingStepUpAction.current = action;
    setStepUpError(''); setStepUpCode(''); setStepUpOpen(true);
    return false;
  }

  async function submitStepUp() {
    if (!client) return;
    const code = stepUpCode.trim();
    if (!code) { setStepUpError(t('security.stepUpFailed')); return; }
    setStepUpBusy(true); setStepUpError('');
    try {
      await client.stepUpTotp(code);
      const action = pendingStepUpAction.current;
      pendingStepUpAction.current = null;
      setLastStepUpAt(Date.now());
      setStepUpOpen(false); setStepUpCode(''); setStepUpBusy(false);
      if (action) {
        try { await action(); }
        catch (e) { setError(describeError(e)); }
      }
    } catch (e) {
      setStepUpBusy(false);
      setStepUpError(isStepUpRequired(e) ? t('security.stepUpExpired') : t('security.stepUpFailed'));
    }
  }

  function deviceLabel(d: DeviceRow): string {
    return d.displayName ?? d.name ?? d.device_id ?? d.id;
  }

  /**
   * Resolve a display name per device: plaintext `name` when the server
   * returns one, else the Vault-Key-decrypted `name_encrypted`, else the
   * device id. Ciphertext is never rendered as a name.
   */
  async function resolveDeviceLabels(list: DeviceRow[]): Promise<DeviceRow[]> {
    return Promise.all(list.map(async (d) => {
      if (d.name) return { ...d, displayName: d.name };
      if (d.name_encrypted) {
        const plain = await decryptWithVaultKey(d.name_encrypted);
        if (plain) return { ...d, displayName: plain };
      }
      return { ...d, displayName: d.device_id ?? d.id };
    }));
  }

  // --- Passkeys ------------------------------------------------------------
  function handleRemovePasskey(pk: PasskeyRow) {
    Alert.alert(t('security.removePasskey'), passkeys.length <= 1 ? t('security.lastMethodWarning') : pk.credential_id_prefix, [
      { text: t('security.cancel'), style: 'cancel' },
      { text: t('security.removePasskey'), style: 'destructive', onPress: () => void doRemovePasskey(pk) },
    ]);
  }
  async function doRemovePasskey(pk: PasskeyRow) {
    if (!client) return;
    setError(''); setNotice(''); setBusy(true);
    try {
      await runWithStepUp(async () => {
        await client.removePasskey(pk.id);
        setPasskeys((list) => list.filter((p) => p.id !== pk.id));
        setNotice(t('security.passkeyRemoved'));
      });
    } catch (e) {
      // 422 = last authentication method with no MFA: the server refuses.
      if (apiStatus(e) === 422) setError(t('security.lastMethodWarning'));
      else setError(describeError(e));
    } finally { setBusy(false); }
  }

  // --- MFA -----------------------------------------------------------------
  async function handleEnrollMfa() {
    if (!client) return;
    setError(''); setNotice(''); setBusy(true);
    try {
      const res = await client.mfaEnroll();
      setMfaEnroll({ otpauthUrl: res.otpauth_url ?? '', secret: res.secret ?? '' });
      setMfaCode('');
    } catch (e) {
      // 409 on enroll most likely means MFA is already enabled.
      if (apiStatus(e) === 409) setMfaState('enabled');
      else setError(describeError(e));
    } finally { setBusy(false); }
  }
  async function handleConfirmMfa() {
    if (!client || !mfaCode.trim()) return;
    setError(''); setBusy(true);
    try {
      await client.mfaConfirm(mfaCode.trim());
      setMfaState('enabled'); setMfaEnroll(null); setMfaCode('');
      setNotice(t('security.mfaEnabled'));
    } catch (e) { setError(describeError(e)); }
    finally { setBusy(false); }
  }
  function handleDisableMfa() {
    Alert.alert(t('security.disableMfa'), t('security.mfa'), [
      { text: t('security.cancel'), style: 'cancel' },
      { text: t('security.disableMfa'), style: 'destructive', onPress: () => void doDisableMfa() },
    ]);
  }
  async function doDisableMfa() {
    if (!client) return;
    setError(''); setBusy(true);
    try {
      await runWithStepUp(async () => {
        await client.mfaDisable();
        setMfaState('disabled'); setNotice(t('security.mfaDisabled'));
      });
    } catch (e) { setError(describeError(e)); }
    finally { setBusy(false); }
  }
  async function handleRegenerateCodes() {
    if (!client) return;
    setError(''); setBusy(true);
    try {
      await runWithStepUp(async () => {
        const res = await client.mfaRecoveryCodes();
        // Wire key is `recovery_codes` (was read as `res.codes`,
        // which is always undefined — fixed 17 Nov 2026).
        setRecoveryCodes(res.recovery_codes);
      });
    } catch (e) { setError(describeError(e)); }
    finally { setBusy(false); }
  }

  // --- Devices & sessions --------------------------------------------------
  async function handleTrustDevice(d: DeviceRow, trusted: boolean) {
    if (!client) return;
    setError(''); setBusy(true);
    try {
      await runWithStepUp(async () => {
        await client.updateDevice(d.id, { trusted });
        setDevices((list) => list.map((x) => (x.id === d.id ? { ...x, trusted } : x)));
      });
    } catch (e) { setError(describeError(e)); }
    finally { setBusy(false); }
  }
  async function handleSaveRename(d: DeviceRow) {
    if (!client) return;
    const name = renameValue.trim();
    if (!name) return;
    setError(''); setBusy(true);
    try {
      // The wire field is name_encrypted: the display name encrypted with
      // the in-memory Vault Key (nonce-prefixed base64, same envelope as
      // exportEncrypted). The server stores it opaquely and can never
      // read it. Encryption needs the unlocked vault — when locked,
      // encryptWithVaultKey throws and the rename is refused honestly.
      const nameEncrypted = await encryptWithVaultKey(name);
      await client.updateDevice(d.id, { name_encrypted: nameEncrypted });
      // Believe the rename only once a fresh list shows the new name.
      const fresh = await resolveDeviceLabels(rows<DeviceRow>(await client.listDevices(), 'devices'));
      setDevices(fresh);
      const updated = fresh.find((x) => x.id === d.id);
      if (!updated || deviceLabel(updated) !== name) {
        setError(`${t('security.error')}: ${name}`);
      } else {
        setRenamingId(null); setRenameValue('');
      }
    } catch (e) { setError(describeError(e)); }
    finally { setBusy(false); }
  }
  function handleRevokeDevice(d: DeviceRow) {
    Alert.alert(t('security.revoke'), deviceLabel(d), [
      { text: t('security.cancel'), style: 'cancel' },
      { text: t('security.revoke'), style: 'destructive', onPress: () => void doRevokeDevice(d) },
    ]);
  }
  async function doRevokeDevice(d: DeviceRow) {
    if (!client) return;
    setError(''); setBusy(true);
    try {
      // No DELETE /v1/devices endpoint exists in the backend contract:
      // revoking a device means untrusting it and revoking every server
      // session bound to it. That signs the device out server-side; it
      // does NOT erase secrets already downloaded on that device.
      await runWithStepUp(async () => {
        await client.updateDevice(d.id, { trusted: false });
        const sess = rows<SessionRow>(await client.listSessions(), 'sessions');
        const mine = sess.filter((s) => (s.device_id ?? '') === (d.device_id ?? d.id));
        await Promise.allSettled(mine.map((s) => client.revokeSession(s.id)));
        await loadAll(client);
      });
    } catch (e) { setError(describeError(e)); }
    finally { setBusy(false); }
  }
  /** Sign out of this device: revoke the current server session,
   *  clear the stored token, lock the vault (via App). When the
   *  server cannot confirm — offline, or the session already
   *  expired — local sign-out still proceeds. Revocation
   *  invalidates the server session only; it does NOT erase
   *  secrets already downloaded or cached offline here. */
  function handleSignOut() {
    Alert.alert(t('signin.signOut'), undefined, [
      { text: t('security.cancel'), style: 'cancel' },
      {
        text: t('signin.signOut'), style: 'destructive',
        onPress: () => void (async () => {
          if (client) {
            try { await client.revokeCurrentSession(); } catch { /* unconfirmed; local sign-out proceeds */ }
          }
          try { await clearSessionToken(asyncTokenStore); } catch { /* non-critical */ }
          onSignedOut?.();
        })(),
      },
    ]);
  }

  function handleRevokeSession(s: SessionRow) {
    Alert.alert(t('security.revokeSession'), s.device_id ?? s.id, [
      { text: t('security.cancel'), style: 'cancel' },
      { text: t('security.revoke'), style: 'destructive', onPress: () => void doRevokeSession(s) },
    ]);
  }
  async function doRevokeSession(s: SessionRow) {
    if (!client) return;
    setError(''); setBusy(true);
    try {
      await client.revokeSession(s.id);
      setSessions((list) => list.filter((x) => x.id !== s.id));
    } catch (e) { setError(describeError(e)); }
    finally { setBusy(false); }
  }
  function handleRevokeOthers() {
    Alert.alert(t('security.revokeOthers'), t('security.revokeOthersConfirm'), [
      { text: t('security.cancel'), style: 'cancel' },
      { text: t('security.revokeOthers'), style: 'destructive', onPress: () => void doRevokeOthers() },
    ]);
  }
  async function doRevokeOthers() {
    if (!client) return;
    setError(''); setBusy(true);
    try {
      await runWithStepUp(async () => {
        await client.revokeOtherSessions();
        await loadAll(client);
      });
    } catch (e) { setError(describeError(e)); }
    finally { setBusy(false); }
  }

  // --- Recovery verifier ---------------------------------------------------
  async function handleRegisterVerifier() {
    if (!client) return;
    setError(''); setNotice('');
    let seed: Uint8Array | null = null;
    try { seed = fromBase64Url(recoveryKeyInput.trim()); } catch { seed = null; }
    if (!seed || seed.length !== 32) { setError(t('security.error')); return; }
    setBusy(true);
    try {
      // Ed25519 keypair deterministically derived from the 32 recovery-key
      // bytes (libsodium crypto_sign_seed_keypair). ONLY the public key
      // ever leaves the device; the seed is zero-filled below and the
      // recovery key itself is never stored or logged.
      await sodium.ready;
      const kp = sodium.crypto_sign_seed_keypair(seed);
      const publicKeyB64 = toBase64(kp.publicKey);
      kp.privateKey.fill(0); // only the public key is ever needed afterwards
      await runWithStepUp(async () => {
        await client.registerRecoveryVerifier(publicKeyB64);
        const fp = toHex(await sha256(kp.publicKey)).slice(0, 16);
        setVerifierFingerprint(fp);
        setNotice(t('security.recoveryVerifierRegistered'));
      });
    } catch (e) { setError(describeError(e)); }
    finally {
      seed.fill(0);
      setRecoveryKeyInput('');
      setBusy(false);
    }
  }

  const section = (title: string) => <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700', marginTop: 24, marginBottom: 10 }}>{title}</Text>;
  const rowCard = { backgroundColor: colors.card, borderColor: colors.cardBorder, borderWidth: 1, borderRadius: 12, padding: 12, marginBottom: 8 } as const;

  if (baseUrl === null || (loading && !loaded)) {
    return (
      <View style={[styles.screen, { alignItems: 'center', justifyContent: 'center', padding: 24 }]}>
        <ActivityIndicator size="large" color={colors.accent} />
        <Text style={{ color: colors.muted, marginTop: 12 }}>{t('security.loading')}</Text>
      </View>
    );
  }

  if (baseUrl === '') {
    return (
      <ScrollView style={styles.screen} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        <Pressable testID="security-back" accessibilityLabel="Back to settings" onPress={onClose} hitSlop={10} style={{ alignSelf: 'flex-start', paddingVertical: 8 }}><Text style={{ color: '#A5B4FC', fontSize: 15 }}>‹ Back</Text></Pressable>
        <Text style={styles.title}>{t('security.title')}</Text>
        <Text style={[styles.subtitle, { marginTop: 12 }]}>{t('security.notConfigured')}</Text>
        <Text style={{ color: colors.muted, fontSize: 14, lineHeight: 20, marginTop: 8 }}>{t('security.notConfiguredBody')}</Text>
        <Pressable testID="security-close" accessibilityLabel={t('security.close')} style={[styles.ghostButton, { marginTop: 20 }]} onPress={onClose}>
          <Text style={styles.ghostButtonText}>{t('security.close')}</Text>
        </Pressable>
      </ScrollView>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
      <Pressable testID="security-back" accessibilityLabel="Back to settings" onPress={onClose} hitSlop={10} style={{ alignSelf: 'flex-start', paddingVertical: 8 }}><Text style={{ color: '#A5B4FC', fontSize: 15 }}>‹ Back</Text></Pressable>
      <Text style={styles.title}>{t('security.title')}</Text>
      <Text style={styles.subtitle}>{t('security.subtitle')}</Text>
      {notice ? <Text testID="security-notice" style={{ color: '#A5B4FC', fontSize: 14, lineHeight: 20, marginTop: 10 }}>{notice}</Text> : null}
      {error ? <Text testID="security-error" style={[styles.error, { marginTop: 10 }]}>{error}</Text> : null}
      {offline ? (
        <View style={{ marginTop: 12 }}>
          <Text style={{ color: colors.warn, fontSize: 14 }}>{t('security.offline')}</Text>
          <Pressable testID="security-retry" accessibilityLabel={t('security.retry')} style={[styles.ghostButton, { marginTop: 10 }]} onPress={() => client && void loadAll(client)}>
            <Text style={styles.ghostButtonText}>{t('security.retry')}</Text>
          </Pressable>
        </View>
      ) : null}

      {section(t('security.authMethods'))}
      <Text style={[styles.label, { marginTop: 4 }]}>{t('security.passkeys')}</Text>
      {passkeys.length === 0 ? (
        <Text style={{ color: colors.muted }}>{t('security.noPasskeys')}</Text>
      ) : passkeys.map((pk) => (
        <View key={pk.id} style={rowCard}>
          <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600' }}>{pk.credential_id_prefix}</Text>
          <Text style={{ color: colors.muted, fontSize: 13, marginTop: 4 }}>{fmtDate(pk.created_at)}</Text>
          <Pressable testID={`remove-passkey-${pk.id}`} accessibilityLabel={t('security.removePasskey')} disabled={busy} style={[styles.ghostButton, { marginTop: 10 }]} onPress={() => handleRemovePasskey(pk)}>
            <Text style={[styles.ghostButtonText, { color: colors.danger }]}>{t('security.removePasskey')}</Text>
          </Pressable>
        </View>
      ))}
      {/* TODO(i18n): no security.* key was specified for the mobile
          passkey limitation, so it is written here in English. */}
      <View style={{ backgroundColor: colors.warnSoft, borderColor: colors.cardBorder, borderWidth: 1, borderRadius: 12, padding: 12, marginTop: 8 }}>
        <Text style={{ color: colors.warn, fontSize: 13, lineHeight: 18, fontWeight: '600' }}>
          Add a passkey from Desktop or Web — passkeys cannot be created from this mobile build yet (this app has no WebAuthn ceremony).
        </Text>
      </View>

      {section(t('security.mfa'))}
      {/* MFA status comes from this client only: the backend contract has
          no MFA-status endpoint, so 'unknown' shows no status claim.
          Enroll+confirm sets enabled, disable sets disabled, and a 409
          on enroll is read as already-enabled. */}
      {mfaState === 'enabled' ? <Text style={{ color: colors.ok }}>{t('security.mfaEnabled')}</Text> : null}
      {mfaState === 'disabled' ? <Text style={{ color: colors.muted }}>{t('security.mfaDisabled')}</Text> : null}
      {mfaEnroll ? (
        <View style={{ marginTop: 12 }}>
          <Text style={[styles.label]}>{t('security.mfaSecretLabel')}</Text>
          <Text selectable testID="mfa-secret" style={{ color: colors.text, fontSize: 14, fontFamily: 'monospace' }}>{mfaEnroll.secret}</Text>
          <Text style={{ color: colors.warn, fontSize: 13, lineHeight: 18, marginTop: 6 }}>{t('security.mfaSecretWarning')}</Text>
          <Pressable testID="mfa-copy-secret" accessibilityLabel={t('common.copy')} style={[styles.ghostButton, { marginTop: 10 }]} onPress={() => void Clipboard.setStringAsync(mfaEnroll.secret)}>
            <Text style={styles.ghostButtonText}>{t('common.copy')}</Text>
          </Pressable>
          {mfaEnroll.otpauthUrl ? (
            <Text selectable style={{ color: colors.muted, fontSize: 12, marginTop: 10 }}>{mfaEnroll.otpauthUrl}</Text>
          ) : null}
          <Field label={t('security.mfaCodeLabel')} testID="mfa-confirm-code" placeholder="123456" value={mfaCode} onChangeText={setMfaCode} autoCapitalize="none" autoCorrect={false} keyboardType="number-pad" />
          <Pressable testID="mfa-confirm-button" accessibilityLabel={t('security.confirmMfa')} disabled={busy} style={styles.primaryButton} onPress={() => void handleConfirmMfa()}>
            <Text style={styles.primaryButtonText}>{t('security.confirmMfa')}</Text>
          </Pressable>
        </View>
      ) : (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 12 }}>
          <Pressable testID="mfa-enroll-button" accessibilityLabel={t('security.enrollMfa')} disabled={busy} style={[styles.primaryButton, { flex: 1, marginRight: 8 }]} onPress={() => void handleEnrollMfa()}>
            <Text style={styles.primaryButtonText}>{t('security.enrollMfa')}</Text>
          </Pressable>
          <Pressable testID="mfa-disable-button" accessibilityLabel={t('security.disableMfa')} disabled={busy} style={[styles.ghostButton, { flex: 1 }]} onPress={handleDisableMfa}>
            <Text style={[styles.ghostButtonText, { color: colors.danger }]}>{t('security.disableMfa')}</Text>
          </Pressable>
        </View>
      )}
      <Text style={[styles.label, { marginTop: 20 }]}>{t('security.recoveryCodes')}</Text>
      <Pressable testID="regenerate-codes-button" accessibilityLabel={t('security.regenerateCodes')} disabled={busy} style={styles.ghostButton} onPress={() => void handleRegenerateCodes()}>
        <Text style={styles.ghostButtonText}>{t('security.regenerateCodes')}</Text>
      </Pressable>
      {recoveryCodes ? (
        <View style={{ backgroundColor: colors.input, borderColor: colors.cardBorder, borderWidth: 1, borderRadius: 12, padding: 12, marginTop: 12 }}>
          <Text style={{ color: colors.warn, fontSize: 13, lineHeight: 18 }}>{t('security.codesShownOnce')}</Text>
          {recoveryCodes.map((c) => (
            <Text key={c} selectable style={{ color: colors.text, fontSize: 14, fontFamily: 'monospace', marginTop: 6 }}>{c}</Text>
          ))}
          <View style={{ flexDirection: 'row', marginTop: 12 }}>
            <Pressable testID="recovery-codes-copy" accessibilityLabel={t('common.copy')} style={[styles.ghostButton, { flex: 1, marginRight: 8 }]} onPress={() => void Clipboard.setStringAsync(recoveryCodes.join('\n'))}>
              <Text style={styles.ghostButtonText}>{t('common.copy')}</Text>
            </Pressable>
            <Pressable testID="recovery-codes-done" accessibilityLabel={t('security.done')} style={[styles.ghostButton, { flex: 1 }]} onPress={() => setRecoveryCodes(null)}>
              <Text style={styles.ghostButtonText}>{t('security.done')}</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {section(t('security.devices'))}
      {devices.length === 0 ? (
        <Text style={{ color: colors.muted }}>—</Text>
      ) : devices.map((d) => (
        <View key={d.id} style={rowCard}>
          <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600' }}>{deviceLabel(d)}</Text>
          <Text style={{ color: colors.muted, fontSize: 13, marginTop: 4 }}>{d.trusted ? t('security.trusted') : t('security.untrusted')}{d.last_seen_at ? ` · ${t('security.lastSeen')}: ${fmtDate(d.last_seen_at)}` : ''}</Text>
          {renamingId === d.id ? (
            <View style={{ marginTop: 10 }}>
              <Field label={t('security.rename')} testID={`rename-device-${d.id}`} placeholder={deviceLabel(d)} value={renameValue} onChangeText={setRenameValue} autoCapitalize="none" autoCorrect={false} />
              <View style={{ flexDirection: 'row' }}>
                <Pressable testID={`save-rename-${d.id}`} accessibilityLabel={t('security.save')} style={[styles.primaryButton, { flex: 1, marginRight: 8 }]} onPress={() => void handleSaveRename(d)}>
                  <Text style={styles.primaryButtonText}>{t('security.save')}</Text>
                </Pressable>
                <Pressable testID={`cancel-rename-${d.id}`} accessibilityLabel={t('security.cancel')} style={[styles.ghostButton, { flex: 1 }]} onPress={() => { setRenamingId(null); setRenameValue(''); }}>
                  <Text style={styles.ghostButtonText}>{t('security.cancel')}</Text>
                </Pressable>
              </View>
            </View>
          ) : (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 10 }}>
              <Pressable testID={`trust-device-${d.id}`} accessibilityLabel={d.trusted ? t('security.untrust') : t('security.trust')} disabled={busy} style={[styles.ghostButton, { flex: 1, marginRight: 8 }]} onPress={() => void handleTrustDevice(d, !d.trusted)}>
                <Text style={styles.ghostButtonText}>{d.trusted ? t('security.untrust') : t('security.trust')}</Text>
              </Pressable>
              <Pressable testID={`rename-device-button-${d.id}`} accessibilityLabel={t('security.rename')} style={[styles.ghostButton, { flex: 1, marginRight: 8 }]} onPress={() => { setRenamingId(d.id); setRenameValue(deviceLabel(d)); }}>
                <Text style={styles.ghostButtonText}>{t('security.rename')}</Text>
              </Pressable>
              <Pressable testID={`revoke-device-${d.id}`} accessibilityLabel={t('security.revoke')} disabled={busy} style={[styles.ghostButton, { flex: 1, borderColor: colors.danger }]} onPress={() => handleRevokeDevice(d)}>
                <Text style={[styles.ghostButtonText, { color: colors.danger }]}>{t('security.revoke')}</Text>
              </Pressable>
            </View>
          )}
        </View>
      ))}

      {section(t('security.sessions'))}
      {/* The revocation notice lives in the revoke-others confirmation
          string (security.revokeOthersConfirm): revocation invalidates
          the server session only and does NOT erase secrets already
          downloaded / offline on that device. Shown here as a standing
          note and again in the confirmation dialog. */}
      <Text style={{ color: colors.warn, fontSize: 13, lineHeight: 18, marginBottom: 10 }}>{t('security.revokeOthersConfirm')}</Text>
      {sessions.length === 0 ? (
        <Text style={{ color: colors.muted }}>—</Text>
      ) : sessions.map((s) => (
        <View key={s.id} style={rowCard}>
          <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600' }}>{s.device_id ?? s.id}</Text>
          <Text style={{ color: colors.muted, fontSize: 13, marginTop: 4 }}>{s.user_agent ?? ''}</Text>
          <Text style={{ color: colors.muted, fontSize: 13 }}>{s.ip_address ?? ''}{s.created_at ? ` · ${fmtDate(s.created_at)}` : ''}</Text>
          {s.current ? <Text style={{ color: colors.ok, fontSize: 13, fontWeight: '600', marginTop: 4 }}>{t('security.currentSession')}</Text> : null}
          {!s.current ? (
            <Pressable testID={`revoke-session-${s.id}`} accessibilityLabel={t('security.revokeSession')} disabled={busy} style={[styles.ghostButton, { marginTop: 10 }]} onPress={() => handleRevokeSession(s)}>
              <Text style={[styles.ghostButtonText, { color: colors.danger }]}>{t('security.revokeSession')}</Text>
            </Pressable>
          ) : null}
        </View>
      ))}
      <Pressable testID="revoke-others-button" accessibilityLabel={t('security.revokeOthers')} disabled={busy} style={[styles.dangerButton, { marginTop: 4 }]} onPress={handleRevokeOthers}>
        <Text style={styles.primaryButtonText}>{t('security.revokeOthers')}</Text>
      </Pressable>
      <Pressable testID="sign-out-button" accessibilityLabel={t('signin.signOut')} disabled={busy} style={[styles.ghostButton, { marginTop: 12 }]} onPress={handleSignOut}>
        <Text style={[styles.ghostButtonText, { color: colors.danger }]}>{t('signin.signOut')}</Text>
      </Pressable>

      {section(t('security.recovery'))}
      <Text style={[styles.label, { marginTop: 4 }]}>{t('security.recoverySettings')}</Text>
      <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 18 }}>{t('security.recoveryNote')}</Text>
      <Text style={[styles.label, { marginTop: 16 }]}>{t('security.recoveryVerifier')}</Text>
      {verifierFingerprint ? (
        <View style={{ marginTop: 4 }}>
          <Text style={{ color: colors.ok, fontSize: 14 }}>{t('security.recoveryVerifierRegistered')}</Text>
          <Text selectable testID="recovery-verifier-fingerprint" style={{ color: colors.text, fontSize: 14, fontFamily: 'monospace', marginTop: 6 }}>{verifierFingerprint}</Text>
        </View>
      ) : null}
      <Field label={t('security.recoveryVerifier')} testID="recovery-verifier-key" placeholder="Recovery key (shown once at vault creation)" secureTextEntry value={recoveryKeyInput} onChangeText={setRecoveryKeyInput} autoCapitalize="none" autoCorrect={false} />
      <Pressable testID="register-verifier-button" accessibilityLabel={t('security.registerRecoveryVerifier')} disabled={busy} style={styles.primaryButton} onPress={() => void handleRegisterVerifier()}>
        <Text style={styles.primaryButtonText}>{t('security.registerRecoveryVerifier')}</Text>
      </Pressable>


      {section(t('security.activity'))}
      {activity.length === 0 ? (
        <Text style={{ color: colors.muted }}>{t('security.noActivity')}</Text>
      ) : activity.map((a, i) => (
        <View key={`${a.event_type}-${a.created_at ?? ''}-${i}`} style={rowCard}>
          <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600' }}>{a.event_type}</Text>
          <Text style={{ color: colors.muted, fontSize: 13, marginTop: 4 }}>{a.device_id ?? ''}{a.created_at ? ` · ${fmtDate(a.created_at)}` : ''}</Text>
        </View>
      ))}

      {stepUpOpen ? (
        <View style={{ backgroundColor: colors.card, borderColor: colors.accent, borderWidth: 1, borderRadius: 12, padding: 16, marginTop: 24 }}>
          <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700' }}>{t('security.stepUpTitle')}</Text>
          <Text style={{ color: colors.muted, fontSize: 14, lineHeight: 20, marginTop: 6 }}>{t('security.stepUpBody')}</Text>
          <View style={{ marginTop: 12 }}>
            <Field label={t('security.stepUpTotpLabel')} testID="stepup-totp-code" placeholder="123456" value={stepUpCode} onChangeText={setStepUpCode} autoCapitalize="none" autoCorrect={false} keyboardType="number-pad" />
          </View>
          {stepUpError ? <Text testID="stepup-error" style={[styles.error, { marginBottom: 10 }]}>{stepUpError}</Text> : null}
          <View style={{ flexDirection: 'row' }}>
            <Pressable testID="stepup-confirm" accessibilityLabel={t('security.confirm')} disabled={stepUpBusy} style={[styles.primaryButton, { flex: 1, marginRight: 8 }]} onPress={() => void submitStepUp()}>
              <Text style={styles.primaryButtonText}>{t('security.confirm')}</Text>
            </Pressable>
            <Pressable testID="stepup-cancel" accessibilityLabel={t('security.cancel')} style={[styles.ghostButton, { flex: 1 }]} onPress={() => { setStepUpOpen(false); setStepUpCode(''); setStepUpError(''); pendingStepUpAction.current = null; }}>
              <Text style={styles.ghostButtonText}>{t('security.cancel')}</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </ScrollView>
  );
}
