import { defineConfig, devices } from '@playwright/test';

// Started by e2e/run.sh, which brings up the backend and serves the web build.
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: '../playwright-report' }]] : 'list',
  outputDir: '../test-results',
  use: {
    baseURL: `http://127.0.0.1:${process.env.GATEWAY_PORT ?? 54321}`,
    ...devices['Pixel 7'],
    timezoneId: 'Asia/Kuala_Lumpur',
    colorScheme: process.env.COLOR_SCHEME === 'dark' ? 'dark' : 'light',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
