import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import type { VaultItem } from '../../../packages/core/src/types';
import { LS_API_TOKEN_EXPIRES_AT, SecurityApiClient, clearSessionToken } from '../../../packages/sdk/src/security';
import SignInScreen from './screens/SignInScreen';
import { loadAccountServer, resolveVaultEntry } from './accountServer';
import { asyncTokenStore, getApiToken } from './screens/SecurityScreen';
import {
  hasVault, lockVault, signOutVault, isUnlocked, listItems, listTrash, upsertItem, importItems,
  deleteItem, restoreItem, permanentlyDeleteItem, toggleFavorite,
} from './vault';
import { useMobileTheme } from './theme';
import { AppButton, AppPage, InlineError, Progress } from './components/mobile-ui';
import MobileNavigator from './MobileNavigator';
import { clearFilePreviews } from './storage/filePreviews';
import { removeEncryptedFile } from './storage/localFiles';
import { isFile } from '../../../packages/core/src/files';
import { I18nProvider, useTranslation } from '../../../packages/i18n/src/react';
import { LOCALE_STORAGE_KEY, defaultLocale, type Locale } from '../../../packages/i18n/src/index';
import OnboardingScreen from './screens/OnboardingScreen';
import LockScreen from './screens/LockScreen';
import BillingScreen from './screens/BillingScreen';
import { useMobileBilling } from './useMobileBilling';
import { AppearanceProvider, useAppPreferences } from './ui/AppearanceProvider';
import { fontAssets } from './ui/fonts';

/** Any authenticated call proves the stored session is still live. */
function checkAccountSession(baseUrl: string) {
  return new SecurityApiClient({ baseUrl, getToken: getApiToken }).listSessions();
}

type Boot = 'loading' | 'error' | 'signin' | 'plans' | 'onboarding' | 'locked' | 'unlocked';

/**
 * Root: restores the language choice (AsyncStorage, same key as web's
 * localStorage) and mounts ONE I18nProvider for every screen; switching
 * language anywhere (useTranslation().setLocale) persists it.
 */
export default function App() {
  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      <AppearanceProvider>
        <Start />
      </AppearanceProvider>
    </SafeAreaProvider>
  );
}

function Start() {
  const [locale, setLocale] = useState<Locale | null>(null);
  const { ready, resolvedScheme } = useAppPreferences();
  const { colors } = useMobileTheme();
  // Every text role names a Be Vietnam Pro face, so nothing renders until the faces are registered.
  const [fontsLoaded, fontError] = useFonts(fontAssets);
  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(LOCALE_STORAGE_KEY)
      .then((v) => { if (active) setLocale(v === 'en' || v === 'vi' ? v : defaultLocale); })
      .catch(() => { if (active) setLocale(defaultLocale); });
    return () => { active = false; };
  }, []);
  return (
    <I18nProvider key={locale ?? 'loading'} initialLocale={locale ?? defaultLocale}
      onLocaleChange={next => void AsyncStorage.setItem(LOCALE_STORAGE_KEY, next).catch(() => undefined)}>
      <StatusBar style={resolvedScheme === 'light' ? 'dark' : 'light'} backgroundColor={colors.canvas} />
      {!fontsLoaded && !fontError ? <View style={{ flex: 1, backgroundColor: colors.canvas }} />
        : ready && locale ? <AppShell /> : <BootStatus />}
    </I18nProvider>
  );
}

function BootStatus({ onRetry }: { onRetry?: () => void }) {
  const { dict, t } = useTranslation();
  return (
    <AppPage testID="app-boot" safeArea="full" scroll={false} contentStyle={{ justifyContent: 'center' }}>
      {onRetry ? (
        <>
          <InlineError>{t('mobileUI.bootError')}</InlineError>
          <AppButton label={t('security.retry')} variant="secondary" onPress={onRetry} />
        </>
      ) : <Progress label={dict.common.loading} />}
    </AppPage>
  );
}

function AppShell() {
  const { styles } = useMobileTheme();
  const { dict } = useTranslation();
  const { autoLock, setAutoLock } = useAppPreferences();
  const [boot, setBoot] = useState<Boot>('loading');
  const [bootAttempt, setBootAttempt] = useState(0);
  const [items, setItems] = useState<VaultItem[]>([]);
  const [trash, setTrash] = useState<VaultItem[]>([]);
  const [notice, setNotice] = useState('');
  const lastActivity = useRef(Date.now());
  const [apiBaseUrl, setApiBaseUrl] = useState('');
  const [sessionExpired, setSessionExpired] = useState(false);
  const [accountUnverified, setAccountUnverified] = useState(false);
  const [accountJustSignedIn, setAccountJustSignedIn] = useState(false);
  const [afterPlans, setAfterPlans] = useState<'locked' | 'onboarding'>('onboarding');
  const [shareAfterSignIn, setShareAfterSignIn] = useState<string>();
  const hasAccountSession = boot === 'plans' || boot === 'onboarding' || boot === 'locked' || boot === 'unlocked';
  const sessionGeneration = useRef(0);
  const currentSession = sessionGeneration.current;

  const refresh = useCallback(() => { if (isUnlocked()) { setItems(listItems()); setTrash(listTrash()); } }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      await clearFilePreviews().catch(() => undefined);
      const url = await loadAccountServer(AsyncStorage, !__DEV__, process.env.EXPO_PUBLIC_ACCOUNT_API_URL);
      const next = await resolveVaultEntry(asyncTokenStore, hasVault, () => checkAccountSession(url));
      // A session that ended while the app was closed takes biometric unlock and autofill with it.
      if (next === 'signin') await signOutVault().catch(() => undefined);
      if (!active) return;
      setApiBaseUrl(url);
      setAccountUnverified(next === 'unverified');
      if (next === 'onboarding') setAfterPlans(next);
      const entry = next === 'unverified' ? 'signin' : next;
      setBoot(entry === 'onboarding' ? 'plans' : entry);
    })().catch(() => { if (active) setBoot('error'); });
    return () => { active = false; };
  }, [bootAttempt]);

  const lockAndClear = useCallback(() => {
    lockVault();
    void clearFilePreviews().catch(() => undefined);
    setItems([]); setTrash([]); setNotice('');
  }, []);

  const doLock = useCallback(() => {
    setShareAfterSignIn(undefined);
    lockAndClear();
    setBoot(current => current === 'unlocked' ? 'locked' : current);
  }, [lockAndClear]);

  const returnToSignIn = useCallback((expired: boolean, shareItemId?: string) => {
    if (currentSession !== sessionGeneration.current) return false;
    sessionGeneration.current += 1;
    lockAndClear();
    void signOutVault().catch(() => undefined);
    setSessionExpired(expired);
    setAccountUnverified(false);
    setAccountJustSignedIn(false);
    setShareAfterSignIn(shareItemId);
    setBoot('signin');
    return true;
  }, [currentSession, lockAndClear]);

  const handleUnauthorized = useCallback((shareItemId?: string) => {
    if (returnToSignIn(true, shareItemId)) void clearSessionToken(asyncTokenStore);
  }, [returnToSignIn]);

  const handleServerSaved = useCallback((next: string) => {
    if (next === apiBaseUrl) return;
    setApiBaseUrl(next);
    returnToSignIn(false);
  }, [apiBaseUrl, returnToSignIn]);

  const handleSignedIn = useCallback((_email: string, recoverySession: boolean, accountCreated: boolean) => {
    setSessionExpired(false);
    setAccountUnverified(false);
    setBoot('loading');
    void resolveVaultEntry(asyncTokenStore, hasVault, () => checkAccountSession(apiBaseUrl)).then(next => {
      setAccountJustSignedIn(next === 'locked');
      if (next === 'signin' || next === 'unverified') { setAccountUnverified(next === 'unverified'); setBoot('signin'); return; }
      setAfterPlans(next);
      setBoot(!recoverySession && (accountCreated || next === 'onboarding') ? 'plans' : next);
    }).catch(() => setBoot('error'));
  }, [apiBaseUrl]);

  const billing = useMobileBilling(apiBaseUrl, hasAccountSession ? currentSession : null, handleUnauthorized);
  const continueFromPlans = useCallback(() => {
    setBoot(current => current === 'plans' ? afterPlans : current);
  }, [afterPlans]);
  useEffect(() => {
    if (boot === 'plans' && billing.access?.tier === 'pro') continueFromPlans();
  }, [billing.access?.tier, boot, continueFromPlans]);

  useEffect(() => {
    if (!hasAccountSession) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function checkSession() {
      const [token, rawExpiry] = await Promise.all([getApiToken(), AsyncStorage.getItem(LS_API_TOKEN_EXPIRES_AT).catch(() => null)]);
      if (!active) return;
      clearTimeout(timer);
      if (!token) {
        handleUnauthorized();
        return;
      }
      const remaining = Number(rawExpiry) - Date.now();
      if (rawExpiry && Number.isFinite(remaining)) {
        timer = setTimeout(() => void checkSession(), Math.min(Math.max(remaining, 0), 2_147_483_647));
      }
    }
    void checkSession();
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') void checkSession();
    });
    return () => { active = false; clearTimeout(timer); sub.remove(); };
  }, [hasAccountSession, handleUnauthorized]);

  // Auto-lock: any touch resets the inactivity clock; a 10s ticker locks
  // the vault once the chosen idle time has passed.
  useEffect(() => {
    if (boot !== 'unlocked' || autoLock === 0) return;
    const id = setInterval(() => { if (Date.now() - lastActivity.current > autoLock * 60_000) doLock(); }, 10_000);
    return () => clearInterval(id);
  }, [boot, autoLock, doLock]);

  // Timers pause in the background, so check on return: background time
  // counts as idle time, and the vault locks before anything is shown.
  useEffect(() => {
    if (boot !== 'unlocked' || autoLock === 0) return;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && Date.now() - lastActivity.current > autoLock * 60_000) doLock();
    });
    return () => sub.remove();
  }, [boot, autoLock, doLock]);

  function markActivity() { lastActivity.current = Date.now(); }
  function handleUnlocked() {
    if (currentSession !== sessionGeneration.current) {
      lockVault();
      return;
    }
    lastActivity.current = Date.now(); refresh(); setAccountJustSignedIn(false); setBoot('unlocked');
  }

  async function handleSaveItem(item: VaultItem, localCardCode?: string) {
    await upsertItem(item, localCardCode); refresh();
  }
  async function handleDelete(id: string) {
    const inTrash = trash.some((t) => t.id === id);
    if (inTrash) {
      const item = trash.find(item => item.id === id);
      if (item && isFile(item)) await removeEncryptedFile(String(item.fields.blob_id ?? ''));
      await permanentlyDeleteItem(id);
    } else await deleteItem(id);
    refresh();
  }
  async function handleRestore(id: string) { await restoreItem(id); refresh(); }
  function handleToggleFavorite(id: string) { toggleFavorite(id); refresh(); }
  async function handleLoadExamples(list: VaultItem[]) { for (const it of list) await upsertItem(it); refresh(); setNotice(dict.mobile.exampleLoaded); }
  async function handleClearExamples(ids: string[]) { for (const id of ids) await permanentlyDeleteItem(id); refresh(); setNotice(dict.mobile.exampleCleared); }

  if (boot === 'loading') return <BootStatus />;
  if (boot === 'error') return <BootStatus onRetry={() => { setBoot('loading'); setBootAttempt(value => value + 1); }} />;
  if (boot === 'plans') return <BillingScreen billing={billing} baseUrl={apiBaseUrl} onContinue={continueFromPlans} />;
  if (boot === 'onboarding') return <OnboardingScreen onDone={handleUnlocked}
    onRestored={() => setBoot(current => current === 'onboarding' ? 'locked' : current)} />;
  if (boot === 'locked') return <LockScreen onUnlocked={handleUnlocked} accountJustSignedIn={accountJustSignedIn} />;
  if (boot === 'signin') {
    return (
      <SignInScreen
        baseUrl={apiBaseUrl}
        sessionExpired={sessionExpired}
        accountUnverified={accountUnverified}
        onSignedIn={handleSignedIn}
      />
    );
  }

  return (
    <View style={styles.screen} onTouchStart={markActivity}>
      <MobileNavigator items={items} trash={trash} autoLock={autoLock} notice={notice} setNotice={setNotice}
        onSave={handleSaveItem} onDelete={handleDelete} onRestore={handleRestore} onToggleFavorite={handleToggleFavorite}
        onImportItems={async (selected) => { await importItems(selected); refresh(); }}
        onLoadExamples={list => void handleLoadExamples(list)} onClearExamples={ids => void handleClearExamples(ids)}
        onAutoLockChange={setAutoLock} onLock={doLock}
        onWiped={() => setBoot(current => current === 'unlocked' ? 'onboarding' : current)}
        apiBaseUrl={apiBaseUrl} billing={billing} initialShareItemId={shareAfterSignIn}
        onSignedOut={() => returnToSignIn(false)} onUnauthorized={handleUnauthorized} onServerSaved={handleServerSaved} />
    </View>
  );
}
