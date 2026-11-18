# Landing site and pricing — research and decisions

Site: `apps/landing` (Vite + React, English and Vietnamese). Status: built, not published.
Prices below are **proposals**: the product has no billing, and `docs/store-prep.md`
still lists pricing as "decide". Every number lives in `apps/landing/src/site.config.ts`.

## What competitors charge (read from vendor pages on 18 Nov 2026)

| Product | Paid individual plan | Free plan | Lifetime | Source |
|---|---|---|---|---|
| 1Password | Individual, $3.99/month billed yearly ($47.88/year); $2.99/month first year for new direct customers | None, 14-day trial | Not on page | https://1password.com/pricing/password-manager |
| Bitwarden | Premium, $19.80/year | Yes, always free | Not on page | https://bitwarden.com/pricing/ |
| Proton Pass | Plus, $23.88 first 12 months, then $35.88/year | Yes: 2 vaults, no item sharing | Not on page | https://proton.me/pass/pricing |
| Enpass | Premium, $1.99/month billed annually (annual total not shown) | Free up to 25 items | Not on page | https://www.enpass.io/pricing/ |

Read from secondary sources only (not used in the public comparison table, prices disagree
between sources): Dashlane (about $59.88/year, free tier reported discontinued in Sept 2025),
NordPass (about $1.4–2.0/month on multi-year terms, renewal higher), Keeper (about $20–48/year,
free tier disputed). Lifetime licences seen in app stores: KeePassium Pro (about $60–80),
Strongbox Pro ($89.99). Enpass reportedly stopped selling new lifetime licences.

## What this tells us

- The market sits at roughly $20–48 a year for one person. Bitwarden is the floor.
- Free tiers are shrinking or capped (Dashlane removed its tier; Proton caps vaults; Enpass caps at 25 items).
- Introductory prices that jump at renewal (Proton, NordPass) are a common complaint.
- Lifetime is rare among the big four; it exists in smaller local-first apps at about $60–90.
- Most products are credential-centric. Few treat bank accounts, IDs, SSH/API keys, documents and
  private media as first-class.

## Proposed plans

| Plan | Price | Why |
|---|---|---|
| Free | $0 | Unlimited items, all 12 types, offline, encrypted export, sync on 2 devices, 100 MB files. A real free tier is the differentiator against 1Password/Dashlane. |
| Pro | $24/year or $2.99/month | Near Bitwarden, below 1Password and Proton's renewal. Flat renewal price. |
| Lifetime | $89 once | In line with KeePassium/Strongbox lifetime pricing; about 3.7 years of Pro. |

Risks to decide on: Lifetime customers keep costing sync and storage (5 GB included), so $89 may
be too low or the storage allowance too high. The Free limits (2 devices, 100 MB) and Pro limits
(5 GB) are not enforced by the product yet; change them in `site.config.ts` and the copy together.

## Honest comparison (shown on the pricing page)

A feature matrix (`matrix` in `apps/landing/src/site.config.ts`): My Secret against 1Password,
Bitwarden, Proton Pass and Enpass. A tick requires confirmation from the vendor's pricing page;
a cross requires an explicit exclusion. Where the page is silent the cell says "Not stated",
including lifetime plans that are not listed. Sources were rechecked on 18 Nov 2026.
My Secret's proposed Lifetime plan is marked "Partly" with an explicit "Planned" note;
its proposed storage allowance is labelled separately from existing encrypted-file support.
Secure item sharing is implemented and tested through the real UI, SDK and API. Family
supports one owner and five members with separate vaults and explicit item sharing. Emergency
access remains unavailable. The open-source comparison row was removed at the user’s request. Only facts from the four vendor pages and from this repo
(`docs/privacy.md`, `specs/*`, `PRODUCT.md`) are stated; no ratings, testimonials or customer
counts exist and none are invented.

The vendor sources remain in configuration and research notes; visible source links were
removed at the user’s request. On phones, the feature column
stays visible while the five product columns scroll horizontally inside the table. The page
heading includes a direct link to the matrix, and a legend explains the symbols.
My Secret prices and allowances in both languages, page metadata, the homepage and the
matrix are derived from the `pricing` object so configuration changes stay consistent.

## Before publishing

1. Fill the placeholders: `npm --workspace apps/landing run check:placeholders` (add `--strict` in CI).
2. Have a lawyer review Privacy and Terms (drafts from `docs/privacy.md` and common terms).
   Retention periods (`BACKUP_RETENTION_DAYS`, `SESSION_PURGE_DAYS`) are still open items there.
3. Decide prices and limits, then implement billing; until then the site says nothing is billed.
4. "Get early access" opens an email to the support address; there is no waitlist backend.
5. Re-check competitor prices; they change.

## Verification (18 Nov 2026)

- Production build and TypeScript check passed.
- Chromium smoke check: all 12 localized routes at 360, 390, 768 and 1280 px;
  no page overflow, broken loaded images or browser runtime errors.
- Matrix checks: 11 feature rows, no visible source links or open-source row, working jump link,
  keyboard horizontal scrolling, sticky row labels and reachable final column.
- Mobile menu, page navigation and language switching passed.
- Axe WCAG A/AA checks at 390 and 1280 px returned no violations on the 12 routes.
  This is an automated check, not a complete accessibility certification.
- Visually reviewed the Vietnamese matrix at phone and desktop sizes.

The legal placeholder check still reports 11 empty values, as requested for the draft.
Billing and early-access email registration are not operational until configured.
Family is free during early access; no paid Family price has been chosen.

## Redesign and integration

The Taste Skill redesign retains routes and the orange brand. It introduces a smoke-white
layout, a real Three.js hinged vault with pointer response and open/close controls,
Motion scroll parallax and an interactive twelve-type explorer. Reduced motion renders
a static scene, offscreen/hidden scenes pause, and unavailable WebGL falls back to an image.
Three.js is dynamically imported and renders only while the scene changes. There are light and dark palettes for every route.

Ghost mascot branding was merged from `feat/ghost-mascot` into local `main` at `def5a7c`.
The website wordmark/favicon use the same artwork. English is the default; explicit saved
language choices continue to work.

Validation after integration: production build; desktop/web/mobile typechecks; `npm test`;
30 Rails request specs for Family/sharing; 15 real two-user SDK/API sharing/Family tests;
two Playwright tests exercising sharing and Family through the real UI.
Axe reported no violations across 48 localized route/viewport/theme combinations.
The interactive vault was checked opening, remaining still under reduced motion, and
working alongside the type explorer. Privacy and Terms remain drafts with 11 placeholders.

The iPhone Release build includes the merged ghost mascot icon and replaces remaining
lock wordmarks on mobile and desktop sign-in. Family UI is available under Settings on
desktop/web and the Family button in the mobile vault. The new Family server endpoints
are tested locally; no hosted API deployment or website publication was performed.

The final Release build was installed on the connected iPhone 17 Pro Max using Apple
`devicectl` after Expo’s older device installer stalled. The updated bundle includes the
Ghost brand and Family refresh UI. The pre-merge stash is retained as a backup.
