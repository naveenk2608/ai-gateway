import { expect, test } from '@playwright/test';
import { sampleResponses } from './fixtures.js';
import { overflow, serveApi } from './helpers.js';

test.describe('the app shell at 1440 px', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('opens dark, switches to light and keeps the choice after a reload', async ({ page }) => {
    await serveApi(page, sampleResponses('owner'));
    await page.goto('/#overview');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByRole('button', { name: 'Switch to light theme' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.getByRole('button', { name: 'Switch to dark theme' })).toBeVisible();
  });

  test('collapses the sidebar to icons and keeps it collapsed', async ({ page }) => {
    await serveApi(page, sampleResponses('owner'));
    await page.goto('/#overview');
    const sidebar = page.locator('.sidebar');
    const wide = (await sidebar.boundingBox())?.width ?? 0;
    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    await expect.poll(async () => (await sidebar.boundingBox())?.width ?? 0).toBeLessThan(wide);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
    // Links still work, by name, from the icon-only sidebar.
    await page.getByRole('link', { name: 'Reliability' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Reliability' })).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });

  test('the range picker changes the range the page asks for', async ({ page }) => {
    await serveApi(page, sampleResponses('owner'));
    const ranges: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname.endsWith('/analytics/overview')) ranges.push(url.searchParams.get('range')!);
    });
    await page.goto('/#overview');
    await expect.poll(() => ranges).toContain('24h');
    await page.getByRole('radio', { name: '7d' }).click();
    await expect.poll(() => ranges).toContain('7d');
  });

  test('logs out from the account menu', async ({ page }) => {
    await serveApi(page, sampleResponses('owner'));
    let loggedOut = false;
    await page.route('**/api/admin/auth/logout', (route) => {
      loggedOut = true;
      return route.fulfill({ status: 204 });
    });
    await page.route('**/api/admin/me', (route) =>
      loggedOut
        ? route.fulfill({
            status: 401,
            json: { error: { code: 'unauthenticated', message: 'Log in first.' } },
          })
        : route.fulfill({ json: sampleResponses('owner')['/admin/me'] }),
    );
    await page.goto('/#overview');
    await page.getByRole('button', { name: 'Account' }).click();
    await page.getByRole('button', { name: 'Log out' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Log in' })).toBeVisible();
    expect(loggedOut).toBe(true);
  });
});
