import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

// MAINBOXPARK816: two-stage escalation for a REAL parked line on the MAIN box.
// The absolute rule stays: the main box is NEVER auto-cleared. What changed:
// the 2026-06-30 total mute aged out (its premise -- dim ghost noise -- is
// handled by the dim-guard BEFORE this branch), so a persistent real parked
// line now (1) becomes visible to the heartbeat round via getMainParkedState,
// and (2) after double the first threshold notifies the OWNER once, with the
// concrete manual fix. The alert deliberately does NOT travel the inter-agent
// queue: a message queued to the main agent would strand behind the very text
// it reports.

const h = vi.hoisted(() => {
  const SEP = '─'.repeat(80)
  const FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
  const LINE = '❯ Igen, írd meg Baloghnak a választ'
  const PARKED = ['', SEP, LINE, SEP, FOOTER].join('\n')
  return { PARKED, calls: [] as string[][] }
})

vi.mock('node:child_process', async (orig) => ({
  ...(await orig() as object),
  execFileSync: vi.fn((_file: string, args?: string[]) => {
    if (Array.isArray(args)) {
      h.calls.push(args)
      if (args.includes('capture-pane')) return h.PARKED
    }
    return ''
  }),
}))
vi.mock('../notify.js', () => ({ notifyChannel: vi.fn(async () => {}), notifyTelegram: vi.fn(async () => {}) }))

import {
  clearStaleParkedInput,
  decideMainParkedEscalation,
  getMainParkedState,
  MAIN_PARKED_HEARTBEAT_AFTER,
  MAIN_PARKED_OWNER_AFTER,
} from '../web/agent-process.js'
import { notifyChannel } from '../notify.js'
import { MAIN_CHANNELS_SESSION } from '../web/main-agent.js'

let clock = 1_000_000
const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock)
const COOLDOWN = 31_000 // > UNWEDGE_COOLDOWN_MS so each call is a fresh round

function clearKeystrokes(): string[][] {
  return h.calls.filter(a => a.includes('send-keys') && (a.includes('C-u') || a.includes('C-k')))
}

beforeEach(() => {
  h.calls.length = 0
  vi.mocked(notifyChannel).mockClear()
})
afterAll(() => { nowSpy.mockRestore() })

describe('decideMainParkedEscalation (pure)', () => {
  it('below the heartbeat threshold: none', () => {
    expect(decideMainParkedEscalation(MAIN_PARKED_HEARTBEAT_AFTER - 1, false)).toBe('none')
  })
  it('at the heartbeat threshold: heartbeat', () => {
    expect(decideMainParkedEscalation(MAIN_PARKED_HEARTBEAT_AFTER, false)).toBe('heartbeat')
  })
  it('the owner threshold is DOUBLE the heartbeat one (the spec ladder)', () => {
    expect(MAIN_PARKED_OWNER_AFTER).toBe(2 * MAIN_PARKED_HEARTBEAT_AFTER)
  })
  it('at the owner threshold, not yet notified: owner (one-shot latch)', () => {
    expect(decideMainParkedEscalation(MAIN_PARKED_OWNER_AFTER, false)).toBe('owner')
    expect(decideMainParkedEscalation(MAIN_PARKED_OWNER_AFTER, true)).toBe('heartbeat')
    expect(decideMainParkedEscalation(MAIN_PARKED_OWNER_AFTER + 5, true)).toBe('heartbeat')
  })
})

describe('main box escalation through clearStaleParkedInput (call-site behavior)', () => {
  it('never clears, notifies the owner ONCE past the owner threshold, with the concrete fix', async () => {
    for (let i = 0; i < MAIN_PARKED_OWNER_AFTER + 3; i++) {
      await clearStaleParkedInput(MAIN_CHANNELS_SESSION)
      clock += COOLDOWN
    }
    // The absolute rule: not a single clearing keystroke reached the main box.
    expect(clearKeystrokes()).toHaveLength(0)
    // Owner notified exactly once per episode, and the message is actionable:
    // names the session and the exact keys (three-second manual fix).
    expect(notifyChannel).toHaveBeenCalledTimes(1)
    const msg = vi.mocked(notifyChannel).mock.calls[0]![0]
    expect(msg).toContain(`tmux attach -t ${MAIN_CHANNELS_SESSION}`)
    expect(msg).toContain('Ctrl-C')
    expect(msg).toContain('Ctrl-U')
  }, 60_000) // 15 sequential real 2s stable-confirm delays (same pattern as parked-input-escalation)

  it('exposes the state to the heartbeat surface past the first threshold, and goes stale after the box clears', async () => {
    for (let i = 0; i < MAIN_PARKED_HEARTBEAT_AFTER; i++) {
      await clearStaleParkedInput(MAIN_CHANNELS_SESSION)
      clock += COOLDOWN
    }
    const state = getMainParkedState(clock)
    expect(state).not.toBeNull()
    expect(state!.fails).toBeGreaterThanOrEqual(MAIN_PARKED_HEARTBEAT_AFTER)
    expect(state!.preview.length).toBeGreaterThan(0)
    // Once the router stops observing the episode (box cleared / text gone),
    // the state must go stale on its own -- a live-looking alert about a
    // resolved wedge would be the false-heartbeat class.
    clock += 10 * COOLDOWN
    expect(getMainParkedState(clock)).toBeNull()
  }, 30_000) // 6 sequential real 2s stable-confirm delays
})

import { formatMainParkedSection } from '../heartbeat.js'

describe('formatMainParkedSection (heartbeat stage-1 surface)', () => {
  it('empty string when nothing to report -- the normal prompt stays byte-identical', () => {
    expect(formatMainParkedSection(null)).toBe('')
  })
  it('names the duration and wraps the parked preview as untrusted', () => {
    const s = formatMainParkedSection({ preview: 'valami parkolt sor', fails: 7, approxMinutes: 4 })
    expect(s).toContain('FO-AGENS INPUT-BOX PARKOLT')
    expect(s).toContain('~4 perce')
    expect(s).toContain('valami parkolt sor')
    expect(s).toContain('NEM szabad nyulni')
  })
})
