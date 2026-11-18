import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import type { VaultItem } from '../../../packages/core/src/types';
import { SecurityApiClient, clearSessionToken, getValidToken } from '../../../packages/sdk/src/security';
import SignInScreen from './screens/SignInScreen';
import { HOSTED_API_BASE_URL, loadAccountServer } from './accountServer';

/** AsyncStorage-backed token store (same LS_API_TOKEN key as
 *  desktop/web — one token store, not one per platform). */
const asyncTokenStore = {
  getItem: (k: string) => AsyncStorage.getItem(k),
  setItem: (k: string, v: string) => AsyncStorage.setItem(k, v),
  removeItem: (k: string) => AsyncStorage.removeItem(k),
};
import {
  hasVault, lockVault, isUnlocked, listItems, listTrash, upsertItem,
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
import { AppearanceProvider, useAppPreferences } from './ui/AppearanceProvider';

type Boot = 'loading' | 'error' | 'signin' | 'onboarding' | 'locked' | 'unlocked';

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
      {ready && locale ? <AppShell /> : <BootStatus />}
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
  // The hosted account is optional. A local vault opens independently.
  const [apiBaseUrl, setApiBaseUrl] = useState('');
  const [signedIn, setSignedIn] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [accountJustSignedIn, setAccountJustSignedIn] = useState(false);

  const refresh = useCallback(() => { if (isUnlocked()) { setItems(listItems()); setTrash(listTrash()); } }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      await clearFilePreviews().catch(() => undefined);
      const url = await loadAccountServer(AsyncStorage, !__DEV__).catch(() => '');
      const [token, exists] = await Promise.all([url ? getValidToken(asyncTokenStore).catch(() => null) : null, hasVault()]);
      if (!active) return;
      setApiBaseUrl(url);
      setSignedIn(Boolean(token));
      const next: Boot = exists ? 'locked' : 'onboarding';
      setBoot(__DEV__ && url && url !== HOSTED_API_BASE_URL && !token ? 'signin' : next);
    })().catch(() => { if (active) setBoot('error'); });
    return () => { active = false; };
  }, [bootAttempt]);

  const doLock = useCallback(() => {
    lockVault(); void clearFilePreviews().catch(() => undefined); setItems([]); setTrash([]); setBoot('locked');
  }, []);

  /** Sign out of the account AND lock the vault. The server session
   *  is revoked first (revokeCurrentSession); when the server cannot
   *  confirm — offline, or the session already expired — local
   *  sign-out still proceeds and the token is cleared regardless.
   *  Revocation invalidates the server session only; it does NOT
   *  erase secrets already downloaded or cached offline here. */
  const handleSignedOut = useCallback(async () => {
    try {
      const client = new SecurityApiClient({
        baseUrl: apiBaseUrl,
        getToken: () => getValidToken(asyncTokenStore),
        tokenStore: asyncTokenStore,
      });
      await client.revokeCurrentSession();
    } catch {
      // Server revocation unconfirmed; local sign-out proceeds.
    }
    await clearSessionToken(asyncTokenStore);
    setSignedIn(false);
    setSessionExpired(false);
    doLock();
    if (__DEV__ && apiBaseUrl && apiBaseUrl !== HOSTED_API_BASE_URL) setBoot('signin');
  }, [apiBaseUrl, doLock]);

  /** A 401 anywhere means the session is gone server-side: clear
   *  the token and send the user back to SignIn with an expiry
   *  note, never silently retrying with the stale token. */
  const handleUnauthorized = useCallback(() => {
    void clearSessionToken(asyncTokenStore);
    setSessionExpired(true);
    setSignedIn(false);
    doLock();
    setBoot(apiBaseUrl ? 'signin' : 'locked');
  }, [apiBaseUrl, doLock]);

  const handleSignIn = useCallback(() => {
    if (!apiBaseUrl) return;
    doLock();
    setBoot('signin');
  }, [apiBaseUrl, doLock]);

  const handleServerSaved = useCallback(async (next: string) => {
    if (next === apiBaseUrl) return;
    setApiBaseUrl(next);
    setSessionExpired(false);
    setSignedIn(false);
    if (next) {
      doLock();
      setBoot('signin');
    }
  }, [apiBaseUrl, doLock]);

  const handleSignedIn = useCallback((_email: string, _recoverySession: boolean) => {
    setSignedIn(true);
    setSessionExpired(false);
    void (async () => {
      const exists = await hasVault();
      setAccountJustSignedIn(exists);
      setBoot(exists ? 'locked' : 'onboarding');
    })();
  }, []);

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
  if (boot === 'onboarding') return <OnboardingScreen onDone={handleUnlocked} onRestored={() => setBoot('locked')} />;
  if (boot === 'locked') return <LockScreen onUnlocked={handleUnlocked} accountJustSignedIn={accountJustSignedIn} />;
  if (boot === 'signin') {
    return (
      <SignInScreen
        baseUrl={apiBaseUrl}
        sessionExpired={sessionExpired}
        onSignedIn={handleSignedIn}
        onContinueLocalOnly={() => {
          void hasVault().then(exists => setBoot(exists ? 'locked' : 'onboarding'));
        }}
      />
    );
  }

  return (
    <View style={styles.screen} onTouchStart={markActivity}>
      <MobileNavigator items={items} trash={trash} autoLock={autoLock} notice={notice} setNotice={setNotice}
        onSave={handleSaveItem} onDelete={handleDelete} onRestore={handleRestore} onToggleFavorite={handleToggleFavorite}
        onLoadExamples={list => void handleLoadExamples(list)} onClearExamples={ids => void handleClearExamples(ids)}
        onAutoLockChange={setAutoLock} onLock={doLock} onWiped={() => setBoot('onboarding')}
        apiBaseUrl={apiBaseUrl} signedIn={signedIn} onSignIn={handleSignIn}
        onSignedOut={() => void handleSignedOut()} onUnauthorized={handleUnauthorized} onServerSaved={handleServerSaved} />
    </View>
  );
}
