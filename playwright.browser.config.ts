// BRIDGEHU813: a config for the static front-end verification. Separate from
// playwright.config.ts on purpose -- that suite measures a running dashboard,
// this one must never point at one.
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/browser',
  timeout: 30_000,
  retries: 0,
  reporter: 'list',
  webServer: {
    command: 'python3 -m http.server 3999 --directory web',
    url: 'http://127.0.0.1:3999/index.html',
    reuseExistingServer: false,
    timeout: 20_000,
  },
  // This checkout's @playwright/test pins a chromium build that is not in the
  // shared cache; the nearest installed one is named explicitly rather than
  // downloading another copy onto the owner's machine.
  use: {
    baseURL: 'http://127.0.0.1:3999',
    headless: true,
    launchOptions: { executablePath: process.env.CHROMIUM_BIN || undefined },
  },
})
