import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parkedClearSequence } from '../pane-state.js'

// 2026-08-01, measured on a wedged MAIN pane that had accumulated 489 characters
// of scheduled-task text over 7 visible rows.
//
// The old sequence was `C-u` x3, then `C-a` + `C-k`, then `C-u` x3 again, and it
// removed NOTHING across repeated runs. The reason is the cursor position: a
// literal string sent with tmux send-keys lands in FRONT of the parked text
//
//     before:  len=489  "the user if it looks wrong. The wrapper marks prov"
//     +MARKER: len=498  "MARKER123the user if it looks wrong. The wrapper m"
//     after C-u: len=489 "the user if it looks wrong. The wrapper marks prov"
//
// so the cursor sits at OFFSET 0. `C-u` kills BACKWARDS to the start of the
// line, finds nothing before the cursor, and is a no-op on every round -- it
// only ever removed the marker that had just been typed in front of it. The
// single `C-a` + `C-k` escalation then clears exactly ONE line, so a multi-line
// box could never be emptied: with PARKED_CLEAR_MAX = 3 the whole cascade could
// remove at most one line and then failed its own verification.
//
// Forward deletion drains it: `C-k` kills to end of line, `Delete` eats the
// newline joining the next one. The live box took 20 such rounds to reach zero.

const ROOT = join(__dirname, '..', '..')
const AGENT_PROCESS = readFileSync(join(ROOT, 'src', 'web', 'agent-process.ts'), 'utf-8')

describe('parkedClearSequence', () => {
  it('starts at the beginning of the buffer so the first kill has something ahead of it', () => {
    expect(parkedClearSequence(1)[0]).toBe('C-a')
  })

  it('deletes FORWARD -- C-u is a no-op with the cursor at offset 0', () => {
    const seq = parkedClearSequence(7)
    expect(seq).toContain('C-k')
    expect(seq).toContain('Delete')
    expect(seq).not.toContain('C-u')
  })

  it('pairs every kill with a newline-eating Delete', () => {
    const seq = parkedClearSequence(4)
    expect(seq.filter((k) => k === 'C-k').length).toBe(seq.filter((k) => k === 'Delete').length)
  })

  it('scales past the measured need: a 7-row box drained in 20 rounds', () => {
    expect(parkedClearSequence(7).filter((k) => k === 'C-k').length).toBeGreaterThanOrEqual(20)
  })

  it('keeps a workable floor for a single-row box', () => {
    expect(parkedClearSequence(1).filter((k) => k === 'C-k').length).toBeGreaterThanOrEqual(8)
  })

  it('never returns an unbounded sequence for an absurd row count', () => {
    expect(parkedClearSequence(9999).length).toBeLessThan(600)
  })
})

describe('clearStaleParkedInput uses the sequence instead of the old C-u cascade', () => {
  // Source-level: the function drives real tmux against a live session, so the
  // behaviour that matters is which keystrokes it emits, not what tmux does.
  it('drives its keystrokes from parkedClearSequence', () => {
    expect(AGENT_PROCESS).toContain('parkedClearSequence')
  })

  it('no longer sends a bare C-u round anywhere in the module', () => {
    const offenders = AGENT_PROCESS.split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /send-keys'[^\n]*'C-u'/.test(line))
      .map(({ n }) => n)
    expect(offenders).toEqual([])
  })

  // The pre-flight clear had the same single-Ctrl-U defect, and a silent failure
  // there is worse than no clear at all: the prompt about to be typed is
  // APPENDED to the stale text. That is how the live box accumulated 489
  // characters across successive scheduled ticks until nothing could submit.
  it('clearInputBuffer also drives the sequence, so a pre-flight clear cannot silently no-op', () => {
    const fn = AGENT_PROCESS.slice(AGENT_PROCESS.indexOf('export async function clearInputBuffer'))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    expect(body).toContain('parkedClearSequence')
  })

  // 2026-09-04 incident: driving the right key sequence is not enough if nobody
  // checks the box afterwards. The clear-scheduled path fired, left a truncated
  // fragment behind, and that leftover read as a human draft on every later
  // restart decision -- the session sat wedged 25.4h. The clear must therefore
  // VERIFY emptiness, retry, and report failure to its caller.
  it('clearInputBuffer verifies the box is empty, retries, and returns the outcome', () => {
    const fn = AGENT_PROCESS.slice(AGENT_PROCESS.indexOf('export async function clearInputBuffer'))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    // re-reads the pane after sending the keys
    expect(body).toContain('stuckInputSignature')
    // bounded retry rather than a single fire-and-forget pass
    expect(body).toContain('CLEAR_INPUT_MAX_ATTEMPTS')
    // the caller can tell a clean clear from a leftover
    expect(body).toContain('return true')
    expect(body).toContain('return false')
  })

  it('the signature is boolean, so callers are able to branch on a failed clear', () => {
    expect(AGENT_PROCESS).toContain('export async function clearInputBuffer(session: string, host: string | null = null): Promise<boolean>')
  })

  // Both clear-only recovery actions must surface a failed clear; a silent
  // "cleared" log for a box that still holds text is what hid the 09-03 wedge.
  it('both clear-only recovery paths log when the box did not empty', () => {
    const monitor = readFileSync(new URL('../web/channel-monitor.ts', import.meta.url), 'utf8')
    const preamble = monitor.slice(monitor.indexOf("case 'clear-preamble'"), monitor.indexOf("case 'enter'"))
    expect(preamble).toContain('left text in the box')
    expect(preamble).toContain('left a fragment in the box')
  })
})
