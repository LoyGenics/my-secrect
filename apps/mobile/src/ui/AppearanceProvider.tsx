import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Appearance, useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createPreferenceWriter, DEFAULT_APP_PREFERENCES, loadAppPreferences, resolveAppearance, type AppPreferences, type AppearancePreference, type AutoLockMinutes } from './preferences';

interface PreferenceContext {
  ready: boolean;
  preference: AppearancePreference;
  resolvedScheme: 'light' | 'dark';
  autoLock: AutoLockMinutes;
  setPreference: (value: AppearancePreference) => void;
  setAutoLock: (value: AutoLockMinutes) => void;
  persistenceError: boolean;
}

const Context = createContext<PreferenceContext | null>(null);

function applyNativePreference(value: AppearancePreference): void {
  // RN 0.76 maps null to the native 'unspecified' configuration.
  Appearance.setColorScheme(value === 'system' ? null : value);
}

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const device = useColorScheme();
  const [preferences, setPreferences] = useState<AppPreferences>(DEFAULT_APP_PREFERENCES);
  const latest = useRef(preferences);
  const [ready, setReady] = useState(false);
  const [persistenceError, setPersistenceError] = useState(false);
  const persist = useMemo(() => createPreferenceWriter(AsyncStorage), []);

  useEffect(() => {
    let active = true;
    const finish = (loaded: AppPreferences, failed: boolean) => {
      if (!active) return;
      latest.current = loaded;
      applyNativePreference(loaded.appearance);
      setPreferences(loaded);
      setPersistenceError(failed);
      setReady(true);
    };
    void loadAppPreferences(AsyncStorage).then(
      (loaded) => finish(loaded, false),
      () => finish(DEFAULT_APP_PREFERENCES, true),
    );
    return () => { active = false; };
  }, []);

  const update = useCallback((patch: Partial<AppPreferences>) => {
    const before = latest.current;
    const next = { ...before, ...patch };
    if (next.appearance !== before.appearance) applyNativePreference(next.appearance);
    latest.current = next;
    setPreferences(next);
    void persist(next).then(
      () => { if (latest.current === next) setPersistenceError(false); },
      () => { if (latest.current === next) setPersistenceError(true); },
    );
  }, [persist]);

  const setPreference = useCallback((appearance: AppearancePreference) => update({ appearance }), [update]);
  const setAutoLock = useCallback((autoLock: AutoLockMinutes) => update({ autoLock }), [update]);
  const resolvedScheme = resolveAppearance(preferences.appearance, device);
  const value = useMemo(() => ({
    ready, preference: preferences.appearance, autoLock: preferences.autoLock, resolvedScheme, setPreference, setAutoLock, persistenceError,
  }), [ready, preferences, resolvedScheme, setPreference, setAutoLock, persistenceError]);

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useAppPreferences(): PreferenceContext {
  const preferences = useContext(Context);
  if (!preferences) throw new Error('App preferences require AppearanceProvider');
  return preferences;
}

/** Component previews can derive an OS theme without mounting app settings. */
export function useResolvedAppearance(): 'light' | 'dark' {
  return useContext(Context)?.resolvedScheme ?? resolveAppearance('system', Appearance.getColorScheme());
}
