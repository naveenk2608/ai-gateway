import { defineConfig, devices } from '@playwright/test';

const PORT = 4174;

/** Browser checks of the built pages; the admin API is answered from fixtures (e2e/). */
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: `http://127.0.0.1:${PORT}` },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm exec vite --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}/dashboard/`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
