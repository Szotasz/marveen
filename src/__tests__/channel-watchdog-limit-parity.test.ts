import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { detectsUsageLimit } from '../model-fallback.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const WATCHDOG = join(ROOT, 'scripts', 'channel-watchdog.sh')

/**
 * The watchdog's `--check-limit` is a shell transcription of `USAGE_LIMIT_RX`.
 * A comment claiming they "mirror" each other is worth nothing once they drift,
 * and drift is exactly what happened: review measured four weekly/session
 * banners that matched in TS and not in shell (2026-09-03). On such a banner the
 * quota hold would not engage and the watchdog would respawn a session that
 * respawning cannot fix -- the failure this gate exists to prevent.
 *
 * So the claim is a test, not a comment. Both implementations run over the same
 * table and must agree on every row.
 */
function shellSaysLimit(pane: string): boolean {
  try {
    execFileSync('bash', [WATCHDOG, '--check-limit'], { input: pane, stdio: ['pipe', 'ignore', 'ignore'] })
    return false // exit 0 -- no banner
  } catch (err) {
    const status = (err as { status?: number }).status
    if (status === 1) return true // exit 1 -- banner detected
    throw err
  }
}

// Every banner shape either implementation claims to know, plus the negatives
// that must stay negative. Rows marked `true` are real Claude usage-limit
// banners; the rest are text that merely sounds like one.
const BANNERS: Array<[string, boolean]> = [
  ['Claude usage limit reached. Your limit will reset at 3pm.', true],
  ['You have reached your usage limit', true],
  ['You have reached your weekly limit', true],
  ['You are approaching your weekly limit', true],
  ['You are approaching your usage limit', true],
  ['Approaching your Opus weekly limit', true],
  ['Weekly limit reached', true],
  ['Session limit reached', true],
  ['You hit the session limit', true],
  ['You hit your usage limit', true],
  ['5-hour limit reached', true],
  ['Your usage limit will reset at 3pm', true],
  ['usage limit reset in 42 minutes', true],
  ['Upgrade to increase your usage limit', true],
  ['nothing to see here', false],
  ['the rate limit on the API returned 429', false],
  ['git push rejected: limit exceeded', false],
  ['', false],
]

describe('channel-watchdog --check-limit parity with detectsUsageLimit', () => {
  it.each(BANNERS)('agrees on %j', (pane, expected) => {
    expect(detectsUsageLimit(pane)).toBe(expected)
    expect(shellSaysLimit(pane)).toBe(expected)
  })

  // Guards the premise of the table above: if the shell entry point ever stops
  // being reachable (renamed subcommand, moved file), every row would silently
  // report "no banner" and the parity test would pass while measuring nothing.
  it('the shell entry point is live (a known banner really exits 1)', () => {
    expect(shellSaysLimit('Claude usage limit reached')).toBe(true)
    expect(shellSaysLimit('plain idle pane')).toBe(false)
  })
})
