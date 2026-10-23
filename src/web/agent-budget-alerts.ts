import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDb } from '../db.js'
import { PROJECT_ROOT } from '../config.js'
import { logger } from '../logger.js'
import { loadCostopsConfig } from '../costops/config.js'
import { evaluateAgentBudgets, alertAgentBudgets, agentsAtHardLimit } from '../costops/agent-budgets.js'
import { sendRoutineAlert } from './routine-alert.js'
import { atomicWriteFileSync } from './atomic-write.js'

export const AGENT_BUDGET_ALERTS_PATH = join(PROJECT_ROOT, 'store', 'agent-budget-alerts.json')

let budgetHold = new Set<string>()

function applyHold(next: Set<string>): void {
  const changed = next.size !== budgetHold.size || [...next].some(a => !budgetHold.has(a))
  budgetHold = next
  if (changed) {
    if (next.size > 0) logger.info({ agents: [...next] }, 'Agent budget hold: background scheduled tasks of these agents are deferred')
    else logger.info('Agent budget hold lifted: no agent is held')
  }
}

/** True while the opt-in enforcement holds this agent's background scheduled tasks (measured at the last budget check). */
export function isAgentBudgetHeld(agent: string): boolean {
  return budgetHold.has(agent)
}

/** Test helper: replace the hold set. */
export function setAgentBudgetHoldForTest(agents: string[]): void {
  budgetHold = new Set(agents)
}

function readSent(statePath: string): Record<string, number> {
  if (!existsSync(statePath)) return {}
  let raw: string
  try { raw = readFileSync(statePath, 'utf-8') } catch { return {} }
  try {
    const parsed = JSON.parse(raw) as { sent?: unknown }
    const sent = parsed?.sent
    if (!sent || typeof sent !== 'object' || Array.isArray(sent)) throw new Error('bad shape')
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(sent)) if (typeof v === 'number') out[k] = v
    return out
  } catch (err) {
    logger.warn({ err }, 'agent-budget-alerts.json is malformed; ignoring it')
    return {}
  }
}

// Runs after each token-usage collection: the per-agent budgets are measured
// against the freshly collected usage, and a warning or hard level alerts at
// most once per month (the alert key carries the month and the level). The
// sent keys are kept in a small state file so a restart does not repeat them.
export function checkAgentBudgets(
  now: number = Math.floor(Date.now() / 1000),
  send: (key: string, text: string, opts: { cooldownMs: number }) => boolean = sendRoutineAlert,
  statePath: string = AGENT_BUDGET_ALERTS_PATH,
): number {
  const { config } = loadCostopsConfig()
  const d = new Date(now * 1000)
  const monthKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
  const before = readSent(statePath)
  const sent: Record<string, number> = {}
  for (const [k, v] of Object.entries(before)) if (k.endsWith(`:${monthKey}`)) sent[k] = v

  const wrapped = (key: string, text: string, opts: { cooldownMs: number }): boolean => {
    if (Object.prototype.hasOwnProperty.call(sent, key)) return false
    const ok = send(key, text, opts)
    if (ok) sent[key] = now
    return ok
  }
  const statuses = evaluateAgentBudgets(getDb(), config, now)
  applyHold(config.enforce_agent_budgets ? agentsAtHardLimit(statuses) : new Set())
  const count = alertAgentBudgets(statuses, wrapped)

  if (JSON.stringify(sent) !== JSON.stringify(before)) {
    try { atomicWriteFileSync(statePath, JSON.stringify({ sent }, null, 2)) }
    catch (err) { logger.warn({ err }, 'Failed to write agent-budget-alerts.json') }
  }
  return count
}

// Collect, then check the budgets. A collect failure propagates (no check on
// stale data); a check failure is logged and never fails the collection.
export async function collectTokenUsageAndCheckBudgets(
  collect: () => Promise<unknown>,
  check: () => unknown,
): Promise<void> {
  await collect()
  try { check() } catch (err) { logger.warn({ err }, 'Agent budget check failed') }
}
