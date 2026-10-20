// Card 41a0c3a3: the session-stuck alert has to say when a session is at the
// plan usage limit ("quota wall") and when the CLI resumes, instead of the
// generic "restart the agent if it is wedged". detectQuotaWall is the pane side
// of that: it reads the banner the CLI paints UNDER the input box.
//
// The fixture is a live capture (2026-09-30 16:14Z, a sub-agent on a key at
// 5h 100%), kept byte for byte from the rule above the prompt downwards; only
// the conversation text above the wall lines and the session title in the top
// rule were replaced. The two NBSPs are the live pane's own (after the prompt
// glyph and after the tool-result glyph).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { detectPaneState, detectQuotaWall } from '../pane-state.js'

const WALL_PANE = readFileSync(join(__dirname, 'fixtures/pane/quota-wall-usage-limit.txt'), 'utf8')
const SEP = '─'.repeat(80)

// The same live pane with the ⚠ banner under the box removed: every wall word
// above the box (the failed turn's own echo) is still there.
function withoutBanner(pane: string): string {
  const lines = pane.split('\n')
  const at = lines.findIndex((l) => l.trimStart().startsWith('⚠'))
  expect(at).toBeGreaterThan(0)
  return [...lines.slice(0, at), ...lines.slice(at + 3)].join('\n')
}

describe('detectQuotaWall: the live usage-limit banner', () => {
  it('reads the wall and its reset time from the live capture', () => {
    const wall = detectQuotaWall(WALL_PANE)
    expect(wall).not.toBeNull()
    expect(wall!.resetsAt).toBe('6:20pm')
    // The wrapped continuation lines are part of the banner, the status line is not.
    expect(wall!.banner).toBe('⚠ Usage limit reached · limit resets 6:20pm Continuing automatically at 6:20pm · esc to cancel · /usage-credits to continue now')
    expect(wall!.banner).not.toContain('5h 100%')
  })

  it('the live wall pane reads idle, not busy (measured: the turn has ended)', () => {
    // Why this matters for the alert: a walled pane is not "working", so the
    // busy text ("Do NOT restart on this alert alone") would not describe it,
    // and the plain not-ready text would advise a restart that cannot help.
    expect(detectPaneState(WALL_PANE)).toBe('idle')
  })

  it('reads the earlier one-line form (continuing automatically at <time>)', () => {
    // Measured 2026-09-24 on an earlier CLI: the time sat after "continuing
    // automatically at", with the credits hint on a second ⚠ line.
    const pane = [
      'done',
      '',
      SEP,
      '❯ ',
      SEP,
      '  ⚠ Usage limit reached · continuing automatically at 7:40pm · esc to cancel',
      '  ⚠ /usage-credits to continue now',
      '  5h 100% | 7d 87%',
    ].join('\n')
    const wall = detectQuotaWall(pane)
    expect(wall).not.toBeNull()
    expect(wall!.resetsAt).toBe('7:40pm')
    // A second ⚠ line at the same depth is a new line, not a continuation.
    expect(wall!.banner).toBe('⚠ Usage limit reached · continuing automatically at 7:40pm · esc to cancel')
  })

  it('a banner without a time still counts as a wall, with resetsAt null', () => {
    const pane = ['', SEP, '❯ ', SEP, '  ⚠ Usage limit reached', '  5h 100% | 7d 87%'].join('\n')
    expect(detectQuotaWall(pane)).toEqual({ banner: '⚠ Usage limit reached', resetsAt: null })
  })
})

describe('detectQuotaWall: what is NOT a wall', () => {
  it('the same words ABOVE the box are conversation (the live pane without its banner)', () => {
    // Negative control on the real capture: "Usage limit reached again" and
    // "You've hit your session limit · resets 6:20pm" stay above the box.
    const pane = withoutBanner(WALL_PANE)
    expect(pane).toContain("You've hit your session limit")
    expect(detectQuotaWall(pane)).toBeNull()
  })

  it('an agent quoting the banner above the box does not trip it', () => {
    const pane = ['The pane said: "⚠ Usage limit reached · limit resets 6:20pm"', '', SEP, '❯ ', SEP, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n')
    expect(detectQuotaWall(pane)).toBeNull()
  })

  it('a quoted banner LINE above the box, marker and all, is still conversation', () => {
    // The hard case for the "under the box" rule: a reply that reproduces the
    // banner line itself, ⚠ first, indented like the real one.
    const pane = [
      'This is what the other session showed:',
      '  ⚠ Usage limit reached · limit resets 6:20pm',
      '    Continuing automatically at 6:20pm · esc to cancel',
      '',
      SEP,
      '❯ ',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(detectQuotaWall(pane)).toBeNull()
  })

  it('the has-reset and approaching forms under the box are not a wall', () => {
    for (const banner of ['  ⚠ Usage limit reset · continuing automatically', '  ⚠ Approaching usage limit · resets 6:20pm']) {
      const pane = ['', SEP, '❯ ', SEP, banner, '  5h 97% | 7d 40%'].join('\n')
      expect(detectQuotaWall(pane)).toBeNull()
    }
  })

  it('a wall sentence without the ⚠ marker under the box is not the banner', () => {
    // Under the footer the CLI lists background tasks; their descriptions can say anything.
    const pane = ['', SEP, '❯ ', SEP, '  ◯ general-purpose check why Usage limit reached · resets 6:20pm'].join('\n')
    expect(detectQuotaWall(pane)).toBeNull()
  })

  it('no box rule at all -> null; empty -> null', () => {
    expect(detectQuotaWall('  ⚠ Usage limit reached · limit resets 6:20pm')).toBeNull()
    expect(detectQuotaWall('')).toBeNull()
    expect(detectQuotaWall('   \n  ')).toBeNull()
  })

  it('caps a runaway banner', () => {
    const long = '  ⚠ Usage limit reached · limit resets 6:20pm ' + 'x'.repeat(400)
    const wall = detectQuotaWall(['', SEP, '❯ ', SEP, long].join('\n'))
    expect(wall).not.toBeNull()
    expect(wall!.banner.length).toBeLessThanOrEqual(220)
    expect(wall!.banner.endsWith('…')).toBe(true)
    // "6:20pm xxxx..." is not a time the alert could quote.
    expect(wall!.resetsAt).toBeNull()
  })
})
