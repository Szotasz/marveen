import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

// Both manual routes that restart the main agent must (1) read the explicit force flag, (2) run the
// gate unless forced, and (3) do both BEFORE the hard restart. The gate's behaviour and the force
// parsing are covered by manual-restart-gate.test.ts; this checks the wiring: a route that calls
// hardRestartMarveenChannels() without the gate would cut a running turn, and a route that drops the
// force check would leave a stuck main agent with no way out.
const marveenRoute = readFileSync(new URL('../web/routes/marveen.ts', import.meta.url), 'utf-8')
const agentsRoute = readFileSync(new URL('../web/routes/agents.ts', import.meta.url), 'utf-8')

describe('manual main restart is gated, with an explicit force', () => {
  it('POST /api/marveen/restart: force check, then gate, then hardRestartMarveenChannels()', () => {
    const start = marveenRoute.indexOf("path === '/api/marveen/restart' && method === 'POST'")
    expect(start).toBeGreaterThan(-1)
    const force = marveenRoute.indexOf('wantsForceRestart(', start)
    const gate = marveenRoute.indexOf('gateManualRestart(MAIN_CHANNELS_SESSION)', start)
    const hard = marveenRoute.indexOf('hardRestartMarveenChannels()', start)
    expect(force).toBeGreaterThan(-1)
    expect(gate).toBeGreaterThan(force)
    expect(hard).toBeGreaterThan(gate)
  })

  it('POST /api/agents/:name/restart (main branch): force check, then gate, then hardRestartMarveenChannels()', () => {
    const start = agentsRoute.indexOf('if (isMainChannelsAgent(name)) {', agentsRoute.indexOf('restartMatch && method'))
    expect(start).toBeGreaterThan(-1)
    const force = agentsRoute.indexOf('wantsForceRestart(', start)
    const gate = agentsRoute.indexOf('gateManualRestart(MAIN_CHANNELS_SESSION)', start)
    const hard = agentsRoute.indexOf('hardRestartMarveenChannels()', start)
    expect(force).toBeGreaterThan(-1)
    expect(gate).toBeGreaterThan(force)
    expect(hard).toBeGreaterThan(gate)
  })
})
