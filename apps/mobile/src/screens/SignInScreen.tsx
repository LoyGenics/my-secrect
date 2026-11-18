import React, { useRef, useState, type ReactNode } from 'react';
import { GhostBrandMark } from '../components/soft';
import {
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import sodium from 'libsodium-wrappers-sumo';
import { useTranslation } from '../../../../packages/i18n/src/react';
import {
  LS_ACCOUNT_EMAIL,
  SecurityApiClient,
  isMfaRequiredResult,
  saveSessionToken,
} from '../../../../packages/sdk/src/security';
import { Icon, illustrations, type IconName } from '../../../../packages/ui/src/native';
import { fromBase64Url, sodiumReady, toBase64 } from '../../../../packages/crypto-adapters/src/index';
import { legacyRecoveryVerifierKeyPair, recoveryVerifierKeyPair } from '../../../../packages/sdk/src/recovery-verifier';
import { apiStatus, isNetworkError } from '../utils/stepUp';
import { Btn, Float, useSoftPalette, Rise, TextButton, useReducedMotion } from '../components/soft';

/**
 * SignInScreen (mobile) — account sign-in WITHOUT WebAuthn, "soft light" finish
 * (docs/mockups/ui-soft-v1.html): warm paper, white card, orange pill action
 * with white text, a floating clay hero, one rise-in per step, six-box code entry.
 *
 * Primary path: a 6-digit code mailed to the account (sign up or sign in, no
 * passkey needed). POST /v1/auth/email/request -> /email/verify (ticket) ->
 * /email/session (spends it). An account that already has a passkey is mailed
 * a notice instead of a code and must sign in from Desktop or Web. The session
 * is UNBOUND: the mobile app has no device key store yet
 * (specs/device-identity.md §8.3), so it reaches account actions only, not
 * vault sync — the screen says so. With MFA the code is followed by a TOTP /
 * recovery code (POST /v1/auth/mfa/verify).
 *
 * Honest limit: React Native has no WebAuthn browser API and
 * expo-local-authentication is NOT WebAuthn, so no passkey ceremony runs here
 * and none is faked.
 *
 * Secondary path: the recovery-key challenge.
 *   POST /v1/recovery/challenges { email, kind: 'recovery_key' } -> challenge
 *   Ed25519 sign it with the verifier keypair derived from the 32 recovery-key
 *   bytes (packages/sdk/src/recovery-verifier.ts; a v0 verifier retries ONCE
 *   with the legacy key), POST /v1/recovery/verify -> a 15-minute RECOVERY
 *   session for account actions. Needs a recovery verifier already registered
 *   (Security Center on Desktop/Web). The key lives in memory only and is
 *   zero-filled after use.
 *
 * Signing in does not unlock the vault: the master passphrase is still
 * required afterwards, as a separate step. Motion is skipped when the OS asks
 * for reduced motion.
 */

export interface SignInScreenProps {
  baseUrl: string;
  /** True when the previous session expired (401). */
  sessionExpired?: boolean;
  onSignedIn: (email: string, recoverySession: boolean) => void;
  onContinueLocalOnly: () => void;
}

/** Six-digit code: one real input (autofill, paste) drawn as six boxes. */
function OtpField({ value, onChange, label, testID, length = 6 }: {
  value: string; onChange: (v: string) => void; label: string; testID: string; length?: number;
}) {
  const P = useSoftPalette();
  const ref = useRef<TextInput>(null);
  const [focused, setFocused] = useState(false);
  return (
    <Pressable onPress={() => ref.current?.focus()} style={{ flexDirection: 'row', gap: 8 }}>
      {Array.from({ length }, (_, i) => {
        const active = focused && i === Math.min(value.length, length - 1);
        return (
          <View
            key={i}
            style={{
              flex: 1,
              height: 56,
              borderRadius: 14,
              borderWidth: active ? 2 : 1,
              borderColor: active ? P.brandFill : value[i] ? '#F2C9B3' : P.line,
              backgroundColor: value[i] || active ? P.surface : P.surface2,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text style={{ fontSize: 22, fontWeight: '700', color: P.ink }}>{value[i] ?? ''}</Text>
          </View>
        );
      })}
      <TextInput
        ref={ref}
        testID={testID}
        accessibilityLabel={label}
        value={value}
        onChangeText={(v) => onChange(v.replace(/[^0-9]/g, '').slice(0, length))}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="sms-otp"
        maxLength={length}
        caretHidden
        style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, opacity: 0.02, fontSize: 16 }}
      />
    </Pressable>
  );
}

export default function SignInScreen({ baseUrl, sessionExpired, onSignedIn, onContinueLocalOnly }: SignInScreenProps) {
  const P = useSoftPalette();
  const { t } = useTranslation();
  const reduced = useReducedMotion();
  const [mode, setMode] = useState<'email' | 'recovery'>('email');
  // Email path: 'email' -> 'code' (code mailed) -> optional 'mfa'.
  const [step, setStep] = useState<'email' | 'code' | 'mfa'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  // Single-use ticket from /email/verify; memory only, kept while a retry may still use it.
  const [ticket, setTicket] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const client = new SecurityApiClient({
    baseUrl,
    getToken: async () => {
      try { return await AsyncStorage.getItem('my-secrect:api-token'); } catch { return null; }
    },
  });
  const asyncStore = {
    getItem: (k: string) => AsyncStorage.getItem(k),
    setItem: (k: string, v: string) => AsyncStorage.setItem(k, v),
    removeItem: (k: string) => AsyncStorage.removeItem(k),
  };
  const address = email.trim().toLowerCase();

  async function finish(who: string, token: string, expiresIn: number, recoverySession: boolean) {
    await saveSessionToken(asyncStore, token, expiresIn);
    try { await AsyncStorage.setItem(LS_ACCOUNT_EMAIL, who); } catch { /* non-critical */ }
    onSignedIn(who, recoverySession);
  }

  function failMessage(e: unknown): string {
    if (isNetworkError(e)) return t('signin.offline');
    const status = apiStatus(e);
    if (status === 503) return t('signin.emailUnavailable');
    if (status === 422) return t('signin.invalidEmail');
    if (status === 401) return t('signin.emailCodeFailed');
    return t('signin.unknownError');
  }

  function restart(message = '') {
    setStep('email');
    setCode('');
    setTicket(null);
    setMfaToken(null);
    setError(message);
  }

  async function sendCode() {
    if (!address || !address.includes('@')) {
      setError(t('signin.invalidEmail'));
      return;
    }
    setBusy(true);
    setError('');
    setTicket(null);
    setCode('');
    try {
      await client.requestEmailCode(address);
      setStep('code');
    } catch (e) {
      setError(failMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function submitCode() {
    setBusy(true);
    setError('');
    try {
      let current = ticket;
      if (!current) {
        try {
          current = (await client.verifyEmailCode(address, code.trim())).registration_ticket;
          setTicket(current);
        } finally {
          setCode('');
        }
      }
      let res;
      try {
        res = await client.emailSessionVerify(address, current);
      } catch (e) {
        // Ticket expired or already spent: a new code is needed.
        if (apiStatus(e) === 401) {
          restart(t('signin.signupExpired'));
          return;
        }
        throw e;
      }
      setTicket(null);
      if (isMfaRequiredResult(res)) {
        setMfaToken(res.mfa_token);
        setStep('mfa');
        return;
      }
      await finish(address, res.token, res.expires_in, false);
    } catch (e) {
      setError(failMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function submitMfa() {
    if (!mfaToken) return;
    setBusy(true);
    setError('');
    try {
      // The mfa_token is single-use: a failure ends this attempt.
      const res = await client.mfaVerify(mfaToken, code.trim().toUpperCase());
      setMfaToken(null);
      await finish(address, res.token, res.expires_in, false);
    } catch (e) {
      if (apiStatus(e) === 401) restart(t('signin.mfaExpired'));
      else setError(failMessage(e));
    } finally {
      setCode('');
      setBusy(false);
    }
  }

  async function submitRecovery() {
    if (!address || !address.includes('@')) {
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
    const privateKeys: Uint8Array[] = [];
    // One full challenge round with one verifier key.
    const attempt = async (privateKey: Uint8Array) => {
      const { challenge_id, challenge } = await client.recoveryChallenge(address, 'recovery_key');
      const challengeBytes = fromBase64Url(challenge);
      const signature = sodium.crypto_sign_detached(new Uint8Array(challengeBytes), privateKey);
      // Only the signature leaves the device — never the recovery key or the private key.
      return client.recoveryVerify(challenge_id, address, toBase64(signature));
    };
    try {
      await sodiumReady;
      const current = await recoveryVerifierKeyPair(seed);
      privateKeys.push(current.privateKey);
      let res;
      try {
        res = await attempt(current.privateKey);
      } catch (first) {
        if (apiStatus(first) !== 401) throw first;
        const legacy = await legacyRecoveryVerifierKeyPair(seed);
        privateKeys.push(legacy.privateKey);
        res = await attempt(legacy.privateKey);
      }
      await finish(address, res.token, res.expires_in, res.recovery_session === true);
    } catch (e) {
      if (isNetworkError(e)) setError(t('signin.offline'));
      else if (apiStatus(e) === 401) setError(t('signin.verificationFailed'));
      else setError(t('signin.unknownError'));
    } finally {
      seed?.fill(0);
      for (const key of privateKeys) key.fill(0);
      setRecoveryKey('');
      setBusy(false);
    }
  }

  const emailInput = (
    <View style={{ gap: 6 }}>
      <Text style={{ fontSize: 13, fontWeight: '600', color: P.ink2 }}>{t('signin.emailLabel')}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, height: 52, borderRadius: 14, borderWidth: 1, borderColor: P.line, backgroundColor: P.surface2, paddingHorizontal: 14 }}>
        <Icon name="mail" size="lg" color={P.ink3} />
        <TextInput
          testID="signin-email"
          accessibilityLabel={t('signin.emailLabel')}
          placeholder={t('signin.emailPlaceholder')}
          placeholderTextColor={P.ink3}
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          textContentType="emailAddress"
          style={{ flex: 1, fontSize: 16, color: P.ink }}
        />
      </View>
    </View>
  );

  const alert = error ? (
    <Text testID="signin-error" accessibilityRole="alert" style={{ backgroundColor: P.dangerSoft, color: P.danger, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10, fontSize: 14, lineHeight: 20 }}>{error}</Text>
  ) : null;

  // One keyed block per step so each step rises in once.
  let body: ReactNode;
  if (mode === 'recovery') {
    body = (
      <View key="recovery" style={{ gap: 14 }}>
        <Rise index={0} reduced={reduced}>
          <View style={{ backgroundColor: P.warnSoft, borderRadius: 14, padding: 12, gap: 6 }}>
            <Text style={{ color: P.warnText, fontSize: 14, fontWeight: '700' }}>{t('signin.recoverySignInTitle')}</Text>
            <Text style={{ color: P.warnText, fontSize: 13, lineHeight: 18 }}>{t('signin.recoverySignInBody')}</Text>
            <Text style={{ color: P.warnText, fontSize: 13, lineHeight: 18 }}>{t('signin.verifierRequiredNote')}</Text>
            <Text style={{ color: P.warnText, fontSize: 13, lineHeight: 18, fontWeight: '700' }}>{t('signin.recoverySessionNote')}</Text>
          </View>
        </Rise>
        <Rise index={1} reduced={reduced}>{emailInput}</Rise>
        <Rise index={2} reduced={reduced}>
          <View style={{ gap: 6 }}>
            <Text style={{ fontSize: 13, fontWeight: '600', color: P.ink2 }}>{t('signin.recoveryKeyLabel')}</Text>
            <TextInput
              testID="signin-recovery-key"
              accessibilityLabel={t('signin.recoveryKeyLabel')}
              placeholder={t('signin.recoveryKeyHint')}
              placeholderTextColor={P.ink3}
              secureTextEntry
              value={recoveryKey}
              onChangeText={setRecoveryKey}
              autoCapitalize="none"
              autoCorrect={false}
              style={{ height: 52, borderRadius: 14, borderWidth: 1, borderColor: P.line, backgroundColor: P.surface2, paddingHorizontal: 14, fontSize: 16, color: P.ink }}
            />
          </View>
        </Rise>
        {alert}
        <Rise index={3} reduced={reduced}>
          <Btn testID="signin-submit" primary icon="recovery" label={t('signin.recoverySignInTitle')} busy={busy} onPress={() => void submitRecovery()} />
        </Rise>
        <TextButton testID="signin-mode-email" label={t('signin.useEmailCodeInstead')} onPress={() => { setMode('email'); setError(''); }} />
      </View>
    );
  } else if (step === 'email') {
    body = (
      <View key="email" style={{ gap: 14 }}>
        <Rise index={0} reduced={reduced}>{emailInput}</Rise>
        {alert}
        <Rise index={1} reduced={reduced}>
          <Btn testID="signin-submit" primary icon="mail" label={t('signin.sendCodeButton')} busy={busy} disabled={!address} onPress={() => void sendCode()} />
        </Rise>
        <TextButton testID="signin-mode-recovery" label={t('signin.useRecoveryKeyInstead')} onPress={() => { setMode('recovery'); setError(''); }} />
      </View>
    );
  } else if (step === 'code') {
    body = (
      <View key="code" style={{ gap: 14 }}>
        <Rise index={0} reduced={reduced}>
          <Text accessibilityRole="header" style={{ fontSize: 18, fontWeight: '700', color: P.ink }}>{t('signin.emailCodeTitle')}</Text>
        </Rise>
        <Rise index={1} reduced={reduced}>
          <Text style={{ fontSize: 14, lineHeight: 20, color: P.ink2 }}>{t('signin.emailCodeBody')}</Text>
        </Rise>
        <Rise index={2} reduced={reduced}>
          <View style={{ alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: P.brandSoft, borderRadius: 999, paddingVertical: 6, paddingHorizontal: 12 }}>
            <Icon name="mail" size="md" color={P.brandText} />
            <Text numberOfLines={1} style={{ fontSize: 14, fontWeight: '600', color: P.ink, maxWidth: 240 }}>{address}</Text>
          </View>
        </Rise>
        {!ticket ? (
          <Rise index={3} reduced={reduced}>
            <View style={{ gap: 8 }}>
              <Text style={{ fontSize: 13, fontWeight: '600', color: P.ink2 }}>{t('signin.emailCodeLabel')}</Text>
              <OtpField testID="signin-email-code" label={t('signin.emailCodeLabel')} value={code} onChange={setCode} />
              <Text style={{ fontSize: 12.5, color: P.ink3 }}>{t('signin.emailCodeHint')}</Text>
            </View>
          </Rise>
        ) : null}
        {alert}
        <Rise index={4} reduced={reduced}>
          <Btn testID="signin-submit" primary icon="enter" label={t('signin.signIn')} busy={busy} disabled={!ticket && code.length !== 6} onPress={() => void submitCode()} />
        </Rise>
        <TextButton testID="signin-resend" brand label={t('signin.resendCode')} disabled={busy} onPress={() => void sendCode()} />
        <TextButton testID="signin-back" label={t('signin.back')} onPress={() => restart()} />
      </View>
    );
  } else {
    body = (
      <View key="mfa" style={{ gap: 14 }}>
        <Rise index={0} reduced={reduced}>
          <Text accessibilityRole="header" style={{ fontSize: 18, fontWeight: '700', color: P.ink }}>{t('signin.mfaTitle')}</Text>
        </Rise>
        <Rise index={1} reduced={reduced}>
          <Text style={{ fontSize: 14, lineHeight: 20, color: P.ink2 }}>{t('signin.mfaBody')}</Text>
        </Rise>
        <Rise index={2} reduced={reduced}>
          <View style={{ gap: 6 }}>
            <Text style={{ fontSize: 13, fontWeight: '600', color: P.ink2 }}>{t('signin.mfaCodeLabel')}</Text>
            <TextInput
              testID="signin-mfa-code"
              accessibilityLabel={t('signin.mfaCodeLabel')}
              value={code}
              onChangeText={(v) => setCode(v.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 9))}
              autoCapitalize="characters"
              autoCorrect={false}
              placeholder="123456 / XXXX-XXXX"
              placeholderTextColor={P.ink3}
              style={{ height: 52, borderRadius: 14, borderWidth: 1, borderColor: P.line, backgroundColor: P.surface2, paddingHorizontal: 14, fontSize: 16, color: P.ink, letterSpacing: 2 }}
            />
          </View>
        </Rise>
        {alert}
        <Rise index={3} reduced={reduced}>
          <Btn testID="signin-submit" primary icon="check" label={t('signin.verifyCode')} busy={busy} disabled={code.trim().length < 6} onPress={() => void submitMfa()} />
        </Rise>
        <TextButton testID="signin-back" label={t('signin.back')} onPress={() => restart()} />
      </View>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: P.bg }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 24, paddingBottom: 40, width: '100%', maxWidth: 560, alignSelf: 'center' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 8 }}>
            <GhostBrandMark />
            <Text style={{ fontSize: 17, fontWeight: '700', color: P.ink }}>My Secret</Text>
          </View>

          <View style={{ alignItems: 'center', marginTop: 24, marginBottom: 20 }}>
            <Float reduced={reduced}>
              <Image source={illustrations.deviceHero} accessibilityIgnoresInvertColors style={{ width: 112, height: 112 }} resizeMode="contain" />
            </Float>

          </View>

          <View style={{ backgroundColor: P.surface, borderRadius: 14, padding: 22 }}>
            <Text accessibilityRole="header" style={{ fontSize: 27, lineHeight: 33, fontWeight: '700', letterSpacing: -0.4, color: P.ink }}>{t('signin.title')}</Text>
            {sessionExpired ? (
              <Text testID="signin-session-expired" style={{ backgroundColor: P.warnSoft, color: P.warnText, borderRadius: 14, padding: 12, fontSize: 14, lineHeight: 20, marginTop: 14 }}>{t('signin.sessionExpired')}</Text>
            ) : null}
            <View style={{ marginTop: 18 }}>{body}</View>
          </View>

          <Pressable testID="signin-local-only" accessibilityRole="button" accessibilityLabel={t('signin.continueLocalOnly')} onPress={onContinueLocalOnly} style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center', marginTop: 8 }}>
            <Text style={{ fontSize: 14, fontWeight: '600', color: P.ink2 }}>{t('signin.continueLocalOnly')}</Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
