import { defineConfig, devices } from '@playwright/test';

const allBrowsers = process.env.E2E_BROWSERS === 'all';

const projects = [
  { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
  { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
];

if (allBrowsers) {
  projects.push(
    { name: 'desktop-firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'desktop-webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'mobile-webkit', use: { ...devices['iPhone 13'] } },
    {
      name: 'small-mobile-chromium',
      use: {
        ...devices['Pixel 7'],
        viewport: { width: 320, height: 568 },
        screen: { width: 320, height: 568 },
      },
    },
  );
}

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI
    ? [
        ['list'],
        ['html', { open: 'never' }],
      ]
    : [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3100',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'node tests/e2e/start-server.mjs',
        url: 'http://127.0.0.1:3100/api/v1/health',
        reuseExistingServer: false,
        timeout: 120_000,
      },
  projects,
});
