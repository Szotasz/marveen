import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }))
const sendSystemDirective = vi.fn(async (..._a: unknown[]): Promise<'sent'> => 'sent')
vi.mock('../web/system-directive.js', () => ({ sendSystemDirective: (...a: unknown[]) => sendSystemDirective(...a) }))

import {
  RESTART_WAKE_DELAY_MS,
  __resetRestartWake,
  cancelRestartWake,
  hasPendingRestartWake,
  restartOptsFromBody,
  restartWakePrompt,
  scheduleRestartWake,
  type RestartWakeOutcome,
} from '../web/restart-wake.js'
import { logger } from '../logger.js'

// RESTARTWAKE927 (df5beec4, decision (b')): a --continue restart that cuts a
// running turn leaves the agent at an empty prompt. The wake lives in
// restartAgentProcess behind a per-caller switch (default OFF); one restart owes
// at most one wake; a fresh restart never gets one.

const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve() }

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
  it('{"wake": false} turns the wake off (the key-rotation automat wakes the agent itself)', () => {
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
    expect(body).toContain('if (started.ok && !opts.fresh && opts.wake) scheduleRestartWake(name, agentSessionName(name), opts.wake.reason)')
    expect(body).toContain('startAgentProcess(name, opts)')
    expect(body.match(/scheduleRestartWake\(/g)).toHaveLength(1)
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
    expect(guard).toContain('restartAgentProcess(name, { fresh: true })')
    expect(guard).not.toMatch(/restartAgentProcess\([^)]*wake/)
  })
})
