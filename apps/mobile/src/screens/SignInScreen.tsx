import React, { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Easing,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  Text,
  TextInput,
  View,
  type ViewStyle,
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

const P = {
  bg: '#F6F4F1',
  surface: '#FFFFFF',
  surface2: '#FAF9F7',
  line: '#EBE8E3',
  ink: '#1E2227',
  ink2: '#565C63',
  ink3: '#8A9097',
  /** Button fill: white text on it is 4.7:1 (the lighter #FF6A2B is 2.9:1). */
  brandFill: '#D23F0C',
  brand: '#FF6A2B',
  brandSoft: '#FFF0E8',
  brandText: '#B8430F',
  danger: '#8A1F23',
  dangerSoft: '#FFE7E2',
  warnSoft: '#FFF4D8',
  warnText: '#6B4A07',
};

export interface SignInScreenProps {
  baseUrl: string;
  /** True when the previous session expired (401). */
  sessionExpired?: boolean;
  onSignedIn: (email: string, recoverySession: boolean) => void;
  onContinueLocalOnly: () => void;
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo?.isReduceMotionEnabled?.()
      .then((v: boolean) => { if (alive) setReduced(!!v); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  return reduced;
}

/** Slow idle float for the clay hero. */
function Float({ children, reduced, style }: { children: ReactNode; reduced: boolean; style?: ViewStyle }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduced) return undefined;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(v, { toValue: 1, duration: 3200, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(v, { toValue: 0, duration: 3200, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [reduced, v]);
  const translateY = v.interpolate({ inputRange: [0, 1], outputRange: [0, -12] });
  const rotate = v.interpolate({ inputRange: [0, 1], outputRange: ['-1.5deg', '1.5deg'] });
  return <Animated.View style={[style, { transform: [{ translateY }, { rotate }] }]}>{children}</Animated.View>;
}

/** One entrance per element: fade + rise, staggered by `index`. */
function Rise({ index = 0, reduced, children }: { index?: number; reduced: boolean; children: ReactNode }) {
  const v = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  useEffect(() => {
    if (reduced) {
      v.setValue(1);
      return;
    }
    Animated.timing(v, { toValue: 1, duration: 460, delay: index * 55, easing: Easing.out(Easing.exp), useNativeDriver: true }).start();
  }, [index, reduced, v]);
  const translateY = v.interpolate({ inputRange: [0, 1], outputRange: [14, 0] });
  return <Animated.View style={{ opacity: v, transform: [{ translateY }] }}>{children}</Animated.View>;
}

/** Six-digit code: one real input (autofill, paste) drawn as six boxes. */
function OtpField({ value, onChange, label, testID, length = 6 }: {
  value: string; onChange: (v: string) => void; label: string; testID: string; length?: number;
}) {
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

function Btn({ label, icon, onPress, disabled, busy, primary, testID }: {
  label: string; icon?: IconName; onPress: () => void; disabled?: boolean; busy?: boolean; primary?: boolean; testID: string;
}) {
  const off = !!disabled || !!busy;
  // A filled button always carries white text.
  const color = primary ? '#FFFFFF' : P.ink;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: off, busy: !!busy }}
      disabled={off}
      onPress={onPress}
      style={({ pressed }) => ({
        height: 52,
        borderRadius: 26,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        backgroundColor: primary ? P.brandFill : P.surface,
        borderWidth: primary ? 0 : 1,
        borderColor: P.line,
        opacity: disabled && !busy ? 0.55 : 1,
        transform: [{ scale: pressed ? 0.98 : 1 }],
        shadowColor: P.brandFill,
        shadowOpacity: primary ? 0.3 : 0,
        shadowRadius: 14,
        shadowOffset: { width: 0, height: 8 },
        elevation: primary ? 4 : 0,
      })}
    >
      {busy ? <ActivityIndicator color={color} /> : icon ? <Icon name={icon} size="lg" color={color} /> : null}
      <Text style={{ fontSize: 16, fontWeight: '700', color }}>{label}</Text>
    </Pressable>
  );
}

function TextButton({ label, onPress, disabled, brand, testID }: { label: string; onPress: () => void; disabled?: boolean; brand?: boolean; testID: string }) {
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.5 : 1 }}>
      <Text style={{ fontSize: 14, fontWeight: '600', color: brand ? P.brandText : P.ink2, textAlign: 'center' }}>{label}</Text>
    </Pressable>
  );
}

export default function SignInScreen({ baseUrl, sessionExpired, onSignedIn, onContinueLocalOnly }: SignInScreenProps) {
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

  const trust: Array<{ icon: IconName; text: string }> = [
    { icon: 'lock', text: t('signin.trustEncrypted') },
    { icon: 'server', text: t('signin.trustCiphertext') },
  ];

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: P.bg }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 8 }}>
            <View style={{ width: 36, height: 36, borderRadius: 12, backgroundColor: P.brandFill, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="lock" size="lg" color="#FFFFFF" />
            </View>
            <Text style={{ fontSize: 17, fontWeight: '700', color: P.ink }}>My Secret</Text>
          </View>

          <View style={{ alignItems: 'center', marginTop: 8, marginBottom: -8 }}>
            <Float reduced={reduced}>
              <Image source={illustrations.deviceHero} accessibilityIgnoresInvertColors style={{ width: 190, height: 190 }} resizeMode="contain" />
            </Float>
            <View style={{ width: 120, height: 14, borderRadius: 60, backgroundColor: 'rgba(30,20,10,0.10)', marginTop: -6 }} />
          </View>

          <View style={{ backgroundColor: P.surface, borderRadius: 28, borderWidth: 1, borderColor: P.line, padding: 22, shadowColor: '#14171C', shadowOpacity: 0.1, shadowRadius: 28, shadowOffset: { width: 0, height: 14 }, elevation: 6 }}>
            <Text accessibilityRole="header" style={{ fontSize: 24, fontWeight: '800', letterSpacing: -0.4, color: P.ink }}>{t('signin.title')}</Text>
            <Text style={{ fontSize: 14, lineHeight: 20, color: P.ink2, marginTop: 8 }}>{t('signin.subtitle')}</Text>
            {sessionExpired ? (
              <Text testID="signin-session-expired" style={{ backgroundColor: P.warnSoft, color: P.warnText, borderRadius: 14, padding: 12, fontSize: 14, lineHeight: 20, marginTop: 14 }}>{t('signin.sessionExpired')}</Text>
            ) : null}
            <View style={{ marginTop: 18 }}>{body}</View>
          </View>

          <View style={{ marginTop: 18, gap: 10 }}>
            {trust.map((row) => (
              <View key={row.icon} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <View style={{ width: 30, height: 30, borderRadius: 10, backgroundColor: P.surface, alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name={row.icon} size="md" color={P.brandFill} />
                </View>
                <Text style={{ flex: 1, fontSize: 13, lineHeight: 18, color: P.ink2 }}>{row.text}</Text>
              </View>
            ))}
            <Text style={{ fontSize: 12.5, lineHeight: 18, color: P.ink3 }}>{t('signin.mobileNoDeviceNote')}</Text>
          </View>

          <Pressable testID="signin-local-only" accessibilityRole="button" accessibilityLabel={t('signin.continueLocalOnly')} onPress={onContinueLocalOnly} style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center', marginTop: 8 }}>
            <Text style={{ fontSize: 14, fontWeight: '600', color: P.ink2 }}>{t('signin.continueLocalOnly')}</Text>
          </Pressable>
          <Text style={{ fontSize: 12, lineHeight: 17, color: P.ink3, textAlign: 'center', marginTop: 4 }}>{t('signin.footerNote')}</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
