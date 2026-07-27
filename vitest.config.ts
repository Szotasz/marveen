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
    // Default 5 s is too tight for DB-heavy tests in a fully-parallel suite run.
    // Affected tests pass in isolation; the timeout is a concurrency artefact.
    testTimeout: 15000,
  },
  coverage: {
    provider: 'v8',
    reporter: ['text', 'html', 'json-summary'],
    reportsDirectory: 'coverage',
    // Only measure backend TypeScript; web/modules/*.js is browser-only JS
    // and cannot be instrumented by vitest (would show 0% and break the gate).
    include: ['src/**/*.ts'],
    exclude: ['src/__tests__/**', 'dist/**'],
    // Thresholds set at current measured baseline (2026-07-27: stmts 46%,
    // branches 47%, functions 51%, lines 47%) to activate the gate without
    // blocking CI on day 1. Ramp toward 90% in subsequent sprints (F2/F3).
    // Measured with include:['src/**/*.ts'], exclude:['src/__tests__/**','dist/**'].
    thresholds: {
      statements: 46,
      branches: 47,
      functions: 51,
      lines: 47,
    },
  },
})
