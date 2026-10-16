import { defineConfig, devices } from '@playwright/test';

// The one-file demo build, served like an embedded page (see demo/serve.mjs).
// `npm run test:demo` builds it first.
const port = Number(process.env.DEMO_PORT ?? 54330);

export default defineConfig({
  testDir: './demo',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  outputDir: '../test-results/demo',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    ...devices['Pixel 7'],
    timezoneId: 'Asia/Kuala_Lumpur',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node demo/serve.mjs',
    url: `http://127.0.0.1:${port}/host`,
    reuseExistingServer: false,
  },
});
