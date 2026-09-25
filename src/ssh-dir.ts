// The ONE place that answers "which .ssh directory does this process write to?"
//
// ENROLL813 (2026-09-15). The question used to be answered in THREE places,
// and only two of them knew about the test seam:
//   src/web/bridge-enroll.ts             resolveSshDir()          -- honoured MARVEEN_SSH_DIR
//   src/web/routes/bridge-service-ports.ts resolveSshDir()        -- byte-identical copy
//   scripts/remote-access-enroll.ts      join(homedir(), '.ssh')  -- knew NOTHING about it
// A seam that only some writers honour is not a seam. Measured consequence:
// 62 real `marveen-remote` keys accumulated in operators' authorized_keys from
// ordinary test runs (Tecton 13, isapp06 51, pestihazak 4; cleaned 2026-09-15).
//
// FAIL-CLOSED RULE: under a test runner, resolving to the REAL ~/.ssh is a bug,
// never an intent. A suite that means to exercise enrollment points
// MARVEEN_SSH_DIR at a scratch directory -- and since
// src/__tests__/setup/default-ssh-dir-seam.ts sets a per-worker default, a test
// only reaches this throw by unsetting the seam on purpose. Writing the
// operator's authorized_keys instead is precisely what this module exists to stop.
//
// Production is unaffected: neither VITEST nor NODE_ENV=test exists in a live
// install (measured 2026-09-15 on isapp06 -- .env, the systemd units and every
// running marveen process: zero occurrences). If the guard ever DOES fire in
// production it would break real device pairing, so every message names the
// signal that triggered it and the one variable that resolves it.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isTestRun } from './test-run-marker.js'

/** MARVEEN_SSH_DIR is a test seam for isolated instances (a scratch server must
 * never write the real ~/.ssh). It lives in a production code path, so if it
 * ever leaks into a real environment (inherited env, copied .env, launchd
 * plist) enrollment would silently write elsewhere and pairing would "succeed
 * but not work". Every use is therefore loudly logged by the caller and
 * flagged into the audit row (see sshDirOverride() callers). */
export function sshDirOverride(): string | null {
  return process.env.MARVEEN_SSH_DIR || null
}

/** Marker code carried by every ENROLL813 guard refusal, so a caller can tell a
 * guard apart from an ordinary I/O error WITHOUT matching on message text.
 * This is the ERROR OBJECT's code (uppercase, like Node's own errno codes); the
 * HTTP routes send the lowercase 'enroll813' on the wire, matching the shape of
 * every other code this server emits and the i18n keys that translate them. */
export const SSH_DIR_GUARD_CODE = 'ENROLL813'

/**
 * A guard REFUSAL, not an I/O failure. It gets its own type because the
 * difference is load-bearing downstream: a catch that lumps this in with
 * "authorized_keys is missing" answers "this device is not paired" for what is
 * actually a fault -- the same silent-failure shape this whole change exists to
 * remove (see readCurrentPorts in src/web/routes/bridge-service-ports.ts, which
 * used to do exactly that).
 */
export class SshDirGuardError extends Error {
  readonly code = SSH_DIR_GUARD_CODE
  constructor(message: string) {
    super(message)
    this.name = 'SshDirGuardError'
  }
}

/** instanceof PLUS a duck-typed code check. ESM can end up with two copies of a
 * module (separate realms, a mocked import, a re-export chain), and then
 * instanceof quietly answers false for an object that IS one of ours -- which
 * would re-open the exact hole this type was added to close. The code field
 * survives that. */
export function isSshDirGuardError(err: unknown): err is SshDirGuardError {
  if (err instanceof SshDirGuardError) return true
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === SSH_DIR_GUARD_CODE
  )
}

/** The operator's real ~/.ssh -- the asset the ENROLL813 guards protect. */
export function realSshDir(): string {
  return join(homedir(), '.ssh')
}

/** Which signal marks this as a test run. Named in every ENROLL813 message so a
 * production misfire is diagnosable from the error text alone, without a repro.
 *
 * Both call sites today sit INSIDE an `if (isTestRun())`, so the "no test signal"
 * branch is unreachable from them. It is kept rather than dropped because the
 * alternative -- returning an empty string -- would render an ENROLL813 message
 * as "(...)" with nothing in it if a future caller ever asks outside that guard,
 * and a diagnostic that reads "(no test signal)" is the more useful of the two.
 * Callers that want the boolean must ask isTestRun(); this function only NAMES. */
export function describeTestRunSignal(): string {
  const signals: string[] = []
  if (process.env['VITEST'] !== undefined) signals.push(`VITEST=${process.env['VITEST']}`)
  if (process.env['NODE_ENV'] === 'test') signals.push('NODE_ENV=test')
  return signals.length > 0 ? signals.join(' + ') : 'no test signal'
}

/**
 * Resolve the .ssh directory for a WRITE path: the override when set, the real
 * ~/.ssh in production, and a hard throw under a test runner (see header).
 *
 * `onOverride` lets each caller keep its own loud notice (pino warn in the web
 * routes, stderr in the CLI) without this module taking a dependency on a logger.
 */
export function resolveSshDir(onOverride?: (dir: string) => void): string {
  const override = sshDirOverride()
  if (override) {
    onOverride?.(override)
    return override
  }
  if (isTestRun()) {
    throw new SshDirGuardError(
      `ENROLL813: refusing to resolve the REAL ${realSshDir()} under a test runner ` +
        `(${describeTestRunSignal()}). Point MARVEEN_SSH_DIR at a scratch directory ` +
        'instead; the suite sets a per-worker default in ' +
        'src/__tests__/setup/default-ssh-dir-seam.ts, so seeing this means it was ' +
        'unset deliberately. If this fired in PRODUCTION, the fix is to remove the ' +
        'test signal named above from the service environment -- not to bypass this guard.',
    )
  }
  return realSshDir()
}
