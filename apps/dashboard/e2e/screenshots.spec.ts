/**
 * Screenshots for design review: every page at 1440 px and 375 px in both themes, with the API
 * answered from fixtures. Runs only when SCREENSHOTS_DIR is set; the images are never committed.
 *
 *   SCREENSHOTS_DIR=screenshots pnpm --filter @ai-gateway/dashboard test:e2e screenshots
 */
import { expect, test, type Page } from '@playwright/test';
import { isAbsolute, join, resolve } from 'node:path';
import { sampleResponses } from './fixtures.js';
import { PAGES, serveApi } from './helpers.js';

const target = process.env.SCREENSHOTS_DIR;
const dir = target ? (isAbsolute(target) ? target : resolve(target)) : '';

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  phone: { width: 375, height: 812 },
} as const;

async function open(page: Page, theme: string, hash: string) {
  await page.addInitScript((value) => localStorage.setItem('ai-gateway.theme', value), theme);
  await serveApi(page, sampleResponses('owner'));
  await page.goto(`/dashboard/#${hash}`);
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

// Animations are finished before the capture, so drawers and menus show at rest.
const shot = (page: Page, name: string) =>
  page.screenshot({ path: join(dir, `${name}.png`), fullPage: true, animations: 'disabled' });

test.describe('screenshots', () => {
  test.skip(!target, 'set SCREENSHOTS_DIR to write screenshots');

  for (const theme of ['dark', 'light']) {
    for (const [size, viewport] of Object.entries(VIEWPORTS)) {
      test.describe(`${theme} ${size}`, () => {
        test.use({ viewport });

        for (const { hash } of PAGES) {
          test(hash, async ({ page }) => {
            await open(page, theme, hash);
            await shot(page, `${theme}-${size}-${hash}`);
          });
        }

        test('requests-panel', async ({ page }) => {
          await open(page, theme, 'requests');
          await page.getByText('mock-failover').first().click();
          await expect(page.getByRole('heading', { name: 'Routing history' })).toBeVisible();
          await shot(page, `${theme}-${size}-requests-panel`);
        });

        test('navigation', async ({ page }) => {
          await open(page, theme, 'overview');
          if (size === 'phone') await page.getByRole('button', { name: 'Open navigation' }).click();
          else await page.getByRole('button', { name: 'Account' }).click();
          await shot(page, `${theme}-${size}-navigation`);
        });
      });
    }
  }
});
