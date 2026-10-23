// CostOps -- per-agent cost budgets (D5a).
//
// Prices come only from the operator's token_prices config; a model without a
// configured price is reported as unpriced, never guessed.

import type Database from 'better-sqlite3'
import type { CostOpsConfig, TokenPrice } from './config.js'

// Local copy of monthWindow's month computation (UTC): importing it from
// ledger.ts would create an import cycle, since ledger.ts imports this module.
function currentMonth(now: number): { key: string; start: number; end: number } {
  const d = new Date(now * 1000)
  const year = d.getUTCFullYear()
  const month = d.getUTCMonth()
  return {
    key: `${year}-${String(month + 1).padStart(2, '0')}`,
    start: Math.floor(Date.UTC(year, month, 1) / 1000),
    end: Math.floor(Date.UTC(year, month + 1, 1) / 1000),
  }
}

export interface AgentSpend {
  cost: number  // unrounded; round only for display
  unpriced_tokens: number
  tokens: { input: number; output: number; cache_write: number; cache_read: number }
}

export function agentSpend(
  db: Database.Database,
  agent: string,
  start: number,
  end: number,
  prices: Record<string, TokenPrice>,
): AgentSpend {
  const rows = db.prepare(`
    SELECT model, SUM(input_tokens) AS i, SUM(output_tokens) AS o,
      SUM(cache_creation_tokens) AS cw, SUM(cache_read_tokens) AS cr
    FROM token_usage WHERE agent = ? AND timestamp >= ? AND timestamp < ? GROUP BY model
  `).all(agent, start, end) as Array<{ model: string | null; i: number | null; o: number | null; cw: number | null; cr: number | null }>

  const tokens = { input: 0, output: 0, cache_write: 0, cache_read: 0 }
  let cost = 0
  let unpriced = 0
  for (const r of rows) {
    const i = r.i ?? 0, o = r.o ?? 0, cw = r.cw ?? 0, cr = r.cr ?? 0
    tokens.input += i; tokens.output += o; tokens.cache_write += cw; tokens.cache_read += cr
    const p = r.model != null && Object.prototype.hasOwnProperty.call(prices, r.model) ? prices[r.model] : undefined
    if (!p) { unpriced += i + o + cw + cr; continue }
    // thinking_tokens are already part of output_tokens.
    cost += i * p.input / 1e6 + o * p.output / 1e6
    if (typeof p.cache_write === 'number') cost += cw * p.cache_write / 1e6
    else unpriced += cw
    if (typeof p.cache_read === 'number') cost += cr * p.cache_read / 1e6
    else unpriced += cr
  }
  return { cost, unpriced_tokens: unpriced, tokens }
}

export interface AgentBudgetStatus {
  id: string
  agent: string
  amount: number
  month: string
  spend: number
  unpriced_tokens: number
  used_pct: number
  status: 'ok' | 'warning' | 'hard' | 'unpriced'
  warning_threshold: number
  hard_threshold: number
}

export function evaluateAgentBudgets(db: Database.Database, config: CostOpsConfig, now: number): AgentBudgetStatus[] {
  const win = currentMonth(now)
  const out: AgentBudgetStatus[] = []
  for (const b of config.budgets) {
    if (b.scope !== 'agent' || !b.scope_ref || !(b.amount > 0)) continue
    const s = agentSpend(db, b.scope_ref, win.start, win.end, config.token_prices ?? {})
    const warning = b.warning_threshold ?? 0.8
    const hard = b.hard_threshold ?? 1.0
    const used = s.cost / b.amount
    const total = s.tokens.input + s.tokens.output + s.tokens.cache_write + s.tokens.cache_read
    // Every token is unpriced: the spend is not measurable, so never report 'ok'.
    const status: AgentBudgetStatus['status'] = total > 0 && s.unpriced_tokens === total
      ? 'unpriced'
      : used >= hard ? 'hard' : used >= warning ? 'warning' : 'ok'
    out.push({
      id: b.id, agent: b.scope_ref, amount: b.amount, month: win.key,
      spend: Math.round(s.cost * 100) / 100, unpriced_tokens: s.unpriced_tokens,
      used_pct: Math.round(used * 10000) / 10000,
      status,
      warning_threshold: warning, hard_threshold: hard,
    })
  }
  return out
}

/** The agents at their hard budget level (status 'hard'), for the opt-in background-task hold. */
export function agentsAtHardLimit(statuses: AgentBudgetStatus[]): Set<string> {
  return new Set(statuses.filter(s => s.status === 'hard').map(s => s.agent))
}

export function alertAgentBudgets(
  statuses: AgentBudgetStatus[],
  send: (key: string, text: string, opts: { cooldownMs: number }) => boolean,
): number {
  let sent = 0
  for (const s of statuses) {
    if (s.status !== 'ok') {
      let text: string
      if (s.status === 'unpriced') {
        text = `Ügynök-költségkeret (${s.agent}): a(z) ${s.month} havi használat teljesen árazatlan (${s.unpriced_tokens} token), a keret nem mérhető. Adj meg árat a token_prices beállításban.`
      } else {
        text = `Ügynök-költségkeret (${s.agent}): ${Math.round(s.used_pct * 100)}% a(z) ${s.month} havi keretből (${s.spend} / ${s.amount}).`
        if (s.unpriced_tokens > 0) text += ` Árazatlan tokenek: ${s.unpriced_tokens}.`
      }
      if (send(`agent-budget:${s.id}:${s.status}:${s.month}`, text, { cooldownMs: 40 * 24 * 60 * 60 * 1000 })) sent++
    }
    // Priced and unpriced usage in the same month: the level is measured on the priced part only,
    // so the unpriced part gets its own alert, once a month, whatever the level.
    if (s.status !== 'unpriced' && s.unpriced_tokens > 0) {
      const text = `Ügynök-költségkeret (${s.agent}): a(z) ${s.month} havi használatban árazatlan tokenek is vannak (${s.unpriced_tokens} token); ezek nincsenek benne a ${Math.round(s.used_pct * 100)}%-ban. Adj meg árat a token_prices beállításban.`
      if (send(`agent-budget:${s.id}:unpriced-partial:${s.month}`, text, { cooldownMs: 40 * 24 * 60 * 60 * 1000 })) sent++
    }
  }
  return sent
}
