import type { Page } from '@playwright/test';

/** Every page: its hash route and the title its header shows. */
export const PAGES = [
  { hash: 'overview', title: 'Overview' },
  { hash: 'requests', title: 'Requests' },
  { hash: 'cost', title: 'Cost' },
  { hash: 'models', title: 'Models' },
  { hash: 'reliability', title: 'Reliability' },
  { hash: 'security', title: 'Security' },
  { hash: 'infra', title: 'Infrastructure' },
  { hash: 'settings', title: 'Settings' },
] as const;

/** Answers /api/... from fixtures; anything else gets the gateway's 404. */
export async function serveApi(page: Page, responses: Record<string, unknown>) {
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
export const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
