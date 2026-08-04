import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// A watchdog that cannot be satisfied must not run at full speed forever.
//
// On a host where the channel plugin CANNOT start -- AVX-less box, broken
// plugin cache, Claude auth deferred at install -- the never-started branch
// fires every 600s, exits non-zero, and the service manager restarts the unit.
// Each restart kill-sessions and recreates the agent's tmux session, so on a
// machine where Claude itself works and only the plugin is dead, the main agent
// loses its context every ten minutes. Measured live on 2026-08-04:
//   08:23:52 status=1/FAILURE -> 08:24:03 scheduled restart -> 08:24:04 new session
// Before the watchdog exited non-zero, that same host simply kept a working
// agent with a dead channel. So an unbounded cycle is a REGRESSION for that
// population, and the budget has to grow.
//
// The line that must not be crossed: we damp the CHURN, never the SIGNAL. The
// warning still goes to the log and the exit stays non-zero, so systemd still
// restarts and OnFailure= still fires. These tests pin both halves.

const ROOT = join(__dirname, '..', '..')
const CHANNELS = readFileSync(join(ROOT, 'scripts', 'channels.sh'), 'utf-8')

function sliceShellFn(src: string, name: string): string {
  const start = src.indexOf(`${name}() {`)
  if (start < 0) throw new Error(`function ${name}() not found`)
  const end = src.indexOf('\n}', start)
  if (end < 0) throw new Error(`unterminated ${name}()`)
  return src.slice(start, end + 2)
}

/** Slice from a start marker to an end marker searched FROM the start offset. */
function sliceBetween(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker)
  if (start < 0) throw new Error(`start marker not found: ${startMarker}`)
  const end = src.indexOf(endMarker, start + startMarker.length)
  if (end < 0) throw new Error(`end marker not found after start: ${endMarker}`)
  return src.slice(start, end + endMarker.length)
}

/** The whole never-started branch: from its own `if` down to its `break`.
 *  Anchoring on the warning text alone starts the slice INSIDE the echo line and
 *  silently drops everything above it -- which is how the first version of these
 *  tests failed on correct code. */
function neverStartedBranch(): string {
  return sliceBetween(CHANNELS, 'if [ "$NOW" -ge "$PLUGIN_NEVER_STARTED_DEADLINE" ]; then', 'break')
}

function runScript(body: string): { out: string; code: number } {
  const dir = mkdtempSync(join(tmpdir(), 'neverstart-'))
  try {
    const p = join(dir, 'probe.sh')
    writeFileSync(p, body + '\n')
    try {
      return { out: execFileSync('bash', [p], { encoding: 'utf-8' }).trim(), code: 0 }
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; status?: number }
      return { out: `${String(err.stdout ?? '')}${String(err.stderr ?? '')}`.trim(), code: err.status ?? -1 }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Run the SHIPPED budget function for a list of streak values. */
function budgets(streaks: number[]): number[] {
  const consts = [
    CHANNELS.match(/^NEVER_STARTED_BASE=\d+$/m)?.[0],
    CHANNELS.match(/^NEVER_STARTED_CAP=\d+$/m)?.[0],
  ]
  if (consts.some((c) => !c)) throw new Error('budget constants not found in channels.sh')
  const body = [consts.join('\n'), sliceShellFn(CHANNELS, 'never_started_budget'),
    streaks.map((s) => `never_started_budget ${s}`).join('\n')].join('\n')
  const r = runScript(body)
  expect(r.code).toBe(0)
  return r.out.split('\n').map((n) => parseInt(n.trim(), 10))
}

describe('never-started budget backoff', () => {
  it('starts at the original 10 minutes, so a healthy cold start is unaffected', () => {
    expect(budgets([0])[0]).toBe(600)
  })

  it('grows on consecutive failures', () => {
    const [b0, b1, b2] = budgets([0, 1, 2])
    expect(b1).toBeGreaterThan(b0)
    expect(b2).toBeGreaterThan(b1)
    expect([b0, b1, b2]).toEqual([600, 1200, 2400])
  })

  it('is capped -- it never grows without bound', () => {
    const long = budgets([0, 1, 2, 3, 4, 8, 20, 99])
    const cap = parseInt(CHANNELS.match(/^NEVER_STARTED_CAP=(\d+)$/m)![1], 10)
    for (const b of long) expect(b).toBeLessThanOrEqual(cap)
    expect(long[long.length - 1]).toBe(cap)
    // and monotonic non-decreasing all the way
    for (let i = 1; i < long.length; i++) expect(long[i]).toBeGreaterThanOrEqual(long[i - 1])
  })

  it('treats a garbage or missing streak file as zero (no accidental 40-minute start)', () => {
    expect(budgets([0])[0]).toBe(600)
    const body = [
      CHANNELS.match(/^NEVER_STARTED_BASE=\d+$/m)![0],
      CHANNELS.match(/^NEVER_STARTED_CAP=\d+$/m)![0],
      sliceShellFn(CHANNELS, 'never_started_budget'),
      'never_started_budget ""',
      'never_started_budget "not-a-number"',
    ].join('\n')
    const r = runScript(body)
    expect(r.code).toBe(0)
    expect(r.out.split('\n').map((n) => parseInt(n, 10))).toEqual([600, 600])
  })
})

describe('the streak is persisted and cleared in the right places', () => {
  it('the never-started exit writes the incremented streak BEFORE exiting', () => {
    const branch = neverStartedBranch()
    expect(branch).toMatch(/_next_streak=\$\(\(NEVER_STARTED_STREAK \+ 1\)\)/)
    // the WRITE is the thing that survives the process exit -- assert the
    // redirect itself, not just that the value was computed (a first version of
    // this test only checked the arithmetic and passed with the write deleted).
    const write = branch.match(/echo "\$_next_streak" > "\$NEVER_STARTED_STREAK_FILE"/)
    expect(write).not.toBeNull()
    expect(branch.indexOf(write![0])).toBeGreaterThan(-1)
    expect(branch.indexOf(write![0])).toBeLessThan(branch.indexOf('RESTART_REQUESTED=1'))
  })

  it('a plugin that comes up clears the streak, so recovery restores the fast watchdog', () => {
    const aliveBranch = sliceBetween(CHANNELS, 'if [ "$_plugin_alive" = "true" ]; then', 'elif')
    expect(aliveBranch).toMatch(/rm -f "\$NEVER_STARTED_STREAK_FILE"/)
    expect(aliveBranch).toMatch(/NEVER_STARTED_STREAK=0/)
  })

  it('the streak file lives in store/, next to the other channel state', () => {
    expect(CHANNELS).toMatch(/NEVER_STARTED_STREAK_FILE="\$INSTALL_DIR\/store\/\.channel-neverstart-streak"/)
  })
})

describe('the signal is NOT damped -- only the churn is', () => {
  it('still warns on every never-started exit', () => {
    const branch = neverStartedBranch()
    expect(branch).toMatch(/echo "WARN:/)
    expect(branch).toMatch(/exiting for service-manager restart/)
  })

  it('still exits non-zero, so the unit restarts and OnFailure= fires', () => {
    const branch = neverStartedBranch()
    expect(branch).toMatch(/RESTART_REQUESTED=1/)
    // and the tail still turns that flag into a non-zero status
    expect(CHANNELS).toMatch(/if \[ "\$RESTART_REQUESTED" = "1" \]; then\n\s+exit 1/)
  })

  it('leaves the died-after-up branch on its unchanged 180s grace (scope pin)', () => {
    expect(CHANNELS).toMatch(/^PLUGIN_DEAD_GRACE=180$/m)
    const deadBranch = sliceBetween(CHANNELS, 'plugin dead for', 'break')
    expect(deadBranch).not.toMatch(/NEVER_STARTED/)
  })
})
