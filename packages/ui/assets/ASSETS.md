# Asset provenance

Every raster shipped from `packages/ui/assets/`. Wiring: `src/illustrations.ts`
(web) and `src/native/illustrations.ts` (React Native). Licences of the tools
and libraries: `THIRD_PARTY_NOTICES.md` (repo root).

## Pipeline

| Step | Tool | Licence |
|---|---|---|
| Illustrations | Qwen-Image (`qwen_image_fp8_e4m3fn.safetensors`), ComfyUI on Google Colab | Apache-2.0 |
| Upscale | Real-ESRGAN x4plus | BSD-3-Clause |
| Cutouts (transparent) | BiRefNet | MIT |
| Motion | Wan 2.2 TI2V-5B (`wan2.2_ti2v_5B_fp16`, `umt5_xxl_fp8_e4m3fn_scaled`, `wan2.2_vae`), image-to-video from the illustration named as start image | Apache-2.0 |
| App sizes | ImageMagick (trim, resize, coalesce) + `cwebp` (q82, alpha q85) | Apache-2.0 / BSD-3-Clause (tools only, nothing bundled) |

Source drop: `my-secrect-assets-inbox/` (outside the repo; `mysecret_illustrations/manifest.json`
holds the full prompt for every id, `mysecret_motion/manifest.json` every clip prompt and
negative prompt). Shared style prompt: soft clay toy, rounded chunky shapes, matte clay and
soft plastic, palette tangerine / mint / lavender / sky blue / butter yellow / coral,
plain cream background, and "No text, no letters, no numbers, no logos, no brand names".
Each id was rendered with seeds 9103 and 9207; the seed column is the one kept after
review (rejected: any with text or symbols such as the `$` coin on `type_bank` 9103,
cropped parts such as the lanyard on `type_identity` 9103, or clutter).

## Illustrations (`illustrations/`, transparent cutouts, WebP)

| File | Source id | Seed | Size | Slot |
|---|---|---|---|---|
| onboarding-welcome.webp | onb_welcome | 9207 | 384 | `deviceHero` |
| onboarding-passphrase.webp | onb_passphrase | 9103 | 384 | `passphrase` |
| onboarding-recovery.webp | onb_recovery | 9103 | 384 | `recoveryKey` |
| onboarding-done.webp | onb_done | 9103 | 384 | `onboardingDone`, `restored` |
| state-locked.webp | state_locked | 9103 | 384 | `splash` (lock screen >= 1024px) |
| state-unlocked.webp | state_unlocked | 9103 | 384 | `selectItem` |
| state-error.webp | state_error | 9207 | 384 | `errorStatic` |
| state-import.webp | state_import | 9103 | 384 | `restore` |
| state-health-good.webp | state_health_good | 9103 | 384 | `healthClear` |
| state-health-warning.webp | state_health_warning | 9207 | 384 | `healthWarning` |
| state-offline.webp | state_offline | 9103 | 384 | `offline` |
| state-not-found.webp | state_not_found | 9207 | 384 | `notFound` |
| empty-vault.webp | empty_vault | 9207 | 384 | `emptyVault` |
| empty-trash.webp | empty_trash | 9207 | 384 | `emptyTrash` |
| empty-favorites.webp | empty_favorites | 9103 | 384 | `emptyFavoritesStatic` |
| empty-search.webp | empty_search | 9207 | 384 | `noResults` |
| empty-archive.webp | state_account_deleted | 9103 | 384 | `emptyArchive` |
| type-login.webp | type_login | 9103 | 256 | `typeArt.login` |
| type-passkey.webp | type_passkey | 9103 | 256 | `typeArt.passkey` |
| type-bank-account.webp | type_bank | 9207 | 256 | `typeArt.bank_account` |
| type-card.webp | type_card | 9207 | 256 | `typeArt.card` |
| type-identity.webp | type_identity | 9207 | 256 | `typeArt.identity` |
| type-ssh-key.webp | type_ssh | 9103 | 256 | `typeArt.ssh_key` |
| type-api-key.webp | type_api | 9103 | 256 | `typeArt.api_key` |
| type-secure-note.webp | type_note | 9207 | 256 | `typeArt.secure_note` |
| type-document.webp | type_document | 9103 | 256 | `typeArt.document` |
| type-media.webp | type_media | 9207 | 256 | `typeArt.media` |
| type-collection.webp | type_collection | 9103 | 256 | `typeArt.collection` |
| type-custom.webp | type_custom | 9103 | 256 | `typeArt.custom` |

## Motion (`motion/`, animated WebP 256px, 49 frames, 24 fps, loop; `*-still.webp` = frame 1)

Under `prefers-reduced-motion: reduce` the still is shown instead (`components/Art.tsx`).

| File | Clip id | Start image | Seed | Slot |
|---|---|---|---|---|
| success.webp / success-still.webp | success_confetti | onb_done | 5501 | `success` |
| working.webp / working-still.webp | loader_key_bounce | type_login | 5501 | `working` |
| sleepy-star.webp / sleepy-star-still.webp | empty_sleepy_star | empty_favorites | 5501 | `emptyFavorites` |
| error.webp / error-still.webp | error_wobble | state_error | 5501 | `error` |

Not shipped (available in the drop): `feature_*`, other `state_*`/`empty_*`, `splash_tall` /
`splash_wide`, motion `unlock_safe_open`, `splash_wave`, `sync_heart_pulse`,
`offline_cloud_float`. Brand mark: not delivered yet (`brandMark` slot is empty).
