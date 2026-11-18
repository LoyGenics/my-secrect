import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { StatusBar } from 'expo-status-bar';
import type { VaultItem } from '../../../packages/core/src/types';
import { SecurityApiClient, clearSessionToken, getValidToken } from '../../../packages/sdk/src/security';
import SignInScreen from './screens/SignInScreen';
import { API_BASE_URL_KEY } from './screens/SecurityScreen';

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
import ScreenFrame from './components/ScreenFrame';
import MobileNavigator from './MobileNavigator';
import { clearFilePreviews } from './storage/filePreviews';
import { removeEncryptedFile } from './storage/localFiles';
import { isFile } from '../../../packages/core/src/files';
import { I18nProvider, useTranslation } from '../../../packages/i18n/src/react';
import { LOCALE_STORAGE_KEY, defaultLocale, type Locale } from '../../../packages/i18n/src/index';
import OnboardingScreen from './screens/OnboardingScreen';
import LockScreen from './screens/LockScreen';
import { type AutoLockMinutes } from './screens/SettingsScreen';

type Boot = 'loading' | 'signin' | 'onboarding' | 'locked' | 'unlocked';

/**
 * Root: restores the language choice (AsyncStorage, same key as web's
 * localStorage) and mounts ONE I18nProvider for every screen; switching
 * language anywhere (useTranslation().setLocale) persists it.
 */
export default function App() {
  const [locale, setLocale] = useState<Locale | null>(null);
  useEffect(() => {
    AsyncStorage.getItem(LOCALE_STORAGE_KEY)
      .then((v) => setLocale(v === 'en' || v === 'vi' ? v : defaultLocale))
      .catch(() => setLocale(defaultLocale));
  }, []);
  if (!locale) return null;
  return (
    <I18nProvider initialLocale={locale} onLocaleChange={(next) => void AsyncStorage.setItem(LOCALE_STORAGE_KEY, next)}>
      <AppShell />
    </I18nProvider>
  );
}

function AppShell() {
  const { colors, styles, scheme } = useMobileTheme();
  const { dict } = useTranslation();
  const statusBar = scheme === 'light' ? 'dark' : 'light';
  const [boot, setBoot] = useState<Boot>('loading');
  const [items, setItems] = useState<VaultItem[]>([]);
  const [trash, setTrash] = useState<VaultItem[]>([]);
  const [notice, setNotice] = useState('');
  const [autoLock, setAutoLock] = useState<AutoLockMinutes>(5);
  const lastActivity = useRef(Date.now());
  // --- Account sign-in state (WorkOS scope) --------------------------
  // Signed-in = a valid (unexpired) session token is stored. When a
  // server is configured and there is no valid session, the sign-in
  // screen comes FIRST — before vault onboarding / lock. Vault unlock
  // (master passphrase) stays a SEPARATE step after sign-in. With no
  // server configured there is no gate at all.
  const [apiBaseUrl, setApiBaseUrl] = useState('');
  const [localOnlyBypass, setLocalOnlyBypass] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);

  const refresh = useCallback(() => { if (isUnlocked()) { setItems(listItems()); setTrash(listTrash()); } }, []);

  useEffect(() => {
    void (async () => {
      await clearFilePreviews().catch(() => undefined);
      const raw = await AsyncStorage.getItem(API_BASE_URL_KEY);
      const url = (raw ?? '').trim();
      setApiBaseUrl(url);
      const exists = await hasVault();
      const next: Boot = exists ? 'locked' : 'onboarding';
      if (url && !localOnlyBypass) {
        const token = await getValidToken(asyncTokenStore);
        setBoot(token ? next : 'signin');
      } else {
        setBoot(next);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    setLocalOnlyBypass(false);
    setSessionExpired(false);
    doLock();
    setBoot(apiBaseUrl ? 'signin' : 'locked');
  }, [apiBaseUrl, doLock]);

  /** A 401 anywhere means the session is gone server-side: clear
   *  the token and send the user back to SignIn with an expiry
   *  note, never silently retrying with the stale token. */
  const handleUnauthorized = useCallback(() => {
    void clearSessionToken(asyncTokenStore);
    setSessionExpired(true);
    setLocalOnlyBypass(false);
    doLock();
    setBoot(apiBaseUrl ? 'signin' : 'locked');
  }, [apiBaseUrl, doLock]);

  const handleServerSaved = useCallback(async (next: string) => {
    if (next === apiBaseUrl) return;
    setApiBaseUrl(next);
    setSessionExpired(false);
    setLocalOnlyBypass(false);
    if (next) {
      doLock();
      setBoot('signin');
    }
  }, [apiBaseUrl, doLock]);

  const handleSignedIn = useCallback((_email: string, _recoverySession: boolean) => {
    setLocalOnlyBypass(false);
    setSessionExpired(false);
    void (async () => {
      const exists = await hasVault();
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
  function handleUnlocked() { lastActivity.current = Date.now(); refresh(); setBoot('unlocked'); }

  async function handleSaveItem(item: VaultItem) {
    await upsertItem(item); refresh();
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

  if (boot === 'loading') {
    return (<View style={[styles.screen, { alignItems: 'center', justifyContent: 'center' }]}><ActivityIndicator size="large" color={colors.accent} /><Text style={{ color: colors.muted, marginTop: 12 }}>{dict.common.loading}</Text><StatusBar style={statusBar} /></View>);
  }
  if (boot === 'onboarding') return (<><StatusBar style={statusBar} /><OnboardingScreen onDone={handleUnlocked} onRestored={() => setBoot('locked')} /></>);
  if (boot === 'locked') return (<><StatusBar style={statusBar} /><LockScreen onUnlocked={handleUnlocked} /></>);
  // Account sign-in comes BEFORE the vault whenever a server is
  // configured and there is no valid session. 'Continue without
  // signing in' keeps the local vault usable offline.
  if (boot === 'signin') {
    return (
      <ScreenFrame style={styles.screen}>
        <StatusBar style={statusBar} />
        <SignInScreen
          baseUrl={apiBaseUrl}
          sessionExpired={sessionExpired}
          onSignedIn={(email, recoverySession) => handleSignedIn(email, recoverySession)}
          onContinueLocalOnly={() => {
            setLocalOnlyBypass(true);
            void (async () => {
              const exists = await hasVault();
              setBoot(exists ? 'locked' : 'onboarding');
            })();
          }}
        />
      </ScreenFrame>
    );
  }

  return (
    <View style={styles.screen} onTouchStart={markActivity}>
      <StatusBar style={statusBar} />
      <MobileNavigator items={items} trash={trash} autoLock={autoLock} notice={notice} setNotice={setNotice}
        onSave={handleSaveItem} onDelete={handleDelete} onRestore={handleRestore} onToggleFavorite={handleToggleFavorite}
        onLoadExamples={list => void handleLoadExamples(list)} onClearExamples={ids => void handleClearExamples(ids)}
        onAutoLockChange={setAutoLock} onLock={doLock} onWiped={() => setBoot('onboarding')}
        onSignedOut={() => void handleSignedOut()} onUnauthorized={handleUnauthorized} onServerSaved={handleServerSaved} />
    </View>
  );
}
