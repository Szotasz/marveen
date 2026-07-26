import { defineConfig, configDefaults } from 'vitest/config'

// The Playwright smoke suite (tests/smoke/**) is driven by `npm run smoke`
// (playwright.config.ts), not by `vitest run`. Playwright's test() API throws
// when collected under vitest, which fails the unit gate. Keep all vitest
// defaults; only carve out the e2e directory.
// dist/** is excluded so that `npm run build` (tsc) compiling tests into
// dist/__tests__/ does not cause vitest to double-run the compiled JS copies,
// which would fail (compiled tests import relative .ts sources that don't
// exist under dist/).
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'tests/smoke/**', 'dist/**'],
  },
})
