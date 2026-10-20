import { expect, test, type Page } from '@playwright/test';
import { emptyResponses, sampleResponses } from './fixtures.js';

/** The narrowest phone layout the dashboard supports (M7 acceptance). */
const PHONE = { width: 375, height: 812 };

const TABS = [
  ['overview', 'Request rate'],
  ['requests', 'mock-failover'],
  ['cost', 'Budgets this month (UTC)'],
  ['models', 'Fallbacks / request'],
  ['reliability', 'Circuit breakers'],
  ['security', 'By reason'],
  ['infra', 'Unread events'],
  ['settings', 'Deployments and routing'],
] as const;

async function serveApi(page: Page, responses: Record<string, unknown>) {
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '');
    const body = responses[path];
    return route.fulfill(
      body === undefined
        ? { status: 404, json: { error: { code: 'not_found', message: path } } }
        : { json: body },
    );
  });
}

/** How far the page is wider than the viewport; 0 means no sideways scrolling. */
const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

for (const [dataset, responses] of [
  ['with data', sampleResponses('owner')],
  ['empty', emptyResponses('owner')],
] as const) {
  test.describe(`at 375 px, ${dataset}`, () => {
    test.use({ viewport: PHONE });

    for (const [tab, marker] of TABS) {
      test(`${tab} fits the screen`, async ({ page }) => {
        await serveApi(page, responses);
        await page.goto(`/#${tab}`);
        await expect(page.getByRole('heading', { name: 'AI Gateway' })).toBeVisible();
        if (dataset === 'with data') await expect(page.getByText(marker).first()).toBeVisible();
        else await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
        expect(await overflow(page)).toBeLessThanOrEqual(0);
        // Every page's controls stay reachable: the tab bar scrolls on its own.
        await expect(
          page.getByRole('navigation', { name: 'Pages' }).getByRole('button', { name: 'Settings' }),
        ).toBeAttached();
      });
    }

    test('the request detail with its routing history fits the screen', async ({ page }) => {
      await serveApi(page, responses);
      await page.goto('/#requests');
      if (dataset === 'empty') return;
      await page.getByText('mock-failover').first().click();
      await expect(page.getByText('Routing history')).toBeVisible();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });
  });
}
