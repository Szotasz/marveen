// TOKENSWAPRESTART1123 (b): a new fleet token saved on the dashboard restarts the shared-token sub-agents.
import { describe, it, expect } from 'vitest'
import { isFleetTokenSwap, restartFleetAfterTokenSwap, swapRestartMessage } from '../web/fleet-token-swap-restart.js'

describe('isFleetTokenSwap', () => {
  it('a different token after an existing one is a swap; a first save or the same token is not', () => {
    expect(isFleetTokenSwap('sk-ant-oat01-old', 'sk-ant-oat01-new')).toBe(true)
    expect(isFleetTokenSwap('sk-ant-oat01-same\n', 'sk-ant-oat01-same')).toBe(false)
    expect(isFleetTokenSwap(null, 'sk-ant-oat01-new')).toBe(false)
    expect(isFleetTokenSwap('  ', 'sk-ant-oat01-new')).toBe(false)
  })
})

describe('restartFleetAfterTokenSwap', () => {
  it('restarts only the RUNNING shared-token agents, one at a time, and tells the owner the count', async () => {
    const order: string[] = []
    const sleeps: number[] = []
    const notes: string[] = []
    const r = await restartFleetAfterTokenSwap({
      listAgents: () => ['a', 'own', 'b', 'off', 'c'],
      usesFleetToken: (n) => n !== 'own',
      isRunning: (n) => n !== 'off',
      restart: async (n) => { order.push(n); return n === 'c' ? { ok: false, error: 'x' } : { ok: true } },
      sleep: async (ms) => { sleeps.push(ms) },
      gapMs: 7,
      notify: async (t) => { notes.push(t) },
    })
    expect(order).toEqual(['a', 'b', 'c'])
    expect(sleeps).toEqual([7, 7]) // a gap between restarts, not before the first
    expect(r).toEqual({ restarted: ['a', 'b'], failed: [{ agent: 'c', error: 'x' }], notRunning: ['off'] })
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('2 kolléga újraindult')
    expect(notes[0]).toContain('Nem sikerült: c')
    expect(notes[0]).toContain('Nem futott')
  })
  it('the message with nothing to restart says 0', () => {
    expect(swapRestartMessage({ restarted: [], failed: [], notRunning: [] })).toBe('Flotta-token csere: 0 kolléga újraindult az új tokennel.')
  })
})

