import { expect, test } from '@playwright/test';
import { sampleResponses } from './fixtures.js';
import { overflow, serveApi } from './helpers.js';

const REQUEST_ID = '0192f5a0-0000-7000-8000-0000000000cc';

/** A streamed chat completion, as the gateway sends it after falling back to the mock. */
const stream = [
  { choices: [{ index: 0, delta: { content: 'Hello from the ' } }] },
  { choices: [{ index: 0, delta: { content: 'gateway.' } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  { choices: [], usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 } },
]
  .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
  .concat('data: [DONE]\n\n')
  .join('');

test.describe('the Playground at 375 px', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('streams a reply with how it was served, and fits the screen', async ({ page }) => {
    await serveApi(page, sampleResponses('owner'));
    let authorization: string | undefined;
    await page.route('**/v1/chat/completions', (route) => {
      authorization = route.request().headers().authorization;
      return route.fulfill({
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'x-request-id': REQUEST_ID,
          'x-gateway-deployment': 'mock',
          'x-gateway-fallback-from': 'mock-error',
        },
        body: stream,
      });
    });

    await page.goto('/dashboard/#playground');
    await expect(page.getByRole('heading', { level: 1, name: 'Playground' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Message' }).fill('Hi');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page.getByText('Hello from the gateway.')).toBeVisible();
    const meta = page.getByLabel('Reply details');
    await expect(meta.getByText('9 in · 4 out')).toBeVisible();
    await expect(meta.getByText('fell back from Mock · mock-error')).toBeVisible();
    // The cost the worker recorded for this request (fixtures: $0.00125).
    await expect(meta.getByText('$0.001250')).toBeVisible();
    await expect(
      meta.getByRole('link', { name: `Open request ${REQUEST_ID} on the Requests page` }),
    ).toHaveAttribute('href', `#requests/${REQUEST_ID}`);
    expect(authorization).toMatch(/^Bearer gw_/);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });

  test('explains to a viewer why it is not available', async ({ page }) => {
    await serveApi(page, sampleResponses('viewer'));
    await page.goto('/dashboard/#playground');
    await expect(page.getByText(/only owners and admins may create keys/)).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });
});
