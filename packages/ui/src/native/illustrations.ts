/**
 * Image slots for React Native — same slot names as web (illustrations.ts),
 * same files (packages/ui/assets/illustrations, static WebP; iOS 14+ and
 * Android decode WebP natively). Provenance: packages/ui/assets/ASSETS.md.
 * Brand rule: onboarding, empty, error and success screens only. Motion is
 * web-only for now (React Native's Image does not animate WebP reliably).
 */
export const illustrations = {
  splash: require('../../assets/illustrations/state-locked.webp'),
  deviceHero: require('../../assets/illustrations/onboarding-welcome.webp'),
  passphrase: require('../../assets/illustrations/onboarding-passphrase.webp'),
  recoveryKey: require('../../assets/illustrations/onboarding-recovery.webp'),
  success: require('../../assets/illustrations/onboarding-done.webp'),
  restore: require('../../assets/illustrations/state-import.webp'),
  healthClear: require('../../assets/illustrations/state-health-good.webp'),
  healthWarning: require('../../assets/illustrations/state-health-warning.webp'),
  error: require('../../assets/illustrations/state-error.webp'),
  offline: require('../../assets/illustrations/state-offline.webp'),
  emptyVault: require('../../assets/illustrations/empty-vault.webp'),
  emptyTrash: require('../../assets/illustrations/empty-trash.webp'),
  emptyFavorites: require('../../assets/illustrations/empty-favorites.webp'),
  noResults: require('../../assets/illustrations/empty-search.webp'),
  emptyArchive: require('../../assets/illustrations/empty-archive.webp'),
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
