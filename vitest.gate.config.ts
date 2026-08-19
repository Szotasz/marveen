import { defineConfig } from 'vitest/config'

import baseConfig from './vitest.config'

// GATENATIV818 -- the config the secret-gate job runs its own tests with
// (.github/workflows/secret-gate.yml).
//
// That job installs with `npm ci --ignore-scripts` on purpose: a job whose
// entire subject is unreviewed incoming material must not execute every
// dependency's install script. The consequence is that no native module is ever
// built in it -- better-sqlite3 has no compiled binding there, and never will.
//
// The suite's global setup files are shared with local runs, and one of them
// probes that binding to catch a Node ABI mismatch. Measured 2026-08-18 on PR
// #994: the gate job died at `new Database(':memory:')` with "Could not locate
// the bindings file", before a single assertion ran. The gate is fail-closed,
// so with that setup file on the base branch it is not a slower pipeline, it is
// every PR blocked.
//
// The gate's own tests need no database at all -- they exercise pure scanning
// logic. So this config inherits the base config unchanged and drops only the
// setup files that require a compiled native module. It is deliberately a
// subtraction from the base rather than a second copy of it: anything added to
// the base config later is inherited here too.
//
// Scope note: this config exists for CI. It is not the way to run the suite
// locally -- `npm test` (the base config, with every gate in place) is.

/**
 * Setup files that load a native module, identified by name because what
 * matters is what the file does, not where it sits. If a future setup file
 * takes the same dependency and is not listed here, this job goes red on the
 * very next PR -- loudly, and before any merge -- rather than passing quietly.
 */
const NATIVE_DEPENDENT_SETUP_FILES = ['assert-supported-node']

const baseSetupFiles = baseConfig.test?.setupFiles ?? []
const inheritedSetupFiles = Array.isArray(baseSetupFiles) ? baseSetupFiles : [baseSetupFiles]

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    setupFiles: inheritedSetupFiles.filter(
      (file) => !NATIVE_DEPENDENT_SETUP_FILES.some((name) => String(file).includes(name)),
    ),
  },
})
