// WHO the channels.sh guard alerts are sent AS (card GUARDSENDER926).
//
// The two alerts in scripts/channels.sh report that the main agent came up on
// the SHARED ~/.claude, which can 401 into a silent channel. Both were sent
// with a hardcoded `from=channels-sh-guard`. Measured 2026-09-26 against the
// live dashboard, that sender is refused:
//
//   POST /api/messages from=channels-sh-guard -> HTTP 403 "unknown agent"
//   POST /api/messages from=<.env MAIN_AGENT_ID> -> HTTP 200
//
// The sender check (src/web/routes/messages.ts) accepts the owner, an id listed
// in SYSTEM_SENDER_IDS, the voice channel, or a directory under agents/.
// SYSTEM_SENDER_IDS is empty by default (src/config.ts) and there is no
// agents/channels-sh-guard/ directory -- so the alert about a silent channel was
// itself undeliverable. Card ecb62920 closed the identical shape for
// `from=marveen` in the prod-tree-guard hook.
//
// SCOPE, BECAUSE IT MATTERS FOR HOW THIS READS: nothing has been lost to this on
// this install. store/channels-failures.log has zero "starting on SHARED" lines,
// so the trigger never fired here. This is prevention.
//
// TWO KINDS OF ASSERTION, ON PURPOSE. A green decision test is not evidence that
// anybody calls the decision (the lesson main-shared-config-guard.test.ts states
// in its own header). So this file measures the resolver by RUNNING it, and
// separately pins that both call sites actually use it.

import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(__dirname, '..', '..', 'scripts', 'channels.sh')
const src = readFileSync(SCRIPT, 'utf-8')

/** The resolver, lifted out of the script so it can be run without booting it. */
const fnStart = src.indexOf('_guard_sender() {')
const fnEnd = src.indexOf('\n}\n', fnStart)
const fn = fnStart >= 0 && fnEnd > fnStart ? src.slice(fnStart, fnEnd + 3) : ''

/** Run the lifted resolver with a given environment. Values travel in the
 *  ENVIRONMENT, never interpolated into the script text: a list entry is
 *  attacker-shaped data in the general case, and a shell that glues it in would
 *  execute it. */
function resolve(env: Record<string, string>): string {
  return execFileSync('bash', ['-c', `${fn}\n_guard_sender`], {
    encoding: 'utf-8',
    env: { PATH: process.env['PATH'] ?? '', ...env },
    timeout: 10000,
  })
}

describe('the resolver exists and is liftable', () => {
  it('_guard_sender is defined in channels.sh', () => {
    expect(fn, '_guard_sender() not found in scripts/channels.sh').toContain('_guard_sender() {')
  })
})

describe('_guard_sender: the guard name only where the install registered it', () => {
  it('sends under its own name when SYSTEM_SENDER_IDS lists it', () => {
    expect(resolve({ MAIN_AGENT_ID: 'sajat-agens', SYSTEM_SENDER_IDS: 'channels-sh-guard' }))
      .toBe('channels-sh-guard')
  })

  it('parses the list the way the server parses it: commas, spaces, several entries', () => {
    expect(resolve({ MAIN_AGENT_ID: 'sajat-agens', SYSTEM_SENDER_IDS: 'cortex, channels-sh-guard ,billing' }))
      .toBe('channels-sh-guard')
  })

  it('falls back to the install id when the list omits the guard', () => {
    expect(resolve({ MAIN_AGENT_ID: 'sajat-agens', SYSTEM_SENDER_IDS: 'cortex,billing' }))
      .toBe('sajat-agens')
  })

  it('falls back to the install id when there is no list at all -- the configuration this host has', () => {
    expect(resolve({ MAIN_AGENT_ID: 'sajat-agens' })).toBe('sajat-agens')
  })

  it('a near-miss entry is NOT a match: the check is exact, not a prefix', () => {
    // If this were a substring test, `channels-sh-guard-old` would enable a
    // sender the API still refuses -- the silent loss again, one layer down.
    expect(resolve({ MAIN_AGENT_ID: 'sajat-agens', SYSTEM_SENDER_IDS: 'channels-sh-guard-old' }))
      .toBe('sajat-agens')
  })

  it('POSITIVE CONTROL: the two answers really are different, so a constant stub cannot pass this file', () => {
    const listed = resolve({ MAIN_AGENT_ID: 'sajat-agens', SYSTEM_SENDER_IDS: 'channels-sh-guard' })
    const notListed = resolve({ MAIN_AGENT_ID: 'sajat-agens', SYSTEM_SENDER_IDS: '' })
    expect(listed).not.toBe(notListed)
  })
})

describe('the call sites USE the resolver -- the half a decision test cannot prove', () => {
  const guardPosts = src.split('\n').filter(l => l.includes('/api/messages') === false && l.includes('\\"from\\":'))

  it('both guard alerts resolve the sender instead of hardcoding it', () => {
    const resolved = guardPosts.filter(l => l.includes('\\"from\\":\\"$(_guard_sender)\\"'))
    expect(resolved.length, `sender-resolving POST bodies found: ${resolved.length}`).toBe(2)
  })

  it('the hardcoded sender is gone from the script entirely', () => {
    expect(src).not.toContain('\\"from\\":\\"channels-sh-guard\\"')
  })

  it('the guard name still appears, but only inside the resolver', () => {
    // It has to stay somewhere -- that is the name to send under where it IS
    // registered. What must not come back is a POST body carrying it directly.
    expect(fn).toContain('channels-sh-guard')
  })
})
