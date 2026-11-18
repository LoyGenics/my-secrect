/**
 * Theme helpers for web/desktop (DOM). React Native must NOT import this
 * file — it touches `document`/`localStorage`/`matchMedia`. Mobile uses
 * `tokens.ts` only (see apps/mobile/src/theme.ts).
 *
 * Every function is DOM-guarded: importing this module in a non-DOM
 * environment is safe; calls become no-ops / fall back to `'light'`.
 *
 * Storage: the choice is a UI preference, stored in `localStorage` under
 * `THEME_STORAGE_KEY`. It is not vault data and never leaves the device.
 */
import { DEFAULT_THEME, darkTheme, lightTheme, type ThemeName, type ThemeTokens } from './tokens';

export type ThemeMode = ThemeName | 'system';

export const THEME_STORAGE_KEY = 'my-secrect:theme';

/** Aluminium (light) for new users; a stored choice always wins. */
export const DEFAULT_THEME_MODE: ThemeMode = DEFAULT_THEME;

/** Resolve a mode to a concrete theme using the OS preference for 'system'. */
export function resolveTheme(mode: ThemeMode): { name: ThemeName; tokens: ThemeTokens } {
  const name = mode === 'system' ? getSystemTheme() : mode;
  return name === 'dark' ? { name: 'dark', tokens: darkTheme } : { name: 'light', tokens: lightTheme };
}

/** OS preference via matchMedia; the default finish when unavailable. */
export function getSystemTheme(): ThemeName {
  try {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
  } catch {
    /* ignore — fall through to the default */
  }
  return DEFAULT_THEME;
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
 * Initialize at app startup: stored mode wins, else the default ('light').
 * Returns the mode and a cleanup function that stops listening for OS
 * changes (only active while mode is 'system').
 */
export function initTheme(): { mode: ThemeMode; resolved: ThemeName; dispose: () => void } {
  const mode = getStoredTheme() ?? DEFAULT_THEME_MODE;
  const resolved = applyTheme(mode, { persist: false });
  let dispose: () => void = () => undefined;
  try {
    if (mode === 'system' && typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
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
 * Pre-paint theme script: sets `data-theme` from the stored mode before the
 * bundle loads, so a stored dark choice never flashes light. The production
 * CSP (`script-src 'self'`, no 'unsafe-inline') blocks inline scripts, so
 * each app serves this exact text as `public/theme-init.js`, loaded with a
 * blocking `<script src>` in `<head>`; packages/ui/tests/tokens-sync.test.ts
 * fails when a copy drifts from this string.
 */
export const themeInitScript = `(function(){var m;try{m=localStorage.getItem('${THEME_STORAGE_KEY}');}catch(e){}if(m!=='light'&&m!=='dark'&&m!=='system')m='${DEFAULT_THEME}';document.documentElement.setAttribute('data-theme',m);})();\n`;
