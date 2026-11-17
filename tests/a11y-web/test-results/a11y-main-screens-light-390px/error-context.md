# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: a11y.spec.ts >> main screens: light @ 390px
- Location: tests/a11y-web/a11y.spec.ts:34:5

# Error details

```
Test timeout of 180000ms exceeded.
```

```
Error: locator.click: Test timeout of 180000ms exceeded.
Call log:
  - waiting for getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Watchtower' })

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
    - main [ref=e12]:
      - generic [ref=e13]:
        - button "Open navigation" [ref=e14] [cursor=pointer]
        - heading "All Items" [level=1] [ref=e16]
        - generic [ref=e17]:
          - button "+ New item" [active] [ref=e18] [cursor=pointer]
          - button "Lock vault" [ref=e19] [cursor=pointer]
      - status [ref=e24]:
        - generic [ref=e26]: Example data loaded — 12 fake items, one per type. All values are fake; delete them with “Clear example data”.
        - button "Dismiss" [ref=e28] [cursor=pointer]
      - region "New item" [ref=e34]:
        - button "Back to list" [ref=e35] [cursor=pointer]
        - form "New item" [ref=e38]:
          - heading "New item" [level=2] [ref=e41]
          - region "New item" [ref=e42]:
            - generic [ref=e43]:
              - generic [ref=e44]:
                - generic [ref=e45]: Type
                - combobox "Item type" [ref=e46] [cursor=pointer]:
                  - option "Login" [selected]
                  - option "Passkey"
                  - option "Bank account"
                  - option "Card"
                  - option "Identity"
                  - option "SSH key"
                  - option "API key"
                  - option "Secure note"
                  - option "Document"
                  - option "Media"
                  - option "Collection"
                  - option "Custom"
              - generic [ref=e47]:
                - generic [ref=e48]: Title
                - textbox "Title" [ref=e49]:
                  - /placeholder: e.g. Example Mail
            - generic [ref=e50]:
              - generic [ref=e51]: Tags (comma-separated)
              - textbox "Tags, comma-separated" [ref=e52]:
                - /placeholder: personal, finance
            - generic [ref=e53] [cursor=pointer]:
              - checkbox "Favorite" [ref=e54]
              - generic [ref=e55]: Favorite
            - separator [ref=e56]
            - generic [ref=e57]:
              - generic [ref=e58]: Username
              - textbox "Username" [ref=e59]
            - generic [ref=e60]:
              - generic [ref=e61]: Password
              - generic [ref=e62]:
                - textbox "Password" [ref=e63]
                - button "Show" [ref=e64] [cursor=pointer]
                - button "Generate…" [ref=e68] [cursor=pointer]
            - generic [ref=e72]:
              - generic [ref=e73]: URL
              - textbox "URL" [ref=e74]:
                - /placeholder: https://…
            - generic [ref=e75]:
              - generic [ref=e76]: TOTP secret (Base32)
              - textbox "TOTP secret (Base32)" [ref=e77]:
                - /placeholder: e.g. JBSWY3DPEHPK3PXP
            - generic [ref=e78]:
              - generic [ref=e79]: Notes
              - textbox "Notes" [ref=e80]
            - group "Relations" [ref=e81]:
              - generic [ref=e83]:
                - generic [ref=e84] [cursor=pointer]:
                  - checkbox "Relate to Example Website" [ref=e85]
                  - generic [ref=e86]: Example Website Login
                - generic [ref=e88] [cursor=pointer]:
                  - checkbox "Relate to Example Passkey" [ref=e89]
                  - generic [ref=e90]: Example Passkey Passkey
                - generic [ref=e92] [cursor=pointer]:
                  - checkbox "Relate to Example Bank" [ref=e93]
                  - generic [ref=e94]: Example Bank Bank account
                - generic [ref=e96] [cursor=pointer]:
                  - checkbox "Relate to Example Visa" [ref=e97]
                  - generic [ref=e98]: Example Visa Card
                - generic [ref=e100] [cursor=pointer]:
                  - checkbox "Relate to Example Passport" [ref=e101]
                  - generic [ref=e102]: Example Passport Identity
                - generic [ref=e104] [cursor=pointer]:
                  - checkbox "Relate to Example SSH Key" [ref=e105]
                  - generic [ref=e106]: Example SSH Key SSH key
                - generic [ref=e108] [cursor=pointer]:
                  - checkbox "Relate to Example Service API" [ref=e109]
                  - generic [ref=e110]: Example Service API API key
                - generic [ref=e112] [cursor=pointer]:
                  - checkbox "Relate to Example Secure Note" [ref=e113]
                  - generic [ref=e114]: Example Secure Note Secure note
                - generic [ref=e116] [cursor=pointer]:
                  - checkbox "Relate to Example Contract.pdf" [ref=e117]
                  - generic [ref=e118]: Example Contract.pdf Document
                - generic [ref=e120] [cursor=pointer]:
                  - checkbox "Relate to Example Photo.jpg" [ref=e121]
                  - generic [ref=e122]: Example Photo.jpg Media
                - generic [ref=e124] [cursor=pointer]:
                  - checkbox "Relate to Example Project" [ref=e125]
                  - generic [ref=e126]: Example Project Collection
                - generic [ref=e128] [cursor=pointer]:
                  - checkbox "Relate to Example Custom Record" [ref=e129]
                  - generic [ref=e130]: Example Custom Record Custom
          - generic [ref=e132]:
            - button "Save" [ref=e133] [cursor=pointer]
            - button "Cancel" [ref=e136] [cursor=pointer]
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
  23 |   expect(blocking.map((v) => `${v.id} (${v.nodes.length})`), `${label}: serious/critical axe violations`).toEqual([]);
  24 | }
  25 | 
  26 | async function nav(page: Page, railName: RegExp, tabName: string) {
  27 |   const rail = page.getByRole('navigation', { name: 'Vault navigation' }).getByRole('button', { name: railName }).first();
  28 |   if (await rail.isVisible().catch(() => false)) return rail.click();
> 29 |   return page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: tabName }).click();
     |                                                                                                ^ Error: locator.click: Test timeout of 180000ms exceeded.
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