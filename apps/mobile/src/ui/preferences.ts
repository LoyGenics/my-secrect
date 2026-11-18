export type AppearancePreference = 'system' | 'light' | 'dark';
export const AUTO_LOCK_CHOICES = [1, 5, 15, 0] as const;
export type AutoLockMinutes = (typeof AUTO_LOCK_CHOICES)[number];

export interface AppPreferences {
  appearance: AppearancePreference;
  autoLock: AutoLockMinutes;
}

interface PreferenceStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export const APP_PREFERENCES_KEY = 'my-secrect.mobile.preferences.v1';
export const DEFAULT_APP_PREFERENCES: Readonly<AppPreferences> = { appearance: 'system', autoLock: 5 };

export async function loadAppPreferences(storage: PreferenceStorage): Promise<AppPreferences> {
  const raw = await storage.getItem(APP_PREFERENCES_KEY);
  if (!raw) return { ...DEFAULT_APP_PREFERENCES };
  try {
    const saved: Partial<AppPreferences> | null = JSON.parse(raw);
    const appearance = saved?.appearance;
    const autoLock = saved?.autoLock;
    return {
      appearance: appearance === 'light' || appearance === 'dark' ? appearance : 'system',
      autoLock: autoLock !== undefined && AUTO_LOCK_CHOICES.includes(autoLock) ? autoLock : DEFAULT_APP_PREFERENCES.autoLock,
    };
  } catch {
    return { ...DEFAULT_APP_PREFERENCES };
  }
}

/** Queue snapshots so a delayed write can never replace a newer preference. */
export function createPreferenceWriter(storage: PreferenceStorage): (preferences: AppPreferences) => Promise<void> {
  let tail = Promise.resolve();
  return (preferences) => {
    const next = tail.then(() => storage.setItem(APP_PREFERENCES_KEY, JSON.stringify(preferences)));
    tail = next.catch(() => undefined);
    return next;
  };
}

export function resolveAppearance(preference: AppearancePreference, device: 'light' | 'dark' | null | undefined): 'light' | 'dark' {
  return preference === 'system' ? (device === 'dark' ? 'dark' : 'light') : preference;
}
