// LSOFPATH805: a single, PATH-independent way to run lsof.
//
// The bug it fixes: the dashboard runs under launchd, whose PATH is
// /usr/bin:/bin (plus homebrew) and OMITS /usr/sbin -- the only place macOS
// ships lsof. So `execSync('lsof ...')` was command-not-found in production,
// and the old `2>/dev/null || true` collapsed that into an empty result
// indistinguishable from "nothing matched". Measured on the live box: with the
// launchd PATH `lsof -ti :3420` returned EMPTY (exit 0), while /usr/sbin/lsof
// returned the two real holders. So the port-holder detection the single-
// instance reclaim depends on was silently a no-op on the production platform.
//
// Fix: resolve an ABSOLUTE lsof path once (usual sbin/bin locations + PATH),
// invoke it via execFileSync (no shell, no PATH lookup), and -- crucially --
// if lsof cannot be found at all, WARN LOUDLY (once) instead of returning a
// silent empty. "No lsof" and "no match" must never look the same again.

import { accessSync, constants as fsConstants } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { logger } from './logger.js'

// undefined = not resolved yet; null = resolved-and-absent; string = path.
let cachedLsofPath: string | null | undefined
let missingWarned = false

// Absolute locations macOS/Linux ship lsof in, checked before PATH so a launchd
// PATH that omits /usr/sbin still finds /usr/sbin/lsof. PATH entries are added
// after, covering homebrew (/opt/homebrew/bin) and non-standard Linux installs.
const ABSOLUTE_CANDIDATES = ['/usr/sbin/lsof', '/usr/bin/lsof', '/sbin/lsof', '/bin/lsof']

/**
 * Pure resolution: the first candidate that `isExecutable` accepts, ABSOLUTE
 * locations first, then PATH entries. Absolute-first is the whole fix -- it is
 * what makes lsof resolvable under a PATH that omits /usr/sbin. Exported so a
 * test can inject env + isExecutable and stay deterministic (no real fs).
 */
export function pickLsofPath(env: NodeJS.ProcessEnv, isExecutable: (path: string) => boolean): string | null {
  const candidates = [...ABSOLUTE_CANDIDATES]
  for (const dir of (env.PATH ?? '').split(':').filter(Boolean)) candidates.push(join(dir, 'lsof'))
  for (const cand of candidates) {
    if (isExecutable(cand)) return cand
  }
  return null
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Resolve an executable lsof path, or null if none exists. Cached. */
export function resolveLsofPath(env: NodeJS.ProcessEnv = process.env): string | null {
  if (cachedLsofPath !== undefined) return cachedLsofPath
  cachedLsofPath = pickLsofPath(env, isExecutableFile)
  return cachedLsofPath
}

/**
 * Run lsof with a resolved absolute path. Returns stdout (possibly empty) when
 * lsof RAN -- lsof exits non-zero on "no match" but still prints usable stdout,
 * so a non-zero exit is not an error here. Returns null ONLY when lsof could
 * not be run at all (binary absent or spawn failure); the absent-binary case is
 * additionally logged LOUDLY once, because a silent null there is exactly the
 * production blindness this module exists to end.
 */
export function runLsof(args: string[], timeoutMs: number): string | null {
  const bin = resolveLsofPath()
  if (bin == null) {
    if (!missingWarned) {
      missingWarned = true
      logger.warn(
        { path: process.env.PATH, tried: ABSOLUTE_CANDIDATES },
        'lsof not found on PATH or usual locations -- port-holder / cwd resolution DISABLED; single-instance reclaim degrades to argv-attribution. Install lsof or add /usr/sbin to PATH.',
      )
    }
    return null
  }
  try {
    return execFileSync(bin, args, { timeout: timeoutMs, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch (err) {
    // Non-zero exit (no match / partial) still carries stdout -- prefer it.
    // Only a genuine spawn failure (ENOENT after a stale cache, timeout) has
    // no stdout, which we surface as null ("could not run").
    const out = (err as { stdout?: string | Buffer } | null)?.stdout
    if (out == null) return null
    return typeof out === 'string' ? out : out.toString('utf-8')
  }
}

// Test-only: clear the resolution cache between cases.
export function __resetLsofCache(): void {
  cachedLsofPath = undefined
  missingWarned = false
}
