import { describe, it, expect, vi } from 'vitest'
import { contextClear, clearVerdict, switchVerdict, type SessionControlDeps } from '../web/session-control.js'
import { DEFAULT_GATE_CONFIG, type GateInputs } from '../context-restart-gate.js'

const NOW = Date.parse('2026-09-22T08:00:00Z')

function inputs(over: Partial<GateInputs> = {}): GateInputs {
  return {
    nowMs: NOW,
    contextTokens: 180_000,
    paneState: 'idle',
    paneUsageLimited: false,
    hardGuardPhase: null,
    pendingOutboundCount: 0,
    hasStaleOutbound: false,
    hasChildProcesses: false,
    msSinceTranscriptWrite: 10 * 60_000,
    hasOpenQuestion: false,
    hasLiveTaskState: false,
    ...over,
  } as GateInputs
}

function deps(i: GateInputs, after: number | null = 12_000) {
  const softClear = vi.fn(async () => {})
  const d: SessionControlDeps = {
    gather: () => ({ cfg: { ...DEFAULT_GATE_CONFIG }, inputs: i }),
    softClear,
    session: () => 'marveen-channels',
    contextTokens: () => after,
  }
  return { d, softClear }
}

describe('/context clear (CMD920 test 10)', () => {
  it('busy session: no /clear, the reply points to /runs', async () => {
    const { d, softClear } = deps(inputs({ paneState: 'busy' }))
    const r = await contextClear(NOW, d)
    expect(r.cleared).toBe(false)
    expect(r.text).toMatch(/Nem töröltem: a session foglalt \(pane-busy.*\/runs/)
    expect(softClear).not.toHaveBeenCalled()
  })

  it('quiet session: the gate soft-restart path runs; the reply shows context before and after', async () => {
    const { d, softClear } = deps(inputs())
    const r = await contextClear(NOW, d)
    expect(r.cleared).toBe(true)
    expect(softClear).toHaveBeenCalledWith('marveen', 'marveen-channels', NOW, 180_000)
    expect(r.text).toMatch(/előtte: 180k · utána: 12k/)
  })

  it('after-size not measurable yet is said out loud', async () => {
    const { d } = deps(inputs(), null)
    expect((await contextClear(NOW, d)).text).toMatch(/utána: még nem mérhető/)
  })

  it('every gate condition still blocks a manual clear (fail-closed), only the size threshold is waived', () => {
    const cfg = { ...DEFAULT_GATE_CONFIG, enabled: false, thresholdTokens: 10_000_000 }
    expect(clearVerdict(inputs(), cfg)).toEqual({ quiet: true })
    expect(clearVerdict(inputs({ contextTokens: null }), cfg)).toEqual({ quiet: true })
    for (const over of [
      { paneState: null },
      { paneState: 'typing' },
      { msSinceTranscriptWrite: 1000 },
      { msSinceTranscriptWrite: null },
      { hasChildProcesses: true },
      { hasChildProcesses: null },
      { pendingOutboundCount: 1 },
      { hasOpenQuestion: true },
      { hasLiveTaskState: true },
      { hardGuardPhase: 'await-handoff' },
      { paneUsageLimited: true },
    ] as Array<Partial<GateInputs>>) {
      expect(clearVerdict(inputs(over), cfg).quiet).toBe(false)
    }
  })

  it('a model switch needs a quiet pane, but not an empty outbox', () => {
    const cfg = { ...DEFAULT_GATE_CONFIG }
    expect(switchVerdict(inputs({ pendingOutboundCount: 3, hasOpenQuestion: true }), cfg)).toEqual({ quiet: true })
    expect(switchVerdict(inputs({ paneState: 'busy' }), cfg).quiet).toBe(false)
    expect(switchVerdict(inputs({ msSinceTranscriptWrite: 500 }), cfg).quiet).toBe(false)
    expect(switchVerdict(inputs({ hasChildProcesses: null }), cfg).quiet).toBe(false)
  })
})
