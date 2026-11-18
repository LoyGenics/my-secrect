# apps/landing

Marketing site for My Secret with English and Vietnamese landing, pricing, security, Black Friday,
privacy, terms and support pages. Static output, no cookies, no analytics. Research and pricing
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
- Deploy `dist/` at `https://msecret.app`. Serve directory indexes and return a genuine 404 for
  unknown paths. English home is `/`, with `/en/` as a canonicalized alias. Vietnamese home is `/vi/`.
- The build renders full HTML and writes `sitemap.xml`, `robots.txt` and `llms.txt`. Privacy and
  Terms stay out of the index while the drafts await approval. Update `isIndexable` in
  `src/entry-server.tsx` when the final text is ready. Support becomes indexable when its
  support email is configured.
- Submit `https://msecret.app/sitemap.xml` in the verified Google Search Console property. Request
  indexing for the two home pages and the localized Black Friday pages after publishing. Keep the
  Google verification file in `public/` so production deploys preserve ownership verification.
