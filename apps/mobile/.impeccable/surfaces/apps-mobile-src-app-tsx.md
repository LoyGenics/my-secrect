---
version: 1
slug: "apps-mobile-src-app-tsx"
primary_target: "apps/mobile/src/App.tsx"
related_targets: ["apps/mobile/src/screens/VaultScreen.tsx","apps/mobile/src/screens/SearchScreen.tsx"]
---

# Mobile redesign

Mode: Operate. Scope: every screen in apps/mobile/src/screens and the navigation shell.
The user rejected the existing mobile UI, explicitly requested a type dropdown and a
single global search, and delegated the reference choice. Chosen reference: 1Password
for iOS; retain the transparent ghost and orange identity. English remains the default.

## Direction contract

THESIS: A personal vault opens on its contents. Category selection stays in a native
menu, search is reachable globally, and secondary tools live in contextual navigation.
OWN-WORLD: Native iOS system typography, warm neutral grouped backgrounds, white or
charcoal list surfaces, one orange action tint, 12px grouped corners and 44pt controls.
STORY: Unlock, find an item, inspect or copy, then return without losing location.
Account security and vault unlock remain distinct. Existing cryptography is preserved.
FIRST VIEWPORT: Native title and add/search actions, one compact category selector,
item count and useful content rows. No wall of type chips or extra utility buttons.
FORM: User-authorized category convention, 1Password/iOS. Concept seed 3c94e037 is
superseded on topology by the user's explicit dropdown/global-search requirements.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

Verification: a dedicated simulator with synthetic sample vault data; inventory every
screen and reachable substate, phone/tablet, light/dark, large Dynamic Type. Never use
or capture the user's real vault contents. Build/install the final version on the
previously authorized iPhone after simulator checks.
