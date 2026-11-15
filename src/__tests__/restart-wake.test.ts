import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }))
const sendSystemDirective = vi.fn(async (..._a: unknown[]): Promise<'sent'> => 'sent')
vi.mock('../web/system-directive.js', () => ({ sendSystemDirective: (...a: unknown[]) => sendSystemDirective(...a) }))

import {
  MAIN_HANDOFF_FRESH_MS,
  MAIN_RESTART_WAKE_REASON,
  RESTART_WAKE_DELAY_MS,
  __resetRestartWake,
  cancelRestartWake,
  freshHandoff,
  hasPendingRestartWake,
  mainRestartWakePrompt,
  restartOptsFromBody,
  restartWakePrompt,
  scheduleMainRestartWake,
  scheduleRestartWake,
  wantsMainRestartWake,
  type RestartWakeOutcome,
} from '../web/restart-wake.js'
import { logger } from '../logger.js'

// RESTARTWAKE927 (df5beec4, decision (b')): a --continue restart that cuts a
// running turn leaves the agent at an empty prompt. The wake lives in
// restartAgentProcess behind a per-caller switch (default OFF); one restart owes
// at most one wake; a fresh restart never gets one.

const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve() }
const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('scheduleRestartWake: one wake, after the boot grace, as the last restart asked', () => {
  const sent: Array<{ agent: string; session: string; text: string }> = []
  const send = vi.fn(async (agent: string, session: string, text: string): Promise<RestartWakeOutcome> => {
    sent.push({ agent, session, text })
    return 'sent'
  })
  beforeEach(() => {
    vi.useFakeTimers()
    __resetRestartWake()
    sent.length = 0
    send.mockClear()
    vi.mocked(logger.warn).mockClear()
  })
  afterEach(() => {
    __resetRestartWake()
    vi.useRealTimers()
  })

  it('sends nothing during the boot grace, then exactly one wake with the caller in the text', async () => {
    scheduleRestartWake('devy', 'agent-devy', 'api-restart', { send })
    vi.advanceTimersByTime(RESTART_WAKE_DELAY_MS - 1)
    await flush()
    expect(send).not.toHaveBeenCalled()
    expect(hasPendingRestartWake('devy')).toBe(true)
    vi.advanceTimersByTime(1)
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(sent[0]).toMatchObject({ agent: 'devy', session: 'agent-devy' })
    expect(sent[0].text).toContain('[RESTART-WAKE]')
    expect(sent[0].text).toContain('ok: api-restart')
    expect(hasPendingRestartWake('devy')).toBe(false)
    vi.advanceTimersByTime(10 * RESTART_WAKE_DELAY_MS)
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('a second restart inside the grace re-arms the timer: still one wake, after the LAST restart', async () => {
    scheduleRestartWake('devy', 'agent-devy', 'plan-switch', { send })
    vi.advanceTimersByTime(RESTART_WAKE_DELAY_MS - 5_000)
    scheduleRestartWake('devy', 'agent-devy', 'api-restart', { send })
    vi.advanceTimersByTime(5_000)
    await flush()
    expect(send).not.toHaveBeenCalled()
    vi.advanceTimersByTime(RESTART_WAKE_DELAY_MS)
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(sent[0].text).toContain('ok: api-restart')
  })

  it('a fresh restart cancels the owed wake (the context guard brings its own directive)', async () => {
    scheduleRestartWake('devy', 'agent-devy', 'model-fallback', { send })
    expect(cancelRestartWake('devy')).toBe(true)
    expect(cancelRestartWake('devy')).toBe(false)
    vi.advanceTimersByTime(2 * RESTART_WAKE_DELAY_MS)
    await flush()
    expect(send).not.toHaveBeenCalled()
  })

  it('agents are independent: one agent\'s restart neither delays nor cancels another\'s wake', async () => {
    scheduleRestartWake('devy', 'agent-devy', 'fleet-plan-switch', { send })
    scheduleRestartWake('samu', 'agent-samu', 'fleet-plan-switch', { send })
    cancelRestartWake('samu')
    vi.advanceTimersByTime(RESTART_WAKE_DELAY_MS)
    await flush()
    expect(sent.map((s) => s.agent)).toEqual(['devy'])
  })

  it('a busy pane is not woken twice: a non-sent outcome is only logged, never retried', async () => {
    const busy = vi.fn(async (): Promise<RestartWakeOutcome> => 'aborted-busy')
    scheduleRestartWake('devy', 'agent-devy', 'api-restart', { send: busy })
    vi.advanceTimersByTime(RESTART_WAKE_DELAY_MS)
    await flush()
    vi.advanceTimersByTime(10 * RESTART_WAKE_DELAY_MS)
    await flush()
    expect(busy).toHaveBeenCalledTimes(1)
    expect(hasPendingRestartWake('devy')).toBe(false)
  })

  it('a caller that passes no text gets the --continue text, unchanged (the callers before MAINRESTARTWAKE1115)', async () => {
    scheduleRestartWake('devy', 'agent-devy', 'api-restart', { send })
    vi.advanceTimersByTime(RESTART_WAKE_DELAY_MS)
    await flush()
    expect(sent.map((s) => s.text)).toEqual([restartWakePrompt('api-restart')])
  })

  it('deps.text replaces the --continue text, and only the text: same agent, session, grace and one-wake rule', async () => {
    scheduleRestartWake('devy', 'agent-devy', 'api-restart', { send, text: 'SAJAT SZOVEG' })
    vi.advanceTimersByTime(RESTART_WAKE_DELAY_MS - 1)
    await flush()
    expect(send).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    await flush()
    expect(sent).toEqual([{ agent: 'devy', session: 'agent-devy', text: 'SAJAT SZOVEG' }])
    expect(sent[0].text).not.toContain('--continue')
  })

  it('a failing delivery is logged and does not escape as an unhandled rejection', async () => {
    const boom = vi.fn(async (): Promise<RestartWakeOutcome> => { throw new Error('tmux gone') })
    scheduleRestartWake('devy', 'agent-devy', 'api-restart', { send: boom })
    vi.advanceTimersByTime(RESTART_WAKE_DELAY_MS)
    await flush()
    expect(boom).toHaveBeenCalledTimes(1)
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'devy', reason: 'api-restart' }),
      'restart-wake: delivery failed',
    )
  })
})

describe('the default sender: an authenticated directive that waits for an idle pane and gives up on a busy one', () => {
  beforeEach(() => { vi.useFakeTimers(); __resetRestartWake(); sendSystemDirective.mockClear() })
  afterEach(() => { __resetRestartWake(); vi.useRealTimers() })
  it('goes through sendSystemDirective with waitForIdle and abort-on-busy, so a pane woken by someone else is not woken twice', async () => {
    scheduleRestartWake('devy', 'agent-devy', 'api-restart')
    vi.advanceTimersByTime(RESTART_WAKE_DELAY_MS)
    await flush()
    for (let i = 0; i < 20 && sendSystemDirective.mock.calls.length === 0; i++) await flush()
    expect(sendSystemDirective).toHaveBeenCalledTimes(1)
    const [agent, session, text, host, opts] = sendSystemDirective.mock.calls[0]
    expect([agent, session, host]).toEqual(['devy', 'agent-devy', null])
    expect(String(text)).toContain('[RESTART-WAKE]')
    expect(opts).toEqual({ waitForIdle: true, onBusyTimeout: 'abort' })
  })
})

describe('restartOptsFromBody: the /restart route wakes a --continue restart unless told not to', () => {
  it('empty or {} body: --continue with a wake', () => {
    expect(restartOptsFromBody('')).toEqual({ fresh: false, wake: { reason: 'api-restart' } })
    expect(restartOptsFromBody('{}')).toEqual({ fresh: false, wake: { reason: 'api-restart' } })
  })
  it('{"wake": false} turns the wake off (a caller that wakes the agent itself)', () => {
    expect(restartOptsFromBody('{"wake": false}')).toEqual({ fresh: false })
  })
  it('a fresh restart never wakes, even when asked', () => {
    expect(restartOptsFromBody('{"fresh": true}')).toEqual({ fresh: true })
    expect(restartOptsFromBody('{"fresh": true, "wake": true}')).toEqual({ fresh: true })
  })
  it('only the literal false switches it off; an unreadable body keeps the defaults', () => {
    expect(restartOptsFromBody('{"wake": "no"}')).toEqual({ fresh: false, wake: { reason: 'api-restart' } })
    expect(restartOptsFromBody('{"wake": 0}')).toEqual({ fresh: false, wake: { reason: 'api-restart' } })
    expect(restartOptsFromBody('not json')).toEqual({ fresh: false, wake: { reason: 'api-restart' } })
    expect(restartOptsFromBody('null')).toEqual({ fresh: false, wake: { reason: 'api-restart' } })
  })
})

describe('restartWakePrompt', () => {
  it('says why, asks to continue, and says an idle agent must not invent work', () => {
    const p = restartWakePrompt('model-fallback')
    expect(p.startsWith('[RESTART-WAKE]')).toBe(true)
    expect(p).toContain('ok: model-fallback')
    expect(p).toContain('FOLYTASD')
    expect(p).toContain('ne talalj ki magadnak feladatot')
  })
})

// MAINRESTARTWAKE1115: the manual restart of the main agent is fresh (no
// --continue) and nothing typed into the new session, so it sat idle until its
// next input (measured 2026-11-14: 23:09:33 -> 23:15:12, the first scheduled task).
describe('mainRestartWakePrompt: the fresh main restart gets a text that does not claim the conversation is back', () => {
  const T0 = Date.UTC(2026, 10, 15, 16, 21, 30)
  const fresh = mainRestartWakePrompt('manual-main-restart', { path: '/srv/app/HANDOFF.md', mtimeMs: T0, ageMs: 12 * 60_000 + 5_000 })
  const none = mainRestartWakePrompt('manual-main-restart', null)

  it('a fresh handoff is named WITH its time (review C1): the stamp to the minute and its age', () => {
    expect(fresh.startsWith('[RESTART-WAKE]')).toBe(true)
    expect(fresh).toContain('ok: manual-main-restart')
    expect(fresh).toContain('A /srv/app/HANDOFF.md atado friss (irva: 2026-11-15T16:21Z, 12 perce)')
    expect(fresh).toContain('olvasd be, es FOLYTASD az ott leirt munkat')
    // what happened after the handoff is not in it: the kanban and the hot memories are still named
    expect(fresh).toContain('Ami az atado ota tortent')
    expect(fresh).toContain('kanban')
    expect(fresh).toContain('hot memoria')
    // the freshness is no longer the model's call
    expect(fresh).not.toContain('nezd meg a datumat')
  })

  it('a handoff written inside the last minute says so instead of "0 perce"', () => {
    const p = mainRestartWakePrompt('manual-main-restart', { path: '/srv/app/HANDOFF.md', mtimeMs: T0, ageMs: 59_999 })
    expect(p).toContain('(irva: 2026-11-15T16:21Z, kevesebb mint egy perce)')
  })

  it('a stale or missing handoff (null) is not mentioned at all: only the kanban and the hot memories (review C1)', () => {
    expect(none.startsWith('[RESTART-WAKE]')).toBe(true)
    expect(none).toContain('ok: manual-main-restart')
    expect(none).not.toContain('HANDOFF')
    expect(none).not.toContain('atado')
    expect(none).toContain('Nezd meg a kanban tabladat es a hot memoriaidat, es FOLYTASD onnan a megkezdett munkat')
  })

  it('both texts say what NOT to do: no invented task, and no channel post about the restart (review C2)', () => {
    for (const p of [fresh, none]) {
      expect(p).toContain('ne talalj ki magadnak feladatot')
      expect(p).toContain('Az ujrainditasrol a csatornadra NE kuldj uzenetet.')
      expect(p).toContain('Ne kezdd elolrol, ami mar kesz')
    }
  })

  it('both say the conversation is NOT back, and carry none of the --continue wording', () => {
    for (const p of [fresh, none]) {
      expect(p).toContain('NEM maradt meg')
      expect(p).not.toContain('--continue')
      expect(p).not.toContain('megmaradt, de')
      expect(p).not.toContain('utolso lepeseidet')
      expect(p).not.toBe(restartWakePrompt('manual-main-restart'))
    }
    // the --continue text is not touched by the review round: it has no channel sentence
    expect(restartWakePrompt('api-restart')).not.toContain('csatornadra')
  })
})

describe('freshHandoff: the code decides whether the handoff file is worth naming (review C1)', () => {
  const NOW = Date.UTC(2026, 10, 15, 18, 0, 0)
  const at = (ageMs: number) => ({ mtimeMs: () => NOW - ageMs })

  it('a file inside the bound is fresh, with its mtime and its age', () => {
    expect(freshHandoff('/x/HANDOFF.md', NOW, at(5 * 60_000))).toEqual({ path: '/x/HANDOFF.md', mtimeMs: NOW - 5 * 60_000, ageMs: 5 * 60_000 })
  })

  it('the bound itself is still fresh, one millisecond past it is not', () => {
    expect(freshHandoff('/x/HANDOFF.md', NOW, at(MAIN_HANDOFF_FRESH_MS))).not.toBeNull()
    expect(freshHandoff('/x/HANDOFF.md', NOW, at(MAIN_HANDOFF_FRESH_MS + 1))).toBeNull()
    expect(MAIN_HANDOFF_FRESH_MS).toBe(2 * 60 * 60 * 1000)
  })

  it('a missing or unreadable file is the same answer as a stale one: null', () => {
    expect(freshHandoff('/x/HANDOFF.md', NOW, { mtimeMs: () => null })).toBeNull()
    // the default reader, on a path that does not exist (no seam): null, not a throw
    expect(freshHandoff(join(SRC_DIR, 'no-such-dir', 'HANDOFF.md'), NOW)).toBeNull()
  })

  it('the default reader reads the real mtime: this test file is "fresh" right after its own mtime and stale days later', () => {
    const self = fileURLToPath(import.meta.url)
    const real = statSync(self).mtimeMs
    expect(freshHandoff(self, real + 1_000)).toEqual({ path: self, mtimeMs: real, ageMs: 1_000 })
    expect(freshHandoff(self, real + 3 * 24 * 60 * 60 * 1000)).toBeNull()
  })

  it('a file stamped in the future (a clock that moved) counts as written now', () => {
    expect(freshHandoff('/x/HANDOFF.md', NOW, { mtimeMs: () => NOW + 60_000 })).toEqual({ path: '/x/HANDOFF.md', mtimeMs: NOW + 60_000, ageMs: 0 })
  })

  it('maxAgeMs replaces the bound (the seam the scheduler does not use)', () => {
    expect(freshHandoff('/x/HANDOFF.md', NOW, { mtimeMs: () => NOW - 10_000, maxAgeMs: 9_999 })).toBeNull()
    expect(freshHandoff('/x/HANDOFF.md', NOW, { mtimeMs: () => NOW - 10_000, maxAgeMs: 10_000 })).not.toBeNull()
  })
})

describe('wantsMainRestartWake: the manual main restart wakes unless told not to', () => {
  it('no body, an empty body or {}: wake (the dashboard button sends no body)', () => {
    expect(wantsMainRestartWake('')).toBe(true)
    expect(wantsMainRestartWake('   ')).toBe(true)
    expect(wantsMainRestartWake(Buffer.alloc(0))).toBe(true)
    expect(wantsMainRestartWake('{}')).toBe(true)
    expect(wantsMainRestartWake('{"force": true}')).toBe(true)
  })
  it('exactly {"wake": false} switches it off, as a string or a Buffer, with or without force', () => {
    expect(wantsMainRestartWake('{"wake": false}')).toBe(false)
    expect(wantsMainRestartWake(Buffer.from('{"wake": false}'))).toBe(false)
    expect(wantsMainRestartWake('{"force": true, "wake": false}')).toBe(false)
  })
  it('only the literal false switches it off; an unreadable body keeps the default', () => {
    for (const body of ['{"wake": "false"}', '{"wake": 0}', '{"wake": null}', '{"wake": true}', 'not json', 'null', '[]', '"wake"']) {
      expect(wantsMainRestartWake(body), body).toBe(true)
    }
  })
})

describe('scheduleMainRestartWake: one fresh-restart wake for the main agent, on the shared timer', () => {
  const sent: Array<{ agent: string; session: string; text: string }> = []
  const send = vi.fn(async (agent: string, session: string, text: string): Promise<RestartWakeOutcome> => {
    sent.push({ agent, session, text })
    return 'sent'
  })
  beforeEach(() => { vi.useFakeTimers(); __resetRestartWake(); sent.length = 0; send.mockClear(); sendSystemDirective.mockClear() })
  afterEach(() => { __resetRestartWake(); vi.useRealTimers() })

  const NOW = Date.UTC(2026, 10, 15, 18, 0, 0)
  const seams = (mtime: number | null) => ({ send, now: () => NOW, mtimeMs: () => mtime })

  it('sends nothing during the boot grace, then exactly one wake with the fresh-restart text', async () => {
    scheduleMainRestartWake('marveen', 'marveen-channels', '/srv/app/HANDOFF.md', seams(NOW - 7 * 60_000))
    expect(hasPendingRestartWake('marveen')).toBe(true)
    vi.advanceTimersByTime(RESTART_WAKE_DELAY_MS - 1)
    await flush()
    expect(send).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    await flush()
    expect(sent).toEqual([{
      agent: 'marveen',
      session: 'marveen-channels',
      text: mainRestartWakePrompt(MAIN_RESTART_WAKE_REASON, { path: '/srv/app/HANDOFF.md', mtimeMs: NOW - 7 * 60_000, ageMs: 7 * 60_000 }),
    }])
    expect(sent[0].text).toContain('/srv/app/HANDOFF.md atado friss (irva: 2026-11-15T17:53Z, 7 perce)')
    expect(hasPendingRestartWake('marveen')).toBe(false)
    vi.advanceTimersByTime(10 * RESTART_WAKE_DELAY_MS)
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('a stale handoff and a missing one end in the same text: the file is not mentioned (review C1)', async () => {
    scheduleMainRestartWake('marveen', 'marveen-channels', '/srv/app/HANDOFF.md', seams(NOW - MAIN_HANDOFF_FRESH_MS - 1))
    vi.advanceTimersByTime(RESTART_WAKE_DELAY_MS)
    await flush()
    scheduleMainRestartWake('marveen', 'marveen-channels', '/srv/app/HANDOFF.md', seams(null))
    vi.advanceTimersByTime(RESTART_WAKE_DELAY_MS)
    await flush()
    expect(sent.map((x) => x.text)).toEqual([
      mainRestartWakePrompt(MAIN_RESTART_WAKE_REASON, null),
      mainRestartWakePrompt(MAIN_RESTART_WAKE_REASON, null),
    ])
    expect(sent[0].text).not.toContain('HANDOFF')
  })

  it('the freshness is read when the wake is SENT, not when it is scheduled (review C1)', async () => {
    // no file when the restart is asked for; one is written during the boot grace
    let mtime: number | null = null
    let clock = NOW
    scheduleMainRestartWake('marveen', 'marveen-channels', '/srv/app/HANDOFF.md', { send, now: () => clock, mtimeMs: () => mtime })
    mtime = NOW + 10_000
    clock = NOW + RESTART_WAKE_DELAY_MS
    vi.advanceTimersByTime(RESTART_WAKE_DELAY_MS)
    await flush()
    expect(sent).toHaveLength(1)
    expect(sent[0].text).toContain('/srv/app/HANDOFF.md atado friss')
    expect(sent[0].text).toContain('kevesebb mint egy perce')
    // and the other way: fresh at schedule time, past the bound by the time the wake is sent
    sent.length = 0
    clock = NOW
    mtime = NOW - MAIN_HANDOFF_FRESH_MS + 1_000
    scheduleMainRestartWake('marveen', 'marveen-channels', '/srv/app/HANDOFF.md', { send, now: () => clock, mtimeMs: () => mtime })
    clock = NOW + RESTART_WAKE_DELAY_MS
    vi.advanceTimersByTime(RESTART_WAKE_DELAY_MS)
    await flush()
    expect(sent).toHaveLength(1)
    expect(sent[0].text).not.toContain('HANDOFF')
  })

  it('another restart of the main session drops the owed wake; a manual restart cancels first and schedules after (review C3)', async () => {
    scheduleMainRestartWake('marveen', 'marveen-channels', '/srv/app/HANDOFF.md', seams(null))
    // a guard / recovery restart inside the grace: hardRestartMarveenChannels() cancels, nobody schedules
    expect(cancelRestartWake('marveen')).toBe(true)
    vi.advanceTimersByTime(10 * RESTART_WAKE_DELAY_MS)
    await flush()
    expect(send).not.toHaveBeenCalled()
    // a second MANUAL restart: the same cancel, then the route schedules -> exactly one wake
    scheduleMainRestartWake('marveen', 'marveen-channels', '/srv/app/HANDOFF.md', seams(null))
    expect(cancelRestartWake('marveen')).toBe(true)
    scheduleMainRestartWake('marveen', 'marveen-channels', '/srv/app/HANDOFF.md', seams(null))
    vi.advanceTimersByTime(RESTART_WAKE_DELAY_MS)
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('two manual restarts inside the grace end in one wake, after the last one', async () => {
    scheduleMainRestartWake('marveen', 'marveen-channels', '/srv/app/HANDOFF.md', { send })
    vi.advanceTimersByTime(RESTART_WAKE_DELAY_MS - 5_000)
    scheduleMainRestartWake('marveen', 'marveen-channels', '/srv/app/HANDOFF.md', { send })
    vi.advanceTimersByTime(5_000)
    await flush()
    expect(send).not.toHaveBeenCalled()
    vi.advanceTimersByTime(RESTART_WAKE_DELAY_MS)
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('the default sender is the same authenticated directive: waits for an idle pane, gives up on a busy one', async () => {
    scheduleMainRestartWake('marveen', 'marveen-channels', '/srv/app/HANDOFF.md')
    vi.advanceTimersByTime(RESTART_WAKE_DELAY_MS)
    await flush()
    for (let i = 0; i < 20 && sendSystemDirective.mock.calls.length === 0; i++) await flush()
    expect(sendSystemDirective).toHaveBeenCalledTimes(1)
    const [agent, session, text, host, opts] = sendSystemDirective.mock.calls[0]
    expect([agent, session, host]).toEqual(['marveen', 'marveen-channels', null])
    // no seam here: the real reader finds no /srv/app/HANDOFF.md, so the file is not named
    expect(String(text)).toBe(mainRestartWakePrompt(MAIN_RESTART_WAKE_REASON, null))
    expect(opts).toEqual({ waitForIdle: true, onBusyTimeout: 'abort' })
  })
})

// The IO-heavy modules (agent-process, the runners, the routes) cannot be
// imported here, so the wiring is pinned at the source: WHICH callers ask for a
// wake, and the one condition under which restartAgentProcess schedules it. The
// behaviour of the wake itself is measured above.
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = (rel: string): string => readFileSync(join(SRC, rel), 'utf8')

describe('wiring: the wake is asked for by the decided callers only (b\')', () => {
  it('restartAgentProcess cancels on a fresh restart and schedules only a started --continue restart that asked', () => {
    const ap = src('web/agent-process.ts')
    const body = ap.slice(ap.indexOf('export async function restartAgentProcess('), ap.indexOf('// Claude Code occasionally pops a'))
    expect(body).toContain('if (opts.fresh) cancelRestartWake(name)')
    // The wake is owed exactly when the restart is --continue and asked for
    // one, and then the start is told it does not own the first prompt.
    expect(body).toContain('const willWake = !opts.fresh && !!opts.wake')
    expect(body).toContain('if (started.ok && willWake && opts.wake) scheduleRestartWake(name, agentSessionName(name), opts.wake.reason)')
    expect(body.match(/scheduleRestartWake\(/g)).toHaveLength(1)
  })
  it('one restart, one first prompt: a restart that owes a wake starts with ownsResume, so no recovery brief stacks on it', () => {
    const ap = src('web/agent-process.ts')
    const body = ap.slice(ap.indexOf('export async function restartAgentProcess('), ap.indexOf('// Claude Code occasionally pops a'))
    expect(body).toContain('startAgentProcess(name, willWake ? { ...opts, ownsResume: true } : opts)')
  })
  it('ON: the /restart route, the plan switch, the fleet plan switch, the model-fallback demotion', () => {
    expect(src('web/routes/agents.ts')).toContain('restartAgentProcess(name, restartOptsFromBody(restartBody))')
    expect(src('web/routes/claude-plans.ts')).toContain("restartAgentProcess(agentId, { wake: { reason: 'plan-switch' } })")
    expect(src('web/claude-plan-fleet-wiring.ts')).toContain("restartAgentProcess(name, { wake: { reason: 'fleet-plan-switch' } })")
    expect(src('web/model-fallback-runner.ts')).toContain("restartAgentProcess(name, { fresh: false, wake: { reason: 'model-fallback' } })")
  })
  it('OFF: the idle-only auto-restart and the context guard\'s fresh restart ask for no wake', () => {
    const auto = src('web/auto-restart-runner.ts')
    expect(auto).toContain("restartAgentProcess(name, { fresh: cfg.mode === 'fresh' })")
    expect(auto).not.toMatch(/wake:/)
    const guard = src('web/context-guard-runner.ts')
    expect(guard).toContain('restartAgentProcess(name, { fresh: true, ownsResume: true })')
    expect(guard).not.toMatch(/restartAgentProcess\([^)]*wake/)
  })
})

describe('wiring: the fresh main wake is owed by the two manual restart routes only (MAINRESTARTWAKE1115)', () => {
  const CALL = 'if (wantsMainRestartWake('
  const SCHEDULE = "scheduleMainRestartWake(MAIN_AGENT_ID, MAIN_CHANNELS_SESSION, join(PROJECT_ROOT, 'HANDOFF.md'))"

  it('POST /api/marveen/restart: scheduled after hardRestartMarveenChannels() and after its 500 exit, before the ok answer', () => {
    const route = src('web/routes/marveen.ts')
    const start = route.indexOf("path === '/api/marveen/restart' && method === 'POST'")
    const end = route.indexOf("path === '/api/marveen/avatar'", start)
    const body = route.slice(start, end)
    const hard = body.indexOf('hardRestartMarveenChannels()')
    const failed = body.indexOf("if (!result.ok) { json(res, { error: result.error || 'Restart failed' }, 500); return true }")
    const wake = body.indexOf(CALL)
    const ok = body.indexOf('json(res, { ok: true })')
    expect(hard).toBeGreaterThan(-1)
    expect(failed).toBeGreaterThan(hard)
    expect(wake).toBeGreaterThan(failed)
    expect(ok).toBeGreaterThan(wake)
    expect(body).toContain(SCHEDULE)
    expect(body.match(/scheduleMainRestartWake\(/g)).toHaveLength(1)
  })

  it('POST /api/agents/:name/restart (main branch): scheduled only inside the ok branch of hardRestartMarveenChannels()', () => {
    const route = src('web/routes/agents.ts')
    const start = route.indexOf('if (isMainChannelsAgent(name)) {', route.indexOf('restartMatch && method'))
    const end = route.indexOf('if (!existsSync(agentDir(name)))', start)
    const body = route.slice(start, end)
    const hard = body.indexOf('hardRestartMarveenChannels()')
    const okBranch = body.indexOf('if (r.ok) {')
    const wake = body.indexOf(CALL)
    const failed = body.indexOf("json(res, { error: r.error || 'Restart failed' }, 500)")
    expect(hard).toBeGreaterThan(-1)
    expect(okBranch).toBeGreaterThan(hard)
    expect(wake).toBeGreaterThan(okBranch)
    expect(failed).toBeGreaterThan(wake)
    expect(body).toContain(SCHEDULE)
    expect(body.match(/scheduleMainRestartWake\(/g)).toHaveLength(1)
  })

  it('hardRestartMarveenChannels() drops a pending main wake FIRST, before any of its restart paths (review C3)', () => {
    const mon = src('web/channel-monitor.ts')
    const start = mon.indexOf('export function hardRestartMarveenChannels(): { ok: boolean; error?: string } {')
    expect(start).toBeGreaterThan(-1)
    const body = mon.slice(start, mon.indexOf('\nexport ', start + 1))
    const cancel = body.indexOf('cancelRestartWake(MAIN_AGENT_ID)')
    expect(cancel).toBeGreaterThan(-1)
    // before the first statement that can leave the function or restart anything
    for (const later of ['return {', 'launchctl', 'respawnMarveenSessionFresh()', 'stampFableOverageConsentSharedRoots()']) {
      expect(body.indexOf(later)).toBeGreaterThan(cancel)
    }
    expect(body.match(/cancelRestartWake\(/g)).toHaveLength(1)
    expect(mon).toContain("import { cancelRestartWake } from './restart-wake.js'")
    // and the function schedules nothing itself: the two manual routes do, after it returned ok
    expect(body).not.toContain('scheduleMainRestartWake(')
  })

  it('no other caller of hardRestartMarveenChannels() schedules it: the guard brings its own directive, the rest is recovery', () => {
    const web = join(SRC, 'web')
    const files = (readdirSync(web, { recursive: true }) as string[])
      .map((f) => f.split('\\').join('/'))
      .filter((f) => f.endsWith('.ts') && !f.includes('__tests__'))
    const hardCallers = files.filter((f) => readFileSync(join(web, f), 'utf8').includes('hardRestartMarveenChannels('))
    const wakers = files.filter((f) => readFileSync(join(web, f), 'utf8').includes('scheduleMainRestartWake('))
    // Negative control for the scan itself: it does see the other callers.
    expect(hardCallers).toEqual(expect.arrayContaining(['context-guard-runner.ts', 'channel-monitor.ts']))
    expect(hardCallers.length).toBeGreaterThan(wakers.length)
    expect(wakers.sort()).toEqual(['restart-wake.ts', 'routes/agents.ts', 'routes/marveen.ts'])
  })
})
