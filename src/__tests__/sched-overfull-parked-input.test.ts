/**
 * SCHEDLOST915: a scheduled prompt parked in an input box taller than the pane.
 *
 * Reproduced 2026-09-15 on Claude Code 2.1.110 in an 80x24 tmux pane (the
 * main channels session's default size): a 6735-char prompt typed as 80-char
 * chunks with an immediate Enter parked in 3 of 6 rounds. The box's top
 * separator and the ❯ glyph scrolled off the capture, so detectPaneState read
 * 'idle' and every parked-input probe read "nothing parked". On the live host
 * the watchdog declared those rounds lost and typed the redelivery on top of
 * the parked copy. Settle-then-Enter submitted 6/6; a settled bare Enter
 * recovered 3/3 parked rounds.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { detectPaneState, overfullParkedInputTail } from '../pane-state.js'
import { isOwnPromptParkedOverfull, isScheduledPromptStuck } from '../web/schedule-runner.js'
import { waitForPaneSettle } from '../web/agent-process.js'

const SEP = '─'.repeat(80)
const FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle)'

// The reproduced capture's SHAPE with neutral prose: wrapped prompt rows from
// the top of the pane down, no top separator, no ❯, then the bottom separator
// and the idle footer.
const PROMPT = [
  'SCHEDULED TASK NOTICE -- the next <scheduled-task source="..."> ... </scheduled-task>',
  'block is one of YOUR OWN scheduled tasks.',
  'Step one: read the state file. Step two: decide whether anything changed since',
  'the previous round. Step three: if nothing changed, end the round without any',
  'action and without typing into the input box. Step four: write the closing',
  'stamp on every branch, including the silent one, so a skipped round is',
  'distinguishable from a round that never ran. </scheduled-task>',
].join(' ')

function wrap(text: string, width = 76): string[] {
  const rows: string[] = []
  let row = ''
  for (const word of text.split(' ')) {
    if ((row + ' ' + word).trim().length > width) { rows.push('  ' + row.trim()); row = word } else row += ' ' + word
  }
  if (row.trim()) rows.push('  ' + row.trim())
  return rows
}

const OVERFULL = [...wrap(PROMPT).slice(-5), SEP, FOOTER, ''].join('\n')

const IDLE = ['  ● OK', '', SEP, '❯ ', SEP, FOOTER, ''].join('\n')
const PARKED_FITS = ['  ● OK', '', SEP, '❯ ' + 'short parked text that fits the box', SEP, FOOTER, ''].join('\n')
const BUSY_OVERFULL = [...wrap(PROMPT).slice(-5), SEP, FOOTER + ' · esc to interrupt', ''].join('\n')

const record = (text: string) => ({ text, at: Date.now() })

describe('overfullParkedInputTail', () => {
  it('pins the blind spot: detectPaneState reads the overfull parked box as idle', () => {
    expect(detectPaneState(OVERFULL)).toBe('idle')
    expect(isScheduledPromptStuck(OVERFULL, '[Heartbeat: memoria-heartbeat]')).toBe(false)
  })

  it('returns the visible tail of a box whose top scrolled off', () => {
    const tail = overfullParkedInputTail(OVERFULL)
    expect(tail).not.toBeNull()
    expect(tail!.endsWith('</scheduled-task>')).toBe(true)
  })

  it('is null for an empty idle box and for a parked box that fits', () => {
    expect(overfullParkedInputTail(IDLE)).toBeNull()
    expect(overfullParkedInputTail(PARKED_FITS)).toBeNull()
  })

  it('is null while the pane is busy', () => {
    expect(overfullParkedInputTail(BUSY_OVERFULL)).toBeNull()
  })

  it('is null without an idle footer or a bottom separator', () => {
    expect(overfullParkedInputTail(wrap(PROMPT).join('\n'))).toBeNull()
    expect(overfullParkedInputTail([...wrap(PROMPT), FOOTER].join('\n'))).toBeNull()
    expect(overfullParkedInputTail('')).toBeNull()
  })

  it('starts at the ❯ row when it is still visible, excluding scrollback above it', () => {
    const pane = ['  earlier reply text', '❯ ' + wrap(PROMPT)[0].trim(), ...wrap(PROMPT).slice(1, 3), SEP, FOOTER].join('\n')
    const tail = overfullParkedInputTail(pane)!
    expect(tail.startsWith('SCHEDULED TASK NOTICE')).toBe(true)
    expect(tail).not.toContain('earlier reply text')
  })
})

describe('isOwnPromptParkedOverfull', () => {
  it('true when the visible tail is part of the prompt this process typed', () => {
    expect(isOwnPromptParkedOverfull(OVERFULL, record(PROMPT))).toBe(true)
  })

  it('false for text we did not type: a human draft never gets an Enter', () => {
    expect(isOwnPromptParkedOverfull(OVERFULL, record('a completely different inter-agent message body'))).toBe(false)
    expect(isOwnPromptParkedOverfull(OVERFULL, null)).toBe(false)
  })

  it('false when nothing is parked or the capture failed', () => {
    expect(isOwnPromptParkedOverfull(IDLE, record(PROMPT))).toBe(false)
    expect(isOwnPromptParkedOverfull(null, record(PROMPT))).toBe(false)
  })
})

describe('waitForPaneSettle', () => {
  function clock() {
    let t = 0
    return { now: () => t, sleep: async (ms: number) => { t += ms } }
  }

  it('resolves true once two consecutive captures match', async () => {
    const frames = ['a', 'b', 'c', 'c']
    const c = clock()
    expect(await waitForPaneSettle(() => frames.shift() ?? 'c', { ...c, pollMs: 250, maxMs: 5000 })).toBe(true)
    expect(c.now()).toBe(750)
  })

  it('gives up after maxMs of continuous change', async () => {
    let n = 0
    const c = clock()
    expect(await waitForPaneSettle(() => String(n++), { ...c, pollMs: 250, maxMs: 1000 })).toBe(false)
    expect(c.now()).toBe(1000)
  })

  it('never treats failed captures as settled', async () => {
    const c = clock()
    expect(await waitForPaneSettle(() => null, { ...c, pollMs: 250, maxMs: 750 })).toBe(false)
  })
})

describe('wiring', () => {
  const RUNNER = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')
  const AGENT = readFileSync(join(__dirname, '../web/agent-process.ts'), 'utf-8')

  it('the post-send resubmit ladder also sees an overfull parked prompt', () => {
    expect(RUNNER).toMatch(/isScheduledPromptStuck\(pane, marker\)\s*\|\| isOwnPromptParkedOverfull\(pane, getInjectedPrompt\(session\)\)/)
  })

  it('the sweep presses at most one Enter per entry before the ordinary lost path', () => {
    expect(RUNNER).toMatch(/decision === 'lost' && !entry\.parkedEnterSent && isOwnPromptParkedOverfull/)
    expect(RUNNER).toMatch(/entry\.parkedEnterSent = true/)
  })

  it('a multi-chunk prompt waits for the pane to settle before its Enter', () => {
    expect(AGENT).toMatch(/if \(oneLine\.length > CHUNK\) await waitForPaneSettle\(\(\) => capturePane\(session, host\)\)\s*\n\s*runTmux\(host, \['send-keys', '-t', session, 'Enter'\]/)
  })
})
