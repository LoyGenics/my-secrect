/**
 * axe-core scan of the main screens of the built web app, in both finishes
 * (graphite / aluminium) at desktop (1280) and phone (390) widths.
 * Fails on any serious or critical violation (WCAG 2.0/2.1/2.2 A + AA rules);
 * moderate/minor findings are printed for review.
 */
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const PASS = 'correct horse battery staple 42!';
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function scan(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  for (const v of results.violations) {
    console.log(`[${label}] ${v.impact} ${v.id}: ${v.help} (${v.nodes.length} node${v.nodes.length === 1 ? '' : 's'})`);
    if (v.impact === 'serious' || v.impact === 'critical') {
      for (const n of v.nodes.slice(0, 5)) console.log(`    ${n.target.join(' ')} — ${n.failureSummary?.split('\n').slice(1).join(' ')}`);
    }
  }
  console.log(`[${label}] passes: ${results.passes.length}, violations: ${results.violations.length}, serious/critical: ${blocking.length}`);
  expect(blocking.map((v) => `${v.id} (${v.nodes.length})`), `${label}: serious/critical axe violations`).toEqual([]);
}

async function nav(page: Page, railName: RegExp, tabName: string) {
  const rail = page.getByRole('navigation', { name: 'Vault navigation' }).getByRole('button', { name: railName }).first();
  if (await rail.isVisible().catch(() => false)) return rail.click();
  return page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: tabName }).click();
}

for (const theme of ['dark', 'light'] as const) {
  for (const width of [1280, 390]) {
    test(`main screens: ${theme} @ ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: width > 600 ? 800 : 844 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.addInitScript((t) => localStorage.setItem('my-secrect:theme', t), theme);
      const tag = `${theme}@${width}`;

      await page.goto('/');
      await page.getByLabel('Master passphrase', { exact: true }).waitFor();
      await scan(page, `${tag} onboarding`);

      await page.getByLabel('Master passphrase', { exact: true }).fill(PASS);
      await page.getByLabel('Confirm passphrase').fill(PASS);
      await page.getByRole('button', { name: 'Create vault' }).click();
      await page.getByLabel('I have saved my recovery key somewhere safe.').waitFor({ timeout: 60_000 });
      await scan(page, `${tag} recovery key`);
      await page.getByLabel('I have saved my recovery key somewhere safe.').check();
      await page.getByRole('button', { name: 'Done', exact: true }).click();
      await page.getByRole('button', { name: 'Open vault' }).click();

      await page.getByRole('button', { name: 'Load example data' }).first().waitFor();
      await scan(page, `${tag} empty vault`);
      await page.getByRole('button', { name: 'Load example data' }).first().click();
      await page.getByText('Example Website').first().waitFor();
      await scan(page, `${tag} vault list`);

      await page.getByText('Example Website').first().click();
      await page.getByRole('heading', { name: 'Example Website', level: 2 }).waitFor();
      await scan(page, `${tag} item detail`);

      await page.getByRole('button', { name: '+ New item' }).click();
      await page.getByRole('heading', { name: 'New item' }).waitFor();
      await scan(page, `${tag} item form`);
      // Phones push the form as its own screen (tab bar hidden); Back returns to the list.
      const back = page.getByRole('button', { name: 'Back to list' });
      if (await back.isVisible().catch(() => false)) await back.click();

      await nav(page, /Watchtower/, 'Watchtower');
      await page.getByRole('meter').first().waitFor();
      await scan(page, `${tag} watchtower`);

      await nav(page, /^Generator$/, 'Generator');
      await page.getByRole('heading', { name: 'Generator', level: 2 }).waitFor();
      await scan(page, `${tag} generator`);

      await nav(page, /^Settings$/, 'Settings');
      await page.getByRole('heading', { name: 'Settings', level: 2 }).waitFor();
      await scan(page, `${tag} settings`);

      await nav(page, /All Items/, 'Vault');
      await page.keyboard.press('Control+k');
      await page.getByRole('dialog').waitFor();
      await scan(page, `${tag} search palette`);
      await page.keyboard.press('Escape');

      await page.getByRole('button', { name: /Lock vault/ }).filter({ visible: true }).first().click();
      await page.getByText('Your vault is locked').waitFor();
      await scan(page, `${tag} lock screen`);
    });
  }
}
