import type { Appearance } from '../lib/settings';

/** Apply the Appearance setting; popup.css resolves 'system' with prefers-color-scheme. */
export function applyAppearance(appearance: Appearance): void {
  document.documentElement.dataset.theme = appearance;
}
