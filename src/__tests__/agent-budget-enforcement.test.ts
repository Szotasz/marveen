import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const H = vi.hoisted(() => ({ root: '' }))
vi.mock('../config.js', async (orig) => ({ ...(await orig<typeof import('../config.js')>()), PROJECT_ROOT: H.root }))
H.root = mkdtempSync(join(tmpdir(), 'agent-budget-enf-'))
mkdirSync(join(H.root, 'store'), { recursive: true })

const { initDatabase, getDb } = await import('../db.js')
const { checkAgentBudgets, isAgentBudgetHeld, setAgentBudgetHoldForTest } = await import('../web/agent-budget-alerts.js')
const { validateConfig } = await import('../costops/config.js')
const { agentsAtHardLimit } = await import('../costops/agent-budgets.js')
const { splitBudgetHeld } = await import('../web/schedule-runner.js')

const STATE = join(H.root, 'store', 'state-test.json')
const CONFIG = join(H.root, 'store', 'costops-config.json')
const NOW = Date.UTC(2026, 9, 15) / 1000

function writeConfig(enforce: boolean): void {
  writeFileSync(CONFIG, JSON.stringify({
    version: 1, currency: 'HUF', fixed_costs: [],
    budgets: [{ id: 'b1', scope: 'agent', scope_ref: 'a1', amount: 10 }],
    token_prices: { m1: { input: 4, output: 20 } },
    enforce_agent_budgets: enforce,
  }))
}
function usage(input: number, output: number, ts = NOW - 3600): void {
  getDb().prepare(
    'INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, thinking_tokens, model) VALUES (?,?,?,?,?,?,?,?,?)',
  ).run('a1', `s-${input}-${output}-${ts}`, ts, input, output, 0, 0, 0, 'm1')
}

beforeAll(() => { initDatabase(':memory:') })
afterAll(() => { rmSync(H.root, { recursive: true, force: true }) })

describe('E1 validateConfig', () => {
  it('defaults to false, accepts booleans, rejects other values', () => {
    expect(validateConfig({}).config.enforce_agent_budgets).toBe(false)
    expect(validateConfig({ enforce_agent_budgets: true }).config.enforce_agent_budgets).toBe(true)
    const r = validateConfig({ enforce_agent_budgets: 'yes' })
    expect(r.config.enforce_agent_budgets).toBe(false)
    expect(r.errors).toContain('enforce_agent_budgets: must be true or false')
  })
})

describe('E2 agentsAtHardLimit', () => {
  it('returns only agents with status hard', () => {
    const mk = (agent: string, status: 'ok' | 'warning' | 'hard' | 'unpriced') => ({
      id: agent, agent, amount: 1, month: '2026-10', spend: 0, unpriced_tokens: 0, used_pct: 0,
      status, warning_threshold: 0.8, hard_threshold: 1,
    })
    expect([...agentsAtHardLimit([mk('a', 'ok'), mk('b', 'warning'), mk('c', 'hard'), mk('d', 'unpriced')])]).toEqual(['c'])
  })
})

describe('E3 splitBudgetHeld', () => {
  const held = (a: string) => a === 'b'
  it('holds only background work, keeping order', () => {
    expect(splitBudgetHeld(['a', 'b', 'c'], 'background', held)).toEqual({ run: ['a', 'c'], held: ['b'] })
    expect(splitBudgetHeld(['a', 'b', 'c'], 'owner-facing', held)).toEqual({ run: ['a', 'b', 'c'], held: [] })
    expect(splitBudgetHeld(['a', 'b', 'c'], 'free', held)).toEqual({ run: ['a', 'b', 'c'], held: [] })
  })
})

describe('E4 checkAgentBudgets hold', () => {
  it('holds only when enforcement is on and the agent is at its hard level', () => {
    setAgentBudgetHoldForTest([])
    usage(0, 1_000_000) // 20 of 10 -> hard
    writeConfig(true)
    checkAgentBudgets(NOW, () => true, STATE)
    expect(isAgentBudgetHeld('a1')).toBe(true)

    writeConfig(false)
    checkAgentBudgets(NOW, () => true, STATE)
    expect(isAgentBudgetHeld('a1')).toBe(false)

    writeConfig(true)
    checkAgentBudgets(NOW, () => true, STATE)
    expect(isAgentBudgetHeld('a1')).toBe(true)

    // a new month: last month's usage no longer counts
    checkAgentBudgets(Date.UTC(2026, 10, 15) / 1000, () => true, STATE)
    expect(isAgentBudgetHeld('a1')).toBe(false)
  })
})

describe('E5 schedule-runner wiring', () => {
  const src = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')
  it('applies the hold after the quota gate and before the pre-check', () => {
    const q = src.indexOf("if (quota.action === 'defer')")
    const s = src.indexOf('const budget = splitBudgetHeld(')
    const p = src.indexOf('const cronPc')
    expect(q).toBeGreaterThan(-1)
    expect(s).toBeGreaterThan(q)
    expect(p).toBeGreaterThan(s)
    const branch = src.slice(src.indexOf('if (budget.run.length === 0)'), p)
    expect(branch).toContain('scheduleLastRun.set(task.name, now)')
    expect(branch).toContain('persistScheduleLastRun()')
    // The rest of the cron path fires only the agents that were not held.
    expect(branch).toContain('const targetAgents = budget.run')
    expect(src.slice(src.indexOf('const targetAgents = budget.run'), src.indexOf('const targetAgents = budget.run') + 4000)).not.toContain('resolvedAgents')
  })
})
