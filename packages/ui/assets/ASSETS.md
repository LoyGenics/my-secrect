# Asset provenance

Every raster shipped from `packages/ui/assets/`. Wiring: `src/illustrations.ts`
(web) and `src/native/illustrations.ts` (React Native). Licences of the tools
and libraries: `THIRD_PARTY_NOTICES.md` (repo root).

## Pipeline

| Step | Tool | Licence |
|---|---|---|
| Illustrations | Qwen-Image (`qwen_image_fp8_e4m3fn.safetensors`), ComfyUI on Google Colab | Apache-2.0 |
| Upscale | Real-ESRGAN x4plus | BSD-3-Clause |
| Cutouts (transparent) | BiRefNet (first batch), flat-colour keying for the mascot (`mascot/pipeline/keyout.py`) | MIT / own code |
| Mascot expressions | Qwen-Image-Edit 2511 (`qwen_image_edit_2511_fp8mixed`, `qwen_2.5_vl_7b_fp8_scaled`, `qwen_image_vae`), ComfyUI on Colab A100, the ghost master as reference image | Apache-2.0 |
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

## Illustrations (`illustrations/`, transparent cutouts, WebP) — only the item-type art (`type-*`) is still used; states and empties now use the mascot, see the slot table at the end

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

## Brand (`brand/`, app icons)

| File | Source | Seed | Use |
|---|---|---|---|
| brand/ghost-mark.webp (256) | logo concept `07_ghost_key` (`hd/07_ghost_key_s8209_00001.webp`) | 8209 | Archived square-tile concept (not used as an in-app logo); also the source of the favicons (`apps/{desktop,web}/public/favicon.png`), the Tauri icons (`apps/desktop/src-tauri/icons/`) and the mobile icon, adaptive foreground and splash (`apps/mobile/assets/`, from the `cutouts_hd` transparent version) |

Prompt: "A tiny friendly white ghost holding a small orange key. Mobile app icon design, soft 3D
clay toy style … solid pastel lavender background"; chosen by the user from 20 concepts × 2 seeds.
Same pipeline as above (Qwen-Image, Real-ESRGAN, BiRefNet for the cutout); the desktop icons have
rounded corners applied here, iOS and Android mask the square themselves.

## Motion, first batch (removed 2026-11-18, replaced by `ghost-*` loops below)

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

## Mascot (`mascot/`, `motion/ghost-*`, `brand/ghost*.svg`)

The ghost holding the orange key (concept `07_ghost_key`, seed 8209, cutout trimmed to
`brand/source/ghost-key-cutout.webp`) is the app mascot. Slots: `mascot`, `mascotMotion`,
`mascotVector` in `src/illustrations.ts` (web), `mascot` in `src/native/illustrations.ts` (static only).
Wired 2026-11-18 (user approved the proposed mapping); the old per-state illustrations and the old success/working/sleepy-star/error clips were removed (still in git history).

### Expressions (`mascot/ghost-<id>.webp`, transparent, 384px, one common crop so the ghost keeps its size)

Method: Qwen-Image-Edit, the ghost master (1024px, flat mint background `#cfeee2`) as the only reference,
25 steps, cfg 4, euler/simple, seeds 1101 and 2202 per id (both reviewed, one kept). Prompt =
"Keep exactly the same white soft-clay ghost character, the same orange clay key, the same matte soft 3D clay toy
style, the same lighting, the same flat plain mint background and the same camera framing and size. Change only the
expression and pose: <description>. The ghost has simple oval dark eyes and a tiny mouth, no other face details.
No text, no letters, no numbers, no symbols." Descriptions and negative prompt: `mascot/pipeline/colab-expressions.py`.
Rejected for cutout artefacts, not for the picture: BiRefNet left grey blobs on 7 of 28, so the mint is keyed out
instead (the `empty` box keeps the BiRefNet cutout because of its floor shadow).

| File | Seed | Meaning |
|---|---|---|
| ghost-neutral | 1101 | default, calm smile |
| ghost-happy | 1101 | delighted |
| ghost-wave | 2202 | greeting, onboarding welcome |
| ghost-sleepy | 2202 | idle, nothing here yet |
| ghost-surprised | 2202 | unexpected prompt, new device |
| ghost-sad | 2202 | failed, lost |
| ghost-proud | 1101 | done well, backup complete |
| ghost-searching | 1101 | looking, no search results |
| ghost-working | 1101 | busy, determined |
| ghost-success | 1101 | celebrate (key raised, confetti) |
| ghost-error | 1101 | worried, something went wrong |
| ghost-thinking | 1101 | choosing, passphrase hint |
| ghost-empty | 2202 | peeks into an empty box |
| ghost-guard | 1101 | protecting the key, security |

### Loops (`motion/ghost-<id>.webp` + `-still.webp`, 256px, 12 fps, 48 frames, loop)

Wan 2.2 TI2V-5B image-to-video from the edited expression (704px, 49 frames, 30 steps, cfg 5, uni_pc, shift 8),
then keyed on the mint, temporal median on the alpha (removes one-frame glitches), cropped to the clip's own
box, every second frame, and played forward then backward so the loop has no seam. The still is frame 1,
shown under `prefers-reduced-motion` (`components/Art.tsx`). Prompts: `mascot/pipeline/colab-motion.py`.

| File | Start image | Seed | Use |
|---|---|---|---|
| ghost-hello | wave | 6602 | greeting |
| ghost-sleepy | original (surprised face) | 5501 | idle, empty favourites |
| ghost-joy | happy | 5501 | success |
| ghost-loading | neutral (prompt "loader") | 6602 | loading, unlock / KDF wait |
| ghost-idle | neutral | 6602 | ambient blink |

Discarded: first `joy` (the key flew out of its hands), first `loading` (almost still), `idle` seed 5501 (face turned into a yawn).

### Vectors (`brand/ghost.svg`, `ghost-mono.svg`, `ghost-favicon.svg`)

Drawn by hand (ComfyUI cannot produce true vectors of a clay render): `ghost.svg` flat colour for print/large,
`ghost-mono.svg` one colour (`currentColor`, knock-outs for eyes, mouth and key), `ghost-favicon.svg` bold tile for 16-64 px.

### App icons (`brand/build-icons.sh`, run from anywhere; needs ImageMagick 7, rsvg-convert, iconutil)

One script rebuilds every platform file from `brand/source/ghost-key-cutout.webp` + `ghost-favicon.svg`
(sizes 16-64 use the flat vector, larger sizes the 3D render):

| Platform | Files |
|---|---|
| Web (`apps/{desktop,web}/public`) | `favicon.svg`, `favicon.ico` (16/32/48), `favicon.png` 128, `apple-touch-icon.png` 180 (opaque), `icon-192/512.png`, `icon-maskable-512.png` (ghost inside the 80% safe zone) |
| macOS / Windows / Linux (Tauri) | `icon.icns` (Big Sur grid: 824px tile, drop shadow, 16-1024 incl. @2x), `icon.ico` (16/24/32/48/64/128/256), `32x32`, `128x128`, `128x128@2x`, `icon.png` 512 |
| iOS / Android (Expo) | `icon.png` 1024 opaque (iOS rounds it), `adaptive-foreground.png` (ghost inside the 66% safe circle), `adaptive-monochrome.png` (Android 13 themed icon), adaptive background `#E9E2FB` |
| Extension | `icon16/32/48/128.png` |
Not covered yet: iOS 18 dark/tinted icon variants and Android legacy mipmap sizes (Expo prebuild derives them).

### Slot mapping (web `illustrations`, native uses the static versions)

| Slot | Mascot | Where it shows |
|---|---|---|
| splash | sleepy | lock screen (vault is asleep) |
| deviceHero, emptyVault | wave | onboarding welcome, "No items yet" |
| passphrase | thinking | choose a passphrase |
| recoveryKey, restore, selectItem, emptyArchive | neutral | recovery key step, restore backup, nothing selected, archive |
| success | joy (loop) | vault ready |
| working | loading (loop) | vault creation / unlock wait |
| onboardingDone, restored | proud | done, backup restored |
| healthClear / healthWarning | happy / surprised | watchtower |
| error, errorStatic | error | failures |
| offline | sad | offline |
| notFound, noResults | searching | not found, no search results |
| emptyTrash | empty | trash empty |
| emptyFavorites (loop) / emptyFavoritesStatic | sleepy | no favourites |
Unused for now: `guard`, `working`, `thinking` elsewhere, `hello`/`idle` loops — kept in `mascot` / `mascotMotion` for new screens. `guard` and `working` frown, so avoid them on friendly screens (recovery key looked angry with `guard`).

### In-app logo transparency

Desktop/web `brandMark`, the mobile `GhostBrandMark` and the landing wordmark use
`brand/source/ghost-key-cutout.webp`, the existing RGBA cutout. They render with
contain sizing and no square tile or corner mask. Launcher icon assets remain
separate from the in-app logo.
