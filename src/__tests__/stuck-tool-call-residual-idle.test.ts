// #2989: the stuck-tool-call watcher respawned an idle main session ~4 minutes after a completed
// scheduled turn of 20 s or longer, and its idle-prompt guard (detectPaneState(pane) === 'idle') did not
// skip it. The report asked which state the guard sees when the footer region holds the past-tense
// residual of a COMPLETED turn ("✻ Baked for 33s"). Measured here on a real capture of an idle fleet
// agent (Claude Code 2.1.328, tmux capture-pane -p, last 8 lines verbatim) and on the shape variants the
// report names: the residual alone keeps the pane 'idle' and still carries the signature that opens the
// spell. So the residual is not what turned the guard off; the 7 reported panes held something else, and
// the recovery WARN now logs paneState + paneTail to show what.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { detectPaneState, stuckToolCallSignature } from '../pane-state.js'

const REAL = readFileSync(join(__dirname, 'fixtures/pane/idle-past-tense-residual-2.1.328.txt'), 'utf8')
const RESIDUAL_RX = /^✻ Baked for 10s · done 11:59 AM$/m

describe('a completed turn\'s past-tense residual above a live idle prompt (#2989)', () => {
  it('the real capture reads idle and still yields the residual signature', () => {
    expect(REAL).toMatch(RESIDUAL_RX)
    expect(detectPaneState(REAL)).toBe('idle')
    expect(stuckToolCallSignature(REAL)).toEqual({ tag: 'baked', seconds: 10 })
  })

  it.each([
    ['the reported tags and counts', '✻ Worked for 22s · done 3:15 PM', 'worked', 22],
    ['brewed, without the "· done" suffix', '✻ Brewed for 27s', 'brewed', 27],
    ['baked, with a background shell still running', '✻ Baked for 33s · done 10:16 AM · 1 shell still running', 'baked', 33],
  ])('%s: still idle', (_name, residual, tag, seconds) => {
    const pane = REAL.replace(RESIDUAL_RX, residual)
    expect(detectPaneState(pane)).toBe('idle')
    expect(stuckToolCallSignature(pane)).toEqual({ tag, seconds })
  })

  it('a pane drawn high (blank rows below the footer) is still idle', () => {
    expect(detectPaneState(REAL + '\n'.repeat(20))).toBe('idle')
  })

  it('the residual right above the box (no context-usage line between) is still idle', () => {
    expect(detectPaneState(REAL.replace(/^\s+\d+% context used\n/m, ''))).toBe('idle')
  })
})
