// Named Claude subscription registry.
//
// A "plan" is a named Claude login: a label plus the CLAUDE_CONFIG_DIR that
// carries its credentials/plugins/sessions, tagged with whether it is a
// personal or a company/team subscription and whether external Channels use
// is allowed on it. Agents reference a plan by its stable `id` (per-agent
// `claudePlan` field) instead of repeating a raw config-dir path, so many
// agents can share one login and the operator can re-point an agent from the
// dashboard with a single field.
//
// This module is the READ + VALIDATE half (PR1). It does NOT wire the main
// agent (channels.sh) or do drift detection -- those are separate, gated
// follow-ups. The launch integration for regular agents lives in
// agent-process.ts and is strictly additive: no plan set => existing
// behaviour.
//
// The store file (store/claude-plans.json) is operator-owned and edited via
// the dashboard; it is an array of raw plan objects. resolveClaudePlans() is
// kept pure (raw JSON string + homeDir in, validated array out) so it unit-
// tests without the fs, mirroring resolveClaudeConfigDir in agent-config.ts.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { expandAndValidateConfigDir } from './agent-config.js'

export const CLAUDE_PLANS_PATH = join(PROJECT_ROOT, 'store', 'claude-plans.json')

export type ClaudePlanType = 'personal' | 'team'

export interface ClaudePlan {
  /** Stable identifier referenced by an agent's `claudePlan` field. */
  id: string
  /** Human label shown in the dashboard dropdown. */
  label: string
  /** Absolute, launcher-validated CLAUDE_CONFIG_DIR for this login. */
  configDir: string
  /** Personal subscription vs. company/team seat. */
  planType: ClaudePlanType
  /** Whether external Channels (Telegram etc.) may run on this plan. Team
   *  plans typically forbid it; the guardrail (PR3) reads this. */
  channelsAllowed: boolean
  /** Forward-compat drift-detection hints (PR3), unused in PR1. Optional so
   *  the schema does not need a migration when drift lands. */
  expectedOrgType?: string
  expectedEmail?: string
}

// Plan ids are used as HTML option values and looked up by string equality;
// keep them to a boring, injection-proof charset.
const PLAN_ID_ALLOWED = /^[A-Za-z0-9_.-]+$/

const VALID_PLAN_TYPES = new Set<ClaudePlanType>(['personal', 'team'])

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

// Validate a single raw entry into a ClaudePlan, or null if malformed. A bad
// entry is dropped rather than throwing so one typo in the registry cannot
// take down plan resolution for every other agent.
function validatePlan(raw: unknown, homeDir: string): ClaudePlan | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>

  const id = isNonEmptyString(o.id) ? o.id.trim() : null
  if (!id || !PLAN_ID_ALLOWED.test(id)) return null

  if (!isNonEmptyString(o.label)) return null
  if (!isNonEmptyString(o.configDir)) return null
  // Same shell-safety gauntlet as the raw per-agent claudeConfigDir: the path
  // is inlined into the tmux launch command.
  const configDir = expandAndValidateConfigDir(o.configDir, homeDir)
  if (!configDir) return null

  const planType = o.planType
  if (typeof planType !== 'string' || !VALID_PLAN_TYPES.has(planType as ClaudePlanType)) {
    return null
  }
  if (typeof o.channelsAllowed !== 'boolean') return null

  const plan: ClaudePlan = {
    id,
    label: o.label.trim(),
    configDir,
    planType: planType as ClaudePlanType,
    channelsAllowed: o.channelsAllowed,
  }
  if (isNonEmptyString(o.expectedOrgType)) plan.expectedOrgType = o.expectedOrgType.trim()
  if (isNonEmptyString(o.expectedEmail)) plan.expectedEmail = o.expectedEmail.trim()
  return plan
}

// Pure resolver: raw JSON text (array) + homeDir -> validated plans. Invalid
// entries are dropped; on duplicate ids the first occurrence wins (later ones
// are ignored) so ordering in the file is authoritative. Non-array / bad JSON
// yields an empty list.
export function resolveClaudePlans(rawJson: string, homeDir: string): ClaudePlan[] {
  let parsed: unknown
  try { parsed = JSON.parse(rawJson) } catch { return [] }
  if (!Array.isArray(parsed)) return []
  const out: ClaudePlan[] = []
  const seen = new Set<string>()
  for (const entry of parsed) {
    const plan = validatePlan(entry, homeDir)
    if (!plan || seen.has(plan.id)) continue
    seen.add(plan.id)
    out.push(plan)
  }
  return out
}

// Read + resolve the registry from disk. Missing file => empty list (the
// feature is opt-in: no registry means every agent keeps its current
// behaviour).
export function readClaudePlans(): ClaudePlan[] {
  let rawJson: string
  try { rawJson = readFileSync(CLAUDE_PLANS_PATH, 'utf8') } catch { return [] }
  return resolveClaudePlans(rawJson, homedir())
}

// Resolve a single plan id to its plan, or null when the id is blank/unknown.
export function getClaudePlan(id: string | null | undefined): ClaudePlan | null {
  if (!id) return null
  return readClaudePlans().find(p => p.id === id) ?? null
}
