import React, { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import sodium from 'libsodium-wrappers-sumo';
import Field from '../components/Field';
import { colors, styles } from '../theme';
import { useTranslation } from '../../../../packages/i18n/src/react';
import {
  LS_ACCOUNT_EMAIL,
  SecurityApiClient,
  saveSessionToken,
} from '../../../../packages/sdk/src/security';
import { fromBase64Url, toBase64 } from '../../../../packages/crypto-adapters/src/index';
import { apiStatus, isNetworkError } from '../utils/stepUp';

/**
 * SignInScreen (mobile) — account sign-in WITHOUT WebAuthn.
 *
 * Honest limit, stated in the UI itself: React Native / Expo Go
 * has no WebAuthn browser API, and expo-local-authentication is
 * NOT WebAuthn, so a passkey ceremony cannot run here and none is
 * faked. The API is passkey-only (no password login exists), so a
 * full sign-in must be done from Desktop or Web.
 *
 * The ONE sign-in this device can genuinely do is the recovery-key
 * challenge, using the API exactly as specified:
 *   POST /v1/recovery/challenges { email, kind: 'recovery_key' }
 *     -> { challenge_id, challenge, expires_in } (5 min, single-use)
 *   Ed25519 sign the challenge bytes with the keypair derived from
 *   the 32 recovery-key bytes (crypto_sign_seed_keypair — the same
 *   derivation SecurityScreen uses to register a recovery verifier)
 *   POST /v1/recovery/verify { challenge_id, email, signature }
 *     -> { token, expires_in: 900, recovery_session: true }
 *
 * The result is a 15-minute RECOVERY session, step-up verified at
 * issue — an account session for recovery actions (e.g. revoking
 * sessions from a lost device), NOT a daily sign-in. The UI says
 * so. It also requires a recovery verifier already registered for
 * the account (Security Center on Desktop/Web); without one every
 * attempt fails with the server's generic 401, and the UI says so
 * instead of inventing a reason.
 *
 * The recovery key is used in memory only: the seed and private
 * key are zero-filled after use, the input is cleared, and the key
 * is never stored or logged. The session token is stored via the
 * SDK's saveSessionToken (key LS_API_TOKEN) — the same store the
 * Security Center reads — never next to a passphrase.
 *
 * Signing in does not unlock the vault: the master passphrase is
 * still required afterwards, as a separate step.
 */

export interface SignInScreenProps {
  baseUrl: string;
  /** True when the previous session expired (401). */
  sessionExpired?: boolean;
  onSignedIn: (email: string, recoverySession: boolean) => void;
  onContinueLocalOnly: () => void;
}

export default function SignInScreen({ baseUrl, sessionExpired, onSignedIn, onContinueLocalOnly }: SignInScreenProps) {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const client = new SecurityApiClient({
    baseUrl,
    getToken: async () => {
      try { return await AsyncStorage.getItem('my-secrect:api-token'); } catch { return null; }
    },
  });

  async function handleSubmit() {
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail || !normalizedEmail.includes('@')) {
      setError(t('signin.invalidEmail'));
      return;
    }
    let seed: Uint8Array | null = null;
    try {
      seed = fromBase64Url(recoveryKey.trim());
    } catch {
      seed = null;
    }
    if (!seed || seed.length !== 32) {
      setError(t('signin.verificationFailed'));
      return;
    }
    setBusy(true);
    setError('');
    let privateKey: Uint8Array | null = null;
    try {
      await sodium.ready;
      const keypair = sodium.crypto_sign_seed_keypair(seed);
      privateKey = keypair.privateKey;
      // Step 1: single-use challenge (5 min).
      const { challenge_id, challenge } = await client.recoveryChallenge(normalizedEmail, 'recovery_key');
      // Step 2: sign the exact challenge bytes. The challenge is
      // base64 (standard or URL-safe); fromBase64Url accepts both.
      const challengeBytes = fromBase64Url(challenge);
      const signature = sodium.crypto_sign_detached(new Uint8Array(challengeBytes), privateKey);
      // Step 3: verify. Only the signature leaves the device —
      // never the recovery key, the seed, or the private key.
      const res = await client.recoveryVerify(challenge_id, normalizedEmail, toBase64(signature));
      const store = {
        getItem: (k: string) => AsyncStorage.getItem(k),
        setItem: (k: string, v: string) => AsyncStorage.setItem(k, v),
        removeItem: (k: string) => AsyncStorage.removeItem(k),
      };
      await saveSessionToken(store, res.token, res.expires_in);
      try { await AsyncStorage.setItem(LS_ACCOUNT_EMAIL, normalizedEmail); } catch { /* non-critical */ }
      onSignedIn(normalizedEmail, res.recovery_session === true);
    } catch (e) {
      if (isNetworkError(e)) setError(t('signin.offline'));
      else if (apiStatus(e) === 401) setError(t('signin.verificationFailed'));
      else setError(t('signin.unknownError'));
    } finally {
      seed?.fill(0);
      privateKey?.fill(0);
      setRecoveryKey('');
      setBusy(false);
    }
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
      <Text style={styles.title}>{t('signin.title')}</Text>
      <Text style={[styles.subtitle, { marginTop: 8 }]}>{t('signin.subtitle')}</Text>

      <View style={{ backgroundColor: colors.warnSoft, borderColor: colors.cardBorder, borderWidth: 1, borderRadius: 12, padding: 12, marginTop: 16 }}>
        <Text style={{ color: colors.warn, fontSize: 13, lineHeight: 18, fontWeight: '700' }}>{t('signin.recoverySignInTitle')}</Text>
        <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 18, marginTop: 6 }}>{t('signin.recoverySignInBody')}</Text>
        <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 18, marginTop: 6 }}>{t('signin.verifierRequiredNote')}</Text>
        <Text style={{ color: colors.warn, fontSize: 13, lineHeight: 18, marginTop: 6 }}>{t('signin.recoverySessionNote')}</Text>
      </View>

      {sessionExpired ? (
        <Text testID="signin-session-expired" style={{ color: colors.warn, fontSize: 14, lineHeight: 20, marginTop: 12 }}>{t('signin.sessionExpired')}</Text>
      ) : null}

      <View style={{ marginTop: 16 }}>
        <Field label={t('signin.emailLabel')} testID="signin-email" placeholder={t('signin.emailPlaceholder')} value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" />
      </View>
      <Field label={t('signin.recoveryKeyLabel')} testID="signin-recovery-key" placeholder={t('signin.recoveryKeyHint')} secureTextEntry value={recoveryKey} onChangeText={setRecoveryKey} autoCapitalize="none" autoCorrect={false} />

      {error ? <Text testID="signin-error" style={[styles.error, { marginTop: 12 }]}>{error}</Text> : null}

      <Pressable testID="signin-submit" accessibilityLabel={t('signin.recoverySignInTitle')} disabled={busy} style={[styles.primaryButton, { marginTop: 16 }]} onPress={() => void handleSubmit()}>
        {busy ? <ActivityIndicator color={colors.text} /> : <Text style={styles.primaryButtonText}>{t('signin.recoverySignInTitle')}</Text>}
      </Pressable>
      <Pressable testID="signin-local-only" accessibilityLabel={t('signin.continueLocalOnly')} style={[styles.ghostButton, { marginTop: 12 }]} onPress={onContinueLocalOnly}>
        <Text style={styles.ghostButtonText}>{t('signin.continueLocalOnly')}</Text>
      </Pressable>
      <Text style={{ color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: 16 }}>
        Passkey-only sign-in — there is no password login. The server never sees your vault keys or contents.
      </Text>
    </ScrollView>
  );
}
