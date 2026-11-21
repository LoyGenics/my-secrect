import React, { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BackHandler, Platform, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import sodium from 'libsodium-wrappers-sumo';
import { useTranslation } from '../../../../packages/i18n/src/react';
import {
  LS_ACCOUNT_EMAIL,
  SecurityApiClient,
  getValidToken,
  isMfaRequiredResult,
  saveSessionToken,
} from '../../../../packages/sdk/src/security';
import { fromBase64Url, sodiumReady, toBase64 } from '../../../../packages/crypto-adapters/src/index';
import { legacyRecoveryVerifierKeyPair, recoveryVerifierKeyPair } from '../../../../packages/sdk/src/recovery-verifier';
import AppTextField from '../components/Field';
import { AppButton, FieldGroup, InlineError } from '../components/mobile-ui';
import { AuthLayout } from '../components/soft';
import { useMobileTheme } from '../theme';
import { radius, space, textStyle } from '../ui/tokens';
import { EMAIL_CODE_LENGTH, isAccountEmail, normalizeMfaRecoveryCode, normalizeOtp } from '../utils/authInput';
import { apiStatus, isNetworkError } from '../utils/stepUp';

export interface SignInScreenProps {
  baseUrl: string;
  sessionExpired?: boolean;
  onSignedIn: (email: string, recoverySession: boolean, accountCreated: boolean) => void;
}

const tokenStore = {
  getItem: (key: string) => AsyncStorage.getItem(key),
  setItem: (key: string, value: string) => AsyncStorage.setItem(key, value),
  removeItem: (key: string) => AsyncStorage.removeItem(key),
};

/** A single editable input supports native paste and OTP suggestions. The boxes are decorative. */
function OtpField({ value, onChange, label, helper, disabled, onSubmit }: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  helper: string;
  disabled: boolean;
  onSubmit: () => void;
}) {
  const { colors, scheme } = useMobileTheme();
  const { width, fontScale } = useWindowDimensions();
  const [focused, setFocused] = useState(false);
  const gap = width < 360 || fontScale > 1.25 ? space[1] : space[2];

  return (
    <View style={{ gap: space[2] }}>
      <Text style={[textStyle.label, { color: colors.secondaryText }]}>{label}</Text>
      <View>
        <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ flexDirection: 'row', gap }}>
          {Array.from({ length: EMAIL_CODE_LENGTH }, (_, index) => {
            const active = focused && index === Math.min(value.length, EMAIL_CODE_LENGTH - 1);
            return (
              <View key={index} style={{
                flex: 1, minWidth: 0, paddingVertical: space[3], alignItems: 'center', justifyContent: 'center',
                borderRadius: radius.field, borderWidth: active ? 2 : 1,
                borderColor: active ? colors.focus : colors.controlBorder, backgroundColor: colors.surfaceMuted,
              }}>
                <Text style={[textStyle.title, { color: colors.text, fontVariant: ['tabular-nums'] }]}>{value[index] ?? ' '}</Text>
              </View>
            );
          })}
        </View>
        <TextInput
          testID="signin-email-code"
          accessibilityLabel={label}
          accessibilityHint={helper}
          value={value}
          onChangeText={(text) => onChange(normalizeOtp(text))}
          editable={!disabled}
          autoFocus
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onSubmitEditing={onSubmit}
          keyboardType="number-pad"
          keyboardAppearance={scheme}
          textContentType={Platform.OS === 'ios' ? 'oneTimeCode' : undefined}
          autoComplete={Platform.OS === 'android' ? 'sms-otp' : undefined}
          returnKeyType="go"
          caretHidden
          style={[StyleSheet.absoluteFill, { opacity: 0.02 }]}
        />
      </View>
      <Text style={[textStyle.helper, { color: colors.secondaryText }]}>{helper}</Text>
    </View>
  );
}

/** Email verification creates or signs in to the account. Vault unlock is a separate next step. */
export default function SignInScreen({ baseUrl, sessionExpired, onSignedIn }: SignInScreenProps) {
  const { dict, t } = useTranslation();
  const { colors } = useMobileTheme();
  const { signin, mobileAuth: auth } = dict;
  const recoveryInput = useRef<TextInput>(null);
  const [step, setStep] = useState<'email' | 'code' | 'mfa' | 'recovery'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [mfaMode, setMfaMode] = useState<'totp' | 'recovery'>('totp');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  // A ticket can be retried after a transport or service failure. Keep it in memory only.
  const [ticket, setTicket] = useState<string | null>(null);
  const [busy, setBusy] = useState<'submit' | 'resend' | null>(null);
  const [error, setError] = useState('');
  const [emailError, setEmailError] = useState('');
  const [feedback, setFeedback] = useState('');
  const client = useMemo(() => new SecurityApiClient({ baseUrl, getToken: () => getValidToken(tokenStore) }), [baseUrl]);
  const address = email.trim().toLowerCase();

  async function finish(who: string, token: string, expiresIn: number, recoverySession: boolean, accountCreated = false) {
    await saveSessionToken(tokenStore, token, expiresIn);
    await AsyncStorage.setItem(LS_ACCOUNT_EMAIL, who).catch(() => undefined);
    onSignedIn(who, recoverySession, accountCreated);
  }

  function failMessage(error: unknown): string {
    if (isNetworkError(error)) return auth.offline;
    switch (apiStatus(error)) {
      case 429: return auth.emailRateLimited;
      case 503: return signin.emailUnavailable;
      case 401: return signin.emailCodeFailed;
      default: return signin.unknownError;
    }
  }

  const restart = useCallback((message = '') => {
    setStep('email');
    setCode('');
    setRecoveryKey('');
    setTicket(null);
    setMfaToken(null);
    setMfaMode('totp');
    setFeedback('');
    setEmailError('');
    setError(message);
  }, []);

  useEffect(() => {
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      if (busy) return true;
      if (step === 'email') return false;
      restart();
      return true;
    });
    return () => back.remove();
  }, [busy, restart, step]);

  function checkAddress() {
    const valid = isAccountEmail(address);
    setEmailError(valid ? '' : signin.invalidEmail);
    return valid;
  }

  async function sendCode() {
    if (busy || !checkAddress()) return;
    const resending = step === 'code';
    setBusy(resending ? 'resend' : 'submit');
    setError('');
    setFeedback('');
    try {
      await client.requestEmailCode(address);
      setTicket(null);
      setCode('');
      if (resending) setFeedback(auth.emailSentAgain);
      setStep('code');
    } catch (error) {
      if (apiStatus(error) === 422 && !resending) setEmailError(signin.invalidEmail);
      else setError(failMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function submitCode() {
    if (busy || (!ticket && code.length !== EMAIL_CODE_LENGTH)) return;
    setBusy('submit');
    setError('');
    setFeedback('');
    try {
      let current = ticket;
      if (!current) {
        current = (await client.verifyEmailCode(address, code)).registration_ticket;
        setTicket(current);
        setCode('');
      }
      let result;
      try {
        result = await client.emailSessionVerify(address, current);
      } catch (error) {
        if (apiStatus(error) === 401) {
          restart(signin.signupExpired);
          return;
        }
        throw error;
      }
      setTicket(null);
      if (isMfaRequiredResult(result)) {
        setMfaToken(result.mfa_token);
        setMfaMode('totp');
        setStep('mfa');
        return;
      }
      await finish(address, result.token, result.expires_in, false, result.account_created === true);
    } catch (error) {
      if (apiStatus(error) === 401) setCode('');
      setError(failMessage(error));
    } finally {
      setBusy(null);
    }
  }

  const mfaValid = mfaMode === 'totp' ? code.length === EMAIL_CODE_LENGTH : code.length === 9;
  async function submitMfa() {
    if (busy || !mfaToken || !mfaValid) return;
    setBusy('submit');
    setError('');
    try {
      const result = await client.mfaVerify(mfaToken, code);
      setMfaToken(null);
      await finish(address, result.token, result.expires_in, false);
    } catch (error) {
      if (apiStatus(error) === 401) restart(signin.mfaExpired);
      else setError(failMessage(error));
    } finally {
      setCode('');
      setBusy(null);
    }
  }

  async function submitRecovery() {
    if (busy || !checkAddress()) return;
    let seed: Uint8Array | undefined;
    try { seed = fromBase64Url(recoveryKey.trim()); } catch { /* Invalid input. */ }
    if (seed?.length !== 32) {
      seed?.fill(0);
      setError(signin.verificationFailed);
      return;
    }
    setBusy('submit');
    setError('');
    const privateKeys: Uint8Array[] = [];
    const attempt = async (privateKey: Uint8Array) => {
      const { challenge_id, challenge } = await client.recoveryChallenge(address, 'recovery_key');
      const signature = sodium.crypto_sign_detached(fromBase64Url(challenge), privateKey);
      return client.recoveryVerify(challenge_id, address, toBase64(signature));
    };
    try {
      await sodiumReady;
      const current = await recoveryVerifierKeyPair(seed);
      privateKeys.push(current.privateKey);
      let result;
      try {
        result = await attempt(current.privateKey);
      } catch (error) {
        if (apiStatus(error) !== 401) throw error;
        const legacy = await legacyRecoveryVerifierKeyPair(seed);
        privateKeys.push(legacy.privateKey);
        result = await attempt(legacy.privateKey);
      }
      await finish(address, result.token, result.expires_in, result.recovery_session === true);
    } catch (error) {
      setError(apiStatus(error) === 401 ? signin.verificationFailed : failMessage(error));
    } finally {
      seed.fill(0);
      for (const key of privateKeys) key.fill(0);
      setRecoveryKey('');
      setBusy(null);
    }
  }

  const emailField = (
    <AppTextField
      flush
      testID="signin-email"
      label={signin.emailLabel}
      placeholder={signin.emailPlaceholder}
      leadingIcon="mail"
      value={email}
      error={emailError || undefined}
      disabled={Boolean(busy)}
      onChangeText={(value) => { setEmail(value); setEmailError(''); }}
      onSubmitEditing={() => {
        if (step === 'email') void sendCode();
        else recoveryInput.current?.focus();
      }}
      returnKeyType={step === 'email' ? 'go' : 'next'}
      autoCapitalize="none"
      autoCorrect={false}
      keyboardType="email-address"
      textContentType="emailAddress"
    />
  );
  const errorMessage = error ? <InlineError testID="signin-error">{error}</InlineError> : null;
  let title: string = signin.title;
  let subtitle: string | undefined = auth.newAccountHint;
  let content: ReactNode;

  if (step === 'email') {
    content = (
      <>
        {sessionExpired && <Text testID="signin-session-expired" accessibilityRole="alert" style={[textStyle.helper, { color: colors.warningText }]}>{signin.sessionExpired}</Text>}
        <FieldGroup>
          {emailField}
          {errorMessage}
          <View style={styles.actions}>
            <AppButton label={auth.continueEmail} icon="mail" testID="signin-submit" loading={busy === 'submit'} onPress={() => void sendCode()} />
            <AppButton label={auth.advancedRecovery} variant="text" size="compact" testID="signin-mode-recovery" disabled={Boolean(busy)} onPress={() => { setStep('recovery'); setError(''); setEmailError(''); }} />
          </View>
        </FieldGroup>
      </>
    );
  } else if (step === 'code') {
    title = signin.emailCodeTitle;
    subtitle = t('mobileAuth.emailTo', address);
    content = (
      <FieldGroup>
        {!ticket && <OtpField label={signin.emailCodeLabel} helper={signin.emailCodeHint} value={code} onChange={setCode} disabled={Boolean(busy)} onSubmit={() => void submitCode()} />}
        {errorMessage}
        {feedback ? <Text accessibilityLiveRegion="polite" style={[textStyle.helper, { color: colors.secondaryText }]}>{feedback}</Text> : null}
        <View style={styles.actions}>
          <AppButton label={signin.verifyCode} icon="check" testID="signin-submit" loading={busy === 'submit'} disabled={busy === 'resend' || (!ticket && code.length !== EMAIL_CODE_LENGTH)} onPress={() => void submitCode()} />
          <AppButton label={signin.resendCode} variant="secondary" testID="signin-resend" loading={busy === 'resend'} disabled={busy === 'submit'} onPress={() => void sendCode()} />
          <AppButton label={auth.changeEmail} variant="text" testID="signin-back" disabled={Boolean(busy)} onPress={() => restart()} />
        </View>
        <Text style={[textStyle.helper, { color: colors.secondaryText }]}>{auth.emailCodeRecoveryHint}</Text>
      </FieldGroup>
    );
  } else if (step === 'mfa') {
    title = signin.mfaTitle;
    subtitle = signin.mfaBody;
    const usingRecovery = mfaMode === 'recovery';
    content = (
      <FieldGroup>
        <AppTextField
          flush
          key={mfaMode}
          label={usingRecovery ? signin.recoveryCodeLabel : signin.mfaCodeLabel}
          helper={usingRecovery ? signin.recoveryCodeHint : signin.mfaTotpHint}
          testID="signin-mfa-code"
          value={code}
          onChangeText={(value) => setCode(usingRecovery ? normalizeMfaRecoveryCode(value) : normalizeOtp(value))}
          keyboardType={usingRecovery ? 'ascii-capable' : 'number-pad'}
          autoCapitalize={usingRecovery ? 'characters' : 'none'}
          autoComplete="off"
          autoCorrect={false}
          autoFocus
          disabled={Boolean(busy)}
          returnKeyType="go"
          onSubmitEditing={() => void submitMfa()}
        />
        {errorMessage}
        <View style={styles.actions}>
          <AppButton label={signin.verifyCode} icon="check" testID="signin-submit" loading={busy === 'submit'} disabled={!mfaValid} onPress={() => void submitMfa()} />
          <AppButton label={usingRecovery ? signin.useTotpCode : signin.useRecoveryCode} variant="secondary" testID="signin-mfa-mode" disabled={Boolean(busy)} onPress={() => {
            setMfaMode(usingRecovery ? 'totp' : 'recovery'); setCode(''); setError('');
          }} />
          <AppButton label={signin.back} variant="text" testID="signin-back" disabled={Boolean(busy)} onPress={() => restart()} />
        </View>
      </FieldGroup>
    );
  } else {
    title = signin.recoverySignInTitle;
    subtitle = auth.accountRecoveryBody;
    content = (
      <FieldGroup>
        {emailField}
        <AppTextField
          flush
          revealable
          ref={recoveryInput}
          testID="signin-recovery-key"
          label={signin.recoveryKeyLabel}
          helper={signin.recoveryKeyHint}
          value={recoveryKey}
          onChangeText={(value) => { setRecoveryKey(value); setError(''); }}
          onSubmitEditing={() => void submitRecovery()}
          returnKeyType="go"
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect={false}
          disabled={Boolean(busy)}
        />
        {errorMessage}
        <View style={styles.actions}>
          <AppButton label={signin.recoverySignInTitle} icon="recovery" loading={busy === 'submit'} testID="signin-submit" onPress={() => void submitRecovery()} />
          <AppButton label={signin.useEmailCodeInstead} variant="text" testID="signin-mode-email" disabled={Boolean(busy)} onPress={() => restart()} />
        </View>
      </FieldGroup>
    );
  }

  return <AuthLayout title={title} subtitle={subtitle}>{content}</AuthLayout>;
}

const styles = StyleSheet.create({ actions: { gap: space[3] } });
