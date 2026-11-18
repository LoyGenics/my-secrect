import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Keyboard, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Clipboard from 'expo-clipboard';
import { AppTextField } from '../components/Field';
import { AppButton, AppPage, BottomSheet, EmptyState, FieldGroup, FormSection, Group, IconButton, InlineError, PageSection, Progress, Rule, SegmentedControl, SelectField, SettingsRow } from '../components/mobile-ui';
import { illustrations } from '../../../../packages/ui/src/native';
import { useMobileTheme } from '../theme';
import { useTranslation } from '../../../../packages/i18n/src/react';
// NOTE (import depth): from apps/mobile/src/screens/ the repo root is four
// levels up — '../../../../packages/...' — the same depth TrashScreen uses
// for packages/core. A three-level import would resolve inside apps/.
// The SDK client (packages/sdk/src/security.ts) is owned by the desktop agent;
// this screen only calls its public methods, never re-implements them.
// Method names follow the SDK as landed (mfaEnroll, mfaConfirm, mfaDisable, mfaRecoveryCodes). Do not “fix” it by inlining a client here.
import { SecurityApiClient, clearSessionToken, getValidToken, isUnauthorized } from '../../../../packages/sdk/src/security';
import { fromBase64Url, sha256, toBase64 } from '../../../../packages/crypto-adapters/src/index';
import { recoveryVerifierKeyPair } from '../../../../packages/sdk/src/recovery-verifier';
import { decryptWithVaultKey, encryptWithVaultKey } from '../vault';
import { apiStatus, isNetworkError, isSessionUnauthorized, isStepUpFresh, isStepUpRequired } from '../utils/stepUp';
import { space } from '../ui/tokens';

/**
 * Security Center (mobile) — account security ONLY. This screen never
 * touches vault content: account auth (passkeys / MFA / sessions /
 * devices) stays separate from vault unlock (passphrase / recovery key),
 * and the server never sees vault content, only ciphertext + opaque ids.
 *
 * Honest-state rules followed here (same as SharesScreen):
 * - No server configured (development build without an API URL)
 *   -> not-configured state, never fake data, never a crash.
 * - Offline -> offline state + retry. Server errors -> error + retry.
 * - Passkeys: list + Remove work server-side. ADD does not: React Native
 *   / Expo Go has no WebAuthn browser API and local biometric prompts do
 *   not perform WebAuthn — so there is no Add button, only guidance
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
type SecuritySection = 'auth' | 'devices' | 'recovery' | 'activity' | 'account';
const resources = ['passkeys', 'sessions', 'devices', 'activity'] as const;
type SecurityResource = (typeof resources)[number];

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
function fmtDate(raw: string | null | undefined, locale: string): string {
  if (!raw) return '';
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? raw : d.toLocaleString(locale);
}

export default function SecurityScreen({ baseUrl, onSignedOut, onUnauthorized }: {
  baseUrl: string;
  onClose: () => void;
  /** App completes sign-out and locks the local vault. */
  onSignedOut?: () => void;
  /** Every server call answered 401: the session is gone
   *  server-side. App clears the token and shows SignIn. */
  onUnauthorized?: () => void;
}) {
  const [sectionKey, setSectionKey] = useState<SecuritySection>('auth');
  const [deviceArea, setDeviceArea] = useState<'devices' | 'sessions'>('devices');
  const { colors, styles } = useMobileTheme();
  const { t, dict, locale } = useTranslation();
  const [loading, setLoading] = useState(Boolean(baseUrl));
  const [offline, setOffline] = useState(false);
  const [failedResources, setFailedResources] = useState<SecurityResource[]>([]);
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
  const [actionDeviceId, setActionDeviceId] = useState<string>();
  const [recoveryKeyInput, setRecoveryKeyInput] = useState('');
  const [verifierFingerprint, setVerifierFingerprint] = useState<string | null>(null);
  const [recoveryKeyError, setRecoveryKeyError] = useState('');
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
    if (isSessionUnauthorized(e)) onUnauthorized?.();
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
    setFailedResources(resources.filter((_, index) => results[index].status === 'rejected'));
    if (!anyOk && anyNetwork) setOffline(true);
    else if (!anyOk) setError(t('security.error'));
    setLoaded(true); setLoading(false);
    // Every call answered 401: the session is gone server-side
    // (revoked or expired). Hand back to SignIn via App; never
    // silently retry with the same stale token.
    if (!anyOk && allUnauthorized) onUnauthorized?.();
  }

  useEffect(() => {
    if (client) void loadAll(client);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

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
    if (!/^\d{6}$/.test(code)) { setStepUpError(dict.mobileSecurity.invalidCode); return; }
    setStepUpBusy(true); setStepUpError('');
    Keyboard.dismiss();
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
        setRenamingId(null); setRenameValue(''); setActionDeviceId(undefined);
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

  function confirmDeleteAccount() {
    if (busy || !client) return;
    Alert.alert(dict.securityActions.deleteAccountConfirm, dict.securityActions.deleteAccountBody, [
      { text: dict.common.cancel, style: 'cancel' },
      { text: dict.securityActions.deleteAccount, style: 'destructive', onPress: () => void requestDeleteAccount(client) },
    ]);
  }

  async function requestDeleteAccount(c: SecurityApiClient) {
    setError(''); setNotice('');
    try {
      await runWithStepUp(async () => {
        setBusy(true);
        try {
          await c.deleteAccount();
          await clearSessionToken(asyncTokenStore).catch(() => undefined);
          if (onSignedOut) {
            Alert.alert(dict.mobileSecurity.deletedTitle, dict.securityActions.accountDeleted, [
              { text: dict.security.done, onPress: onSignedOut },
            ], { cancelable: false });
          } else {
            setNotice(dict.securityActions.accountDeleted);
          }
        } catch (error) {
          if (isStepUpRequired(error)) throw error;
          if (apiStatus(error) === 409 && error instanceof Error && error.message.includes('active_billing')) {
            setError(dict.mobileSecurity.activeBilling);
          } else {
            setError(describeError(error));
          }
        } finally {
          setBusy(false);
        }
      });
    } catch (error) {
      setError(describeError(error));
    }
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
    setError(''); setNotice(''); setRecoveryKeyError('');
    let seed: Uint8Array | null = null;
    try { seed = fromBase64Url(recoveryKeyInput.trim()); } catch { seed = null; }
    if (!seed || seed.length !== 32) { setRecoveryKeyError(dict.mobileSecurity.invalidRecoveryKey); return; }
    setBusy(true);
    try {
      // Ed25519 keypair derived from the 32 recovery-key bytes with domain
      // separation (HKDF-SHA-256, info "my-secrect/recovery-verifier/v1" —
      // packages/sdk/src/recovery-verifier.ts), so the verifier key is never
      // the vault's recovery secret itself. ONLY the public key ever leaves
      // the device; the recovery key is zero-filled below and never stored
      // or logged.
      const kp = await recoveryVerifierKeyPair(seed);
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

  const labels = dict.mobileSecurity;
  const security = dict.security;
  const sections: Array<{ value: SecuritySection; label: string }> = [
    { value: 'auth', label: security.authMethods },
    { value: 'devices', label: labels.devicesSessions },
    { value: 'recovery', label: security.recovery },
    { value: 'activity', label: security.activity },
    { value: 'account', label: labels.account },
  ];
  const actionDevice = devices.find(({ id }) => id === actionDeviceId);
  const renaming = actionDevice && actionDevice.id === renamingId;
  const unavailable = failedResources.length === resources.length;
  const deviceDetail = (device: DeviceRow) => [
    device.trusted ? security.trusted : security.untrusted,
    device.last_seen_at && `${security.lastSeen} · ${fmtDate(device.last_seen_at, locale)}`,
  ].filter(Boolean).join('\n');
  const sessionDetail = (session: SessionRow) => [
    session.current && security.currentSession,
    session.user_agent,
    session.ip_address,
    fmtDate(session.created_at, locale),
  ].filter(Boolean).join('\n');

  function closeDeviceActions() {
    if (busy) return;
    setActionDeviceId(undefined);
    setRenamingId(null);
    setRenameValue('');
  }

  function cancelStepUp() {
    if (stepUpBusy) return;
    setStepUpOpen(false);
    setStepUpCode('');
    setStepUpError('');
    pendingStepUpAction.current = null;
  }

  function copyOneTimeValue(value: string) {
    void Clipboard.setStringAsync(value)
      .then(() => setNotice(dict.common.copied))
      .catch(() => setError(labels.copyFailed));
  }

  if (!baseUrl) {
    return <AppPage safeArea="bottom">
      <EmptyState image={illustrations.emptyVault} title={t('mobileUI.securityConnect')} detail={t('mobileUI.securityConnectBody')} />
    </AppPage>;
  }

  if (loading && !loaded) {
    return <AppPage safeArea="bottom"><Progress label={security.loading} testID="security-loading" /></AppPage>;
  }

  return (
    <AppPage safeArea="bottom" testID="security-screen">
      <SelectField testID="security-section" label={labels.area} value={sectionKey} choices={sections}
        onChange={(value) => setSectionKey(value as SecuritySection)} />
      {loading && <Progress label={security.loading} testID="security-reloading" />}
      {!!notice && <Text testID="security-notice" accessibilityLiveRegion="polite" style={[styles.small, local.feedback, { color: colors.successText }]}>{notice}</Text>}
      {(error && !renaming || offline || failedResources.length > 0) && (
        <PageSection>
          {offline ? <InlineError testID="security-offline">{security.offline}</InlineError>
            : (error && !renaming) ? <InlineError testID="security-error">{error}</InlineError>
              : <InlineError testID="security-partial-load">{labels.incomplete}</InlineError>}
          {failedResources.length > 0 && <AppButton testID="security-retry" label={security.retry} variant="secondary"
            icon="regenerate" loading={loading} onPress={() => client && void loadAll(client)} />}
        </PageSection>
      )}

      {!unavailable && sectionKey === 'auth' && <>
        <Group title={security.passkeys} footer={labels.passkeyAvailability}>
          {passkeys.length === 0 && !failedResources.includes('passkeys') && <SettingsRow label={security.noPasskeys} />}
          {passkeys.map((passkey, index) => (
            <React.Fragment key={passkey.id}>
              {index > 0 && <Rule leading />}
              <SettingsRow label={passkey.credential_id_prefix} icon="passkey" detail={fmtDate(passkey.created_at, locale)}>
                <IconButton testID={`remove-passkey-${passkey.id}`} icon="trash" tone="danger" accessibilityLabel={security.removePasskey}
                  disabled={busy || failedResources.includes('passkeys')} onPress={() => handleRemovePasskey(passkey)} />
              </SettingsRow>
            </React.Fragment>
          ))}
        </Group>

        <FormSection title={security.mfa}
          description={mfaState === 'unknown' ? undefined : mfaState === 'enabled' ? security.mfaEnabled : security.mfaDisabled}>
          {mfaEnroll ? <FieldGroup>
            <View style={[styles.card, local.secretBlock]}>
              <Text style={styles.label}>{security.mfaSecretLabel}</Text>
              <Text selectable testID="mfa-secret" style={[styles.body, local.monospace]}>{mfaEnroll.secret}</Text>
              <Text style={[styles.small, { color: colors.warningText }]}>{security.mfaSecretWarning}</Text>
              {mfaEnroll.otpauthUrl ? <Text selectable style={[styles.small, local.monospace]}>{mfaEnroll.otpauthUrl}</Text> : null}
              <AppButton testID="mfa-copy-secret" label={dict.common.copy} icon="copy" variant="secondary" onPress={() => copyOneTimeValue(mfaEnroll.secret)} />
            </View>
            <AppTextField flush label={security.mfaCodeLabel} testID="mfa-confirm-code" value={mfaCode}
              onChangeText={(value) => setMfaCode(value.replace(/\D/g, ''))} maxLength={6} autoCapitalize="none" autoCorrect={false}
              keyboardType="number-pad" autoComplete="one-time-code" />
            <AppButton testID="mfa-confirm-button" label={security.confirmMfa} loading={busy} disabled={mfaCode.length !== 6}
              onPress={() => void handleConfirmMfa()} />
          </FieldGroup> : <View style={local.actions}>
            {mfaState !== 'enabled' && <AppButton testID="mfa-enroll-button" label={security.enrollMfa} icon="shield"
              loading={busy} onPress={() => void handleEnrollMfa()} />}
            {mfaState !== 'disabled' && <AppButton testID="mfa-disable-button" label={security.disableMfa}
              variant="secondary" disabled={busy} onPress={handleDisableMfa} />}
          </View>}
        </FormSection>
      </>}

      {!unavailable && sectionKey === 'devices' && <>
        <PageSection>
          <SegmentedControl label={labels.devicesSessions} testID="security-device-area" value={deviceArea}
            choices={[{ value: 'devices', label: security.devices }, { value: 'sessions', label: security.sessions }]}
            onChange={(value) => setDeviceArea(value as typeof deviceArea)} />
        </PageSection>
        {deviceArea === 'devices' ? <Group>
          {devices.length === 0 && !failedResources.includes('devices') && <SettingsRow label={labels.noDevices} />}
          {devices.map((device, index) => (
            <React.Fragment key={device.id}>
              {index > 0 && <Rule leading />}
              <SettingsRow label={deviceLabel(device)} icon="system" detail={deviceDetail(device)}>
                <IconButton testID={`device-more-${device.id}`} icon="more" accessibilityLabel={t('mobileSecurity.deviceActions', deviceLabel(device))}
                  disabled={busy || failedResources.includes('devices')} onPress={() => setActionDeviceId(device.id)} />
              </SettingsRow>
            </React.Fragment>
          ))}
        </Group> : <PageSection description={security.revokeOthersConfirm}>
          <Group>
            {sessions.length === 0 && !failedResources.includes('sessions') && <SettingsRow label={labels.noSessions} />}
            {sessions.map((session, index) => (
              <React.Fragment key={session.id}>
                {index > 0 && <Rule leading />}
                <SettingsRow label={session.device_id ?? session.id} icon="security" detail={sessionDetail(session)}>
                  {session.current ? undefined : <IconButton testID={`revoke-session-${session.id}`} icon="trash" tone="danger"
                    accessibilityLabel={security.revokeSession} disabled={busy || failedResources.includes('sessions')} onPress={() => handleRevokeSession(session)} />}
                </SettingsRow>
              </React.Fragment>
            ))}
          </Group>
          {sessions.some((session) => !session.current) && !failedResources.includes('sessions') &&
            <AppButton testID="revoke-others-button" label={security.revokeOthers} variant="destructive" disabled={busy} onPress={handleRevokeOthers} />}
        </PageSection>}
      </>}

      {!unavailable && sectionKey === 'recovery' && <>
        <FormSection title={security.recoveryCodes}>
          <View style={local.actions}>
            {recoveryCodes && <View style={[styles.card, local.secretBlock]}>
              <Text style={[styles.small, { color: colors.warningText }]}>{security.codesShownOnce}</Text>
              {recoveryCodes.map((code) => <Text key={code} selectable style={[styles.body, local.monospace]}>{code}</Text>)}
              <AppButton testID="recovery-codes-copy" label={dict.common.copy} icon="copy" variant="secondary"
                onPress={() => copyOneTimeValue(recoveryCodes.join('\n'))} />
              <AppButton testID="recovery-codes-done" label={security.done} variant="text" onPress={() => setRecoveryCodes(null)} />
            </View>}
            {mfaState !== 'disabled' && <AppButton testID="regenerate-codes-button" label={security.regenerateCodes} icon="regenerate"
              variant="secondary" disabled={busy} onPress={() => void handleRegenerateCodes()} />}
          </View>
        </FormSection>
        <FormSection title={security.recoveryVerifier} description={security.recoveryNote}>
          <FieldGroup>
            {verifierFingerprint && <Text selectable testID="recovery-verifier-fingerprint" style={[styles.body, local.monospace]}>{verifierFingerprint}</Text>}
            <AppTextField flush revealable label={labels.recoveryKey} testID="recovery-verifier-key" error={recoveryKeyError || undefined}
              value={recoveryKeyInput} onChangeText={(value) => { setRecoveryKeyInput(value); setRecoveryKeyError(''); }}
              autoCapitalize="none" autoCorrect={false} autoComplete="off" />
            <AppButton testID="register-verifier-button" label={security.registerRecoveryVerifier} icon="shield"
              disabled={busy || !recoveryKeyInput.trim()} onPress={() => void handleRegisterVerifier()} />
          </FieldGroup>
        </FormSection>
      </>}

      {!unavailable && sectionKey === 'activity' && <Group>
        {activity.length === 0 && !failedResources.includes('activity') && <SettingsRow label={security.noActivity} />}
        {activity.map((entry, index) => (
          <React.Fragment key={`${entry.event_type}-${entry.created_at ?? ''}-${index}`}>
            {index > 0 && <Rule leading />}
            <SettingsRow label={entry.event_type} icon="health" detail={[entry.device_id, fmtDate(entry.created_at, locale)].filter(Boolean).join('\n')} />
          </React.Fragment>
        ))}
      </Group>}

      {sectionKey === 'account' && <>
        <FormSection title={labels.account} description={dict.securityActions.signOutNote}>
            <AppButton testID="sign-out-button" label={dict.signin.signOut} variant="secondary" disabled={busy} onPress={handleSignOut} />
        </FormSection>
        {!unavailable && <FormSection description={dict.securityActions.deleteAccountBody}>
          <AppButton testID="security-delete-account" label={dict.securityActions.deleteAccount} variant="destructive"
            icon="trash" loading={busy} onPress={confirmDeleteAccount} />
        </FormSection>}
      </>}

      <BottomSheet compact visible={!!actionDevice} title={renaming ? labels.renameDevice : actionDevice ? deviceLabel(actionDevice) : security.devices}
        testID="security-device-actions" onClose={closeDeviceActions}>
        {actionDevice && (renaming ? <FieldGroup>
          <AppTextField flush label={labels.deviceName} testID={`rename-device-${actionDevice.id}`} value={renameValue} onChangeText={setRenameValue}
            autoCapitalize="sentences" autoCorrect={false} error={error || undefined} returnKeyType="done" onSubmitEditing={() => void handleSaveRename(actionDevice)} />
          <AppButton testID={`save-rename-${actionDevice.id}`} label={security.save} loading={busy}
            disabled={!renameValue.trim()} onPress={() => void handleSaveRename(actionDevice)} />
          <AppButton testID={`cancel-rename-${actionDevice.id}`} label={security.cancel} variant="text" disabled={busy} onPress={closeDeviceActions} />
        </FieldGroup> : <Group>
          <SettingsRow testID={`trust-device-${actionDevice.id}`} label={actionDevice.trusted ? security.untrust : security.trust} icon="shield"
            onPress={() => { closeDeviceActions(); void handleTrustDevice(actionDevice, !actionDevice.trusted); }} />
          <Rule leading />
          <SettingsRow testID={`rename-device-button-${actionDevice.id}`} label={labels.renameDevice} icon="edit"
            onPress={() => { setError(''); setRenamingId(actionDevice.id); setRenameValue(deviceLabel(actionDevice)); }} />
          <Rule leading />
          <SettingsRow testID={`revoke-device-${actionDevice.id}`} label={security.revoke} icon="trash" destructive
            onPress={() => { closeDeviceActions(); handleRevokeDevice(actionDevice); }} />
        </Group>)}
      </BottomSheet>

      <BottomSheet visible={stepUpOpen} title={security.stepUpTitle} testID="security-stepup-sheet" onClose={cancelStepUp}
        footer={<>
          <AppButton testID="stepup-confirm" label={security.confirm} loading={stepUpBusy} onPress={() => void submitStepUp()} />
          <AppButton testID="stepup-cancel" label={security.cancel} variant="text" disabled={stepUpBusy} onPress={cancelStepUp} />
        </>}>
        <FieldGroup>
          <Text style={styles.small}>{labels.stepUpBody}</Text>
          <AppTextField flush label={security.stepUpTotpLabel} testID="stepup-totp-code" value={stepUpCode}
            onChangeText={(value) => { setStepUpCode(value.replace(/\D/g, '')); setStepUpError(''); }}
            keyboardType="number-pad" maxLength={6} autoCorrect={false} autoComplete="one-time-code" />
          {!!stepUpError && <InlineError testID="stepup-error">{stepUpError}</InlineError>}
        </FieldGroup>
      </BottomSheet>
    </AppPage>
  );
}

const local = StyleSheet.create({
  feedback: { marginBottom: space[4] },
  actions: { gap: space[3] },
  secretBlock: { gap: space[2] },
  monospace: { fontFamily: 'monospace' },
});
