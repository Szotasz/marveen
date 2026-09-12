// PR2b: readClaudePlansState(), the reader for the not-yet-written (PR2c)
// store/claude-plans-state.json rotation side-car. Nothing writes this file
// yet, so these tests only cover: missing file, malformed content, and a
// well-formed snapshot read back verbatim.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-claude-plans-state-test-'))

vi.mock('../config.js', () => ({ PROJECT_ROOT: tmpRoot }))

const { readClaudePlansState, CLAUDE_PLANS_STATE_PATH } = await import('../web/claude-plans-state.js')

describe('readClaudePlansState', () => {
  it('returns an empty state when the file does not exist', () => {
    expect(readClaudePlansState()).toEqual({ activePlanId: null, plans: {} })
  })

  it('returns an empty state on unparseable JSON', () => {
    mkdirSync(join(tmpRoot, 'store'), { recursive: true })
    writeFileSync(CLAUDE_PLANS_STATE_PATH, 'not json')
    expect(readClaudePlansState()).toEqual({ activePlanId: null, plans: {} })
  })

  it('returns an empty state when the JSON is not an object (array, null, primitive)', () => {
    writeFileSync(CLAUDE_PLANS_STATE_PATH, '[]')
    expect(readClaudePlansState()).toEqual({ activePlanId: null, plans: {} })
    writeFileSync(CLAUDE_PLANS_STATE_PATH, 'null')
    expect(readClaudePlansState()).toEqual({ activePlanId: null, plans: {} })
    writeFileSync(CLAUDE_PLANS_STATE_PATH, '"pro"')
    expect(readClaudePlansState()).toEqual({ activePlanId: null, plans: {} })
  })

  it('reads a well-formed snapshot back verbatim', () => {
    const snapshot = {
      activePlanId: 'pro',
      plans: {
        pro: { observedAt: 1_700_000_000_000, source: 'authoritative', windows: { five_hour: { usedPercent: 42, resetsAt: 1_700_010_000 } } },
        team: { observedAt: 1_699_000_000_000, source: 'authoritative_cached', windows: {} },
      },
    }
    writeFileSync(CLAUDE_PLANS_STATE_PATH, JSON.stringify(snapshot))
    expect(readClaudePlansState()).toEqual(snapshot)
  })

  it('defaults a missing/bad-typed activePlanId or plans key rather than throwing', () => {
    writeFileSync(CLAUDE_PLANS_STATE_PATH, JSON.stringify({ activePlanId: 42, plans: 'nope' }))
    expect(readClaudePlansState()).toEqual({ activePlanId: null, plans: {} })

    writeFileSync(CLAUDE_PLANS_STATE_PATH, JSON.stringify({}))
    expect(readClaudePlansState()).toEqual({ activePlanId: null, plans: {} })
  })
})
