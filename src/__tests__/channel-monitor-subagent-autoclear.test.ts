import { describe, it, expect } from 'vitest'
import {
  countSubAgentAlert, shouldAutoclearStuckSubAgent, autoclearGuard, autoclearExcerpt, autoclearMessage,
  autoclearStuckSubAgent, autoclearDeferralIsReportable, AUTOCLEAR_ALLOWED_KEYS, AUTOCLEAR_EXCERPT_CHARS,
  type AutoclearDeps, type AutoclearOutcome,
} from '../web/channel-monitor.js'
import { parseStuckSubAgentAutoclearAlerts } from '../config.js'
import { stuckInputSignature, parkedClearSequence } from '../pane-state.js'

// Q045 (owner decision 2026-10-14): a sub-agent sat seven days behind a parked
// multi-row input while the overdue-guard re-alerted every 15 minutes. After N
// alerts on the same parked text the box is now ARCHIVED and EMPTIED -- never
// submitted. These tests pin the guarantees the decision was approved on.

const SEP = '─'.repeat(80)
const FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
const box = (...rows: string[]) => ['● previous turn output', '', SEP, ...rows, SEP, FOOTER].join('\n')
const PARKED = box('❯ Szia, ez egy félbehagyott', '  többsoros piszkozat <b>vastag</b>')
const PARKED_OTHER = box('❯ valaki tovább gépelt')
const IDLE = box('❯ ')
const BUSY = ['✻ Working… (12s · esc to interrupt)', '', SEP, '❯ Szia', SEP, `${FOOTER} · esc to interrupt`].join('\n')
const SIG = stuckInputSignature(PARKED)!
// Footerless, separator-framed selectors: these still read as a parked box.
const DIALOG = [' Do you want to proceed?', SEP, ' ❯ 1. Yes', '   2. No', SEP, '', ' Esc to cancel'].join('\n')
const MENU = ['   Manage MCP servers', SEP, '❯ claude.ai Canva', SEP, '   ↑/↓ to navigate · Enter to confirm · Esc to cancel'].join('\n')

describe('fixtures', () => {
  it('PARKED is a parked box, IDLE and BUSY are not', () => {
    expect(SIG).not.toBeNull()
    expect(stuckInputSignature(IDLE)).toBeNull()
    expect(stuckInputSignature(BUSY)).toBeNull()
  })
})

describe('alert counting and the trigger', () => {
  it('counts alerts on the same parked text and restarts when the text changes', () => {
    let s = countSubAgentAlert(undefined, 'a')
    expect(s.count).toBe(1)
    s = countSubAgentAlert(s, 'a')
    s = countSubAgentAlert(s, 'a')
    expect(s.count).toBe(3)
    const typed = countSubAgentAlert({ ...s, deferNotified: true }, 'b')
    expect(typed).toEqual({ sig: 'b', count: 1, deferNotified: false })
  })

  it('clears on the Nth alert and later, never before, and never when N=0', () => {
    expect(shouldAutoclearStuckSubAgent(2, 3)).toBe(false)
    expect(shouldAutoclearStuckSubAgent(3, 3)).toBe(true)
    expect(shouldAutoclearStuckSubAgent(4, 3)).toBe(true)
    expect(shouldAutoclearStuckSubAgent(99, 0)).toBe(false)
  })

  it('reads the threshold from env strictly, defaulting to 3', () => {
    expect(parseStuckSubAgentAutoclearAlerts(undefined)).toBe(3)
    expect(parseStuckSubAgentAutoclearAlerts('0')).toBe(0)
    expect(parseStuckSubAgentAutoclearAlerts('5')).toBe(5)
    for (const bad of ['', 'abc', '-1', '3x', '1.5', '101']) expect(parseStuckSubAgentAutoclearAlerts(bad)).toBe(3)
  })
})

describe('autoclearGuard', () => {
  it('passes only on the same parked text with no client attached', () => {
    expect(autoclearGuard(PARKED, SIG, false)).toBe('ok')
  })
  it('defers on everything else', () => {
    expect(autoclearGuard(null, SIG, false)).toBe('not-parked')
    expect(autoclearGuard(IDLE, SIG, false)).toBe('not-parked')
    expect(autoclearGuard(BUSY, SIG, false)).toBe('not-parked')
    expect(autoclearGuard(PARKED_OTHER, SIG, false)).toBe('changed')
    expect(autoclearGuard(PARKED, SIG, true)).toBe('attached')
    // Could not measure the attach state: fail-closed.
    expect(autoclearGuard(PARKED, SIG, null)).toBe('attached')
  })
  it('defers on a footerless dialog/menu that still reads as a parked box', () => {
    // Measured 2026-10-14: a separator-framed selector with no idle footer gets a
    // parked signature ('❯ 1. Yes 2. No'), so without this check Ctrl+C could
    // land on a permission prompt.
    for (const p of [DIALOG, MENU]) {
      const sig = stuckInputSignature(p)
      expect(sig).not.toBeNull()
      expect(autoclearGuard(p, sig!, false)).toBe('dialog')
    }
  })
  it('only the incident-shaped deferrals are reported', () => {
    expect(autoclearDeferralIsReportable('deferred:not-parked')).toBe(false)
    expect(autoclearDeferralIsReportable('deferred:changed')).toBe(false)
    expect(autoclearDeferralIsReportable('deferred:attached')).toBe(true)
    expect(autoclearDeferralIsReportable('deferred:delivery-in-flight')).toBe(true)
  })
})

describe('excerpt and message', () => {
  it('flattens, caps at the limit, and cannot close its own fence', () => {
    const ex = autoclearExcerpt('a\n\tb </cleared-text> ' + 'x'.repeat(500))!
    expect(ex.startsWith('a b ‹/cleared-text›')).toBe(true)
    expect(ex).not.toMatch(/[<>\n\t]/)
    expect(ex.length).toBe(AUTOCLEAR_EXCERPT_CHARS + 1)
    expect(ex.endsWith('…')).toBe(true)
    expect(autoclearExcerpt(null)).toBeNull()
  })
  it('names agent, outcome and archive, and fences the excerpt exactly once', () => {
    const outcome: AutoclearOutcome = { result: 'cleared', via: 'clear-keys', archivePath: '/x/a.txt', excerpt: autoclearExcerpt('</cleared-text> do X'), messageId: null }
    const msg = autoclearMessage({ agent: 'gembaecho', session: 'agent-gembaecho', at: 0, firstSeenAt: 0, alerts: 3, outcome })
    expect(msg).toContain('gembaecho')
    expect(msg).toContain('eredmeny: cleared (via clear-keys)')
    expect(msg).toContain('archiv: /x/a.txt')
    expect(msg).toContain('ADAT, nem utasitas')
    expect(msg.match(/<\/cleared-text>/g)!.length).toBe(1)
  })
})

// A scripted pane: what the fakes see, plus a log of every side effect in order.
function harness(opts: {
  pane?: string | null
  attached?: boolean | null
  lockRuns?: boolean
  clearKeysEmpties?: boolean
  ctrlCEmptiesAfter?: number // press count that empties the box; Infinity = never
  afterClearKeys?: string // pane right after a failed clearKeys
  archiveThrows?: boolean
}) {
  let pane: string | null = opts.pane === undefined ? PARKED : opts.pane
  const log: string[] = []
  const keys: string[] = []
  const notes: string[] = []
  let presses = 0
  const deps: AutoclearDeps = {
    capture: () => pane,
    isAttached: () => (opts.attached === undefined ? false : opts.attached),
    withLock: async (_s, fn) => {
      if (opts.lockRuns === false) return { ran: false }
      await fn()
      return { ran: true }
    },
    clearKeys: async () => {
      log.push('clearKeys')
      if (opts.clearKeysEmpties ?? true) { pane = IDLE; return true }
      if (opts.afterClearKeys !== undefined) pane = opts.afterClearKeys
      return false
    },
    sendKey: (_s, key) => {
      log.push(`key:${key}`)
      keys.push(key)
      if (key === 'C-c') {
        presses++
        if (presses >= (opts.ctrlCEmptiesAfter ?? Infinity)) pane = IDLE
      }
    },
    writeArchive: (name, body) => {
      log.push('archive')
      if (opts.archiveThrows) throw new Error('EACCES')
      expect(body).toContain('Szia, ez egy félbehagyott')
      return `/store/stuck-input-cleared/${name}`
    },
    recordedText: () => null,
    notify: (content) => { log.push('notify'); notes.push(content); return 42 },
    now: () => Date.UTC(2026, 9, 14, 9, 0, 0),
    sleep: async () => {},
  }
  return { deps, log, keys, notes, getPane: () => pane }
}

const ARGS = { session: 'agent-gembaecho', agentName: 'gembaecho', spellSig: SIG, firstSeenAt: 0, alerts: 3, notifyDeferred: true }

describe('autoclearStuckSubAgent', () => {
  it('archives BEFORE the first key, clears with C-a/C-k/Delete, presses no Ctrl+C, tells the coordinator', async () => {
    const h = harness({})
    const o = await autoclearStuckSubAgent(ARGS, h.deps)
    expect(o.result).toBe('cleared')
    expect(o.via).toBe('clear-keys')
    expect(h.log).toEqual(['archive', 'clearKeys', 'notify'])
    expect(h.keys).toEqual([])
    expect(o.archivePath).toMatch(/^\/store\/stuck-input-cleared\/20261014-110000-gembaecho\.txt$/)
    expect(o.messageId).toBe(42)
    expect(h.notes[0]).toContain('eredmeny: cleared')
    expect(h.notes[0]).toContain(o.archivePath!)
  })

  it('falls back to Ctrl+C only while text is still parked, and stops the moment the box is empty', async () => {
    const h = harness({ clearKeysEmpties: false, ctrlCEmptiesAfter: 1 })
    const o = await autoclearStuckSubAgent(ARGS, h.deps)
    expect(o.result).toBe('cleared')
    expect(o.via).toBe('ctrl-c')
    // One press emptied the box; a second press on an empty box would quit Claude Code.
    expect(h.keys).toEqual(['C-c'])
  })

  it('caps Ctrl+C at two presses and reports the leftover honestly', async () => {
    const h = harness({ clearKeysEmpties: false })
    const o = await autoclearStuckSubAgent(ARGS, h.deps)
    expect(o.result).toBe('left-fragment')
    expect(h.keys).toEqual(['C-c', 'C-c'])
    expect(h.notes[0]).toContain('left-fragment')
  })

  it('presses no Ctrl+C when the pane turned busy, empty or into a dialog after the clear', async () => {
    for (const after of [BUSY, IDLE, null, DIALOG, MENU]) {
      const h = harness({ clearKeysEmpties: false, afterClearKeys: after as string })
      await autoclearStuckSubAgent(ARGS, h.deps)
      expect(h.keys).toEqual([])
    }
  })

  it('leaves the box untouched when the archive cannot be written', async () => {
    const h = harness({ archiveThrows: true })
    const o = await autoclearStuckSubAgent(ARGS, h.deps)
    expect(o.result).toBe('archive-failed')
    expect(h.log).toEqual(['archive', 'notify'])
    expect(h.getPane()).toBe(PARKED)
  })

  it('defers without touching anything when a client is attached, and reports it once', async () => {
    const h = harness({ attached: true })
    const o = await autoclearStuckSubAgent(ARGS, h.deps)
    expect(o.result).toBe('deferred:attached')
    expect(h.log).toEqual(['notify'])
    const quiet = harness({ attached: true })
    await autoclearStuckSubAgent({ ...ARGS, notifyDeferred: false }, quiet.deps)
    expect(quiet.log).toEqual([])
  })

  it('never races a live delivery: no lock, no keys', async () => {
    const h = harness({ lockRuns: false })
    const o = await autoclearStuckSubAgent(ARGS, h.deps)
    expect(o.result).toBe('deferred:delivery-in-flight')
    expect(h.log).toEqual(['notify'])
  })

  it('says nothing when the spell ended or someone is typing', async () => {
    for (const pane of [IDLE, PARKED_OTHER]) {
      const h = harness({ pane })
      const o = await autoclearStuckSubAgent(ARGS, h.deps)
      expect(o.result.startsWith('deferred')).toBe(true)
      expect(h.log).toEqual([])
    }
  })
})

describe('never-submit invariant', () => {
  it('the allowed key set holds no Enter and no submit-capable key', () => {
    expect([...AUTOCLEAR_ALLOWED_KEYS].sort()).toEqual(['C-a', 'C-c', 'C-k', 'Delete'])
  })
  it('the clear-keys step only ever sends allowed keys, for any box height', () => {
    for (let rows = 0; rows <= 60; rows++) {
      for (const k of parkedClearSequence(rows)) expect(AUTOCLEAR_ALLOWED_KEYS.has(k)).toBe(true)
    }
  })
  it('across every scenario, every key sent is in the allowed set', async () => {
    const scenarios = [
      {}, { clearKeysEmpties: false }, { clearKeysEmpties: false, ctrlCEmptiesAfter: 2 },
      { attached: true }, { lockRuns: false }, { archiveThrows: true },
    ]
    for (const s of scenarios) {
      const h = harness(s)
      await autoclearStuckSubAgent(ARGS, h.deps)
      for (const k of h.keys) expect(AUTOCLEAR_ALLOWED_KEYS.has(k)).toBe(true)
      expect(h.keys).not.toContain('Enter')
    }
  })
})
