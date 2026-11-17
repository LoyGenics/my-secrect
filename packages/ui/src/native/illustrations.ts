/**
 * 3D objects for React Native (Microsoft Fluent Emoji 3D, MIT — see
 * THIRD_PARTY_NOTICES.md). Same brand rule as web: onboarding, empty and
 * success screens only. PNG 160px (shown at <=80pt), required statically so
 * Metro bundles them.
 */
export const illustrations = {
  vault: require('../../assets/3d/native/locked_with_key.png'),
  recoveryKey: require('../../assets/3d/native/old_key.png'),
  success: require('../../assets/3d/native/check_mark_button.png'),
  emptyVault: require('../../assets/3d/native/card_file_box.png'),
  emptyTrash: require('../../assets/3d/native/wastebasket.png'),
  noResults: require('../../assets/3d/native/magnifying_glass_tilted_left.png'),
  emptyArchive: require('../../assets/3d/native/package.png'),
  restore: require('../../assets/3d/native/floppy_disk.png'),
} as const;

export type NativeIllustrationName = keyof typeof illustrations;
