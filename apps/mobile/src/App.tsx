import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { StatusBar } from 'expo-status-bar';
import type { VaultItem } from '../../packages/core/src/types';
import { SecurityApiClient, clearSessionToken, getValidToken } from '../../packages/sdk/src/security';
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
import { colors, styles } from './theme';
import OnboardingScreen from './screens/OnboardingScreen';
import LockScreen from './screens/LockScreen';
import VaultScreen from './screens/VaultScreen';
import SearchScreen from './screens/SearchScreen';
import GeneratorScreen from './screens/GeneratorScreen';
import HealthScreen from './screens/HealthScreen';
import SettingsScreen, { type AutoLockMinutes } from './screens/SettingsScreen';
import TrashScreen from './screens/TrashScreen';
import SecurityScreen from './screens/SecurityScreen';
import ItemDetailScreen from './screens/ItemDetailScreen';
import ItemFormScreen from './screens/ItemFormScreen';

type Tab = 'vault' | 'search' | 'generator' | 'health' | 'settings';
type Boot = 'loading' | 'signin' | 'onboarding' | 'locked' | 'unlocked';

const TABS: Array<{ key: Tab; label: string; icon: string }> = [
  { key: 'vault', label: 'Vault', icon: '🔒' },
  { key: 'search', label: 'Search', icon: '🔍' },
  { key: 'generator', label: 'Generate', icon: '⚡' },
  { key: 'health', label: 'Health', icon: '🛡️' },
  { key: 'settings', label: 'Settings', icon: '⚙️' },
];

/**
 * Mobile shell. Navigation is a small custom state machine (no
 * react-navigation dependency): bottom tabs + full-screen detail/form/
 * trash overlays. Every screen is a real, working screen — see
 * src/screens/. Auto-lock is enforced by an inactivity timer.
 */
export default function App() {
  const [boot, setBoot] = useState<Boot>('loading');
  const [items, setItems] = useState<VaultItem[]>([]);
  const [trash, setTrash] = useState<VaultItem[]>([]);
  const [tab, setTab] = useState<Tab>('vault');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingItem, setEditingItem] = useState<VaultItem | null>(null);
  const [showTrash, setShowTrash] = useState(false);
  const [showSecurity, setShowSecurity] = useState(false);
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
    lockVault(); setItems([]); setTrash([]); setSelectedId(null); setShowForm(false); setEditingItem(null); setShowTrash(false); setShowSecurity(false); setBoot('locked');
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

  function markActivity() { lastActivity.current = Date.now(); }
  function handleUnlocked() { lastActivity.current = Date.now(); refresh(); setBoot('unlocked'); }
  function clearSelection() { setSelectedId(null); setShowForm(false); setEditingItem(null); }

  async function handleSaveItem(item: VaultItem) {
    await upsertItem(item); refresh(); setShowForm(false); setEditingItem(null); setSelectedId(item.id);
  }
  async function handleDelete(id: string) {
    const inTrash = trash.some((t) => t.id === id);
    if (inTrash) await permanentlyDeleteItem(id); else await deleteItem(id);
    if (selectedId === id) setSelectedId(null);
    refresh();
  }
  async function handleRestore(id: string) { await restoreItem(id); refresh(); setSelectedId(id); setShowTrash(false); }
  function handleToggleFavorite(id: string) { toggleFavorite(id); refresh(); }
  async function handleLoadExamples(list: VaultItem[]) { for (const it of list) await upsertItem(it); refresh(); setNotice('Example data loaded — fake values only.'); }
  async function handleClearExamples(ids: string[]) { for (const id of ids) await permanentlyDeleteItem(id); refresh(); setNotice('Example data cleared.'); }

  const selectedItem = [...items, ...trash].find((i) => i.id === selectedId) ?? null;
  const inTrash = selectedItem ? trash.some((t) => t.id === selectedItem.id) : false;

  if (boot === 'loading') {
    return (<View style={[styles.screen, { alignItems: 'center', justifyContent: 'center' }]}><ActivityIndicator size="large" color={colors.accent} /><Text style={{ color: colors.muted, marginTop: 12 }}>Loading vault…</Text><StatusBar style="light" /></View>);
  }
  if (boot === 'onboarding') return (<><StatusBar style="light" /><OnboardingScreen onDone={handleUnlocked} /></>);
  if (boot === 'locked') return (<><StatusBar style="light" /><LockScreen onUnlocked={handleUnlocked} /></>);
  // Account sign-in comes BEFORE the vault whenever a server is
  // configured and there is no valid session. 'Continue without
  // signing in' keeps the local vault usable offline.
  if (boot === 'signin') {
    return (
      <View style={styles.screen}>
        <StatusBar style="light" />
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
      </View>
    );
  }

  return (
    <View style={styles.screen} onTouchStart={markActivity}>
      <StatusBar style="light" />
      {showSecurity ? (
        <SecurityScreen
          onClose={() => setShowSecurity(false)}
          onSignedOut={() => void handleSignedOut()}
          onUnauthorized={handleUnauthorized}
        />
      ) : showTrash ? (
        <TrashScreen trash={trash} onSelect={(id) => { setSelectedId(id); setShowTrash(false); }} onRestore={(id) => void handleRestore(id)} onPermanentDelete={(id) => void handleDelete(id)} />
      ) : showForm ? (
        <ItemFormScreen initial={editingItem ?? undefined} allItems={items} onSave={(item) => void handleSaveItem(item)} onCancel={clearSelection} />
      ) : selectedItem ? (
        <ItemDetailScreen item={selectedItem} allItems={items} inTrash={inTrash} onEdit={() => { setEditingItem(selectedItem); setShowForm(true); }} onDelete={() => void handleDelete(selectedItem.id)} onRestore={() => void handleRestore(selectedItem.id)} onToggleFavorite={() => handleToggleFavorite(selectedItem.id)} onClose={clearSelection} onSelectRelated={(id) => setSelectedId(id)} />
      ) : tab === 'vault' ? (
        <VaultScreen items={items} trash={trash} onSelect={(id) => setSelectedId(id)} onToggleFavorite={handleToggleFavorite} onNew={() => { setEditingItem(null); setShowForm(true); }} onLoadExamples={(list) => void handleLoadExamples(list)} onClearExamples={(ids) => void handleClearExamples(ids)} />
      ) : tab === 'search' ? (
        <SearchScreen items={items} onSelect={(id) => setSelectedId(id)} onToggleFavorite={handleToggleFavorite} />
      ) : tab === 'generator' ? (
        <GeneratorScreen />
      ) : tab === 'health' ? (
        <HealthScreen items={items} onFix={(item) => { setEditingItem(item); setShowForm(true); }} />
      ) : (
        <SettingsScreen autoLock={autoLock} onAutoLockChange={setAutoLock} onLock={doLock} onWiped={() => setBoot('onboarding')} notice={notice} setNotice={setNotice} onViewTrash={() => setShowTrash(true)} onViewSecurity={() => setShowSecurity(true)} />
      )}
      {notice && !showForm && !selectedItem && !showTrash && !showSecurity ? (
        <Pressable testID="app-notice" accessibilityLabel="Dismiss notice" onPress={() => setNotice('')} style={{ backgroundColor: colors.card, borderTopColor: colors.cardBorder, borderTopWidth: 1, padding: 10 }}>
          <Text style={{ color: '#A5B4FC', fontSize: 13, textAlign: 'center' }}>{notice} — tap to dismiss</Text>
        </Pressable>
      ) : null}
      {!showForm && !selectedItem && !showTrash && !showSecurity ? (
        <View style={{ flexDirection: 'row', borderTopColor: colors.cardBorder, borderTopWidth: 1, backgroundColor: colors.card, paddingBottom: 20, paddingTop: 8 }}>
          {TABS.map((t) => (
            <Pressable key={t.key} testID={`tab-${t.key}`} accessibilityLabel={`${t.label} tab`} accessibilityRole="tab" accessibilityState={{ selected: tab === t.key }} onPress={() => { setTab(t.key); clearSelection(); }} style={{ flex: 1, alignItems: 'center', minHeight: 48, justifyContent: 'center' }}>
              <Text style={{ fontSize: 22 }}>{t.icon}</Text>
              <Text style={{ color: tab === t.key ? colors.accent : colors.muted, fontSize: 11, fontWeight: tab === t.key ? '700' : '500', marginTop: 2 }}>{t.label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}
