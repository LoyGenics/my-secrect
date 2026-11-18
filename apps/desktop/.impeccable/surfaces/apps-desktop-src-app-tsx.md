---
version: 1
slug: "apps-desktop-src-app-tsx"
primary_target: "apps/desktop/src/App.tsx"
related_targets: ["apps/web/src/App.tsx","apps/mobile/src/App.tsx"]
---

# Surface brief — My Secret app (web/desktop shell; mobile and extension inherit the world)

Scope: the whole vault app — lock/unlock, onboarding, item list + detail, Watchtower, generator, Settings, Security Center, media, sharing — on web/desktop (apps/desktop, apps/web) first; mobile (apps/mobile) and the extension popup inherit the same world with native navigation.
Visitor mode: Operate. Daily task: unlock, find, copy or fill in seconds. Rare tasks: onboarding with one-time recovery key, restore, account security.
Constraints: PRODUCT.md (Lucide icons, 3D pictures on onboarding/empty/success and item tiles, honest security copy, VN + EN, WCAG 2.2 AA, 360px → wide desktop). System fonts only (CSP, privacy, nothing to load).

## Direction contract

THESIS: The vault is a calm, friendly place for everything private — soft and light, not a hardware panel and not a web dashboard. It refuses the category default of navy sidebar + blue accent + shield icons, the cold industrial "IT tool" look, and neon-on-black AI looks. Approved mockup: docs/mockups/ui-soft-v1.html (boards 1 and 4 apply to this surface).

OWN-WORLD: Light by default (body #F6F4F1, cards #FFFFFF, sidebar and fields #FAF9F7, hairline #EBE8E3, ink #1E2227 / #5F656C), with a "soft dark" in the same spirit (warm charcoal #17191C body, #212429 cards, hairlines instead of shadows, muted pastel tiles) chosen under Appearance; no flash of the wrong theme on load (public/theme-init.js). One orange #FF6A2B for the primary action only (labels on it are ink, not white, for contrast); status colours green #2FA66A, amber #E3A12F, red #E5484D appear as small dots and tinted notices, never as the only signal. Each item type sits on one pastel tile (sky, mint, butter, coral, lavender, tangerine) behind its 3D picture, identical in sidebar swatch, list row, detail header and phone. Cards are white, 20px radius, one gentle shadow; buttons are pills with sentence-case labels; fields are 44px soft fields with a 14px radius and an orange focus ring; segmented controls are pill tracks with a raised white segment; switches are orange when on. Radii 10 / 14 / 20 / 28, two shadow levels, motion 0.2s on one ease-out curve (reduced-motion = crossfade). Type: the platform's rounded system face (ui-rounded, SF Pro Rounded, system-ui) at a strict five-step scale, sentence case everywhere — no UPPERCASE tracked labels, no LEDs, no metal edges; tabular numerals where numbers align. Lucide icons inside a single Icon wrapper.

STORY: The visitor sees a friendly, trustworthy home for their private things, understands that unlocking happens on this device with their passphrase (separate from account sign-in), finds an item by its colourful tile or by search, and copies it — with a visible "Copied" confirmation that says when the clipboard clears only where the app really clears it (web/desktop; not mobile).

FIRST VIEWPORT: Locked state is a white lock card centred on a warm gradient: wordmark "My Secret", one soft passphrase field, a full-width orange "Unlock" pill beneath it, a small link "Use recovery key", a 3D picture beside it on wide screens. Unlocked on desktop (≥1024px): three columns — sidebar (brand mark, categories as coloured swatches with counts, tools, a "Lock vault" pill at the bottom), list (title and "+ New item" pill, pill search with ⌘K, rows with pastel tiles; the selected row tinted in soft orange), detail (large tile, title, pill buttons Edit / Favorite / Archive / Delete — the row has room for a future Share button —, a one-time-code card with a countdown ring, a card of field rows ending in reveal and copy buttons). Tablet (768px): sidebar collapses to icons, list and detail stay. Phone (≤480px): bottom tab bar (Vault, Search, Generator, Watchtower, Settings), full-screen list, detail pushed as its own screen with a thumb-reach bar at the bottom; nothing sits under the status bar; no horizontal scroll anywhere. Onboarding, empty states and success screens carry one 3D object set beside the lock card; item tiles carry the type pictures in lists and detail headers.

FORM: Soft light consumer app — warm neutrals, pastel tiles, big radii, quiet shadows, one orange. Kept from earlier rounds: colour discipline (colour only as signal), strict five-step type scale, one complete item state with actions in thumb reach on phones, every control state visible — rest, hover, pressed, focus, disabled. Signature interaction: unlock — the status dot settles green and the lock card fades up and away (≈320 ms; reduced-motion crossfade). Copy feedback: a green "Copied" chip beside the value, with "clears in N s" on web/desktop where the clipboard is really cleared.

FINISH: reviewed against the mockup at 1280, 768 and 390 px in light and dark; every shipping raster carries its provenance (packages/ui/assets/ASSETS.md).
