import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

const preinstalledChromium =
  '/ms-playwright/chrome-headless-shell-linux64/chrome-headless-shell';

export default defineConfig({
  testDir: './e2e',
  outputDir: '/tmp/swimlog-pw-results',
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      executablePath: existsSync(preinstalledChromium) ? preinstalledChromium : undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
  },
  webServer: {
    command: 'npx vite --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      VITE_SUPABASE_URL: 'https://mock-supabase.invalid',
      VITE_SUPABASE_ANON_KEY:
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6Im1vY2stc3VwYWJhc2UifQ.mock-sig',
    },
  },
});
