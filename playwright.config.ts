import { defineConfig } from '@playwright/test'

// SMOKELIVE815: the suite must never default to the owner's LIVE dashboard.
// Most specs read and stub, but one typo'd stub, one new un-stubbed route or a
// future writing test is enough for a default-of-live to mutate the running
// system -- with the suite staying green. Running against a live instance is
// still possible, but only as an explicit, deliberate choice.
const baseURL = process.env.DASHBOARD_URL
if (!baseURL) {
  throw new Error(
    [
      'DASHBOARD_URL is not set -- the smoke suite refuses to guess a target.',
      'Point it at a disposable test instance, e.g.:',
      '  DASHBOARD_URL=http://localhost:3421 npm run smoke',
      'To measure a LIVE dashboard intentionally, name it explicitly:',
      '  DASHBOARD_URL=http://localhost:3420 npm run smoke',
    ].join('\n'),
  )
}

export default defineConfig({
  testDir: './tests/smoke',
  timeout: 30_000,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL,
    headless: true,
    screenshot: 'only-on-failure',
  },
})
