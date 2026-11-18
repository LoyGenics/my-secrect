#!/usr/bin/env bash
# Rebuilds every app icon from the ghost master so no platform shows a stretched or blurry mark.
#
#   packages/ui/assets/brand/build-icons.sh          (run from anywhere)
#
# Inputs : brand/source/ghost-key-cutout.webp (3D master, transparent) and brand/ghost-favicon.svg
#          (flat vector, bolder at 16-64 px where the 3D render turns to mush).
# Needs  : ImageMagick 7 (`magick`), `rsvg-convert`, and `iconutil` (macOS) for the .icns.
# Output : web favicons + apple-touch + maskable, Tauri (macOS .icns, Windows .ico, Linux png),
#          Expo (iOS icon, Android adaptive + monochrome), browser-extension icons.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
B="$ROOT/packages/ui/assets/brand"
SRC="$B/source/ghost-key-cutout.webp"
FAV="$B/ghost-favicon.svg"
BG='#E9E2FB'   # tile colour; also the Android adaptive background (apps/mobile/app.json)
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# ghost SIZE FILL SHADOW OUT — transparent SIZExSIZE canvas, ghost fitted to FILL% of it.
ghost() {
  local size=$1 fill=$2 shadow=$3 out=$4 box=$(( $1 * $2 / 100 ))
  if [ "$shadow" = shadow ]; then
    magick "$SRC" -trim +repage -resize "${box}x${box}" \
      \( +clone -background '#6f58b0' -shadow "28x$(( size / 70 ))+0+$(( size / 50 ))" \) +swap \
      -background none -layers merge +repage -gravity center -extent "${size}x${size}" "$out"
  else
    magick "$SRC" -trim +repage -resize "${box}x${box}" -background none -gravity center -extent "${size}x${size}" "$out"
  fi
}
# tile SIZE FILL OUT — opaque full-bleed square: BG + ghost.
tile() { ghost "$1" "$2" shadow "$TMP/g.png"; magick -size "$1x$1" "xc:$BG" "$TMP/g.png" -composite -alpha off "$3"; }
# round SIZE FILL RADIUS% OUT — the same tile with rounded corners (transparent outside).
round() {
  local s=$1 r=$(( $1 * $3 / 100 ))
  tile "$s" "$2" "$TMP/t.png"
  magick -size "${s}x${s}" xc:none -fill white -draw "roundrectangle 0,0 $((s-1)),$((s-1)) $r,$r" "$TMP/m.png"
  magick "$TMP/t.png" "$TMP/m.png" -alpha off -compose CopyOpacity -composite "$4"
}
# flat SIZE OUT — the vector tile rasterised for tiny sizes.
flat() { rsvg-convert -w "$1" -h "$1" "$FAV" -o "$2"; }

# ---- web (desktop shell + web mirror share the same files) --------------------------------
for app in desktop web; do
  P="$ROOT/apps/$app/public"
  cp "$FAV" "$P/favicon.svg"
  round 128 66 22 "$P/favicon.png"
  for s in 16 32 48; do flat $s "$TMP/f$s.png"; done
  magick "$TMP/f16.png" "$TMP/f32.png" "$TMP/f48.png" "$P/favicon.ico"
  tile 180 66 "$P/apple-touch-icon.png"                    # iOS home screen masks it itself
  round 192 66 22 "$P/icon-192.png"; round 512 66 22 "$P/icon-512.png"
  tile 512 54 "$P/icon-maskable-512.png"                   # Android maskable: ghost inside the 80% safe zone
done

# ---- Tauri: macOS .icns, Windows .ico, Linux/Windows png ------------------------------------
I="$ROOT/apps/desktop/src-tauri/icons"
flat 32 "$I/32x32.png"
round 128 66 22 "$I/128x128.png"; round 256 66 22 "$I/128x128@2x.png"; round 512 66 22 "$I/icon.png"
for s in 16 24 48; do flat $s "$TMP/w$s.png"; done
flat 32 "$TMP/w32.png"; round 64 66 22 "$TMP/w64.png"; round 128 66 22 "$TMP/w128.png"; round 256 66 22 "$TMP/w256.png"
magick "$TMP/w16.png" "$TMP/w24.png" "$TMP/w32.png" "$TMP/w48.png" "$TMP/w64.png" "$TMP/w128.png" "$TMP/w256.png" "$I/icon.ico"
# macOS Big Sur grid: 824 px rounded tile centred in 1024, soft drop shadow.
round 824 62 23 "$TMP/mac_tile.png"
magick "$TMP/mac_tile.png" \( +clone -background black -shadow 38x18+0+14 \) +swap -background none -layers merge +repage \
  -gravity center -extent 1024x1024 "$TMP/mac1024.png"
IS="$TMP/icon.iconset"; mkdir -p "$IS"
magick "$TMP/mac1024.png" -resize 512x512 "$IS/icon_512x512.png"; magick "$TMP/mac1024.png" -resize 256x256 "$IS/icon_256x256.png"
cp "$TMP/mac1024.png" "$IS/icon_512x512@2x.png"; magick "$TMP/mac1024.png" -resize 512x512 "$IS/icon_256x256@2x.png"
magick "$TMP/mac1024.png" -resize 256x256 "$IS/icon_128x128@2x.png"; magick "$TMP/mac1024.png" -resize 128x128 "$IS/icon_128x128.png"
flat 16 "$IS/icon_16x16.png"; flat 32 "$IS/icon_16x16@2x.png"; flat 32 "$IS/icon_32x32.png"; flat 64 "$IS/icon_32x32@2x.png"
iconutil -c icns "$IS" -o "$I/icon.icns"

# ---- Expo (iOS + Android) -------------------------------------------------------------------
M="$ROOT/apps/mobile/assets"
tile 1024 66 "$M/icon.png"                                  # opaque, no alpha: iOS rounds it
ghost 1024 52 shadow "$M/adaptive-foreground.png"           # Android adaptive: inside the 66% safe circle
ghost 1024 52 none "$TMP/mono.png"
magick "$TMP/mono.png" -fill white -colorize 100 "$M/adaptive-monochrome.png"   # Android 13 themed icons

# ---- browser extension ----------------------------------------------------------------------
E="$ROOT/apps/extension/public/icons"
flat 16 "$E/icon16.png"; flat 32 "$E/icon32.png"
round 48 66 22 "$E/icon48.png"; round 128 66 22 "$E/icon128.png"

echo "icons rebuilt from $SRC"
