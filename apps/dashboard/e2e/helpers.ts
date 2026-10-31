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
  { hash: 'playground', title: 'Playground' },
  { hash: 'settings', title: 'Settings' },
] as const;

/** The gateway's paths the dashboard calls; everything else is the dashboard's own files. */
export const GATEWAY_PATHS = /^\/(admin|v1)\/|^\/ready$/;

/**
 * Answers the gateway's paths from fixtures (`METHOD /path` first, then `/path` for GET);
 * unknown ones get the gateway's 404.
 */
export async function serveApi(page: Page, responses: Record<string, unknown>) {
  await page.route(
    (url) => GATEWAY_PATHS.test(url.pathname),
    (route) => {
      const path = new URL(route.request().url()).pathname;
      const method = route.request().method();
      const body =
        responses[`${method} ${path}`] ?? (method === 'GET' ? responses[path] : undefined);
      return route.fulfill(
        body === undefined
          ? { status: 404, json: { error: { code: 'not_found', message: path } } }
          : { json: body },
      );
    },
  );
}

/** How far the page is wider than the viewport; 0 means no sideways scrolling. */
export const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
