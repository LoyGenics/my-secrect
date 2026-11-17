/**
 * Theme helpers for web/desktop (DOM). React Native must NOT import this
 * file — it touches `document`/`localStorage`/`matchMedia`. Mobile uses
 * `tokens.ts` only (see apps/mobile/src/theme.ts).
 *
 * Every function is DOM-guarded: importing this module in a non-DOM
 * environment is safe; calls become no-ops / fall back to `'dark'`.
 *
 * Storage: the choice is a UI preference, stored in `localStorage` under
 * `THEME_STORAGE_KEY`. It is not vault data and never leaves the device.
 */
import { darkTheme, lightTheme, type ThemeName, type ThemeTokens } from './tokens';

export type ThemeMode = ThemeName | 'system';

export const THEME_STORAGE_KEY = 'my-secrect:theme';

export const DEFAULT_THEME_MODE: ThemeMode = 'dark';

/** Resolve a mode to a concrete theme using the OS preference for 'system'. */
export function resolveTheme(mode: ThemeMode): { name: ThemeName; tokens: ThemeTokens } {
  if (mode === 'system') {
    return getSystemTheme() === 'light'
      ? { name: 'light', tokens: lightTheme }
      : { name: 'dark', tokens: darkTheme };
  }
  return mode === 'light' ? { name: 'light', tokens: lightTheme } : { name: 'dark', tokens: darkTheme };
}

/** OS preference via matchMedia; `'dark'` when unavailable (keeps the current dark-only look). */
export function getSystemTheme(): ThemeName {
  try {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
  } catch {
    /* ignore — fall through to dark */
  }
  return 'dark';
}

/** Read the stored mode; returns null when nothing was stored or storage is unavailable. */
export function getStoredTheme(): ThemeMode | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
    return null;
  } catch {
    return null;
  }
}

/** Persist the mode. No-op when storage is unavailable. */
export function storeTheme(mode: ThemeMode): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    /* storage unavailable (private mode, etc.) — theme still applies in-memory */
  }
}

/**
 * Apply a mode: sets `data-theme` on <html> (read by tokens.css) and
 * persists the choice. Pass `{ persist: false }` for a preview.
 */
export function applyTheme(mode: ThemeMode, options?: { persist?: boolean }): ThemeName {
  const resolved = resolveTheme(mode);
  try {
    if (typeof document !== 'undefined' && document.documentElement) {
      document.documentElement.setAttribute('data-theme', mode);
      document.documentElement.style.colorScheme = resolved.name;
    }
  } catch {
    /* non-DOM — ignore */
  }
  if (options?.persist !== false) storeTheme(mode);
  return resolved.name;
}

/**
 * Initialize at app startup: stored mode wins, else the default ('dark').
 * Returns the mode and a cleanup function that stops listening for OS
 * changes (only active while mode is 'system').
 */
export function initTheme(): { mode: ThemeMode; resolved: ThemeName; dispose: () => void } {
  const mode = getStoredTheme() ?? DEFAULT_THEME_MODE;
  const resolved = applyTheme(mode, { persist: false });
  let dispose = () => undefined;
  try {
    if (mode === 'system' && typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      const mq = window.matchMedia('(prefers-color-scheme: light)');
      const onChange = () => applyTheme('system', { persist: false });
      if (typeof mq.addEventListener === 'function') {
        mq.addEventListener('change', onChange);
        dispose = () => mq.removeEventListener('change', onChange);
      }
    }
  } catch {
    /* ignore */
  }
  return { mode, resolved, dispose };
}

/**
 * Inline script for index.html to avoid a theme flash before the bundle
 * loads. NOT applied anywhere yet — index.html files are not owned by
 * Phase D. An app can inline it in a <script> tag in <head>:
 *   <script dangerouslySetInnerHTML or inline>${themeInitScript}</script>
 * It reads the same localStorage key and sets data-theme before first paint.
 */
export const themeInitScript = `(function(){try{var m=localStorage.getItem('${THEME_STORAGE_KEY}');if(m!=='light'&&m!=='dark'&&m!=='system')m='dark';document.documentElement.setAttribute('data-theme',m);}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();`;
