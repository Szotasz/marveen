import { defineConfig, configDefaults } from 'vitest/config'

// The Playwright suites are driven by their own configs, not by `vitest run`:
// tests/smoke/** by `npm run smoke` (playwright.config.ts, a running dashboard)
// and tests/browser/** by `npm run browser-verify`
// (playwright.browser.config.ts, the static front end). Playwright's test() API
// throws when collected under vitest, which fails the unit gate. Keep all
// vitest defaults; only carve out the e2e directories.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'tests/smoke/**', 'tests/browser/**'],
    // vitest 4 enforces the 5s default testTimeout on tests that vitest 2 let
    // run long. Three subprocess-spawning tests (send-honesty-final,
    // send-honesty-round2) legitimately take 15-30s: they shell out to
    // watchdog-replay.py and wait for it. Measured 2026-09-04 on the v2->v4
    // bump: without this line those three red out as timeouts, with it the
    // suite is green. This is a timeout budget, not a behavioural change.
    testTimeout: 60000,
    // Hard gates, run in every worker before any test module is imported:
    //  - assert-not-live-install: refuse to run inside a live install (see that
    //    setup file's header for the 2026-07-27 incident it prevents).
    //  - assert-supported-node: refuse to run on a Node whose ABI the installed
    //    native modules were not built for, which otherwise reds out 40 files
    //    with errors that look like bugs in those files (2026-08-17).
    setupFiles: [
      './src/__tests__/setup/assert-not-live-install.ts',
      './src/__tests__/setup/assert-supported-node.ts',
    ],
  },
})
