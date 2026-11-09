// The voice-channel fast path of the inbox-nudge watcher. A row FROM the voice
// channel (the owner speaking in a live call) is nudged within one fast interval, without the
// steady-stream guards; every other row keeps the 20 s path. The tmux and DB edges are mocked; the
// watcher's own decision and timer code is the real one. Sender ids are neutral fixtures.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const m = vi.hoisted(() => ({
  pending: [] as Array<{ id: number; from_agent: string; to_agent: string; created_at: number }>,
  ready: true,
  sendResult: 'sent' as 'sent' | 'aborted-busy' | 'skipped-locked',
  sendThrows: false,
  sends: [] as number[],
  sendGate: null as Promise<void> | null,
  voiceId: 'hangvonal' as string | null,
  frozen: false,
}))

vi.mock('../db.js', () => ({ getPendingMessages: () => m.pending }))
vi.mock('../delivery-order.js', () => ({ voiceChannelSenderId: () => m.voiceId }))
vi.mock('../web/main-agent.js', () => ({ MAIN_CHANNELS_SESSION: 'fougynok-channels' }))
vi.mock('../web/agent-process.js', () => ({
  sessionExistsOnHost: () => true,
  isSessionReadyForPrompt: async () => m.ready,
  clearFeedbackModalAndRecheck: async () => false,
  sendPromptToSession: async () => {
    m.sends.push(Date.now())
    if (m.sendGate) await m.sendGate
    if (m.sendThrows) throw new Error('tmux gone')
    return m.sendResult
  },
}))
vi.mock('../web/channel-monitor.js', () => ({ sendAlert: () => undefined }))
vi.mock('../web/fleet-freeze.js', () => ({
  whileNotFrozen: (_label: string, fn: (...a: unknown[]) => unknown) => (...a: unknown[]) => (m.frozen ? undefined : fn(...a)),
}))
vi.mock('../settings-store.js', () => ({ getEffectiveSettingValue: () => 'hu' }))
vi.mock('../web/agent-text-lang.js', () => ({ agentFacingLang: () => 'hu' as const }))

import * as W from '../web/inbox-nudge-watcher.js'

const VOICE = 'hangvonal'
const nowSec = () => Math.floor(Date.now() / 1000)
const row = (id: number, from: string, ageSec = 0) => ({ id, from_agent: from, to_agent: 'fougynok', created_at: nowSec() - ageSec })
// Let the async tick bodies (awaits inside the timer callbacks) settle under fake timers.
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

beforeEach(() => {
  W._resetNudgeStateForTest()
  m.pending = []
  m.ready = true
  m.sendResult = 'sent'
  m.sendThrows = false
  m.sends = []
  m.sendGate = null
  m.voiceId = VOICE
  m.frozen = false
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('voice channel: nudged at once', () => {
  it('V1 a voice row is nudged within one fast interval of the running watcher (2 s, not 21-25 s)', async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 })
    const iv = W.startInboxNudgeWatcher()
    m.pending = [row(7, VOICE)]
    await vi.advanceTimersByTimeAsync(2_000)
    await settle()
    expect(m.sends.length).toBe(1)
    clearInterval(iv)
  })

  it('V2 the voice step alone nudges a 1 s old voice row (no MIN_PENDING_AGE, no debounce)', async () => {
    m.pending = [row(7, VOICE, 1)]
    await W.runVoiceNudgeTick()
    expect(m.sends.length).toBe(1)
  })
})

describe('other rows keep the old guards', () => {
  it('V3 a non-voice row is not nudged before the 20 s body runs, then nudged once', async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 })
    const iv = W.startInboxNudgeWatcher()
    m.pending = [row(5, 'tarsugynok')]
    await vi.advanceTimersByTimeAsync(19_000)
    await settle()
    expect(m.sends.length).toBe(0)
    await vi.advanceTimersByTimeAsync(1_000)
    await settle()
    expect(m.sends.length).toBe(1)
    clearInterval(iv)
  })

  it('V4 the voice step ignores a non-voice row, and a lane that is off (voice id null)', async () => {
    m.pending = [row(5, 'tarsugynok', 1)]
    await W.runVoiceNudgeTick()
    m.voiceId = null
    m.pending = [row(6, VOICE, 1)]
    await W.runVoiceNudgeTick()
    expect(m.sends.length).toBe(0)
  })
})

describe('no nudge into a busy session', () => {
  it('V5 not prompt-ready -> nothing typed, and the row is retried once the session is ready', async () => {
    m.pending = [row(7, VOICE)]
    m.ready = false
    await W.runVoiceNudgeTick()
    expect(m.sends.length).toBe(0)
    m.ready = true
    await W.runVoiceNudgeTick()
    expect(m.sends.length).toBe(1)
  })

  it('V6 aborted-busy / a throwing send leave the row un-nudged, so the next step retries', async () => {
    m.pending = [row(7, VOICE)]
    m.sendResult = 'aborted-busy'
    await W.runVoiceNudgeTick()
    m.sendResult = 'sent'
    m.sendThrows = true
    await W.runVoiceNudgeTick()
    m.sendThrows = false
    await W.runVoiceNudgeTick()
    expect(m.sends.length).toBe(3)
    await W.runVoiceNudgeTick()
    expect(m.sends.length).toBe(3) // the third one landed: no more
  })
})

describe('no nudge storm', () => {
  it('V7 a burst of voice rows gets ONE nudge; only a newer voice row gets the next', async () => {
    m.pending = [row(3, VOICE), row(4, VOICE), row(5, VOICE)]
    await W.runVoiceNudgeTick()
    await W.runVoiceNudgeTick()
    await W.runVoiceNudgeTick()
    expect(m.sends.length).toBe(1)
    m.pending = [...m.pending, row(6, VOICE)]
    await W.runVoiceNudgeTick()
    await W.runVoiceNudgeTick()
    expect(m.sends.length).toBe(2)
  })

  it('V8 in the running watcher an undrained voice row gets one nudge in the first 60 s (the 20 s body keeps the debounce floor)', async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 })
    const iv = W.startInboxNudgeWatcher()
    m.pending = [row(7, VOICE), row(8, 'tarsugynok')]
    await vi.advanceTimersByTimeAsync(58_000)
    await settle()
    expect(m.sends.length).toBe(1)
    clearInterval(iv)
  })

  it('V9 the voice step and the 20 s body never send at the same time', async () => {
    // The 20 s body sends first and is still typing (the send is held open); a voice step in that gap
    // must not type a second nudge. (The other order is covered by the debounce floor, V8.)
    let open!: () => void
    m.sendGate = new Promise<void>((r) => { open = r })
    m.pending = [row(8, 'tarsugynok', 30), row(7, VOICE)]
    const b = W.runInboxNudgeTick()
    await settle()
    const a = W.runVoiceNudgeTick()
    await settle()
    open()
    await Promise.all([a, b])
    expect(m.sends.length).toBe(1)
  })

  it('V10 a frozen fleet runs no voice step', async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 })
    m.frozen = true
    const iv = W.startInboxNudgeWatcher()
    m.pending = [row(7, VOICE)]
    await vi.advanceTimersByTimeAsync(6_000)
    await settle()
    expect(m.sends.length).toBe(0)
    clearInterval(iv)
  })

  it('V12 a wall clock that steps back does not push the 20 s body out (the schedule is monotonic)', async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 })
    const iv = W.startInboxNudgeWatcher()
    vi.setSystemTime(1_800_000_000_000 - 3_600_000) // the clock steps back an hour right after the start
    m.pending = [row(9, 'tarsugynok', 30)]
    await vi.advanceTimersByTimeAsync(20_000)
    await settle()
    expect(m.sends.length).toBe(1) // the body ran on its 20 s period, not an hour later
    clearInterval(iv)
  })
})

describe('decideVoiceNudge (pure)', () => {
  it('V11 the newest voice row above the last nudged id; null otherwise', () => {
    const rows = [{ id: 9, from_agent: VOICE }, { id: 4, from_agent: VOICE }, { id: 12, from_agent: 'tarsugynok' }]
    expect(W.decideVoiceNudge(rows, VOICE, 0)).toBe(9)
    expect(W.decideVoiceNudge(rows, VOICE, 9)).toBeNull()
    expect(W.decideVoiceNudge(rows, null, 0)).toBeNull()
    expect(W.decideVoiceNudge([], VOICE, 0)).toBeNull()
  })
})
