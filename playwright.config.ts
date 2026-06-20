import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/smoke',
  timeout: 30_000,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: process.env.DASHBOARD_URL || 'http://localhost:3420',
    headless: true,
    screenshot: 'only-on-failure',
  },
})
