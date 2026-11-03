import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { monthWindow, getCostSummary } from '../costops/ledger.js'
import { agentSpend, evaluateAgentBudgets, alertAgentBudgets } from '../costops/agent-budgets.js'
import type { AgentBudgetStatus } from '../costops/agent-budgets.js'
import { validateConfig } from '../costops/config.js'
import type { CostOpsConfig, TokenPrice } from '../costops/config.js'

const NOW = Math.floor(Date.UTC(2026, 9, 15) / 1000)
const WIN = monthWindow(NOW)
const PRICES: Record<string, TokenPrice> = { m1: { input: 4, output: 20, cache_write: 5, cache_read: 0.4 } }

function insert(agent: string, ts: number, model: string | null, i: number, o: number, cr: number, cw: number, th = 0) {
  getDb().prepare('INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, thinking_tokens, model) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(agent, 's', ts, i, o, cr, cw, th, model)
}
function seed53() { insert('a1', WIN.start + 100, 'm1', 1_000_000, 2_000_000, 10_000_000, 1_000_000, 999) }
function cfg(budgets: CostOpsConfig['budgets'], token_prices: CostOpsConfig['token_prices'] = PRICES): CostOpsConfig {
  return { version: 1, currency: 'HUF', fixed_costs: [], budgets, token_prices }
}

beforeEach(() => { initDatabase(':memory:') })

describe('agentSpend', () => {
  it('prices input/output/cache per 1M', () => {
    seed53()
    const s = agentSpend(getDb(), 'a1', WIN.start, WIN.end, PRICES)
    expect(s.cost).toBe(53)
    expect(s.unpriced_tokens).toBe(0)
    expect(s.tokens).toEqual({ input: 1_000_000, output: 2_000_000, cache_write: 1_000_000, cache_read: 10_000_000 })
  })
  it('never prices a model without a price', () => {
    insert('a1', WIN.start + 1, 'm1', 1_000_000, 0, 0, 0)
    insert('a1', WIN.start + 2, 'm2', 1, 2, 3, 4)
    insert('a1', WIN.start + 3, null, 10, 20, 30, 40)
    const s = agentSpend(getDb(), 'a1', WIN.start, WIN.end, PRICES)
    expect(s.cost).toBe(4)
    expect(s.unpriced_tokens).toBe(10 + 100)
  })
  it('a model id that is an Object.prototype key ("constructor") is unpriced, not priced through the prototype', () => {
    insert('a1', WIN.start + 1, 'constructor', 1, 2, 3, 4)
    const s = agentSpend(getDb(), 'a1', WIN.start, WIN.end, PRICES)
    expect(s.cost).toBe(0)
    expect(s.unpriced_tokens).toBe(10)
    expect(evaluateAgentBudgets(getDb(), cfg([{ id: 'b1', scope: 'agent', scope_ref: 'a1', amount: 100 }]), NOW)[0].status).toBe('unpriced')
  })
  it('missing cache_read price makes cache-read tokens unpriced', () => {
    insert('a1', WIN.start + 1, 'm1', 0, 0, 7, 0)
    const s = agentSpend(getDb(), 'a1', WIN.start, WIN.end, { m1: { input: 4, output: 20 } })
    expect(s.cost).toBe(0)
    expect(s.unpriced_tokens).toBe(7)
  })
  it('missing cache_write price makes only cache-write tokens unpriced', () => {
    insert('a1', WIN.start + 1, 'm1', 1000, 2000, 30, 40)
    const p = { input: 4, output: 20, cache_read: 0.4 }
    const s = agentSpend(getDb(), 'a1', WIN.start, WIN.end, { m1: p })
    expect(s.unpriced_tokens).toBe(40)
    expect(s.cost).toBeCloseTo(1000 * p.input / 1e6 + 2000 * p.output / 1e6 + 30 * p.cache_read / 1e6, 10)
  })
  it('input/output-only price leaves both cache kinds unpriced', () => {
    insert('a1', WIN.start + 1, 'm1', 1000, 2000, 30, 40)
    const s = agentSpend(getDb(), 'a1', WIN.start, WIN.end, { m1: { input: 4, output: 20 } })
    expect(s.unpriced_tokens).toBe(70)
  })
  it('counts only own rows inside [start, end)', () => {
    insert('a1', WIN.end, 'm1', 1_000_000, 0, 0, 0)
    insert('a1', WIN.start, 'm1', 1_000_000, 0, 0, 0)
    insert('a2', WIN.start + 5, 'm1', 1_000_000, 0, 0, 0)
    expect(agentSpend(getDb(), 'a1', WIN.start, WIN.end, PRICES).cost).toBe(4)
  })
})

describe('evaluateAgentBudgets', () => {
  const mk = (amount: number, extra = {}) => cfg([
    { id: 'b1', scope: 'agent', scope_ref: 'a1', amount, ...extra },
    { id: 'g', scope: 'global', amount: 5 },
    { id: 'b0', scope: 'agent', scope_ref: 'a2', amount: 0 },
  ])
  it('evaluates only agent budgets with amount > 0', () => {
    seed53()
    const r = evaluateAgentBudgets(getDb(), mk(100), NOW)
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ id: 'b1', agent: 'a1', spend: 53, used_pct: 0.53, status: 'ok', month: '2026-10' })
    expect(evaluateAgentBudgets(getDb(), mk(60), NOW)[0].status).toBe('warning')
    expect(evaluateAgentBudgets(getDb(), mk(50), NOW)[0].status).toBe('hard')
  })
  it('honours custom thresholds', () => {
    seed53()
    const r = evaluateAgentBudgets(getDb(), mk(100, { warning_threshold: 0.5, hard_threshold: 0.6 }), NOW)[0]
    expect(r.status).toBe('warning')
    expect(evaluateAgentBudgets(getDb(), mk(100, { warning_threshold: 0.1, hard_threshold: 0.5 }), NOW)[0].status).toBe('hard')
  })
  it('a level starts exactly at its threshold', () => {
    seed53()
    expect(evaluateAgentBudgets(getDb(), mk(53), NOW)[0].status).toBe('hard') // 53 / 53 = 1.0
    expect(evaluateAgentBudgets(getDb(), mk(106, { warning_threshold: 0.5 }), NOW)[0].status).toBe('warning') // 0.5
  })
  it('a non-agent budget is ignored even when it names a scope_ref', () => {
    seed53()
    const cfg = mk(100)
    cfg.budgets.push({ id: 'src1', scope: 'source', scope_ref: 'a1', amount: 10 })
    expect(evaluateAgentBudgets(getDb(), cfg, NOW).map(r => r.id)).toEqual(['b1'])
  })
})

describe('unpriced status', () => {
  const one = [{ id: 'b1', scope: 'agent' as const, scope_ref: 'a1', amount: 100 }]
  it('is unpriced when the only usage is on an unpriced model', () => {
    insert('a1', WIN.start + 1, 'm2', 5, 6, 7, 8)
    const [r] = evaluateAgentBudgets(getDb(), cfg(one), NOW)
    expect(r.status).toBe('unpriced')
    expect(r.spend).toBe(0)
  })
  it('is ok without usage this month', () => {
    expect(evaluateAgentBudgets(getDb(), cfg(one), NOW)[0].status).toBe('ok')
  })
  it('stays ok for priced usage under the threshold plus some unpriced usage, and the unpriced part alerts on its own', () => {
    seed53()
    insert('a1', WIN.start + 2, 'm2', 5, 6, 7, 8)
    const [r] = evaluateAgentBudgets(getDb(), cfg(one), NOW)
    expect(r.status).toBe('ok')
    expect(r.unpriced_tokens).toBe(26)
    const send = vi.fn((_k: string, _t: string, _o: { cooldownMs: number }) => true)
    expect(alertAgentBudgets([r], send)).toBe(1)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toBe('agent-budget:b1:unpriced-partial:2026-10')
    expect(send.mock.calls[0][1]).toContain('(26 token)')
    expect(send.mock.calls[0][1]).toContain('token_prices')
  })
})

describe('rounding', () => {
  it('judges the budget on the unrounded cost', () => {
    insert('a1', WIN.start + 1, 'm', 1, 0, 0, 0)
    const c = cfg([{ id: 'b1', scope: 'agent', scope_ref: 'a1', amount: 0.01 }], { m: { input: 5000, output: 0 } })
    const [st] = evaluateAgentBudgets(getDb(), c, NOW)
    expect(st.status).toBe('ok')
    expect(st.used_pct).toBe(0.5)
    expect(st.spend).toBe(0.01)
  })
})

describe('alertAgentBudgets', () => {
  const st = (id: string, status: AgentBudgetStatus['status'], unpriced = 0): AgentBudgetStatus => ({
    id, agent: 'ag-' + id, amount: 100, month: '2026-10', spend: 85, unpriced_tokens: unpriced,
    used_pct: 0.85, status, warning_threshold: 0.8, hard_threshold: 1,
  })
  it('sends once per warning/hard status', () => {
    const send = vi.fn((_k: string, _t: string, _o: { cooldownMs: number }) => true)
    const n = alertAgentBudgets([st('b1', 'warning'), st('b2', 'hard', 5), st('b3', 'ok')], send)
    expect(n).toBe(3)
    expect(send).toHaveBeenCalledTimes(3)
    const d = 40 * 24 * 60 * 60 * 1000
    expect(send.mock.calls[0][0]).toBe('agent-budget:b1:warning:2026-10')
    expect(send.mock.calls[1][0]).toBe('agent-budget:b2:hard:2026-10')
    expect(send.mock.calls[2][0]).toBe('agent-budget:b2:unpriced-partial:2026-10')
    expect(send.mock.calls[0][2]).toEqual({ cooldownMs: d })
    expect(send.mock.calls[0][1]).toContain('ag-b1')
    expect(send.mock.calls[0][1]).toContain('85%')
    expect(send.mock.calls[0][1]).not.toContain('Árazatlan')
    expect(send.mock.calls[1][1]).toContain('Árazatlan tokenek: 5.')
  })
  it('alerts for unpriced status and not for ok', () => {
    const send = vi.fn((_k: string, _t: string, _o: { cooldownMs: number }) => true)
    expect(alertAgentBudgets([st('b1', 'unpriced', 9), st('b2', 'ok')], send)).toBe(1)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toBe('agent-budget:b1:unpriced:2026-10')
    expect(send.mock.calls[0][1]).toContain('teljesen árazatlan')
    expect(send.mock.calls[0][1]).toContain('(9 token)')
    expect(send.mock.calls[0][2]).toEqual({ cooldownMs: 40 * 24 * 60 * 60 * 1000 })
  })
  it('counts only calls that returned true', () => {
    expect(alertAgentBudgets([st('b1', 'warning')], () => false)).toBe(0)
  })
  it('an ok level with unpriced usage sends only the unpriced alert', () => {
    const send = vi.fn((_k: string, _t: string, _o: { cooldownMs: number }) => true)
    expect(alertAgentBudgets([st('b1', 'ok', 7)], send)).toBe(1)
    expect(send).toHaveBeenCalledTimes(1)
    const [key, text, opts] = send.mock.calls[0] as unknown as [string, string, { cooldownMs: number }]
    expect(key).toBe('agent-budget:b1:unpriced-partial:2026-10')
    expect(text).toContain('(7 token)')
    expect(text).toContain('85%')
    expect(opts).toEqual({ cooldownMs: 40 * 24 * 60 * 60 * 1000 })
  })
  it('a fully unpriced month sends only its own status alert', () => {
    const send = vi.fn((_k: string, _t: string, _o: { cooldownMs: number }) => true)
    expect(alertAgentBudgets([st('b1', 'unpriced', 9)], send)).toBe(1)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toBe('agent-budget:b1:unpriced:2026-10')
  })
  it('an ok level without unpriced usage sends nothing', () => {
    const send = vi.fn((_k: string, _t: string, _o: { cooldownMs: number }) => true)
    expect(alertAgentBudgets([st('b1', 'ok', 0)], send)).toBe(0)
    expect(send).not.toHaveBeenCalled()
  })
})

describe('getCostSummary', () => {
  it('includes agent_budgets', () => {
    seed53()
    const s = getCostSummary(getDb(), cfg([{ id: 'b1', scope: 'agent', scope_ref: 'a1', amount: 100 }]), NOW)
    expect(s.agent_budgets).toHaveLength(1)
    expect(s.agent_budgets[0].spend).toBe(53)
  })
})

describe('validateConfig token_prices', () => {
  it('keeps valid, drops invalid with errors, accepts absence', () => {
    const r = validateConfig({
      token_prices: {
        ok: { input: 1, output: 2, cache_read: 0.1 },
        neg: { input: -1, output: 2 },
        str: { input: '1', output: 2 },
        badcache: { input: 1, output: 2, cache_write: -3 },
      },
    })
    expect(r.config.token_prices).toEqual({ ok: { input: 1, output: 2, cache_read: 0.1 } })
    expect(r.errors).toHaveLength(3)
    expect(r.errors[0]).toContain('token_prices.neg')
    const none = validateConfig({})
    expect(none.errors).toEqual([])
    expect('token_prices' in none.config).toBe(false)
    const msg = 'token_prices: must be an object mapping a model id to its prices'
    expect(validateConfig({ token_prices: 5 }).errors).toEqual([msg])
    expect(validateConfig({ token_prices: [] }).errors).toEqual([msg])
  })
  it('skips a __proto__ model id and keeps the others', () => {
    const r = validateConfig(JSON.parse('{"token_prices":{"__proto__":{"input":1,"output":2},"m1":{"input":4,"output":20}}}'))
    expect(r.errors).toEqual(['token_prices.__proto__: not a valid model id'])
    expect(r.config.token_prices).toEqual({ m1: { input: 4, output: 20 } })
    expect(Object.getPrototypeOf(r.config.token_prices)).toBe(Object.prototype)
  })
})
