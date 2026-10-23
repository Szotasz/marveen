import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// checkAgentBudgets reads the real costops config file under the install root,
// so the root is a temporary directory for this file.
const H = vi.hoisted(() => ({ root: '' }))
vi.mock('../config.js', async (orig) => ({ ...(await orig<typeof import('../config.js')>()), PROJECT_ROOT: H.root }))
H.root = mkdtempSync(join(tmpdir(), 'agent-budget-alerts-'))
mkdirSync(join(H.root, 'store'), { recursive: true })

const { initDatabase, getDb } = await import('../db.js')
const { checkAgentBudgets } = await import('../web/agent-budget-alerts.js')

const STATE = join(H.root, 'store', 'state-test.json')
const NOW = Date.UTC(2026, 9, 15) / 1000 // 2026-10-15, mid-month

function usage(input: number, output: number): void {
  getDb().prepare(
    'INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, thinking_tokens, model) VALUES (?,?,?,?,?,?,?,?,?)',
  ).run('a1', `s-${input}-${output}`, NOW - 3600, input, output, 0, 0, 0, 'm1')
}

beforeAll(() => {
  initDatabase(':memory:')
  writeFileSync(join(H.root, 'store', 'costops-config.json'), JSON.stringify({
    version: 1, currency: 'HUF', fixed_costs: [],
    budgets: [{ id: 'b1', scope: 'agent', scope_ref: 'a1', amount: 10 }],
    token_prices: { m1: { input: 4, output: 20 } },
  }))
})

afterAll(() => { rmSync(H.root, { recursive: true, force: true }) })

describe('checkAgentBudgets', () => {
  it('reads the config and the usage, and alerts only above a threshold, once per level and month', () => {
    usage(1_000_000, 0) // 4 of 10 -> ok
    const send = vi.fn(() => true)
    expect(checkAgentBudgets(NOW, send, STATE)).toBe(0)
    expect(send).not.toHaveBeenCalled()

    usage(0, 1_000_000) // +20 -> 24 of 10 -> hard
    expect(checkAgentBudgets(NOW, send, STATE)).toBe(1)
    expect(send).toHaveBeenCalledTimes(1)
    const [key, text, opts] = send.mock.calls[0] as unknown as [string, string, { cooldownMs: number }]
    expect(key).toBe('agent-budget:b1:hard:2026-10')
    expect(text).toContain('a1')
    expect(text).toContain('240%')
    expect(opts.cooldownMs).toBe(40 * 24 * 60 * 60 * 1000)
  })

  it('remembers a sent alert in the state file (survives a restart)', () => {
    const again = vi.fn(() => true)
    expect(checkAgentBudgets(NOW, again, STATE)).toBe(0)
    expect(again).not.toHaveBeenCalled()
    expect(JSON.parse(readFileSync(STATE, 'utf-8')).sent['agent-budget:b1:hard:2026-10']).toBe(NOW)
  })

  it('prunes keys of older months', () => {
    writeFileSync(STATE, JSON.stringify({ sent: { 'agent-budget:b1:hard:2026-09': 1, 'agent-budget:b1:hard:2026-10': NOW } }))
    checkAgentBudgets(NOW, vi.fn(() => true), STATE)
    const sent = JSON.parse(readFileSync(STATE, 'utf-8')).sent
    expect(Object.keys(sent)).toEqual(['agent-budget:b1:hard:2026-10'])
  })

  it('treats a malformed state file as empty without throwing', () => {
    writeFileSync(STATE, '{not json')
    const send = vi.fn(() => true)
    expect(() => checkAgentBudgets(NOW, send, STATE)).not.toThrow()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('alerts once for fully unpriced usage and dedups in the same month', () => {
    getDb().prepare('DELETE FROM token_usage').run()
    getDb().prepare(
      'INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, thinking_tokens, model) VALUES (?,?,?,?,?,?,?,?,?)',
    ).run('a1', 's-unpriced', NOW - 3600, 100, 50, 0, 0, 0, 'unknown-model')
    const state = join(H.root, 'store', 'state-unpriced.json')
    const send = vi.fn(() => true)
    expect(checkAgentBudgets(NOW, send, state)).toBe(1)
    expect(send).toHaveBeenCalledTimes(1)
    const [key, text] = send.mock.calls[0] as unknown as [string, string]
    expect(key).toBe('agent-budget:b1:unpriced:2026-10')
    expect(text).toContain('teljesen árazatlan')
    expect(checkAgentBudgets(NOW, send, state)).toBe(0)
    expect(send).toHaveBeenCalledTimes(1)
  })
})
