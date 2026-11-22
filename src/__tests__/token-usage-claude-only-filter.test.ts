// CLAUDEACCOUNTONLY1122: the Token Monitor's headline numbers used to sum every
// agent's every model, including the fleet's free OpenRouter models -- not just
// what actually billed against the owner's own claude.ai account. The claudeOnly
// filter (model NOT LIKE '%/%') tells the two apart: every OpenRouter model id has
// a vendor/model-name shape, no real Anthropic model id does.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { getTokenSummary, getTokenTimeline, getModelDistribution } from '../web/token-usage.js'

function insertRow(db: ReturnType<typeof getDb>, opts: {
  agent: string
  sessionId: string
  timestamp: number
  model: string | null
  inputTokens?: number
  outputTokens?: number
}) {
  db.prepare(
    `INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, model)
     VALUES (?, ?, ?, ?, ?, 0, 0, ?)`
  ).run(opts.agent, opts.sessionId, opts.timestamp, opts.inputTokens ?? 100, opts.outputTokens ?? 10, opts.model)
}

beforeEach(() => {
  initDatabase(':memory:')
})

describe('claudeOnly filter', () => {
  it('getTokenSummary: excludes vendor/model rows when claudeOnly is set, keeps them otherwise', () => {
    const db = getDb()
    insertRow(db, { agent: 'toni-shark', sessionId: 's1', timestamp: 1000, model: 'claude-sonnet-5', inputTokens: 1000 })
    insertRow(db, { agent: 'coolio-rex', sessionId: 's2', timestamp: 1010, model: 'nvidia/nemotron-3.5-super-vl:free', inputTokens: 5000 })

    const all = getTokenSummary(undefined, undefined)
    expect(all.reduce((s, r) => s + r.totalInput, 0)).toBe(6000)

    const claudeOnly = getTokenSummary(undefined, undefined, true)
    expect(claudeOnly).toHaveLength(1)
    expect(claudeOnly[0].agent).toBe('toni-shark')
    expect(claudeOnly[0].totalInput).toBe(1000)
  })

  it('getTokenTimeline: claudeOnly drops OpenRouter-slug buckets', () => {
    const db = getDb()
    insertRow(db, { agent: 'toni-shark', sessionId: 's1', timestamp: 1000, model: 'claude-sonnet-5', inputTokens: 1000 })
    insertRow(db, { agent: 'garagizike', sessionId: 's2', timestamp: 1000, model: 'cohere/north-mini-code:free', inputTokens: 9000 })

    const all = getTokenTimeline(60, undefined, undefined, undefined, false)
    expect(all.reduce((s, r) => s + (r.inputTokens || 0), 0)).toBe(10000)

    const claudeOnly = getTokenTimeline(60, undefined, undefined, undefined, true)
    expect(claudeOnly).toHaveLength(1)
    expect(claudeOnly[0].agent).toBe('toni-shark')
    expect(claudeOnly[0].inputTokens).toBe(1000)
  })

  it('getModelDistribution: claudeOnly keeps only non-slug model ids', () => {
    const db = getDb()
    insertRow(db, { agent: 'toni-shark', sessionId: 's1', timestamp: 1000, model: 'claude-sonnet-5' })
    insertRow(db, { agent: 'toni-shark', sessionId: 's2', timestamp: 1010, model: 'claude-haiku-5-5' })
    insertRow(db, { agent: 'daikin-dia', sessionId: 's3', timestamp: 1020, model: 'nvidia/nemotron-3.5-super-vl:free' })

    const all = getModelDistribution()
    expect(all).toHaveLength(3)

    const claudeOnly = getModelDistribution(undefined, undefined, undefined, true)
    expect(claudeOnly.map((r) => r.model).sort()).toEqual(['claude-haiku-5-5', 'claude-sonnet-5'])
  })
})
