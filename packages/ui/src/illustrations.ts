/// <reference path="./assets.d.ts" />
/**
 * Image slots. Every raster the app shows is looked up here by SLOT, so a
 * new render is a path change in this file (web) and native/illustrations.ts
 * (mobile). Provenance per file: packages/ui/assets/ASSETS.md.
 *
 * Art: the soft-3D clay set (tangerine, mint, lavender, sky, butter, coral),
 * transparent cutouts so they sit on either finish; no text or brand marks.
 * Brand rule: imagery on onboarding/splash, the lock screen (>= 1024px),
 * empty, error and success states, and the item-type tiles (list rows and
 * detail header, on the type's pastel) — never as an interface icon.
 * Decorative (alt=""): the text beside it carries the meaning. Static slots are 384px WebP (type art 256px);
 * motion slots are 256px animated WebP with a still first frame that is
 * shown instead under prefers-reduced-motion (see components/Art.tsx).
 */
import type { ItemTypeKey } from './tokens';
import onboardingWelcome from '../assets/illustrations/onboarding-welcome.webp';
import onboardingPassphrase from '../assets/illustrations/onboarding-passphrase.webp';
import onboardingRecovery from '../assets/illustrations/onboarding-recovery.webp';
import onboardingDone from '../assets/illustrations/onboarding-done.webp';
import stateLocked from '../assets/illustrations/state-locked.webp';
import stateUnlocked from '../assets/illustrations/state-unlocked.webp';
import stateError from '../assets/illustrations/state-error.webp';
import stateImport from '../assets/illustrations/state-import.webp';
import stateHealthGood from '../assets/illustrations/state-health-good.webp';
import stateHealthWarning from '../assets/illustrations/state-health-warning.webp';
import stateOffline from '../assets/illustrations/state-offline.webp';
import stateNotFound from '../assets/illustrations/state-not-found.webp';
import emptyVault from '../assets/illustrations/empty-vault.webp';
import emptyTrash from '../assets/illustrations/empty-trash.webp';
import emptyFavorites from '../assets/illustrations/empty-favorites.webp';
import emptySearch from '../assets/illustrations/empty-search.webp';
import emptyArchive from '../assets/illustrations/empty-archive.webp';
import typeLogin from '../assets/illustrations/type-login.webp';
import typePasskey from '../assets/illustrations/type-passkey.webp';
import typeBankAccount from '../assets/illustrations/type-bank-account.webp';
import typeCard from '../assets/illustrations/type-card.webp';
import typeIdentity from '../assets/illustrations/type-identity.webp';
import typeSshKey from '../assets/illustrations/type-ssh-key.webp';
import typeApiKey from '../assets/illustrations/type-api-key.webp';
import typeSecureNote from '../assets/illustrations/type-secure-note.webp';
import typeDocument from '../assets/illustrations/type-document.webp';
import typeMedia from '../assets/illustrations/type-media.webp';
import typeCollection from '../assets/illustrations/type-collection.webp';
import typeCustom from '../assets/illustrations/type-custom.webp';
import ghostMark from '../assets/brand/ghost-mark.webp';
import motionSuccess from '../assets/motion/success.webp';
import motionSuccessStill from '../assets/motion/success-still.webp';
import motionWorking from '../assets/motion/working.webp';
import motionWorkingStill from '../assets/motion/working-still.webp';
import motionSleepyStar from '../assets/motion/sleepy-star.webp';
import motionSleepyStarStill from '../assets/motion/sleepy-star-still.webp';
import motionError from '../assets/motion/error.webp';
import motionErrorStill from '../assets/motion/error-still.webp';

/** A slot is a static image URL or an animated clip with its still first frame. */
export type ArtSource = string | { animated: string; still: string };

export const illustrations = {
  /** Splash / lock screen hero (shown at >= 1024px beside the device face). */
  splash: stateLocked,
  /** Onboarding steps beside the device face. */
  deviceHero: onboardingWelcome,
  passphrase: onboardingPassphrase,
  recoveryKey: onboardingRecovery,
  /** Success: vault ready. */
  success: { animated: motionSuccess, still: motionSuccessStill } as ArtSource,
  /** Busy: vault creation / unlock KDF running. */
  working: { animated: motionWorking, still: motionWorkingStill } as ArtSource,
  onboardingDone,
  /** Restore an encrypted backup / backup restored. */
  restore: stateImport,
  restored: onboardingDone,
  /** Watchtower. */
  healthClear: stateHealthGood,
  healthWarning: stateHealthWarning,
  /** Error and offline states. */
  error: { animated: motionError, still: motionErrorStill } as ArtSource,
  errorStatic: stateError,
  offline: stateOffline,
  notFound: stateNotFound,
  /** Nothing selected in the detail pane. */
  selectItem: stateUnlocked,
  /** Empty states. */
  emptyVault,
  emptyTrash,
  emptyFavorites: { animated: motionSleepyStar, still: motionSleepyStarStill } as ArtSource,
  emptyFavoritesStatic: emptyFavorites,
  noResults: emptySearch,
  emptyArchive,
} as const;

export type IllustrationName = keyof typeof illustrations;

/** Item-type art (tiles in list rows and the detail header): one clay object per type. */
export const typeArt: Partial<Record<ItemTypeKey, string>> = {
  login: typeLogin,
  passkey: typePasskey,
  bank_account: typeBankAccount,
  card: typeCard,
  identity: typeIdentity,
  ssh_key: typeSshKey,
  api_key: typeApiKey,
  secure_note: typeSecureNote,
  document: typeDocument,
  media: typeMedia,
  collection: typeCollection,
  custom: typeCustom,
};

/**
 * Brand mark (rail header, lock card): the ghost holding an orange key, chosen
 * from the logo concepts (07_ghost_key, seed 8209) — a full-bleed lavender
 * square, so consumers round its corners (`.ms-brand-img`). Provenance:
 * packages/ui/assets/ASSETS.md.
 */
export const brandMark: { src?: string } = { src: ghostMark };
