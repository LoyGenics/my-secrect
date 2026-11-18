/**
 * Icon vocabulary shared by every platform. Platform-neutral (no React,
 * no DOM, no React Native): the web wrapper (components/Icon.tsx, on
 * lucide-react) and the native wrapper (native/Icon.tsx, on
 * lucide-react-native) each map these SEMANTIC names to Lucide glyphs with
 * a `Record<IconName, …>`, so the two can never drift apart and app code
 * never names a Lucide glyph directly. Emoji and unicode glyphs are not
 * icons in this product; use a name from here. Item-type glyphs live in
 * modules.ts (`moduleIcon`).
 */

export const iconNames = [
  // Vault views
  'items', 'favorite', 'trash', 'archive', 'unarchive', 'gallery', 'share', 'health', 'settings', 'security',
  'export', 'import', 'recovery', 'lock', 'unlock', 'tag',
  // Categories
  'credentials', 'finance', 'identity', 'developer', 'notes', 'media', 'documents', 'collections',
  // Item types without a category twin
  'passkey', 'card', 'apiKey', 'custom',
  // Actions
  'menu', 'search', 'add', 'generate', 'regenerate', 'close', 'edit', 'restore', 'show', 'hide', 'copy', 'check',
  'back', 'forward', 'expand', 'sort', 'enter', 'file', 'more', 'open',
  // Content markers
  'timer', 'link', 'attachment', 'server', 'language', 'appearance', 'light', 'dark', 'system', 'checklist',
  // Status
  'info', 'success', 'warning', 'error', 'reused', 'expiring', 'spinner', 'mail', 'shield',
] as const;

export type IconName = (typeof iconNames)[number];

/** Icon sizes in px. `sm` (14) sits on 13px text; `md` (16) on 15px; `lg` (20) in keys on touch; `xl` for module marks. */
export const iconSize = { xs: 12, sm: 14, md: 16, lg: 20, xl: 24 } as const;
export type IconSize = keyof typeof iconSize;

/** One stroke weight everywhere (Lucide default is 2; 1.75 reads finer at 16px). */
export const iconStrokeWidth = 1.75;
