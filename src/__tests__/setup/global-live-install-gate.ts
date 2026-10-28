// GLOBAL GATE (vitest `globalSetup`): refuse the WHOLE run inside a live install.
//
// Runs once in the main process before any worker starts, so a live checkout gets
// one clear error instead of a wall of per-file failures. assert-not-live-install.ts
// stays as the second layer (per worker), for runs under a different config or
// without this globalSetup. See that file's header for the incident this prevents.
//
// The root is derived from this file's location, never from the environment, and
// there is deliberately no override switch: no part of the suite needs to run in a
// live tree.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findLiveMarkers } from './live-install-markers.js'

const checkoutRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** Throw if `root` carries any live-install marker. Exported for tests (explicit root). */
export function assertNotLiveInstall(root: string): void {
  const found = findLiveMarkers(root)
  if (found.length === 0) return
  throw new Error(
    `REFUSING TO RUN TESTS: ${root} looks like a LIVE install (found: ${found.join(', ')}).\n` +
      'The suite mutates files under the checkout it runs in (store/, .env, .claude/skills/). ' +
      'Run it from a git worktree or CI checkout UNDER YOUR HOME (not /tmp), ' +
      'whose store/ carries no runtime state.',
  )
}

export default function setup(): void {
  assertNotLiveInstall(checkoutRoot)
}
