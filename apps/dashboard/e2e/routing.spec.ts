import { expect, test } from '@playwright/test';
import { PROJECT_ID, sampleResponses } from './fixtures.js';
import { overflow, serveApi } from './helpers.js';

// The route editor on the Models page (M15, ADR 034), in a real browser at phone width.
test.use({ viewport: { width: 375, height: 812 } });

const base = `/admin/projects/${PROJECT_ID}/routes/chat-pair`;

test('an admin reorders a route, saves it as a new version and rolls back, at 375 px', async ({
  page,
}) => {
  const responses = {
    ...sampleResponses('admin'),
    [`PUT ${base}`]: { version: 3, route: null },
    [`POST ${base}/rollback`]: { version: 3, route: null },
  };
  await serveApi(page, responses);
  await page.goto('/dashboard/#models');
  const editor = page.getByRole('form', { name: 'Route of chat-pair' });
  await expect(editor).toBeVisible();
  await expect(page.getByText('Overridden for this project (version 2,')).toBeVisible();
  await expect(editor.getByLabel('Policy')).toHaveValue('weighted');
  expect(await overflow(page)).toBeLessThanOrEqual(0);

  // groq-fast moves back to the top, with gemini-lite's weight kept at 3.
  await editor.getByRole('button', { name: 'Move groq-fast up' }).click();
  await editor.getByLabel('Policy').selectOption('priority');
  const saved = page.waitForRequest((r) => r.method() === 'PUT' && r.url().endsWith(base));
  await editor.getByRole('button', { name: 'Save as a new version' }).click();
  expect((await saved).postDataJSON()).toEqual({
    policy: 'priority',
    targets: [
      { deployment: 'groq-fast', weight: 1, lastResort: false },
      { deployment: 'gemini-lite', weight: 3, lastResort: false },
    ],
  });

  // The history lists both versions; rolling back to version 1 posts it.
  await expect(page.getByRole('cell', { name: 'owner@example.test' }).first()).toBeVisible();
  const rolledBack = page.waitForRequest(
    (r) => r.method() === 'POST' && r.url().endsWith(`${base}/rollback`),
  );
  await page.getByRole('button', { name: 'Roll back to 1' }).click();
  expect((await rolledBack).postDataJSON()).toEqual({ version: 1 });
});

test('a viewer sees the route and its history without controls', async ({ page }) => {
  await serveApi(page, sampleResponses('viewer'));
  await page.goto('/dashboard/#models');
  const editor = page.getByRole('form', { name: 'Route of chat-pair' });
  await expect(editor).toBeVisible();
  await expect(editor.getByText('Only admins change routing.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save as a new version' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Roll back to 1' })).toHaveCount(0);
  await expect(editor.getByLabel('Policy')).toBeDisabled();
});
