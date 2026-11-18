# apps/landing

Marketing site for My Secret: landing, pricing, security, privacy, terms, support. English and
Vietnamese (`/en/…`, `/vi/…`). Static output, no cookies, no analytics. Research and pricing
decisions: `docs/landing-pricing.md`.

```bash
npm --workspace apps/landing run dev          # http://localhost:5180
npm --workspace apps/landing run build        # tsc, vite build, then one HTML file per route in dist/
npm --workspace apps/landing run check:placeholders [-- --strict]
```

- Copy: `src/content/en.ts` and `vi.ts` (same shape, `vi` is typed against `en`).
- Edit before publishing: `src/site.config.ts` (company, emails, retention days, prices, competitor facts).
  Empty values render as highlighted `[TOKEN]`s on the page.
- Look: `src/styles/tokens.css` (all colours and fonts), `site.css`. White text on the orange button is
  deliberate; the fill is `#D23F0C` (4.7:1), not the lighter brand orange.
- Art: the shared clay set in `packages/ui/assets/illustrations` (provenance in `ASSETS.md`).
- Deploy: serve `dist/` from any static host. `404.html` is the SPA fallback; the root redirects to the
  visitor's language.
