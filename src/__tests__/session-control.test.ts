import { describe, it, expect, vi } from 'vitest'
import { contextClear, clearVerdict, switchVerdict, type SessionControlDeps } from '../web/session-control.js'
import { DEFAULT_GATE_CONFIG, type GateInputs } from '../context-restart-gate.js'
import { readLastTurnActivityMs, projectsDirFor } from '../web/active-model.js'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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
    expect(r.text).toMatch(/Nem töröltem: a session foglalt \(pane-busy/)
    expect(r.busy).toBe(true)   // queued for the end of the turn
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

  // ELSOKOR922 Phase 7 A-smoke: the command's own hook-blocked prompt writes
  // bookkeeping lines to the transcript just before the deferred command runs;
  // the mtime then read "0s" and refused every owner write.
  it('own blocked prompt: a fresh mtime but an old turn line does not block', () => {
    const cfg = { ...DEFAULT_GATE_CONFIG }
    const own = inputs({ msSinceTranscriptWrite: 500, msSinceTurnActivity: 5 * 60_000 })
    expect(switchVerdict(own, cfg)).toEqual({ quiet: true })
    expect(clearVerdict(own, cfg)).toEqual({ quiet: true })
  })

  it('readLastTurnActivityMs skips the blocked-prompt bookkeeping lines (the shape measured on the test transcript)', () => {
    const cfgDir = mkdtempSync(join(tmpdir(), 'turn-'))
    try {
      const dir = projectsDirFor('/opt/marveen', cfgDir)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 's.jsonl'), [
        JSON.stringify({ type: 'assistant', timestamp: '2026-09-22T13:30:26.598Z', message: { model: 'claude-sonnet-5' } }),
        JSON.stringify({ type: 'system', subtype: 'stop_hook_summary', hookCount: 2 }),
        JSON.stringify({ type: 'queue-operation', timestamp: '2026-09-22T13:35:17.269Z', content: '<channel ...>/model</channel>' }),
        JSON.stringify({ type: 'system', subtype: 'informational', timestamp: '2026-09-22T13:35:18.082Z', content: 'UserPromptSubmit operation blocked by hook' }),
        JSON.stringify({ type: 'last-prompt' }),
        '',
      ].join('\n'))
      expect(readLastTurnActivityMs('/opt/marveen', cfgDir)).toBe(Date.parse('2026-09-22T13:30:26.598Z'))
    } finally { rmSync(cfgDir, { recursive: true, force: true }) }
  })

  it('a fresh session with only bookkeeping lines reads as "never had a turn" (0); an oversized file stays unknown (null)', () => {
    const cfgDir = mkdtempSync(join(tmpdir(), 'turn-'))
    try {
      const dir = projectsDirFor('/opt/marveen', cfgDir)
      mkdirSync(dir, { recursive: true })
      const book = [
        JSON.stringify({ type: 'system', subtype: 'local_command', timestamp: '2026-09-23T13:19:39.000Z', content: '<command-name>/rename</command-name>' }),
        JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-09-23T13:19:44.000Z', content: '<channel>/model</channel>' }),
        JSON.stringify({ type: 'system', subtype: 'informational', timestamp: '2026-09-23T13:19:44.500Z', content: 'UserPromptSubmit operation blocked by hook' }),
      ]
      writeFileSync(join(dir, 's.jsonl'), book.join('\n') + '\n')
      expect(readLastTurnActivityMs('/opt/marveen', cfgDir)).toBe(0)
      const filler = JSON.stringify({ type: 'system', subtype: 'informational', content: 'x'.repeat(1000) })
      writeFileSync(join(dir, 's.jsonl'), Array.from({ length: 600 }, () => filler).join('\n') + '\n')
      expect(readLastTurnActivityMs('/opt/marveen', cfgDir)).toBeNull()
    } finally { rmSync(cfgDir, { recursive: true, force: true }) }
  })

  it('readLastTurnActivityMs skips our own /model lines (local command, no model turn; measured 2026-09-23)', () => {
    const cfgDir = mkdtempSync(join(tmpdir(), 'turn-'))
    try {
      const dir = projectsDirFor('/opt/marveen', cfgDir)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 's.jsonl'), [
        JSON.stringify({ type: 'assistant', timestamp: '2026-09-23T13:01:00.000Z', message: { model: 'claude-sonnet-5' } }),
        JSON.stringify({ type: 'system', subtype: 'local_command', timestamp: '2026-09-23T13:07:00.300Z', content: '<command-name>/model</command-name>' }),
        JSON.stringify({ type: 'user', timestamp: '2026-09-23T13:07:00.310Z', message: { role: 'user', content: '<command-name>/model</command-name>\n<command-message>model</command-message>' } }),
        JSON.stringify({ type: 'user', timestamp: '2026-09-23T13:07:00.317Z', message: { role: 'user', content: '<local-command-stdout>Set model to \u001b[1mclaude-sonnet-5\u001b[22m</local-command-stdout>' } }),
        '',
      ].join('\n'))
      expect(readLastTurnActivityMs('/opt/marveen', cfgDir)).toBe(Date.parse('2026-09-23T13:01:00.000Z'))
      // a real owner prompt after it counts again
      writeFileSync(join(dir, 's.jsonl'), JSON.stringify({ type: 'user', timestamp: '2026-09-23T13:08:00.000Z', message: { role: 'user', content: 'szia' } }) + '\n', { flag: 'a' })
      expect(readLastTurnActivityMs('/opt/marveen', cfgDir)).toBe(Date.parse('2026-09-23T13:08:00.000Z'))
    } finally { rmSync(cfgDir, { recursive: true, force: true }) }
  })

  it('a real turn line still blocks; the switch window is 20 s, /context clear keeps the gate 2 min', () => {
    const cfg = { ...DEFAULT_GATE_CONFIG }
    expect(switchVerdict(inputs({ msSinceTurnActivity: 10_000 }), cfg)).toEqual({ quiet: false, reason: 'turn-active (10s ago, need 20s)' })
    expect(switchVerdict(inputs({ msSinceTurnActivity: 30_000 }), cfg)).toEqual({ quiet: true })
    expect(clearVerdict(inputs({ msSinceTurnActivity: 30_000 }), cfg).quiet).toBe(false)
  })
})
