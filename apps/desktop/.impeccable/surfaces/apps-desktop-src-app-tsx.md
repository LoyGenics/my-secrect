---
version: 1
slug: "apps-desktop-src-app-tsx"
primary_target: "apps/desktop/src/App.tsx"
related_targets: ["apps/web/src/App.tsx","apps/mobile/src/App.tsx"]
---

# Surface brief — My Secret app (web/desktop shell; mobile and extension inherit the world)

Scope: the whole vault app — lock/unlock, onboarding, item list + detail, Watchtower, generator, Settings, Security Center, media, sharing — on web/desktop (apps/desktop, apps/web) first; mobile (apps/mobile) and the extension popup inherit the same world with native navigation.
Visitor mode: Operate. Daily task: unlock, find, copy or fill in seconds. Rare tasks: onboarding with one-time recovery key, restore, account security.
Constraints: PRODUCT.md (Lucide icons, 3D only on onboarding/empty/success, honest security copy, VN + EN, WCAG 2.2 AA, 360px → wide desktop). Self-hosted fonts only (CSP, privacy).

## Direction contract

THESIS: The vault is a precisely made personal device you hold, not a web dashboard. It refuses the category default of navy sidebar + blue accent + shield icons and the cream-and-serif or neon-on-black AI looks.

OWN-WORLD: Two finishes of one object — light "anodized aluminium" (#E6E4DF body, #F2F1EE plates, #D9D7D1 recessed wells, ink #1B1C1E / #5E6064, hairline #C4C2BC) and dark "graphite" (#161718 body, #1F2022 plates, #111213 wells, ink #ECEBE7 / #9A9C9F, hairline #2E3033). Colour only as signal: one orange key #FF5B1F (primary action, focus ring), LEDs green #35B46A (ok/synced/unlocked), amber #F2A93B (attention), red #E5484D (danger). Twelve item types each own one module silhouette + muted code colour, used identically in rail, list, detail and mobile. Plates are flat machined panels with 1px hairlines and a 1px inner top highlight — no gradients, no glass, no glow. Buttons are molded keys: solid fill, 1px darker lower edge, printed UPPERCASE tracked legend; pressed removes the edge and drops 1px. Inputs are recessed wells. Toggles are physical switches, segmented controls are rocker switches, counts are small LCD-style tabular readouts. Type: native system UI stack for body and fields; one self-hosted semi-condensed industrial grotesk for printed legends and headings at a strict five-step scale; tabular numerals everywhere numbers align. Lucide icons at one stroke weight inside a single Icon wrapper. Motion is mechanical: 120–180 ms ease-out, detents, no bounce; reduced-motion = instant or crossfade.

STORY: The visitor sees an object that feels solid and private, understands that unlocking happens on this device with their passphrase (separate from account sign-in), finds an item by type module or search, and copies or fills it — with a visible LED confirming the copy and when the clipboard clears.

FIRST VIEWPORT: Locked state is the device face, centred: printed wordmark "MY SECRET", a four-segment LED strip (amber = locked), one recessed passphrase well, a full-width orange UNLOCK key directly beneath it, a small legend link "Use recovery key". Unlocked on desktop (≥1024px): fixed-height shell; left instrument rail (category modules with LCD counts, Watchtower dial readout, Lock key at the bottom); centre list of rows (type module, title, secondary line, copy key on hover/focus); right detail as a spec-sheet plate whose field rows each end in a copy key; top bar = search well with ⌘K legend, sync LED, orange "+ NEW" key. Tablet (768px): rail collapses to icon modules, list/detail split stays. Phone (≤480px): native-feeling bottom tab bar (Vault, Search, Generator, Watchtower, Settings), full-screen list, detail pushed as its own screen with a thumb-reach action rail (Copy password, Copy username, Open/Fill, More) above the home indicator; no horizontal scroll anywhere. Onboarding, empty states and success screens carry one 3D object (3dicons clay / Fluent Emoji 3D) set beside the device face, never inside lists.

FORM: Precision Instrument — industrial hardware object (Braun-era consumer hardware + hardware security keys); position 6 on the ordered grounded list; seed key ada320cc. Raises kept: colour discipline (Datamatics), strict five-step type scale (Bitmap Specimen), one complete item state with actions in thumb reach on phones (Vertical Feed), shape encodes item type (Labanotation), every control state a distinct printed mark — rest, pressed, focus, disabled (Centre-Rail), Watchtower as one instrument dial owning its panel (Catalog Sleeve). Signature interaction: unlock "key turn" — the LED strip sweeps orange then settles green and the device-face plate slides away to reveal the instrument panel (≈280 ms; reduced-motion crossfade). Copy feedback: the field's LED lights with "COPIED · CLEARS IN 30S".

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
