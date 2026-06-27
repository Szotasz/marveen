import { describe, it, expect } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import {
  restartStateToJson,
  parseRestartState,
  loadRestartState,
  saveRestartState,
  emptyRestartState,
} from '../web/agent-restart-state.js'

describe('agent-restart-state serialisation', () => {
  it('round-trips failures + lastRestart through JSON', () => {
    const failures = new Map([['hacker', 3], ['heli', 1]])
    const lastRestart = new Map([['hacker', 1782490000000], ['heli', 1782490500000]])
    const parsed = parseRestartState(restartStateToJson(failures, lastRestart))
    expect(parsed.failures).toEqual({ hacker: 3, heli: 1 })
    expect(parsed.lastRestart).toEqual({ hacker: 1782490000000, heli: 1782490500000 })
  })

  it('returns empty state for malformed JSON', () => {
    expect(parseRestartState('not json {')).toEqual(emptyRestartState())
    expect(parseRestartState('null')).toEqual(emptyRestartState())
    expect(parseRestartState('[1,2,3]')).toEqual(emptyRestartState())
  })

  it('drops corrupt / out-of-range entries instead of trusting them', () => {
    // negative / NaN failures (would disable back-off) and a zero lastRestart
    // (min 1, an epoch ms can never be 0) must all be discarded.
    const raw = JSON.stringify({
      failures: { hacker: -2, heli: 'x', key: 4, bad: NaN },
      lastRestart: { hacker: 0, heli: 1782490000000, '': 5 },
    })
    const parsed = parseRestartState(raw)
    expect(parsed.failures).toEqual({ key: 4 })
    expect(parsed.lastRestart).toEqual({ heli: 1782490000000 })
  })

  it('floors fractional counters', () => {
    const parsed = parseRestartState(JSON.stringify({ failures: { hacker: 2.9 }, lastRestart: {} }))
    expect(parsed.failures).toEqual({ hacker: 2 })
  })
})

describe('agent-restart-state file I/O', () => {
  it('saves and loads from disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'restart-state-'))
    const path = join(dir, 'state.json')
    try {
      saveRestartState(path, new Map([['hacker', 2]]), new Map([['hacker', 1782490000000]]))
      const loaded = loadRestartState(path)
      expect(loaded.failures).toEqual({ hacker: 2 })
      expect(loaded.lastRestart).toEqual({ hacker: 1782490000000 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns empty state when the file is missing', () => {
    const loaded = loadRestartState(join(tmpdir(), 'definitely-missing-restart-state-xyz.json'))
    expect(loaded).toEqual(emptyRestartState())
  })

  it('returns empty state when the file is corrupt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'restart-state-'))
    const path = join(dir, 'corrupt.json')
    try {
      writeFileSync(path, '{ broken')
      expect(loadRestartState(path)).toEqual(emptyRestartState())
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
