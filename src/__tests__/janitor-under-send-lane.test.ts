import { describe, it, expect, vi, beforeEach } from 'vitest'

// PANEWRITERS910: behavioural pin for the two not-ready-path janitors under
// the per-pane send lane. Both fire raw send-keys and are driven by timers
// independent of the delivery path (message-router tick, schedule-runner tick,
// inbox-nudge-watcher, telegram-inbox-wake), so a delivery pausing past
// clearStaleParkedInput's 2s stability window looks exactly like a stale
// parked line -- the IDENTLANE910 splice class. The contract pinned here:
//   - lane HELD by a delivery -> both janitors return false and send NOTHING;
//   - lane free               -> both act (positive control, so a broken
//                                acquire cannot pass as "safely skipped");
//   - lockMode 'held'         -> clearStaleParkedInput still acts (the
//                                schedule-runner reinject site owns the lane;
//                                a re-acquire there would self-deadlock into
//                                a permanent false skip).
//
// Same harness as parked-input-escalation.test.ts: capturePane/runTmux are
// LOCAL to agent-process and go through node:child_process execFileSync, so we
// mock execFileSync with arg-inspection. session-send-lock is deliberately NOT
// mocked -- the test holds the real lane the way a real delivery does.

const h = vi.hoisted(() => {
  const SEP = '─'.repeat(80)
  const FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
  // Real, normal-intensity parked line (survives the dim strip).
  const PARKED = ['', SEP, '❯ Csendes heartbeat.', SEP, FOOTER].join('\n')
  // The self-drafted feedback modal: bordered option line ABOVE the prompt
  // marker, idle footer, no busy indicators -- detectsFeedbackDraftModal fires.
  const MODAL = [
    '╭──────────────────────────────────────────────╮',
    '│ ✻ Bug report drafted: sample summary…        │',
    '│ 1 to review · 2 to send · 0 to dismiss       │',
    '╰──────────────────────────────────────────────╯',
    '', SEP, '❯ ', SEP, FOOTER,
  ].join('\n')
  return { PARKED, MODAL, pane: PARKED, calls: [] as string[][] }
})

vi.mock('node:child_process', async (orig) => ({
  ...(await orig() as object),
  execFileSync: vi.fn((_file: string, args?: string[]) => {
    if (Array.isArray(args)) {
      h.calls.push(args)
      if (args.includes('capture-pane')) return h.pane
    }
    return ''
  }),
}))
vi.mock('../notify.js', () => ({ notifyChannel: vi.fn(async () => {}), notifyTelegram: vi.fn(async () => {}) }))

import { clearStaleParkedInput, clearFeedbackModalAndRecheck } from '../web/agent-process.js'
import { tryAcquireSessionSendLane, __resetSessionSendLocks } from '../web/session-send-lock.js'

function sentKeys(): string[][] {
  return h.calls.filter(a => a.includes('send-keys'))
}

beforeEach(() => {
  h.calls.length = 0
  __resetSessionSendLocks()
})

describe('clearStaleParkedInput under the send lane', () => {
  // Distinct session per case: the module-level cooldown map keys on session,
  // so reusing one would turn a later case into a cooldown skip.
  it('skips fail-closed while a delivery holds the lane: false, zero keystrokes', async () => {
    h.pane = h.PARKED
    const release = tryAcquireSessionSendLane('subagent-lane-busy', null)!
    try {
      expect(await clearStaleParkedInput('subagent-lane-busy')).toBe(false)
    } finally {
      release()
    }
    expect(sentKeys().length).toBe(0)
  })

  it('positive control: with the lane free the clear sequence fires', async () => {
    h.pane = h.PARKED
    await clearStaleParkedInput('subagent-lane-free')
    expect(sentKeys().length).toBeGreaterThan(0)
  }, 15_000) // real 2s stable-confirm + clear-settle delays

  it("lockMode 'held': acts even though the caller owns the lane (no self-deadlock skip)", async () => {
    h.pane = h.PARKED
    const release = tryAcquireSessionSendLane('subagent-lane-held', null)!
    try {
      await clearStaleParkedInput('subagent-lane-held', null, { lockMode: 'held' })
    } finally {
      release()
    }
    expect(sentKeys().length).toBeGreaterThan(0)
  }, 15_000)
})

describe('clearFeedbackModalAndRecheck under the send lane', () => {
  it('skips fail-closed while a delivery holds the lane: false, zero keystrokes', async () => {
    h.pane = h.MODAL
    const release = tryAcquireSessionSendLane('subagent-modal-busy', null)!
    try {
      expect(await clearFeedbackModalAndRecheck('subagent-modal-busy')).toBe(false)
    } finally {
      release()
    }
    expect(sentKeys().length).toBe(0)
  })

  it("positive control: with the lane free the dismissal '0' fires", async () => {
    h.pane = h.MODAL
    await clearFeedbackModalAndRecheck('subagent-modal-free')
    expect(sentKeys().some(a => a[a.length - 1] === '0')).toBe(true)
  }, 15_000)
})
