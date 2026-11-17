/// <reference path="./assets.d.ts" />
/**
 * Image slots. Every raster the app shows is looked up here by SLOT, so
 * replacing the temporary art with the "Precision Instrument" render set is
 * a path change in this file only (web) and native/illustrations.ts (mobile).
 *
 * Current art: Microsoft Fluent Emoji 3D (MIT — see THIRD_PARTY_NOTICES.md),
 * WebP 256px, 2–8 KB each. Brand rule: imagery ONLY on onboarding, the lock
 * screen (>= 1024px), empty states, success screens and the item-type art
 * slots — never inside list rows or as an interface icon. Render with
 * loading="lazy" and alt="" (decorative: the heading beside it carries the
 * meaning).
 */
import type { ItemTypeKey } from './tokens';
import lockedWithKey from '../assets/3d/locked_with_key.webp';
import oldKey from '../assets/3d/old_key.webp';
import checkMark from '../assets/3d/check_mark_button.webp';
import cardFileBox from '../assets/3d/card_file_box.webp';
import cardIndex from '../assets/3d/card_index.webp';
import wastebasket from '../assets/3d/wastebasket.webp';
import magnifier from '../assets/3d/magnifying_glass_tilted_left.webp';
import star from '../assets/3d/star.webp';
import packageBox from '../assets/3d/package.webp';
import floppyDisk from '../assets/3d/floppy_disk.webp';

export const illustrations = {
  /** Onboarding hero beside the device face (create vault). */
  deviceHero: lockedWithKey,
  /** Lock screen hero, shown only at >= 1024px. */
  lockHero: lockedWithKey,
  /** Save the one-time recovery key. */
  recoveryKey: oldKey,
  /** Success: vault ready, backup restored. */
  success: checkMark,
  /** Watchtower all clear. */
  healthClear: checkMark,
  /** Empty vault / category / tag. */
  emptyVault: cardFileBox,
  /** Nothing selected in the detail pane. */
  selectItem: cardIndex,
  emptyTrash: wastebasket,
  noResults: magnifier,
  emptyFavorites: star,
  emptyArchive: packageBox,
  /** Restore an encrypted backup. */
  restore: floppyDisk,
} as const;

export type IllustrationName = keyof typeof illustrations;

/**
 * Item-type art (detail header, rail): one object per type. Empty until the
 * render set lands; consumers fall back to the vector TypeModule, so filling
 * an entry here is the whole swap.
 */
export const typeArt: Partial<Record<ItemTypeKey, string>> = {};
