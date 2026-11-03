import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Two holes the typed-echo wait (#2135) opened in sendPromptToSession, driven through the REAL
// function over a mocked tmux (the send-prompt-placeholder-recovery.test.ts harness):
//
// #2143: the caller's emitGuard ran before the first key and before each retry key, but not
// before the submitting Enter, which can now come ~35 s after the pre-send look. A pane that
// turns into a permission prompt in that window takes the Enter as its answer.
//
// #2144: each clear-and-resend waited the full echo bound again, so one holder of a frozen pane
// kept the send lane past DEFAULT_DELIVER_WAIT_BUDGET_MS, and the next writer failed open. The
// timing cases below run on vitest's fake clock; `tmuxLatencyMs` makes every tmux call cost that
// much clock time. Typing time is not bounded by the fix (it predates #2135).

const h = vi.hoisted(() => {
  const SEP = '─'.repeat(80)
  const FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
  const box = (input: string) => ['  ⎿  Done', '', SEP, `❯ ${input}`, SEP, FOOTER].join('\n')
  const s = {
    // the input box: what was typed since the last Enter / Ctrl-C
    typed: '',
    // a TUI that stopped reading its input: the box shows only the first 80 characters
    frozen: false,
    // how many Enters on a multi-chunk box park it as a paste placeholder
    parkEnters: 0,
    state: 'idle' as 'idle' | 'parked' | 'prompt',
    // when set and true after a typed chunk, the pane turns into a permission prompt
    // `flipDelay` captures later (0 = at once)
    flipWhen: null as null | ((s: { typed: string; ctrlC: number }) => boolean),
    flipDelay: 0,
    armed: false,
    ctrlC: 0,
    entersOnPrompt: 0,
    tmuxLatencyMs: 0,
    advance: null as null | ((ms: number) => void),
    lastChunkAt: 0,
    // for each Enter: when it was pressed, when the chunk typed last before it went in, and
    // how many characters the box held
    enters: [] as Array<{ at: number; lastChunkAt: number; typedChars: number }>,
    // chunks and pass ends (Enter / Ctrl-C), in clock order
    timeline: [] as Array<{ kind: 'chunk' | 'end'; at: number }>,
    // the box as the 'second writer' typed its first chunk
    boxAtWriterStart: null as null | { state: string; typed: string },
    permissionPane: '',
    calls: [] as string[][],
  }
  return { box, s }
})

vi.mock('node:child_process', async (orig) => ({
  ...(await orig() as object),
  execFileSync: vi.fn((_file: string, args?: string[]) => {
    if (!Array.isArray(args)) return ''
    const s = h.s
    s.calls.push(args)
    if (s.tmuxLatencyMs > 0) s.advance?.(s.tmuxLatencyMs)
    if (args.includes('capture-pane')) {
      if (s.state === 'prompt') return s.permissionPane
      if (s.state === 'parked') return h.box('[Pasted text #1 +812 chars]')
      if (s.armed && s.flipDelay-- <= 0) {
        s.state = 'prompt'
        return s.permissionPane
      }
      return h.box(s.frozen && s.typed.length > 80 ? s.typed.slice(0, 80) : s.typed)
    }
    if (args.includes('display-message')) return '4242 claude\n'
    if (args.includes('send-keys')) {
      const key = args[args.length - 1]
      if (args.includes('-l')) {
        const chunk = args[args.indexOf('-l') + 1]
        if (chunk.includes('second writer') && s.boxAtWriterStart == null) s.boxAtWriterStart = { state: s.state, typed: s.typed }
        s.typed += chunk
        s.lastChunkAt = Date.now()
        s.timeline.push({ kind: 'chunk', at: Date.now() })
        if (!s.armed && s.flipWhen?.(s)) {
          s.armed = true
          if (s.flipDelay === 0) s.state = 'prompt'
        }
      } else if (key === 'Enter') {
        s.enters.push({ at: Date.now(), lastChunkAt: s.lastChunkAt, typedChars: s.typed.length })
        s.timeline.push({ kind: 'end', at: Date.now() })
        if (s.state === 'prompt') s.entersOnPrompt++
        else if (s.typed.length > 80 && s.parkEnters > 0 && !s.typed.includes('second writer')) {
          s.parkEnters--
          s.state = 'parked'
        } else {
          s.typed = ''
          s.state = 'idle'
        }
      } else if (key === 'C-c') {
        s.ctrlC++
        s.timeline.push({ kind: 'end', at: Date.now() })
        if (s.state === 'parked') s.state = 'idle'
        s.typed = ''
      }
    }
    return ''
  }),
}))
vi.mock('../notify.js', () => ({ notifyChannel: vi.fn(async () => {}), notifyTelegram: vi.fn(async () => {}) }))

import { sendPromptToSession, TYPED_ECHO_MAX_MS } from '../web/agent-process.js'
import { DEFAULT_DELIVER_WAIT_BUDGET_MS, __resetSessionSendLocks } from '../web/session-send-lock.js'
import { getInjectedPrompt } from '../web/injected-prompt-registry.js'
import { paneOneLine as paneOneLineOf } from '../web/pane-text.js'
import { urgentEmitRefusal, formatUrgentHoldNotice } from '../web/message-router.js'
import { logger } from '../logger.js'

const PERMISSION_PANE = readFileSync(join(__dirname, 'fixtures/pane/permission-prompt-bash-grep.txt'), 'utf8')
const SHORT_STOP = '[STOP] ne kuldd ki'
const LONG_STOP = '[STOP] ' + 'please stop the current task right now and wait for the owner, '.repeat(4)
const enterPresses = () => h.s.calls.filter((a) => a.includes('send-keys') && a[a.length - 1] === 'Enter')
// No repeated phrase, so the end of the prompt is never among the first 80 characters the frozen
// box shows. 1400 items: 53,345 characters, above the recorded 44,448-char kanban-audit delivery.
const promptOf = (items: number) => 'scheduled task: ' + Array.from({ length: items }, (_, i) => `item ${i}: check row ${i * 7} and note it.`).join(' ')

beforeEach(() => {
  Object.assign(h.s, {
    typed: '', frozen: false, parkEnters: 0, state: 'idle', flipWhen: null, flipDelay: 0, armed: false,
    ctrlC: 0, entersOnPrompt: 0, tmuxLatencyMs: 0, advance: null, lastChunkAt: 0, permissionPane: PERMISSION_PANE,
  })
  h.s.enters.length = 0
  h.s.timeline.length = 0
  h.s.boxAtWriterStart = null
  h.s.calls.length = 0
  __resetSessionSendLocks()
})

describe('#2143: the emit guard looks again right before the submitting Enter', () => {
  it('⛔ single-chunk STOP: the pane turns into a permission prompt while the text goes in -> no Enter, aborted-guard-typed, record dropped', async () => {
    h.s.flipWhen = (s) => s.typed.length > 0
    const out = await sendPromptToSession('guard-enter-test', SHORT_STOP, null, { waitForIdle: false, emitGuard: urgentEmitRefusal })
    expect(out).toBe('aborted-guard-typed')
    expect(enterPresses()).toEqual([])
    expect(h.s.entersOnPrompt).toBe(0)
    // The row is typed again later: the stuck-input watcher must not submit this leftover.
    expect(getInjectedPrompt('guard-enter-test')).toBeNull()
  })

  it('⛔ multi-chunk STOP: the text echoes, then the pane turns into a prompt during the settle wait -> no Enter', async () => {
    h.s.flipWhen = (s) => s.typed.length >= LONG_STOP.length
    h.s.flipDelay = 1
    const out = await sendPromptToSession('guard-enter-test', LONG_STOP, null, { waitForIdle: false, emitGuard: urgentEmitRefusal })
    expect(out).toBe('aborted-guard-typed')
    expect(enterPresses()).toEqual([])
    expect(getInjectedPrompt('guard-enter-test')).toBeNull()
  })

  it('⛔ clear-and-resend: the prompt opens while the resend goes in -> its Enter is not pressed, aborted-guard-typed', async () => {
    h.s.parkEnters = 1
    h.s.flipWhen = (s) => s.ctrlC > 0 && s.typed.length >= LONG_STOP.length
    h.s.flipDelay = 1
    const out = await sendPromptToSession('guard-enter-test', LONG_STOP, null, { waitForIdle: false, emitGuard: urgentEmitRefusal })
    expect(h.s.ctrlC).toBeGreaterThan(0) // the resend path really ran
    expect(out).toBe('aborted-guard-typed')
    expect(enterPresses()).toHaveLength(1) // only the first, parked submit
    expect(h.s.entersOnPrompt).toBe(0)
    expect(getInjectedPrompt('guard-enter-test')).toBeNull()
  })

  it('control: the same guarded STOP on a pane that stays idle is typed and submitted, and stays on record', async () => {
    const out = await sendPromptToSession('guard-enter-test', LONG_STOP, null, { waitForIdle: false, emitGuard: urgentEmitRefusal })
    expect(out).toBe('sent')
    expect(enterPresses()).toHaveLength(1)
    expect(getInjectedPrompt('guard-enter-test')).not.toBeNull()
  })
})

describe('#2143: the orchestrator notice says whether the row was typed', () => {
  const msg = { id: 7, from_agent: 'marveen', to_agent: 'worker' }
  const hold = { kind: 'permission-prompt', ask: null } as unknown as Parameters<typeof formatUrgentHoldNotice>[2]

  it('typed before the refusal: says the text WAS typed and is not submitted, and that the retry types it again', () => {
    const notice = formatUrgentHoldNotice(msg, 'agent-worker', hold, 'STOP', true)
    expect(notice).toContain('WAS typed into the pane but NOT submitted')
    expect(notice).toContain('typed AGAIN')
    expect(notice).not.toContain('was NOT typed')
    expect(notice).not.toContain('sends neither')
  })

  it('refused before the first key: the wording stays "was NOT typed"', () => {
    const notice = formatUrgentHoldNotice(msg, 'agent-worker', hold, 'STOP')
    expect(notice).toContain('was NOT typed')
    expect(notice).not.toContain('WAS typed')
  })

  it('wiring: the STOP branch passes the typed outcome to the notice', () => {
    const ROUTER = readFileSync(join(__dirname, '../web/message-router.ts'), 'utf-8')
    expect(ROUTER).toMatch(/const typed = outcome === 'aborted-guard-typed'[\s\S]{0,600}?noticeUrgentHold\(msg, session, hold, urgentLabel, now, typed\)/)
  })
})

describe('#2144: the pre-Enter waits of one call share one budget', () => {
  interface Tracked { done: boolean; at: number; value?: unknown; error?: unknown }
  // Settled-at time (fake clock, ms after t0); Infinity while still running.
  function track(p: Promise<unknown>, t0: number): Tracked {
    const r: Tracked = { done: false, at: Number.POSITIVE_INFINITY }
    p.then((v) => { r.value = v }, (e) => { r.error = e }).then(() => { r.done = true; r.at = Date.now() - t0 })
    return r
  }
  async function runUntil(done: () => boolean): Promise<void> {
    for (let i = 0; i < 6000 && !done(); i++) await vi.advanceTimersByTimeAsync(100)
  }
  // The first send's full bounds (echo + settle, #2135). The waits of the whole call must fit in
  // them, plus the retry loop's 300 ms polls and 450 ms placeholder clears, which predate #2135.
  const FIRST_SEND_WAITS_MS = TYPED_ECHO_MAX_MS + 5_000
  const LOOP_SLACK_MS = 4_000
  // Typing time of every pass: from its first chunk to its last (a pass ends at Enter or Ctrl-C).
  function typingMs(): number {
    let total = 0
    let passStart = -1
    let last = -1
    for (const e of h.s.timeline) {
      if (e.kind === 'chunk') {
        if (passStart < 0) passStart = e.at
        last = e.at
      } else if (passStart >= 0) {
        total += last - passStart
        passStart = -1
      }
    }
    return passStart >= 0 ? total + (last - passStart) : total
  }

  it('the wait part of a frozen-pane send is bounded the same for a 5.4k and a 53k prompt; the first send keeps its full echo wait; the call ends on the spent-budget give-up, before the retry limit', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(logger, 'warn')
    try {
      const waitParts: number[] = []
      for (const items of [170, 1400]) {
        Object.assign(h.s, { typed: '', state: 'idle', ctrlC: 0 })
        h.s.enters.length = 0
        h.s.timeline.length = 0
        __resetSessionSendLocks()
        warn.mockClear()
        h.s.frozen = true
        h.s.parkEnters = Number.POSITIVE_INFINITY // every submit parks
        const t0 = Date.now()
        const holder = track(sendPromptToSession('frozen-wait-test', promptOf(items), null, { waitForIdle: false }), t0)
        await runUntil(() => holder.done)
        expect(holder.value, `${items} items`).toBe('sent') // develop's give-up path returns 'sent'
        expect(warn.mock.calls.some((c) => String(c[1]).includes('prompt still parked after retries'))).toBe(true)
        // The give-up came from the spent budget, not from the attempt limit: one clear-and-resend
        // used the rest of the budget, so no further follow-up was made. Without the budgetSpent
        // branch the loop runs on to SUBMIT_RETRY_MAX_ATTEMPTS (more Ctrl-C resends and Enters).
        expect(warn.mock.calls.some((c) => String(c[1]).includes('pre-Enter wait budget spent; no further follow-ups')), `${items} items: budget give-up`).toBe(true)
        expect(h.s.ctrlC, `${items} items: clear-and-resends`).toBe(1)
        expect(h.s.enters, `${items} items: Enters`).toHaveLength(2)
        const first = h.s.enters[0]
        expect(first.at - first.lastChunkAt, `${items} items: first echo wait`).toBeGreaterThanOrEqual(TYPED_ECHO_MAX_MS)
        waitParts.push(holder.at - typingMs())
      }
      for (const w of waitParts) expect(w).toBeLessThanOrEqual(FIRST_SEND_WAITS_MS + LOOP_SLACK_MS)
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  }, 120_000)

  it('a 53k prompt over slow tmux (60 ms per call) on a healthy pane is typed in full and submitted once, as on develop', async () => {
    vi.useFakeTimers()
    try {
      h.s.tmuxLatencyMs = 60
      h.s.advance = (ms) => { vi.advanceTimersByTime(ms) }
      const text = promptOf(1400)
      const t0 = Date.now()
      const holder = track(sendPromptToSession('slow-tmux-test', text, null, { waitForIdle: false }), t0)
      await runUntil(() => holder.done)
      expect(holder.error).toBeUndefined()
      expect(holder.value).toBe('sent')
      expect(h.s.enters).toHaveLength(1)
      expect(h.s.enters[0].typedChars).toBe(text.length) // the whole prompt was in the box at its Enter
      expect(typingMs()).toBeGreaterThan(45_000) // slow enough that a typing cap would have cut it
    } finally {
      vi.useRealTimers()
    }
  }, 120_000)

  it('a frozen-pane holder releases the lane before the queued writer gives up; the writer starts after the holder\'s last key, on the parked prompt the give-up leaves', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(logger, 'warn')
    try {
      h.s.frozen = true
      h.s.parkEnters = Number.POSITIVE_INFINITY // every submit of the holder parks (the second writer's does not)
      const holderText = promptOf(170)
      const t0 = Date.now()
      const holder = track(sendPromptToSession('frozen-lane-test', holderText, null, { waitForIdle: false }), t0)
      // Let the holder take the lane before the second writer queues behind it.
      for (let i = 0; i < 50 && h.s.typed.length === 0; i++) await vi.advanceTimersByTimeAsync(10)
      expect(h.s.typed.length).toBeGreaterThan(0)
      const writer = track(sendPromptToSession('frozen-lane-test', 'second writer', null, { waitForIdle: false }), t0)
      await runUntil(() => holder.done && writer.done)

      expect(warn.mock.calls.some((c) => String(c[1]).includes('delivery lock wait budget elapsed'))).toBe(false)
      expect(holder.at).toBeLessThan(DEFAULT_DELIVER_WAIT_BUDGET_MS)
      expect(holder.value).toBe('sent')
      expect(writer.value).toBe('sent')
      // Ordering only: no holder key after the writer's first chunk.
      const keys = h.s.calls.filter((a) => a.includes('send-keys'))
      const firstWriterKey = keys.findIndex((a) => a.includes('-l') && a.includes('second writer'))
      expect(firstWriterKey).toBeGreaterThan(0)
      expect(keys.slice(firstWriterKey).some((a) => a.includes('-l') && !a.includes('second writer'))).toBe(false)
      // The box when the writer starts: the holder's prompt is still parked in it, exactly what
      // the give-up path leaves (as on develop at the retry limit). This change does not clear it.
      expect(h.s.boxAtWriterStart).toEqual({ state: 'parked', typed: paneOneLineOf(holderText) })
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  }, 120_000)
})
