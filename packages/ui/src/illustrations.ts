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
import mascotNeutral from '../assets/mascot/ghost-neutral.webp';
import mascotHappy from '../assets/mascot/ghost-happy.webp';
import mascotWave from '../assets/mascot/ghost-wave.webp';
import mascotSleepy from '../assets/mascot/ghost-sleepy.webp';
import mascotSurprised from '../assets/mascot/ghost-surprised.webp';
import mascotSad from '../assets/mascot/ghost-sad.webp';
import mascotProud from '../assets/mascot/ghost-proud.webp';
import mascotSearching from '../assets/mascot/ghost-searching.webp';
import mascotWorking from '../assets/mascot/ghost-working.webp';
import mascotSuccess from '../assets/mascot/ghost-success.webp';
import mascotError from '../assets/mascot/ghost-error.webp';
import mascotThinking from '../assets/mascot/ghost-thinking.webp';
import mascotEmpty from '../assets/mascot/ghost-empty.webp';
import mascotGuard from '../assets/mascot/ghost-guard.webp';
import ghostMotionHello from '../assets/motion/ghost-hello.webp';
import ghostMotionHelloStill from '../assets/motion/ghost-hello-still.webp';
import ghostMotionSleepy from '../assets/motion/ghost-sleepy.webp';
import ghostMotionSleepyStill from '../assets/motion/ghost-sleepy-still.webp';
import ghostMotionJoy from '../assets/motion/ghost-joy.webp';
import ghostMotionJoyStill from '../assets/motion/ghost-joy-still.webp';
import ghostMotionLoading from '../assets/motion/ghost-loading.webp';
import ghostMotionLoadingStill from '../assets/motion/ghost-loading-still.webp';
import ghostMotionIdle from '../assets/motion/ghost-idle.webp';
import ghostMotionIdleStill from '../assets/motion/ghost-idle-still.webp';
import ghostVector from '../assets/brand/ghost.svg';
import ghostVectorMono from '../assets/brand/ghost-mono.svg';
import ghostVectorTile from '../assets/brand/ghost-favicon.svg';

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

/**
 * Mascot: the ghost with the orange key (07_ghost_key, seed 8209) in one expression per
 * situation — transparent 384px WebP, same clay style and palette, so they swap freely.
 * Use for empty, error, success, onboarding and waiting states, never as an interface icon.
 * Provenance: packages/ui/assets/ASSETS.md.
 */
export const mascot = {
  neutral: mascotNeutral,
  happy: mascotHappy,
  wave: mascotWave,
  sleepy: mascotSleepy,
  surprised: mascotSurprised,
  sad: mascotSad,
  proud: mascotProud,
  searching: mascotSearching,
  working: mascotWorking,
  success: mascotSuccess,
  error: mascotError,
  thinking: mascotThinking,
  empty: mascotEmpty,
  guard: mascotGuard,
} as const;
export type MascotName = keyof typeof mascot;

/** Mascot loops (256px animated WebP, ping-pong so the loop is seamless) with a still first frame for reduced motion. */
export const mascotMotion = {
  hello: { animated: ghostMotionHello, still: ghostMotionHelloStill } as ArtSource,
  sleepy: { animated: ghostMotionSleepy, still: ghostMotionSleepyStill } as ArtSource,
  joy: { animated: ghostMotionJoy, still: ghostMotionJoyStill } as ArtSource,
  loading: { animated: ghostMotionLoading, still: ghostMotionLoadingStill } as ArtSource,
  idle: { animated: ghostMotionIdle, still: ghostMotionIdleStill } as ArtSource,
} as const;
export type MascotMotionName = keyof typeof mascotMotion;

/** Flat vector ghost (SVG): `color` for large print, `mono` (currentColor) for one-colour uses, `tile` for favicons. */
export const mascotVector = { color: ghostVector, mono: ghostVectorMono, tile: ghostVectorTile } as const;
