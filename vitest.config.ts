import { defineConfig, configDefaults } from 'vitest/config'
import { execSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'

// Resolve the main working tree root regardless of whether vitest is run from a
// git worktree in /tmp. `git rev-parse --git-common-dir` always returns the main
// repo's .git directory (absolute when called from a linked worktree, relative
// ".git" when called from the main tree). resolve() normalises both cases to an
// absolute path; dirname then strips the trailing /.git component.
// This value is injected as MARVEEN_SCRIPTS_DIR so that agent-scaffold.ts resolves
// hook-script paths to the real repo (not the /tmp worktree), keeping
// isUnsafeHookCommand from blocking every inject* call in tests. PROJECT_ROOT is
// deliberately left pointing at the worktree so agent-config lookups stay isolated.
const gitCommonDir = resolve(execSync('git rev-parse --git-common-dir').toString().trim())
const mainRepoRoot = dirname(gitCommonDir)

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
    env: {
      MARVEEN_SCRIPTS_DIR: mainRepoRoot,
    },
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
    // Thresholds ratcheted to F3b measured baseline (2026-07-27) after adding
    // route-handler unit tests for agents-channels, agents-crud (extended),
    // marveen, scheduled-tasks-io, skills (extended).
    // Stmts at 64% (not 65%) after fixing wrong vi.mock paths in batch-1 tests:
    // incorrect '../../channel-provider.js' now correctly mocks the module,
    // removing accidental side-effect coverage from the real channel-provider.ts.
    // Measured with include:['src/**/*.ts'], exclude:['src/__tests__/**','dist/**'].
    thresholds: {
      statements: 64,
      branches: 63,
      functions: 66,
      lines: 66,
    },
  },
})
