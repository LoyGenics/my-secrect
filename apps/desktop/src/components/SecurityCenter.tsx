import { useEffect, useState } from 'react';
import sodium from 'libsodium-wrappers-sumo';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { formatDate, type Dictionary } from '../../../../packages/i18n/src/index';
import {
  ApiError,
  isStepUpRequired,
  isUnauthorized,
  isVerificationFailed,
  type ActivityEvent,
  type DeviceInfo,
  type PasskeyAuthenticator,
  type SecurityApiClient,
  type SessionInfo,
} from '../../../../packages/sdk/src/security';
import { fromBase64Url, sha256, toBase64 } from '../../../../packages/crypto-adapters/src/index';
import { deviceMessage as deviceSignedMessage, enrollPayload, toBase64UrlNoPad } from '../../../../packages/sdk/src/device-identity';
import { serializeCreateCredential, toCreationOptions } from '../utils/webauthn';
import StepUpDialog from './StepUpDialog';

/** localStorage prefix for the device signing key (private half, encrypted under the Vault Key). */
const LS_DEVICE_KEY_PREFIX = 'my-secrect:device-key:';

/**
 * SecurityCenter — account security for a server-backed account.
 *
 * Four sections:
 *   (a) Authentication methods — passkeys (WebAuthn) + MFA (TOTP) +
 *       recovery codes.
 *   (b) Trusted devices & sessions — rename / trust / revoke devices,
 *       revoke sessions. Revocation invalidates server sessions only;
 *       it does NOT erase secrets already downloaded or stored offline
 *       on a device (that sentence is in the i18n strings and shown
 *       next to the revoke controls).
 *   (c) Recovery settings — register a recovery verifier: an Ed25519
 *       keypair is derived on-device from the recovery key
 *       (crypto_sign_seed_keypair, seed = the 32 recovery-key bytes)
 *       and ONLY the public key is sent to the server. The seed and
 *       the private key are zero-filled immediately after use, and the
 *       pasted recovery key is cleared from state. Losing passphrase +
 *       recovery key + all devices is permanent loss — no reset.
 *   (d) Security activity — the server's event list, shown as-is.
 *       Nothing is ever invented here; an empty list renders empty.
 *   (e) Delete account — DELETE /v1/auth/account via guarded(), so a
 *       403 step_up_required opens the server step-up dialog (passkey /
 *       TOTP, verified by the server) and the delete does not proceed
 *       until it succeeds. Labels live in the `securityActions`
 *       dictionary section (the 65-key `security` section is frozen).
 *
 * Account auth is SEPARATE from vault unlock: signing in does not
 * unlock the vault, and the server never sees vault keys or contents.
 *
 * Honest states everywhere: not-configured (no API base URL),
 * loading, offline (fetch failed), empty, and per-action errors.
 * A server call that answers 403 `step_up_required` does not proceed:
 * it shows stepUpExpired and offers a Verify button that re-runs the
 * action through the App's step-up dialog.
 *
 * Honest limits, shown in the UI itself:
 *  - MFA status has no read endpoint in the API contract, so the
 *    screen only reports the result of an enroll / disable done in
 *    this session; before that it makes no status claim.
 *  - There is no device-delete endpoint in the contract, so device
 *    "Revoke" revokes that device's server sessions (matched by
 *    device_id), not the device record itself.
 *  - Device display names are encrypted under the local Vault Key
 *    (encryptWithVaultKey) before they are sent as `name_encrypted`;
 *    the server stores opaque ciphertext. Names the server returns
 *    that this vault cannot decrypt are shown as the device id.
 *
 * NOTE on the one hardcoded string: the exact 65-key `security`
 * dictionary has no slot for a WebAuthn-unavailable note, so that one
 * explanatory clause is plain English here (the rest of the desktop
 * app hardcodes its strings too). Everything else uses the dictionary.
 */

export interface SecurityCenterProps {
  /** Null when no API base URL is configured — the screen then shows
   *  the not-configured state and makes no server call. */
  security: SecurityApiClient | null;
  apiBaseUrl: string;
  /** Vault-Key encryption for device display names (server sees only ciphertext). */
  encryptWithVaultKey: (plaintext: string) => Promise<string>;
  decryptWithVaultKey: (encoded: string) => Promise<string>;
  /** Email of the signed-in account (display only). */
  signedInEmail?: string;
  /** Sign out: revokes the current server session, clears the
   *  stored token and locks the vault (owned by App). */
  onSignOut?: () => void;
  /** Called when the server answers 401 to every load: the stored
   *  session is gone server-side. App clears the token and shows
   *  the sign-in gate again; this screen never silently retries. */
  onUnauthorized?: () => void;
  /** Called after the server confirmed account deletion (204). App
   *  clears the stored session + email and returns to the sign-in gate;
   *  the local vault is NOT erased. */
  onAccountDeleted?: () => void;
}

type LoadStatus = 'not-configured' | 'loading' | 'ready' | 'error';

function describeError(err: unknown, dict: Dictionary): string {
  const s = dict.security;
  if (err instanceof ApiError) {
    if (err.status === 422 && err.message.includes('last_authenticator')) return dict.securityActions.lastPasskeyBlocked;
    return `${s.error} (HTTP ${err.status})`;
  }
  if (err instanceof TypeError) return s.offline;
  return err instanceof Error ? err.message : s.error;
}

function webAuthnAvailable(): boolean {
  try {
    return (
      typeof navigator !== 'undefined' &&
      !!navigator.credentials &&
      typeof navigator.credentials.create === 'function' &&
      typeof navigator.credentials.get === 'function'
    );
  } catch {
    return false;
  }
}

export default function SecurityCenter({
  security,
  apiBaseUrl,
  encryptWithVaultKey,
  decryptWithVaultKey,
  signedInEmail,
  onSignOut,
  onUnauthorized,
  onAccountDeleted,
}: SecurityCenterProps) {
  const { dict, locale } = useTranslation();
  const s = dict.security;
  const x = dict.securityActions;
  const [status, setStatus] = useState<LoadStatus>(security ? 'loading' : 'not-configured');
  const [loadError, setLoadError] = useState('');
  const [passkeys, setPasskeys] = useState<PasskeyAuthenticator[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [displayNames, setDisplayNames] = useState<Record<string, string>>({});
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  // Server step-up: when the server answers 403 step_up_required this
  // screen opens its OWN serverOnly dialog (passkey / TOTP, verified by
  // the server) and re-runs the refused action once it succeeds. The
  // App-level dialog (passphrase) is for local actions and cannot
  // satisfy the server.
  const [stepUpRetry, setStepUpRetry] = useState<(() => Promise<void>) | null>(null);

  // (a) passkeys
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [passkeyError, setPasskeyError] = useState('');
  const [passkeyMessage, setPasskeyMessage] = useState('');
  const [confirmRemovePasskeyId, setConfirmRemovePasskeyId] = useState<string | null>(null);
  const [webAuthnUnavailable, setWebAuthnUnavailable] = useState(false);

  // (a) MFA — status is only known from an enroll/disable done here;
  // the API contract has no MFA-status read endpoint, so before any
  // action this screen makes no status claim (see header).
  const [mfaState, setMfaState] = useState<'unknown' | 'enabled' | 'disabled'>('unknown');
  const [mfaSecret, setMfaSecret] = useState<{ otpauth_url: string; secret: string } | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [mfaBusy, setMfaBusy] = useState(false);
  const [mfaError, setMfaError] = useState('');
  const [mfaMessage, setMfaMessage] = useState('');
  const [confirmDisableMfa, setConfirmDisableMfa] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  // (b) devices & sessions
  const [deviceError, setDeviceError] = useState('');
  const [deviceMessage, setDeviceMessage] = useState('');
  const [renameDeviceId, setRenameDeviceId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [sessionError, setSessionError] = useState('');
  const [sessionMessage, setSessionMessage] = useState('');
  const [confirmRevokeSessionId, setConfirmRevokeSessionId] = useState<string | null>(null);
  const [confirmRevokeOthers, setConfirmRevokeOthers] = useState(false);
  const [enrollName, setEnrollName] = useState('');
  const [enrollBusy, setEnrollBusy] = useState(false);

  // (c) recovery verifier
  const [recoveryKeyInput, setRecoveryKeyInput] = useState('');
  const [verifierFingerprint, setVerifierFingerprint] = useState<string | null>(null);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryError, setRecoveryError] = useState('');
  const [recoveryMessage, setRecoveryMessage] = useState('');

  // (e) account deletion — server account only; the local vault stays.
  const [confirmDeleteAccount, setConfirmDeleteAccount] = useState(false);
  const [deleteAccountBusy, setDeleteAccountBusy] = useState(false);
  const [deleteAccountError, setDeleteAccountError] = useState('');
  const [deleteAccountMessage, setDeleteAccountMessage] = useState('');

  const fmtDate = (iso: string | null | undefined): string => {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return formatDate(locale, d);
  };

  const copyText = async (text: string, field: string) => {
    try {
      await navigator.clipboard?.writeText(text);
      setCopiedField(field);
    } catch {
      // Clipboard unavailable: the value stays visible so it can be selected manually.
    }
  };

  /**
   * Run a server action. On 403 `step_up_required` the action does NOT
   * proceed: the serverOnly step-up dialog opens and, once the server
   * has verified a passkey / TOTP, the action runs again (and may
   * prompt again if the server still refuses). Any other failure
   * surfaces as an error string. Resolves true only when `fn` ran to
   * completion in THIS call.
   */
  const guarded = async (
    fn: () => Promise<void>,
    setError: (msg: string) => void,
    onSuccess?: () => void,
  ): Promise<boolean> => {
    try {
      await fn();
      onSuccess?.();
      return true;
    } catch (err) {
      if (isStepUpRequired(err)) {
        setStepUpRetry(() => async () => { await guarded(fn, setError, onSuccess); });
        return false;
      }
      // A 401 here means the session died mid-action: hand back to
      // SignIn via App instead of showing a dead-end error.
      // Exempt: wrong MFA-confirm code (isVerificationFailed, path-scoped). Any
      // other `verification_failed` 401 (e.g. passkey add verify) is ambiguous,
      // so re-check with a cheap authenticated call and sign out only if the
      // session is really dead.
      if (isUnauthorized(err) && !isVerificationFailed(err)) {
        const ambiguous = err instanceof ApiError && err.message.includes('verification_failed');
        const alive = ambiguous && security ? await security.listSessions().then(() => true, () => false) : false;
        if (!alive) onUnauthorized?.();
      }
      setError(describeError(err, dict));
      return false;
    }
  };

  const loadAll = async () => {
    if (!security) {
      setStatus('not-configured');
      return;
    }
    setStatus('loading');
    setLoadError('');
    const [pk, sess, dev, act] = await Promise.allSettled([
      security.listPasskeys(),
      security.listSessions(),
      security.listDevices(),
      security.listActivity(),
    ]);
    let failures = 0;
    let firstError: unknown = null;
    if (pk.status === 'fulfilled') setPasskeys(pk.value.authenticators ?? []);
    else { failures += 1; firstError ??= pk.reason; }
    if (sess.status === 'fulfilled') setSessions(sess.value.sessions ?? []);
    else { failures += 1; firstError ??= sess.reason; }
    if (dev.status === 'fulfilled') {
      const list = dev.value.devices ?? [];
      setDevices(list);
      const names: Record<string, string> = {};
      for (const d of list) {
        if (d.name_encrypted) {
          try {
            names[d.id] = await decryptWithVaultKey(d.name_encrypted);
          } catch {
            // Undecryptable under this Vault Key: fall back to id below.
          }
        } else if (d.name) {
          names[d.id] = d.name;
        }
      }
      setDisplayNames(names);
    } else { failures += 1; firstError ??= dev.reason; }
    if (act.status === 'fulfilled') setActivity(act.value.events ?? []);
    else { failures += 1; firstError ??= act.reason; }
    if (failures === 4) {
      setStatus('error');
      setLoadError(describeError(firstError, dict));
      // Every call answered 401: the session is gone server-side
      // (revoked or expired). Hand the user back to SignIn via App;
      // never retry here with the same stale token.
      if (isUnauthorized(firstError)) onUnauthorized?.();
    } else {
      setStatus('ready');
      if (failures > 0) setLoadError(describeError(firstError, dict));
    }
  };

  useEffect(() => {
    void loadAll();
    // Reload when the configured server (hence the client) changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [security]);

  const deviceLabel = (d: DeviceInfo): string =>
    displayNames[d.id] ?? d.platform ?? d.user_agent ?? `device ${d.id.slice(0, 8)}`;

  // --- (a) Passkeys ----------------------------------------------------------
  const handleAddPasskey = async () => {
    if (!security) return;
    if (!webAuthnAvailable()) {
      setWebAuthnUnavailable(true);
      return;
    }
    setWebAuthnUnavailable(false);
    setPasskeyError('');
    setPasskeyMessage('');
    setPasskeyBusy(true);
    await guarded(
      async () => {
        // The server requires step-up on /add/options, so a refusal
        // happens BEFORE any authenticator prompt. The rotated session
        // token in the verify response is adopted by the client.
        const { creation_options } = await security.passkeyAddOptions();
        const cred = await navigator.credentials.create({
          publicKey: toCreationOptions(creation_options),
        });
        if (!cred) throw new Error('no credential returned');
        await security.passkeyAddVerify(serializeCreateCredential(cred as PublicKeyCredential));
      },
      setPasskeyError,
      () => {
        setPasskeyMessage(s.passkeyAdded);
        void loadAll();
      },
    );
    setPasskeyBusy(false);
  };

  const handleRemovePasskey = async (id: string) => {
    if (!security) return;
    setConfirmRemovePasskeyId(null);
    setPasskeyError('');
    setPasskeyMessage('');
    await guarded(
      async () => { await security.removePasskey(id); },
      setPasskeyError,
      () => { setPasskeyMessage(s.passkeyRemoved); void loadAll(); },
    );
  };

  // --- (a) MFA ---------------------------------------------------------------
  const handleEnrollMfa = async () => {
    if (!security) return;
    setMfaError('');
    setMfaMessage('');
    setMfaBusy(true);
    try {
      const res = await security.mfaEnroll();
      setMfaSecret({ otpauth_url: res.otpauth_url, secret: res.secret });
    } catch (err) {
      setMfaError(describeError(err, dict));
    } finally {
      setMfaBusy(false);
    }
  };

  const handleConfirmMfa = async () => {
    if (!security) return;
    setMfaError('');
    setMfaBusy(true);
    await guarded(
      async () => {
        const res = await security.mfaConfirm(mfaCode.trim());
        // Recovery codes are returned ONCE, here. Shown once, kept in
        // component state only, never persisted.
        setRecoveryCodes(res.recovery_codes ?? []);
      },
      setMfaError,
      () => {
        setMfaState('enabled');
        setMfaSecret(null);
        setMfaCode('');
        setMfaMessage(s.mfaEnabled);
      },
    );
    setMfaBusy(false);
  };

  const handleDisableMfa = async () => {
    if (!security) return;
    setConfirmDisableMfa(false);
    setMfaError('');
    await guarded(
      async () => { await security.mfaDisable(); },
      setMfaError,
      () => {
        setMfaState('disabled');
        setMfaMessage(s.mfaDisabled);
        setRecoveryCodes(null);
        void loadAll();
      },
    );
  };

  const handleRegenerateCodes = async () => {
    if (!security) return;
    setMfaError('');
    await guarded(
      async () => {
        const res = await security.mfaRecoveryCodes();
        // Shown once: kept in component state only, never persisted.
        // Wire key is `recovery_codes` (was read as `res.codes`,
        // which is always undefined — fixed 17 Nov 2026).
        setRecoveryCodes(res.recovery_codes ?? []);
      },
      setMfaError,
    );
  };

  // --- (b) Devices & sessions --------------------------------------------------
  const handleSaveDeviceName = async (device: DeviceInfo) => {
    if (!security) return;
    const name = renameValue.trim();
    if (!name) return;
    setDeviceError('');
    setDeviceMessage('');
    await guarded(
      async () => {
        const encrypted = await encryptWithVaultKey(name);
        await security.updateDevice(device.id, { name_encrypted: encrypted });
      },
      setDeviceError,
      () => {
        setDisplayNames((prev) => ({ ...prev, [device.id]: name }));
        setRenameDeviceId(null);
        setRenameValue('');
        void loadAll();
      },
    );
  };

  const handleToggleTrust = async (device: DeviceInfo) => {
    if (!security) return;
    setDeviceError('');
    await guarded(
      async () => { await security.updateDevice(device.id, { trusted: !device.trusted }); },
      setDeviceError,
      () => void loadAll(),
    );
  };

  /** DELETE /v1/devices/:id — the server marks the device revoked and
   *  ends its server sessions. It does NOT erase data already on that
   *  device. If the current session belongs to that device, the next
   *  load answers 401 and App returns to sign-in. */
  const handleRevokeDevice = async (device: DeviceInfo) => {
    if (!security) return;
    setDeviceError('');
    setDeviceMessage('');
    await guarded(
      async () => { await security.revokeDevice(device.id); },
      setDeviceError,
      () => { setDeviceMessage(x.deviceRevoked); void loadAll(); },
    );
  };

  /** Enroll THIS browser: a fresh Ed25519 device key pair; only the
   *  public key, a proof-of-possession signature over a fresh server
   *  challenge, and a Vault-Key-encrypted name are sent. The private
   *  half is stored encrypted under the Vault Key (never in clear) and
   *  zero-filled in memory. Enrolling grants no vault access. (Sign-in
   *  binding uses a separate, non-extractable key — device-key-store.) */
  const handleEnrollDevice = async () => {
    if (!security) return;
    const name = enrollName.trim();
    if (!name) return;
    setDeviceError('');
    setDeviceMessage('');
    setEnrollBusy(true);
    let privateKey: Uint8Array | null = null;
    await guarded(
      async () => {
        await sodium.ready;
        const seed = sodium.randombytes_buf(32);
        const kp = sodium.crypto_sign_seed_keypair(seed);
        seed.fill(0);
        privateKey = kp.privateKey;
        // Proof of possession (specs/device-identity.md §6.2): the new key
        // signs a fresh single-use server challenge for 'enroll'.
        const { challenge } = await security.deviceChallenge('enroll');
        const publicKey = toBase64UrlNoPad(kp.publicKey);
        const signature = sodium.crypto_sign_detached(deviceSignedMessage('enroll', enrollPayload(challenge, publicKey)), kp.privateKey);
        const res = await security.enrollDevice({
          public_key: publicKey,
          challenge,
          signature: toBase64UrlNoPad(signature),
          name_encrypted: await encryptWithVaultKey(name),
          platform: typeof navigator !== 'undefined' ? navigator.platform || 'web' : 'web',
        });
        const id = res?.device?.id;
        if (id) {
          try {
            localStorage.setItem(LS_DEVICE_KEY_PREFIX + id, await encryptWithVaultKey(toBase64(kp.privateKey)));
          } catch {
            // Without local storage the device record still exists; no key is kept in clear.
          }
        }
      },
      setDeviceError,
      () => { setEnrollName(''); setDeviceMessage(x.deviceEnrolled); void loadAll(); },
    );
    (privateKey as Uint8Array | null)?.fill(0);
    setEnrollBusy(false);
  };

  const handleRevokeSession = async (id: string) => {
    if (!security) return;
    setConfirmRevokeSessionId(null);
    setSessionError('');
    setSessionMessage('');
    await guarded(
      async () => { await security.revokeSession(id); },
      setSessionError,
      () => { setSessionMessage(x.sessionRevoked); void loadAll(); },
    );
  };

  const handleRevokeOthers = async () => {
    if (!security) return;
    setConfirmRevokeOthers(false);
    setSessionError('');
    setSessionMessage('');
    let revoked = 0;
    await guarded(
      async () => { revoked = (await security.revokeOtherSessions())?.revoked_count ?? 0; },
      setSessionError,
      () => { setSessionMessage(x.othersRevoked.replace('{n}', String(revoked))); void loadAll(); },
    );
  };

  // --- (c) Recovery verifier ---------------------------------------------------
  const handleRegisterVerifier = async () => {
    if (!security) return;
    setRecoveryError('');
    setRecoveryMessage('');
    setRecoveryBusy(true);
    let seed: Uint8Array | null = null;
    let privateKey: Uint8Array | null = null;
    try {
      await sodium.ready;
      try {
        seed = fromBase64Url(recoveryKeyInput.trim());
      } catch {
        throw new Error(x.recoveryKeyInvalid);
      }
      if (seed.length !== 32) throw new Error(x.recoveryKeyInvalid);
      const keypair = sodium.crypto_sign_seed_keypair(seed);
      privateKey = keypair.privateKey;
      const publicKeyB64 = toBase64(keypair.publicKey);
      const fp = await sha256(keypair.publicKey);
      const fingerprint = Array.from(fp.subarray(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
      await guarded(
        async () => { await security.registerRecoveryVerifier(publicKeyB64); },
        setRecoveryError,
        () => {
          setVerifierFingerprint(fingerprint);
          setRecoveryMessage(s.recoveryVerifierRegistered);
        },
      );
    } catch (err) {
      setRecoveryError(err instanceof Error ? err.message : s.error);
    } finally {
      // The seed and private key exist in memory only for this derivation.
      seed?.fill(0);
      privateKey?.fill(0);
      setRecoveryKeyInput('');
      setRecoveryBusy(false);
    }
  };

  // --- (e) Delete account ------------------------------------------------------
  const handleDeleteAccount = async () => {
    if (!security) return;
    setConfirmDeleteAccount(false);
    setDeleteAccountError('');
    setDeleteAccountMessage('');
    setDeleteAccountBusy(true);
    await guarded(
      async () => { await security.deleteAccount(); },
      setDeleteAccountError,
      () => {
        setPasskeys([]);
        setSessions([]);
        setDevices([]);
        setActivity([]);
        setDeleteAccountMessage(x.accountDeleted);
        // App clears the stored token + email and shows the sign-in gate.
        onAccountDeleted?.();
      },
    );
    setDeleteAccountBusy(false);
  };

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6 p-5">
      <div>
        <h2 className="text-lg font-semibold">{s.title}</h2>
        <p className="mt-1 text-sm text-zinc-400">{s.subtitle}</p>
        {security && onSignOut && (
          <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm">
            <span className="text-zinc-300">
              {dict.signin.signedInAs} <strong>{signedInEmail || '—'}</strong>
            </span>
            <button
              type="button"
              className="btn-ghost !py-1 text-xs"
              onClick={() => onSignOut()}
              aria-label={dict.signin.signOut}
            >
              {dict.signin.signOut}
            </button>
            <span className="text-xs text-zinc-500">
              {x.signOutNote}
            </span>
          </div>
        )}
      </div>

      {status === 'not-configured' && (
        <section className="card p-5" aria-labelledby="security-not-configured-heading">
          <h3 id="security-not-configured-heading" className="text-base font-semibold">
            {s.notConfigured}
          </h3>
          <p className="mt-1 text-sm text-zinc-400">{s.notConfiguredBody}</p>
        </section>
      )}

      {status === 'loading' && <p className="text-sm text-zinc-400">{s.loading}</p>}

      {status === 'error' && (
        <section className="card p-5" aria-labelledby="security-error-heading">
          <h3 id="security-error-heading" className="text-base font-semibold">
            {s.error}
          </h3>
          <p className="mt-1 text-sm text-zinc-400">{loadError || s.offline}</p>
          <button type="button" className="btn-primary mt-3" onClick={() => void loadAll()}>
            {s.retry}
          </button>
        </section>
      )}

      {status === 'ready' && (
        <>
          {loadError && (
            <p role="alert" className="rounded-lg border border-amber-900/60 bg-amber-950/40 px-3 py-2 text-sm text-amber-200">
              {loadError}
            </p>
          )}

          {/* (a) Authentication methods */}
          <section className="card p-5" aria-labelledby="security-auth-heading">
            <h3 id="security-auth-heading" className="text-base font-semibold">
              {s.authMethods}
            </h3>

            <h4 className="mt-4 text-sm font-semibold">{s.passkeys}</h4>
            {passkeys.length === 0 ? (
              <p className="mt-1 text-sm text-zinc-500">{s.noPasskeys}</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {passkeys.map((pk) => (
                  <li key={pk.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-sm text-zinc-100">{pk.credential_id_prefix}…</p>
                      <p className="text-xs text-zinc-400">{fmtDate(pk.created_at)}</p>
                    </div>
                    {confirmRemovePasskeyId === pk.id ? (
                      <span className="flex flex-wrap items-center gap-2">
                        {passkeys.length === 1 && (
                          <span className="text-xs text-amber-200">{s.lastMethodWarning}</span>
                        )}
                        <button type="button" className="btn-ghost !py-1 text-xs" onClick={() => setConfirmRemovePasskeyId(null)}>
                          {s.cancel}
                        </button>
                        <button type="button" className="btn-danger !py-1 text-xs" onClick={() => void handleRemovePasskey(pk.id)}>
                          {s.confirm}
                        </button>
                      </span>
                    ) : (
                      <button type="button" className="btn-ghost !py-1 text-xs" onClick={() => setConfirmRemovePasskeyId(pk.id)}>
                        {s.removePasskey}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-3">
              <button type="button" className="btn-primary" disabled={passkeyBusy} onClick={() => void handleAddPasskey()}>
                {s.addPasskey}
              </button>
            </div>
            {webAuthnUnavailable && (
              <p className="mt-2 rounded-lg border border-amber-900/60 bg-amber-950/40 px-3 py-2 text-sm text-amber-200">
                WebAuthn is not available in this browser or build, so a passkey cannot be added
                here. Nothing is faked — use an authenticator app instead.
              </p>
            )}
            {passkeyError && <p role="alert" className="mt-2 text-sm text-red-400">{passkeyError}</p>}
            {passkeyMessage && <p role="status" className="mt-2 text-sm text-emerald-400">{passkeyMessage}</p>}

            <h4 className="mt-6 text-sm font-semibold">{s.mfa}</h4>
            {mfaState === 'enabled' && <p className="mt-1 text-sm text-emerald-400">{s.mfaEnabled}</p>}
            {mfaState === 'disabled' && <p className="mt-1 text-sm text-zinc-400">{s.mfaDisabled}</p>}
            {/* No status line while 'unknown': the API contract has no
             *  MFA-status read endpoint, so no claim is made before an
             *  enroll / disable is done in this session. */}
            {!mfaSecret && (
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" className="btn-primary" disabled={mfaBusy} onClick={() => void handleEnrollMfa()}>
                  {s.enrollMfa}
                </button>
                {mfaState !== 'disabled' && !confirmDisableMfa && (
                  <button type="button" className="btn-ghost" onClick={() => setConfirmDisableMfa(true)}>
                    {s.disableMfa}
                  </button>
                )}
                {confirmDisableMfa && (
                  <span className="flex gap-2">
                    <button type="button" className="btn-ghost" onClick={() => setConfirmDisableMfa(false)}>
                      {s.cancel}
                    </button>
                    <button type="button" className="btn-danger" onClick={() => void handleDisableMfa()}>
                      {s.confirm}
                    </button>
                  </span>
                )}
              </div>
            )}
            {mfaSecret && (
              <div className="mt-3 space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
                <p className="text-sm text-amber-200">{s.mfaSecretWarning}</p>
                <div>
                  <label className="label" htmlFor="security-mfa-secret">
                    {s.mfaSecretLabel}
                  </label>
                  <div className="flex gap-2">
                    <input
                      id="security-mfa-secret"
                      name="mfa-secret"
                      type="text"
                      readOnly
                      className="input font-mono"
                      value={mfaSecret.secret}
                      aria-label={s.mfaSecretLabel}
                    />
                    <button
                      type="button"
                      className="btn-ghost shrink-0"
                      onClick={() => void copyText(mfaSecret.secret, 'mfa-secret')}
                      aria-label={`${dict.common.copy} ${s.mfaSecretLabel}`}
                    >
                      {copiedField === 'mfa-secret' ? dict.common.copied : dict.common.copy}
                    </button>
                  </div>
                </div>
                <div>
                  <label className="label" htmlFor="security-mfa-otpauth">
                    otpauth URL
                  </label>
                  <div className="flex gap-2">
                    <input
                      id="security-mfa-otpauth"
                      name="mfa-otpauth-url"
                      type="text"
                      readOnly
                      className="input break-all font-mono text-xs"
                      value={mfaSecret.otpauth_url}
                      aria-label="otpauth URL"
                    />
                    <button
                      type="button"
                      className="btn-ghost shrink-0"
                      onClick={() => void copyText(mfaSecret.otpauth_url, 'mfa-otpauth')}
                      aria-label={`${dict.common.copy} otpauth URL`}
                    >
                      {copiedField === 'mfa-otpauth' ? dict.common.copied : dict.common.copy}
                    </button>
                  </div>
                </div>
                <form
                  className="space-y-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void handleConfirmMfa();
                  }}
                >
                  <div>
                    <label className="label" htmlFor="security-mfa-code">
                      {s.mfaCodeLabel}
                    </label>
                    <input
                      id="security-mfa-code"
                      name="mfa-code"
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      className="input font-mono"
                      value={mfaCode}
                      onChange={(e) => setMfaCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
                      placeholder="123456"
                      aria-label={s.mfaCodeLabel}
                    />
                  </div>
                  <div className="flex gap-2">
                    <button type="submit" className="btn-primary" disabled={mfaBusy || mfaCode.length !== 6}>
                      {s.confirmMfa}
                    </button>
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => { setMfaSecret(null); setMfaCode(''); }}
                    >
                      {s.cancel}
                    </button>
                  </div>
                </form>
              </div>
            )}
            {mfaError && <p role="alert" className="mt-2 text-sm text-red-400">{mfaError}</p>}
            {mfaMessage && <p role="status" className="mt-2 text-sm text-emerald-400">{mfaMessage}</p>}

            <h4 className="mt-6 text-sm font-semibold">{s.recoveryCodes}</h4>
            <p className="mt-1 text-sm text-zinc-400">{s.codesShownOnce}</p>
            <button type="button" className="btn-ghost mt-2" onClick={() => void handleRegenerateCodes()}>
              {s.regenerateCodes}
            </button>
            {recoveryCodes && (
              <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
                <ul className="grid grid-cols-2 gap-2 font-mono text-sm text-zinc-100">
                  {recoveryCodes.map((code) => (
                    <li key={code}>{code}</li>
                  ))}
                </ul>
                <button type="button" className="btn-primary mt-3" onClick={() => setRecoveryCodes(null)}>
                  {s.done}
                </button>
              </div>
            )}
          </section>

          {/* (b) Trusted devices & sessions */}
          <section className="card p-5" aria-labelledby="security-devices-heading">
            <h3 id="security-devices-heading" className="text-base font-semibold">
              {s.devices}
            </h3>
            {devices.length === 0 ? (
              <p className="mt-1 text-sm text-zinc-500">{dict.common.none}</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {devices.map((d) => (
                  <li key={d.id} className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
                    <div className="flex flex-wrap items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-zinc-100">{deviceLabel(d)}</p>
                        <p className="text-xs text-zinc-400">
                          {d.trusted ? s.trusted : s.untrusted} · {s.lastSeen} {fmtDate(d.last_seen_at ?? d.created_at)}
                        </p>
                      </div>
                      <span className="flex flex-wrap gap-2">
                        <button type="button" className="btn-ghost !py-1 text-xs" onClick={() => { setRenameDeviceId(d.id); setRenameValue(displayNames[d.id] ?? ''); }}>
                          {s.rename}
                        </button>
                        <button type="button" className="btn-ghost !py-1 text-xs" onClick={() => void handleToggleTrust(d)}>
                          {d.trusted ? s.untrust : s.trust}
                        </button>
                        <button type="button" className="btn-ghost !py-1 text-xs" onClick={() => void handleRevokeDevice(d)}>
                          {s.revoke}
                        </button>
                      </span>
                    </div>
                    {renameDeviceId === d.id && (
                      <form
                        className="mt-3 flex gap-2"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void handleSaveDeviceName(d);
                        }}
                      >
                        <div className="flex-1">
                          <label className="label" htmlFor={`security-rename-${d.id}`}>
                            {s.rename}
                          </label>
                          <input
                            id={`security-rename-${d.id}`}
                            name="device-name"
                            type="text"
                            className="input"
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            autoComplete="off"
                            aria-label={s.rename}
                            autoFocus
                          />
                        </div>
                        <button type="submit" className="btn-primary self-end" disabled={!renameValue.trim()}>
                          {s.save}
                        </button>
                        <button type="button" className="btn-ghost self-end" onClick={() => { setRenameDeviceId(null); setRenameValue(''); }}>
                          {s.cancel}
                        </button>
                      </form>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-xs text-zinc-500">{x.deviceRevokeNote}</p>
            <form
              className="mt-3 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3"
              onSubmit={(e) => { e.preventDefault(); void handleEnrollDevice(); }}
            >
              <p className="text-xs text-zinc-400">{x.enrollDeviceBody}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <div className="min-w-0 flex-1">
                  <label className="label" htmlFor="security-enroll-name">{x.enrollDeviceName}</label>
                  <input
                    id="security-enroll-name"
                    name="enroll-device-name"
                    type="text"
                    className="input"
                    value={enrollName}
                    onChange={(e) => setEnrollName(e.target.value)}
                    autoComplete="off"
                    aria-label={x.enrollDeviceName}
                  />
                </div>
                <button type="submit" className="btn-primary self-end" disabled={enrollBusy || !enrollName.trim()}>
                  {x.enrollDevice}
                </button>
              </div>
            </form>
            {deviceError && <p role="alert" className="mt-2 text-sm text-red-400">{deviceError}</p>}
            {deviceMessage && <p role="status" className="mt-2 text-sm text-zinc-400">{deviceMessage}</p>}

            <h3 className="mt-6 text-base font-semibold">{s.sessions}</h3>
            <p className="mt-1 rounded-lg border border-amber-900/60 bg-amber-950/40 px-3 py-2 text-sm text-amber-200">
              {s.revokeOthersConfirm}
            </p>
            {sessions.length === 0 ? (
              <p className="mt-2 text-sm text-zinc-500">{dict.common.none}</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {sessions.map((sess) => (
                  <li key={sess.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-zinc-100">
                        {sess.user_agent || sess.device_id}
                        {sess.current && (
                          <span className="ml-2 rounded-full bg-indigo-600/25 px-2 py-0.5 text-[11px] font-medium text-indigo-200">
                            {s.currentSession}
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-zinc-400">
                        {sess.ip_address ? `${sess.ip_address} · ` : ''}{fmtDate(sess.created_at)}
                      </p>
                    </div>
                    {!sess.current && confirmRevokeSessionId === sess.id ? (
                      <span className="flex gap-2">
                        <button type="button" className="btn-ghost !py-1 text-xs" onClick={() => setConfirmRevokeSessionId(null)}>
                          {s.cancel}
                        </button>
                        <button type="button" className="btn-danger !py-1 text-xs" onClick={() => void handleRevokeSession(sess.id)}>
                          {s.confirm}
                        </button>
                      </span>
                    ) : !sess.current ? (
                      <button type="button" className="btn-ghost !py-1 text-xs" onClick={() => setConfirmRevokeSessionId(sess.id)}>
                        {s.revokeSession}
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-3">
              {confirmRevokeOthers ? (
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-zinc-300">{s.revokeOthersConfirm}</span>
                  <button type="button" className="btn-ghost" onClick={() => setConfirmRevokeOthers(false)}>
                    {s.cancel}
                  </button>
                  <button type="button" className="btn-danger" onClick={() => void handleRevokeOthers()}>
                    {s.confirm}
                  </button>
                </span>
              ) : (
                <button type="button" className="btn-danger" onClick={() => setConfirmRevokeOthers(true)}>
                  {s.revokeOthers}
                </button>
              )}
            </div>
            {sessionError && <p role="alert" className="mt-2 text-sm text-red-400">{sessionError}</p>}
            {sessionMessage && <p role="status" className="mt-2 text-sm text-emerald-400">{sessionMessage}</p>}
          </section>

          {/* (c) Recovery settings */}
          <section className="card p-5" aria-labelledby="security-recovery-heading">
            <h3 id="security-recovery-heading" className="text-base font-semibold">
              {s.recoverySettings}
            </h3>
            <p className="mt-1 text-sm text-zinc-400">{s.recoveryNote}</p>
            <h4 className="mt-4 text-sm font-semibold">{s.recoveryVerifier}</h4>
            <p className="mt-1 text-sm text-zinc-400">{s.recovery}</p>
            <form
              className="mt-3 space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                void handleRegisterVerifier();
              }}
            >
              <div>
                <label className="label" htmlFor="security-recovery-key">
                  {x.recoveryKeyLabel}
                </label>
                <input
                  id="security-recovery-key"
                  name="recovery-key"
                  type="password"
                  className="input font-mono"
                  value={recoveryKeyInput}
                  onChange={(e) => setRecoveryKeyInput(e.target.value)}
                  autoComplete="off"
                  aria-label={x.recoveryKeyLabel}
                />
              </div>
              <button type="submit" className="btn-primary" disabled={recoveryBusy || !recoveryKeyInput.trim() || !security}>
                {s.registerRecoveryVerifier}
              </button>
            </form>
            {verifierFingerprint && (
              <div role="status" className="mt-2 space-y-1">
                <p className="text-sm text-emerald-400">{s.recoveryVerifierRegistered}</p>
                <p className="break-all font-mono text-sm text-zinc-200">
                  {s.recoveryVerifier}: {verifierFingerprint}
                </p>
              </div>
            )}
            {recoveryError && <p role="alert" className="mt-2 text-sm text-red-400">{recoveryError}</p>}
            {recoveryMessage && !verifierFingerprint && (
              <p role="status" className="mt-2 text-sm text-emerald-400">{recoveryMessage}</p>
            )}
          </section>

          {/* (d) Security activity */}
          <section className="card p-5" aria-labelledby="security-activity-heading">
            <h3 id="security-activity-heading" className="text-base font-semibold">
              {s.activity}
            </h3>
            {activity.length === 0 ? (
              <p className="mt-1 text-sm text-zinc-500">{s.noActivity}</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {activity.map((ev, i) => (
                  <li key={`${ev.event_type}-${ev.created_at}-${i}`} className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-zinc-100">{ev.event_type}</p>
                      <p className="text-xs text-zinc-400">
                        {ev.device_id} · {fmtDate(ev.created_at)}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* (e) Delete account. Dictionary has no keys for this action. */}
          <section className="card p-5" aria-labelledby="security-delete-account-heading">
            <h3 id="security-delete-account-heading" className="text-base font-semibold">
              {x.deleteAccount}
            </h3>
            <p className="mt-1 text-sm text-zinc-400">{x.deleteAccountBody}</p>
            <div className="mt-3">
              {confirmDeleteAccount ? (
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-zinc-300">{x.deleteAccountConfirm}</span>
                  <button
                    type="button"
                    className="btn-ghost"
                    disabled={deleteAccountBusy}
                    onClick={() => setConfirmDeleteAccount(false)}
                  >
                    {s.cancel}
                  </button>
                  <button
                    type="button"
                    className="btn-danger"
                    disabled={deleteAccountBusy || !security}
                    onClick={() => void handleDeleteAccount()}
                  >
                    {s.confirm}
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="btn-danger"
                  disabled={deleteAccountBusy || !security}
                  onClick={() => setConfirmDeleteAccount(true)}
                >
                  {x.deleteAccount}
                </button>
              )}
            </div>
            {deleteAccountError && <p role="alert" className="mt-2 text-sm text-red-400">{deleteAccountError}</p>}
            {deleteAccountMessage && <p role="status" className="mt-2 text-sm text-emerald-400">{deleteAccountMessage}</p>}
          </section>
        </>
      )}

      <p className="text-xs text-zinc-500">
        {s.title} · {apiBaseUrl ? apiBaseUrl : s.notConfigured}
      </p>

      <StepUpDialog
        open={stepUpRetry !== null}
        security={security}
        serverOnly
        onVerified={() => {
          const retry = stepUpRetry;
          setStepUpRetry(null);
          if (retry) void retry();
        }}
        onCancel={() => setStepUpRetry(null)}
      />
    </div>
  );
}
