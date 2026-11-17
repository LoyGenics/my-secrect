# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: a11y.spec.ts >> main screens: dark @ 1280px
- Location: tests/a11y-web/a11y.spec.ts:34:5

# Error details

```
Error: dark@1280 empty vault: serious/critical axe violations

expect(received).toEqual(expected) // deep equality

- Expected  - 1
+ Received  + 3

- Array []
+ Array [
+   "label-content-name-mismatch (1)",
+ ]
```

# Page snapshot

```yaml
- generic [ref=e3]:
  - alert [ref=e4]:
    - paragraph [ref=e5]: Web client — separate attack surface. Web is limited — use Desktop for sensitive data.
    - group [ref=e7]:
      - generic "Why is the web client limited?" [ref=e8] [cursor=pointer]
  - generic [ref=e10]:
    - link "Skip to content" [ref=e11] [cursor=pointer]:
      - /url: "#ms-main"
    - navigation "Vault navigation" [ref=e12]:
      - generic [ref=e15]:
        - generic [ref=e16]: My Secret
        - generic [ref=e17]: Local vault · this device only
      - generic [ref=e18]:
        - group "Vaults" [ref=e19]:
          - button "All Items" [ref=e21] [cursor=pointer]
          - button "Favorites" [ref=e27] [cursor=pointer]
          - button "Archived" [ref=e32] [cursor=pointer]
          - button "Trash" [ref=e38] [cursor=pointer]
        - group "Categories" [ref=e44]:
          - button "Credentials" [ref=e46] [cursor=pointer]
          - button "Finance" [ref=e55] [cursor=pointer]
          - button "Identity" [ref=e63] [cursor=pointer]
          - button "Developer" [ref=e73] [cursor=pointer]
          - button "Secure Notes" [ref=e82] [cursor=pointer]
          - button "Private Media" [ref=e91] [cursor=pointer]
          - button "Documents" [ref=e101] [cursor=pointer]
          - button "Collections" [ref=e110] [cursor=pointer]
        - group "Tools" [ref=e118]:
          - button "Watchtower" [ref=e120] [cursor=pointer]
          - button "Generator" [ref=e125] [cursor=pointer]
        - group "Library" [ref=e131]:
          - button "Media gallery" [ref=e133] [cursor=pointer]
          - button "Sharing" [ref=e141] [cursor=pointer]
        - group "App" [ref=e150]:
          - button "Settings" [ref=e152] [cursor=pointer]
          - button "Security Center" [ref=e158] [cursor=pointer]
          - button "Export encrypted backup" [ref=e170] [cursor=pointer]
          - button "Import encrypted backup" [ref=e176] [cursor=pointer]
          - button "Recovery key" [ref=e182] [cursor=pointer]
      - button "Lock vault" [ref=e193] [cursor=pointer]
    - main [ref=e198]:
      - generic [ref=e199]:
        - heading "All Items" [level=1] [ref=e200]
        - generic [ref=e202]:
          - searchbox "Search items" [ref=e203]
          - button "Search vault" [ref=e204] [cursor=pointer]:
            - generic [ref=e205]: ⌘K
        - button "+ New item" [ref=e207] [cursor=pointer]
      - generic [ref=e209]:
        - region "All Items" [ref=e210]:
          - generic [ref=e211]:
            - button "Select" [ref=e212] [cursor=pointer]
            - combobox "Sort items" [ref=e217] [cursor=pointer]:
              - option "Recently updated" [selected]
              - option "Newest first"
              - option "Title A–Z"
          - generic [ref=e218]:
            - heading "No items yet" [level=2] [ref=e219]
            - paragraph [ref=e220]: No items in this view yet. Press Cmd/Ctrl+N to add one.
            - button "Load example data" [ref=e222] [cursor=pointer]
            - paragraph [ref=e224]: Example data is clearly labelled EXAMPLE DATA — every value is fake.
        - region "Nothing selected" [ref=e225]:
          - generic [ref=e226]:
            - heading "Nothing selected" [level=2] [ref=e227]
            - paragraph [ref=e228]: Select an item to view it, or create a new one.
            - button "Load example data" [ref=e230] [cursor=pointer]
            - paragraph [ref=e232]: Cmd/Ctrl+K to search · Cmd/Ctrl+N for a new itemLoads 12 fake items, one per type — clearly labelled EXAMPLE DATA.
  - contentinfo [ref=e233]: my-secrect web — local-first, encrypted on this device. Not audited, not production-ready. For sensitive data, use the desktop app.
```

# Test source

```ts
  1  | /**
  2  |  * axe-core scan of the main screens of the built web app, in both finishes
  3  |  * (graphite / aluminium) at desktop (1280) and phone (390) widths.
  4  |  * Fails on any serious or critical violation (WCAG 2.0/2.1/2.2 A + AA rules);
  5  |  * moderate/minor findings are printed for review.
  6  |  */
  7  | import { test, expect, type Page } from '@playwright/test';
  8  | import AxeBuilder from '@axe-core/playwright';
  9  | 
  10 | const PASS = 'correct horse battery staple 42!';
  11 | const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
  12 | 
  13 | async function scan(page: Page, label: string) {
  14 |   const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  15 |   const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  16 |   for (const v of results.violations) {
  17 |     console.log(`[${label}] ${v.impact} ${v.id}: ${v.help} (${v.nodes.length} node${v.nodes.length === 1 ? '' : 's'})`);
  18 |     if (v.impact === 'serious' || v.impact === 'critical') {
  19 |       for (const n of v.nodes.slice(0, 5)) console.log(`    ${n.target.join(' ')} — ${n.failureSummary?.split('\n').slice(1).join(' ')}`);
  20 |     }
  21 |   }
  22 |   console.log(`[${label}] passes: ${results.passes.length}, violations: ${results.violations.length}, serious/critical: ${blocking.length}`);
> 23 |   expect(blocking.map((v) => `${v.id} (${v.nodes.length})`), `${label}: serious/critical axe violations`).toEqual([]);
     |                                                                                                           ^ Error: dark@1280 empty vault: serious/critical axe violations
  24 | }
  25 | 
  26 | async function nav(page: Page, railName: RegExp, tabName: string) {
  27 |   const rail = page.getByRole('navigation', { name: 'Vault navigation' }).getByRole('button', { name: railName }).first();
  28 |   if (await rail.isVisible().catch(() => false)) return rail.click();
  29 |   return page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: tabName }).click();
  30 | }
  31 | 
  32 | for (const theme of ['dark', 'light'] as const) {
  33 |   for (const width of [1280, 390]) {
  34 |     test(`main screens: ${theme} @ ${width}px`, async ({ page }) => {
  35 |       await page.setViewportSize({ width, height: width > 600 ? 800 : 844 });
  36 |       await page.emulateMedia({ reducedMotion: 'reduce' });
  37 |       await page.addInitScript((t) => localStorage.setItem('my-secrect:theme', t), theme);
  38 |       const tag = `${theme}@${width}`;
  39 | 
  40 |       await page.goto('/');
  41 |       await page.getByLabel('Master passphrase', { exact: true }).waitFor();
  42 |       await scan(page, `${tag} onboarding`);
  43 | 
  44 |       await page.getByLabel('Master passphrase', { exact: true }).fill(PASS);
  45 |       await page.getByLabel('Confirm passphrase').fill(PASS);
  46 |       await page.getByRole('button', { name: 'Create vault' }).click();
  47 |       await page.getByLabel('I have saved my recovery key somewhere safe.').waitFor({ timeout: 60_000 });
  48 |       await scan(page, `${tag} recovery key`);
  49 |       await page.getByLabel('I have saved my recovery key somewhere safe.').check();
  50 |       await page.getByRole('button', { name: 'Done', exact: true }).click();
  51 |       await page.getByRole('button', { name: 'Open vault' }).click();
  52 | 
  53 |       await page.getByRole('button', { name: 'Load example data' }).first().waitFor();
  54 |       await scan(page, `${tag} empty vault`);
  55 |       await page.getByRole('button', { name: 'Load example data' }).first().click();
  56 |       await page.getByText('Example Website').first().waitFor();
  57 |       await scan(page, `${tag} vault list`);
  58 | 
  59 |       await page.getByText('Example Website').first().click();
  60 |       await page.getByRole('heading', { name: 'Example Website', level: 2 }).waitFor();
  61 |       await scan(page, `${tag} item detail`);
  62 | 
  63 |       await page.getByRole('button', { name: '+ New item' }).click();
  64 |       await page.getByRole('heading', { name: 'New item' }).waitFor();
  65 |       await scan(page, `${tag} item form`);
  66 | 
  67 |       await nav(page, /Watchtower/, 'Watchtower');
  68 |       await page.getByRole('meter').first().waitFor();
  69 |       await scan(page, `${tag} watchtower`);
  70 | 
  71 |       await nav(page, /^Generator$/, 'Generator');
  72 |       await page.getByRole('heading', { name: 'Generator', level: 2 }).waitFor();
  73 |       await scan(page, `${tag} generator`);
  74 | 
  75 |       await nav(page, /^Settings$/, 'Settings');
  76 |       await page.getByRole('heading', { name: 'Settings', level: 2 }).waitFor();
  77 |       await scan(page, `${tag} settings`);
  78 | 
  79 |       await nav(page, /All Items/, 'Vault');
  80 |       await page.keyboard.press('Control+k');
  81 |       await page.getByRole('dialog').waitFor();
  82 |       await scan(page, `${tag} search palette`);
  83 |       await page.keyboard.press('Escape');
  84 | 
  85 |       await page.getByRole('button', { name: /Lock vault/ }).filter({ visible: true }).first().click();
  86 |       await page.getByText('Your vault is locked').waitFor();
  87 |       await scan(page, `${tag} lock screen`);
  88 |     });
  89 |   }
  90 | }
  91 | 
```