import { describe, it, expect, vi, beforeEach } from 'vitest'

// The gate reads panes and sessions through these two helpers; the pane classifier is replaced by a
// marker so each test states the pane state it means ('IDLE' = idle prompt, anything else = busy).
const capturePane = vi.fn<(session: string, host?: string | null) => string | null>()
const sessionExistsOnHost = vi.fn<(host: string | null, session: string) => boolean>()

vi.mock('../web/agent-process.js', () => ({
  capturePane: (session: string, host: string | null = null) => capturePane(session, host),
  sessionExistsOnHost: (host: string | null, session: string) => sessionExistsOnHost(host, session),
}))
vi.mock('../pane-state.js', () => ({
  paneLooksIdle: (capture: string) => capture === 'IDLE',
}))

import {
  decideManualRestart,
  gateManualRestart,
  MANUAL_RESTART_FORCE_HINT,
  MANUAL_RESTART_INTERVAL_MS,
  MANUAL_RESTART_SAMPLES,
  wantsForceRestart,
} from '../web/manual-restart-gate.js'

beforeEach(() => {
  capturePane.mockReset()
  sessionExistsOnHost.mockReset()
  sessionExistsOnHost.mockReturnValue(true)
})

describe('decideManualRestart (pure)', () => {
  it('allows only when every sample is idle', () => {
    expect(decideManualRestart([true, true, true])).toEqual({ allow: true, reason: 'idle' })
  })

  it('refuses a busy pane in any position, not only the first or last sample', () => {
    expect(decideManualRestart([true, false, true])).toEqual({ allow: false, reason: 'busy' })
    expect(decideManualRestart([false, true, true])).toEqual({ allow: false, reason: 'busy' })
    expect(decideManualRestart([true, true, false])).toEqual({ allow: false, reason: 'busy' })
  })

  it('fails closed on an unreadable pane (null)', () => {
    expect(decideManualRestart([true, null, true])).toEqual({ allow: false, reason: 'no-pane' })
  })

  it('fails closed when the sample count is wrong', () => {
    expect(decideManualRestart([true, true])).toEqual({ allow: false, reason: 'unknown-state' })
  })
})

describe('gateManualRestart (sampler)', () => {
  it('allows a restart of a session that does not exist (no turn to cut) without capturing', async () => {
    sessionExistsOnHost.mockReturnValue(false)
    const verdict = await gateManualRestart('marveen-channels', null, async () => {})
    expect(verdict).toEqual({ allow: true, reason: 'no-session' })
    expect(capturePane).not.toHaveBeenCalled()
  })

  it('takes MANUAL_RESTART_SAMPLES captures spaced by the interval, and allows when all are idle', async () => {
    capturePane.mockReturnValue('IDLE')
    const sleep = vi.fn(async () => {})
    const verdict = await gateManualRestart('marveen-channels', null, sleep)
    expect(verdict).toEqual({ allow: true, reason: 'idle' })
    expect(capturePane).toHaveBeenCalledTimes(MANUAL_RESTART_SAMPLES)
    expect(sleep).toHaveBeenCalledTimes(MANUAL_RESTART_SAMPLES - 1)
    expect(sleep).toHaveBeenCalledWith(MANUAL_RESTART_INTERVAL_MS)
  })

  it('refuses when the pane turns busy partway through the samples (a running turn is never cut)', async () => {
    capturePane.mockReturnValueOnce('IDLE').mockReturnValueOnce('working ( 12s )').mockReturnValueOnce('IDLE')
    const verdict = await gateManualRestart('marveen-channels', null, async () => {})
    expect(verdict).toEqual({ allow: false, reason: 'busy' })
  })

  it('refuses when the pane is unreadable while the session exists', async () => {
    capturePane.mockReturnValue(null)
    const verdict = await gateManualRestart('marveen-channels', null, async () => {})
    expect(verdict).toEqual({ allow: false, reason: 'no-pane' })
  })
})

describe('force override (an operator decision that cuts the running turn)', () => {
  it('only an explicit {"force": true} body forces, as text or as a buffer', () => {
    expect(wantsForceRestart('{"force": true}')).toBe(true)
    expect(wantsForceRestart(Buffer.from('{"force":true}'))).toBe(true)
  })

  it('an empty, malformed, non-true or non-object body does not force', () => {
    expect(wantsForceRestart('')).toBe(false)
    expect(wantsForceRestart('{"force": "yes"}')).toBe(false)
    expect(wantsForceRestart('{"force": false}')).toBe(false)
    expect(wantsForceRestart('not json')).toBe(false)
    expect(wantsForceRestart('null')).toBe(false)
  })

  it('the refusal hint tells the caller how to force', () => {
    expect(MANUAL_RESTART_FORCE_HINT).toContain('{"force": true}')
    expect(MANUAL_RESTART_FORCE_HINT).toContain('/api/marveen/restart')
  })
})
