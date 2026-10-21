import { expect, test } from '@playwright/test';
import { emptyResponses, sampleResponses } from './fixtures.js';
import { overflow, PAGES, serveApi } from './helpers.js';

/** The narrowest phone layout the dashboard supports (M7 acceptance). */
const PHONE = { width: 375, height: 812 };

/** Text each page shows only when the API returned data. */
const MARKERS: Record<(typeof PAGES)[number]['hash'], string> = {
  overview: 'Request rate',
  requests: 'mock-failover',
  cost: 'Budgets this month (UTC)',
  models: 'Fallbacks / request',
  reliability: 'Circuit breakers',
  security: 'By reason',
  infra: 'Unread events',
  settings: 'Deployments and routing',
};

for (const [dataset, responses] of [
  ['with data', sampleResponses('owner')],
  ['empty', emptyResponses('owner')],
] as const) {
  test.describe(`at 375 px, ${dataset}`, () => {
    test.use({ viewport: PHONE });

    for (const { hash, title } of PAGES) {
      test(`${hash} fits the screen`, async ({ page }) => {
        await serveApi(page, responses);
        await page.goto(`/#${hash}`);
        await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
        if (dataset === 'with data') {
          await expect(page.getByText(MARKERS[hash]).first()).toBeVisible();
        } else {
          await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
        }
        expect(await overflow(page)).toBeLessThanOrEqual(0);

        // Every page stays reachable: the navigation drawer lists them all, and fits too.
        await page.getByRole('button', { name: 'Open navigation' }).click();
        const drawer = page.getByRole('dialog', { name: 'Navigation' });
        await expect(drawer.getByRole('link', { name: 'Settings' })).toBeVisible();
        expect(await overflow(page)).toBeLessThanOrEqual(0);
        await page.keyboard.press('Escape');
        await expect(drawer).toBeHidden();
      });
    }

    test('the navigation drawer opens another page and closes', async ({ page }) => {
      await serveApi(page, responses);
      await page.goto('/#overview');
      await page.getByRole('button', { name: 'Open navigation' }).click();
      await page
        .getByRole('dialog', { name: 'Navigation' })
        .getByRole('link', { name: 'Cost' })
        .click();
      await expect(page.getByRole('heading', { level: 1, name: 'Cost' })).toBeVisible();
      await expect(page.getByRole('dialog', { name: 'Navigation' })).toBeHidden();
      expect(new URL(page.url()).hash).toBe('#cost');
    });

    test('the request detail with its routing history fits the screen', async ({ page }) => {
      await serveApi(page, responses);
      await page.goto('/#requests');
      if (dataset === 'empty') return;
      await page.getByText('mock-failover').first().click();
      await expect(page.getByRole('heading', { name: 'Routing history' })).toBeVisible();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });
  });
}
