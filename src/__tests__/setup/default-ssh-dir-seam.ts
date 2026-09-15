// GLOBAL SUITE SEAM: no test may reach the operator's real ~/.ssh by default.
//
// ENROLL813 (2026-09-15). `POST /api/security/bridge-enroll` calls bridgeEnroll()
// with no deps, so it resolved homedir()/.ssh -- and bridge-enroll.test.ts has one
// branch ("Positive control on the same route") that hits that route BEFORE the
// file sets MARVEEN_SSH_DIR. Every full suite run therefore enrolled exactly one
// REAL `marveen-remote` key, and stayed green while doing it: the branch's only
// assertion (`not.toMatch(/Invalid host/)`) is satisfied by a SUCCESSFUL
// enrollment just as well as by the refusal it meant to rule out. 62 keys piled
// up across the fleet before anyone looked (Tecton 13, isapp06 51, pestihazak 4).
//
// Why the existing live-install gate could not have caught this -- worth stating,
// because it makes this file look redundant next to assert-not-live-install.ts:
// that gate inspects the CHECKOUT (store/.dashboard-token & co in the repo root)
// and tells you to run from a clean worktree under your HOME. But ~/.ssh is
// HOME-scoped, not checkout-scoped. Following its advice to the letter still
// wrote the operator's authorized_keys. A checkout-scoped gate cannot protect a
// home-scoped asset; this seam is the home-scoped half.
//
// This one line alone would have prevented all 62 keys -- which is why it is a
// setupFile (every worker, before any test module imports) and not a per-file
// beforeEach somebody can forget. The fail-closed guards in src/ssh-dir.ts and
// src/remote-enroll-fs.ts are the backstop for the case where a test unsets it.
//
// Scoped, not blanket: an existing MARVEEN_SSH_DIR is respected, so a test that
// wants its own directory keeps it.
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (!process.env.MARVEEN_SSH_DIR) {
  // Bounded and reused, NOT mkdtemp. The first version of this file made a fresh
  // random directory per worker and cleaned it from a `process.on('exit')` hook.
  // That hook does not fire in vitest's per-file isolated workers, so one full
  // suite run left one empty /tmp/marveen-ssh-seam-* directory per test FILE --
  // 436 of them for 443 files -- and 1813 had piled up unnoticed by the time
  // anyone counted (both measured 2026-09-15).
  // Shipping that would have been this PR's own thesis -- silent accumulation
  // nobody looks at -- reproduced inside the fix for it.
  //
  // VITEST_POOL_ID is the pool slot, documented as 1..maxWorkers, so the set of
  // directories stays the size of the worker pool however many times the suite
  // runs; process.pid is the fallback for a runner that does not set it. The
  // segment is sanitised because it ends up in a path.
  const slot = (process.env.VITEST_POOL_ID || String(process.pid)).replace(/[^A-Za-z0-9_-]/g, '_')
  const seamDir = join(tmpdir(), 'marveen-ssh-seam', `w${slot}`)
  // Cleared on ENTRY, not on exit. Two things follow from that, both wanted:
  // a slot is handed to the next test file once this one is done, and wiping it
  // here is what keeps one file's authorized_keys out of the next file's
  // assertions -- without depending on a hook that never runs. Concurrent
  // workers never share a slot, so no worker can wipe another's directory.
  rmSync(seamDir, { recursive: true, force: true })
  mkdirSync(seamDir, { recursive: true })
  process.env.MARVEEN_SSH_DIR = seamDir
}
