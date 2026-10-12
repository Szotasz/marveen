// GLOBAL SUITE GATE: refuse to run the test suite on a Node whose ABI the
// installed native modules were not built for.
//
// 2026-08-17: a full-suite run went red across 40 files / 149 tests, and not one
// of those failures was real. `node_modules` had been installed under Node 22
// (.nvmrc, and what the service itself runs on), while the shell's default
// `node` was a newer Homebrew major. better-sqlite3's binding then refused to
// load — "compiled against a different Node.js version using
// NODE_MODULE_VERSION 127; this version requires 147" — and every suite that
// opens the database failed with an error that reads like a bug in that suite.
// The cost is the diagnosis, not the fix: the fix is one PATH export.
//
// So the mismatch is stated once, up front, in the terms that matter: nothing is
// broken, here is the Node you are on, here is the Node the repo expects, here
// is the command. Loaded via vitest `setupFiles` so it gates every worker before
// any test module is imported — the same placement, and the same hard-failure
// policy, as its sibling `assert-not-live-install.ts`.
//
// The probe deliberately imports better-sqlite3 (the repo's only native
// dependency) rather than comparing version numbers: `engines` allows a whole
// range of majors, but the compiled binding is bound to exactly one ABI, so a
// version check would pass in cases that still cannot load. Asking the module
// itself is the only answer that cannot be wrong.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildNodeAbiMessage, isNodeAbiMismatch, readExpectedNodeMajor } from './node-abi.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

try {
  // Importing the module is NOT enough: better-sqlite3 resolves its compiled
  // binding lazily, inside the Database constructor (lib/database.js →
  // bindings()). A bare import therefore succeeds on a mismatched Node and the
  // gate would wave the run through — verified 2026-08-17, the first version of
  // this file did exactly that. Opening an in-memory database is the cheapest
  // way to make the module actually load its binding; it touches no files.
  const { default: Database } = await import('better-sqlite3')
  new Database(':memory:').close()
} catch (error) {
  // A genuine failure (missing install, a real bug in the module) must surface
  // as itself — this gate only translates the one error it knows how to.
  if (!isNodeAbiMismatch(error)) throw error

  throw new Error(
    buildNodeAbiMessage({
      originalMessage: error instanceof Error ? error.message : String(error),
      runningVersion: process.version,
      expectedMajor: readExpectedNodeMajor(repoRoot),
    }),
  )
}
