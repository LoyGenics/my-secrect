/**
 * Image slots for React Native — same slot names as web (illustrations.ts),
 * mascot expressions (packages/ui/assets/mascot, static WebP; iOS 14+ and
 * Android decode WebP natively). Provenance: packages/ui/assets/ASSETS.md.
 * Brand rule: onboarding, empty, error and success screens only. Motion is
 * web-only for now (React Native's Image does not animate WebP reliably).
 */
export const illustrations = {
  splash: require('../../assets/mascot/ghost-sleepy.webp'),
  deviceHero: require('../../assets/mascot/ghost-wave.webp'),
  passphrase: require('../../assets/mascot/ghost-thinking.webp'),
  recoveryKey: require('../../assets/mascot/ghost-neutral.webp'),
  success: require('../../assets/mascot/ghost-success.webp'),
  restore: require('../../assets/mascot/ghost-neutral.webp'),
  healthClear: require('../../assets/mascot/ghost-happy.webp'),
  healthWarning: require('../../assets/mascot/ghost-surprised.webp'),
  error: require('../../assets/mascot/ghost-error.webp'),
  offline: require('../../assets/mascot/ghost-sad.webp'),
  emptyVault: require('../../assets/mascot/ghost-wave.webp'),
  emptyTrash: require('../../assets/mascot/ghost-empty.webp'),
  emptyFavorites: require('../../assets/mascot/ghost-sleepy.webp'),
  noResults: require('../../assets/mascot/ghost-searching.webp'),
  emptyArchive: require('../../assets/mascot/ghost-neutral.webp'),
} as const;

export type NativeIllustrationName = keyof typeof illustrations;

/** Item-type art for detail headers. */
export const typeArt = {
  login: require('../../assets/illustrations/type-login.webp'),
  passkey: require('../../assets/illustrations/type-passkey.webp'),
  bank_account: require('../../assets/illustrations/type-bank-account.webp'),
  card: require('../../assets/illustrations/type-card.webp'),
  identity: require('../../assets/illustrations/type-identity.webp'),
  ssh_key: require('../../assets/illustrations/type-ssh-key.webp'),
  api_key: require('../../assets/illustrations/type-api-key.webp'),
  secure_note: require('../../assets/illustrations/type-secure-note.webp'),
  document: require('../../assets/illustrations/type-document.webp'),
  media: require('../../assets/illustrations/type-media.webp'),
  collection: require('../../assets/illustrations/type-collection.webp'),
  custom: require('../../assets/illustrations/type-custom.webp'),
} as const;

/** Mascot expressions (same files as web, static; see illustrations.ts). */
export const mascot = {
  neutral: require('../../assets/mascot/ghost-neutral.webp'),
  happy: require('../../assets/mascot/ghost-happy.webp'),
  wave: require('../../assets/mascot/ghost-wave.webp'),
  sleepy: require('../../assets/mascot/ghost-sleepy.webp'),
  surprised: require('../../assets/mascot/ghost-surprised.webp'),
  sad: require('../../assets/mascot/ghost-sad.webp'),
  proud: require('../../assets/mascot/ghost-proud.webp'),
  searching: require('../../assets/mascot/ghost-searching.webp'),
  working: require('../../assets/mascot/ghost-working.webp'),
  success: require('../../assets/mascot/ghost-success.webp'),
  error: require('../../assets/mascot/ghost-error.webp'),
  thinking: require('../../assets/mascot/ghost-thinking.webp'),
  empty: require('../../assets/mascot/ghost-empty.webp'),
  guard: require('../../assets/mascot/ghost-guard.webp'),
} as const;
export type NativeMascotName = keyof typeof mascot;
