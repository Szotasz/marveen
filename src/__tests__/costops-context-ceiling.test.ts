import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import {
  classifyContext,
  readAgentContext,
  checkContextCeilings,
  BREAK_EVEN_TOKENS,
  DEFAULT_CEILING_TOKENS,
  ALERT_COOLDOWN_SECONDS,
  WATCHED_AGENTS,
  type CeilingState,
} from '../costops/context-ceiling.js'

/**
 * The eco-worker is only cheaper while its context stays small. Past ~433k
 * tokens its per-call cost matches running the same task inside the fat main
 * session, and the main session averaged ~461k at the measured runs -- so a
 * neglected worker really can get there. This watch is what turns "keep the
 * context small" from a wish into something that gets noticed.
 */

const NOW = 1_785_000_000
const WATCH = { vesta: DEFAULT_CEILING_TOKENS }

function freshDb() {
  initDatabase(':memory:')
  getDb().exec('DELETE FROM token_usage;')
}

function insert(agent: string, ctx: number, ts = NOW - 60) {
  getDb().prepare(`INSERT INTO token_usage
    (agent,session_id,timestamp,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,model)
    VALUES (?,?,?,?,0,?,0,'claude-sonnet-5')`).run(agent, `s-${agent}-${ts}`, ts, ts % 97, ctx)
}

describe('classifying a context size', () => {
  it('uses the ceiling to warn and the break-even to escalate', () => {
    expect(classifyContext(100_000, DEFAULT_CEILING_TOKENS)).toBe('ok')
    expect(classifyContext(DEFAULT_CEILING_TOKENS, DEFAULT_CEILING_TOKENS)).toBe('over_ceiling')
    expect(classifyContext(400_000, DEFAULT_CEILING_TOKENS)).toBe('over_ceiling')
    expect(classifyContext(BREAK_EVEN_TOKENS, DEFAULT_CEILING_TOKENS)).toBe('past_break_even')
  })

  it('leaves room to act between the ceiling and the break-even', () => {
    // Alerting only at break-even would be alerting at the moment the worker
    // has already stopped being worth having.
    expect(DEFAULT_CEILING_TOKENS).toBeLessThan(BREAK_EVEN_TOKENS)
  })
})

describe('reading an agent context', () => {
  beforeEach(freshDb)

  it('takes the most recent call cache_read', () => {
    insert('vesta', 100_000, NOW - 300)
    insert('vesta', 260_000, NOW - 60)
    expect(readAgentContext(getDb(), 'vesta', 24 * 3600, NOW)).toBe(260_000)
  })

  it('returns null, not zero, when the agent has not run', () => {
    // An unstarted worker reported as a comfortable 0k would look healthy.
    expect(readAgentContext(getDb(), 'vesta', 24 * 3600, NOW)).toBeNull()
  })

  it('ignores rows outside the lookback', () => {
    insert('vesta', 300_000, NOW - 48 * 3600)
    expect(readAgentContext(getDb(), 'vesta', 24 * 3600, NOW)).toBeNull()
  })

  it('does not read another agent context', () => {
    insert('marveen', 900_000)
    expect(readAgentContext(getDb(), 'vesta', 24 * 3600, NOW)).toBeNull()
  })
})

describe('the watch', () => {
  beforeEach(freshDb)

  const deps = (over: Parameters<typeof checkContextCeilings>[1] = {}) => ({
    now: NOW, watched: WATCH, notify: () => {},
    readState: () => ({ last_alert_at: {} }), writeState: () => {},
    ...over,
  })

  it('says nothing while the worker stays small', () => {
    insert('vesta', 90_000)
    const notify = vi.fn()
    const r = checkContextCeilings(getDb(), deps({ notify }))
    expect(r.readings[0].level).toBe('ok')
    expect(notify).not.toHaveBeenCalled()
  })

  it('warns over the ceiling and names both numbers', () => {
    insert('vesta', 260_000)
    let text = ''
    checkContextCeilings(getDb(), deps({ notify: (t) => { text = t } }))
    expect(text).toContain('260k')
    expect(text).toContain('250k')
    expect(text).toContain('433k')
  })

  it('escalates past the break-even with a different message', () => {
    insert('vesta', 500_000)
    let text = ''
    const r = checkContextCeilings(getDb(), deps({ notify: (t) => { text = t } }))
    expect(r.readings[0].level).toBe('past_break_even')
    expect(text).toContain('no cheaper than running them in the main session')
  })

  it('never claims to have fixed anything', () => {
    // It reports. Compaction is the worker's job and restarts are the
    // operator's; a watch that quietly acted would be the worst of both.
    insert('vesta', 260_000)
    let text = ''
    checkContextCeilings(getDb(), deps({ notify: (t) => { text = t } }))
    expect(text).toContain('only reports and changes nothing')
  })

  it('does not watch the main agent, which is large by design', () => {
    // A daily false alarm about the main session is how a real warning gets
    // ignored, so the watch is an allow-list.
    insert('marveen', 900_000)
    const notify = vi.fn()
    const r = checkContextCeilings(getDb(), deps({ notify }))
    expect(notify).not.toHaveBeenCalled()
    expect(r.readings).toEqual([])
    expect(Object.keys(WATCHED_AGENTS)).not.toContain('marveen')
  })

  it('reports a watched agent it has not seen rather than passing it as fine', () => {
    const r = checkContextCeilings(getDb(), deps())
    expect(r.not_seen).toEqual(['vesta'])
    expect(r.readings).toEqual([])
  })

  it('stays quiet inside the cooldown', () => {
    insert('vesta', 300_000)
    const notify = vi.fn()
    const state: CeilingState = { last_alert_at: { vesta: NOW - 60 } }
    checkContextCeilings(getDb(), deps({ notify, readState: () => state }))
    expect(notify).not.toHaveBeenCalled()
  })

  it('speaks again once the cooldown has passed', () => {
    insert('vesta', 300_000)
    const notify = vi.fn()
    const state: CeilingState = { last_alert_at: { vesta: NOW - ALERT_COOLDOWN_SECONDS - 1 } }
    checkContextCeilings(getDb(), deps({ notify, readState: () => state }))
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('records the alert so the next cycle honours the cooldown', () => {
    insert('vesta', 300_000)
    const writeState = vi.fn()
    checkContextCeilings(getDb(), deps({ writeState }))
    expect(writeState).toHaveBeenCalledWith({ last_alert_at: { vesta: NOW } })
  })
})
