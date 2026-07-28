import { defineConfig, configDefaults } from 'vitest/config'

// The Playwright smoke suite (tests/smoke/**) is driven by `npm run smoke`
// (playwright.config.ts), not by `vitest run`. Playwright's test() API throws
// when collected under vitest, which fails the unit gate. Keep all vitest
// defaults; only carve out the e2e directory.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'tests/smoke/**'],
    // Hard gate: refuse to run inside a live install (see the setup file header
    // for the 2026-07-27 incident this prevents). Runs in every worker before
    // any test module is imported.
    setupFiles: ['./src/__tests__/setup/assert-not-live-install.ts'],
  },
})
