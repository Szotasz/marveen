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
// This module was the READ + VALIDATE half in PR1. PR2b (see
// docs/superpowers/specs/2026-09-11-claude-key-rotation-design.md section 7)
// adds the WRITE half: writeClaudePlans() + the exported validatePlan(), used
// by the dashboard CRUD route so a malformed entry can never reach disk
// through a different gate than the one resolveClaudePlans() reads back
// through. It still does NOT wire the main agent (channels.sh), do drift
// detection, or perform any rotation -- those stay separate, gated follow-ups
// (PR2c / PR3). The launch integration for regular agents lives in
// agent-process.ts and is strictly additive: no plan set => existing
// behaviour.
//
// The store file (store/claude-plans.json) is operator-owned and edited via
// the dashboard; it is an array of raw plan objects. resolveClaudePlans() is
// kept pure (raw JSON string + homeDir in, validated array out) so it unit-
// tests without the fs, mirroring resolveClaudeConfigDir in agent-config.ts.

import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import {
  expandAndValidateConfigDir,
  readAgentClaudeConfigDir,
  readAgentClaudePlan,
} from './agent-config.js'

export const CLAUDE_PLANS_PATH = join(PROJECT_ROOT, 'store', 'claude-plans.json')

export type ClaudePlanType = 'personal' | 'team'

export interface ClaudePlan {
  /** Stable identifier referenced by an agent's `claudePlan` field. */
  id: string
  /** Human label shown in the dashboard dropdown. */
  label: string
  /** Absolute, launcher-validated CLAUDE_CONFIG_DIR for this login. Mutually
   *  exclusive with tokenSecretId -- see validatePlan(). */
  configDir?: string
  /** Vault secret id (src/web/vault.ts) holding a raw, portable long-lived
   *  token (`claude setup-token`'s printed output, `sk-ant-oat01-...`), as an
   *  alternative to configDir. Mutually exclusive with configDir.
   *
   *  Why: a configDir-mode plan needs an INTERACTIVE `claude setup-token` run
   *  ON the machine that will use it -- fine for a plan registered where it
   *  runs, painful for a remote/headless install (2026-09-12 incident: two
   *  plans got registered on a remote host with no credentials ever placed in
   *  their configDir, because the setup-token step was never run there, and
   *  the dashboard registration alone gave no signal that anything was
   *  missing). A token-mode plan needs no per-host step at all: the operator
   *  can run `claude setup-token` ANYWHERE with a browser and paste the
   *  resulting string into the plan.
   *
   *  Every token-mode plan shares the SAME generic isolated CLAUDE_CONFIG_DIR
   *  (ensureMainAgentIsolatedConfigDir, credential-less) -- rotation only
   *  changes which token is exported as CLAUDE_CODE_OAUTH_TOKEN at launch,
   *  exactly like the flotta's own token already works. See
   *  resolveMainAgentRotatedTokenSecretId() and
   *  buildMainSessionRespawnCmd()'s ownCredentials/tokenSecretId handling. */
  tokenSecretId?: string
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

// Plan ids (and token-mode's tokenSecretId, which doubles as a vault secret
// id) are used as HTML option values / shell-interpolated / looked up by
// string equality; keep them to a boring, injection-proof charset.
export const PLAN_ID_ALLOWED = /^[A-Za-z0-9_.-]+$/

const VALID_PLAN_TYPES = new Set<ClaudePlanType>(['personal', 'team'])

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

// Validate a single raw entry into a ClaudePlan, or null if malformed. A bad
// entry is dropped rather than throwing so one typo in the registry cannot
// take down plan resolution for every other agent.
//
// Exported for the write API (PR2b, src/web/routes/claude-plans.ts): the
// route layer runs every create/update body through this exact function
// before it ever reaches writeClaudePlans(), so the write side accepts
// nothing that resolveClaudePlans() would then drop reading it back.
export function validatePlan(raw: unknown, homeDir: string): ClaudePlan | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>

  const id = isNonEmptyString(o.id) ? o.id.trim() : null
  if (!id || !PLAN_ID_ALLOWED.test(id)) return null

  if (!isNonEmptyString(o.label)) return null

  // Exactly one of configDir / tokenSecretId -- never both, never neither.
  // Both-set is rejected rather than silently preferring one: a caller that
  // sent both almost certainly has a bug, and guessing hides it.
  const hasConfigDir = isNonEmptyString(o.configDir)
  const hasTokenSecretId = isNonEmptyString(o.tokenSecretId)
  if (hasConfigDir === hasTokenSecretId) return null

  let configDir: string | undefined
  let tokenSecretId: string | undefined
  if (hasConfigDir) {
    // Same shell-safety gauntlet as the raw per-agent claudeConfigDir: the
    // path is inlined into the tmux launch command.
    const expanded = expandAndValidateConfigDir(o.configDir as string, homeDir)
    if (!expanded) return null
    configDir = expanded
  } else {
    const tid = (o.tokenSecretId as string).trim()
    if (!PLAN_ID_ALLOWED.test(tid)) return null
    tokenSecretId = tid
  }

  const planType = o.planType
  if (typeof planType !== 'string' || !VALID_PLAN_TYPES.has(planType as ClaudePlanType)) {
    return null
  }
  if (typeof o.channelsAllowed !== 'boolean') return null

  const plan: ClaudePlan = {
    id,
    label: o.label.trim(),
    planType: planType as ClaudePlanType,
    channelsAllowed: o.channelsAllowed,
  }
  if (configDir) plan.configDir = configDir
  if (tokenSecretId) plan.tokenSecretId = tokenSecretId
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
//
// Memoized by the file's mtime: the fleet-list poll resolves an agent's config
// dir on every tick (getAgentSummary -> resolveAgentConfigDir), so without a
// cache each poll re-reads + re-validates the whole registry per agent. The
// cache is invalidated automatically when the operator edits the file (mtime
// bumps); a missing file caches as an empty list under the sentinel mtime -1.
let plansCache: { mtimeMs: number; plans: ClaudePlan[] } | null = null

export function readClaudePlans(): ClaudePlan[] {
  let mtimeMs: number
  try { mtimeMs = statSync(CLAUDE_PLANS_PATH).mtimeMs } catch { mtimeMs = -1 }
  if (plansCache && plansCache.mtimeMs === mtimeMs) return plansCache.plans
  let plans: ClaudePlan[]
  if (mtimeMs === -1) {
    plans = []
  } else {
    let rawJson: string
    try { rawJson = readFileSync(CLAUDE_PLANS_PATH, 'utf8') } catch { rawJson = '' }
    plans = resolveClaudePlans(rawJson, homedir())
  }
  plansCache = { mtimeMs, plans }
  return plans
}

// Atomic overwrite of the whole registry (PR2b write API: create/update/
// delete all read-modify-write the full array and call this once). The mtime
// cache is reset immediately rather than left to the next statSync() to
// notice a bumped mtime -- two calls within the same filesystem timestamp
// resolution window would otherwise serve the pre-write cache straight back
// to a caller that just wrote fresh data (e.g. the route's own response, or a
// second write racing right behind it).
export function writeClaudePlans(plans: ClaudePlan[]): void {
  mkdirSync(dirname(CLAUDE_PLANS_PATH), { recursive: true })
  atomicWriteFileSync(CLAUDE_PLANS_PATH, JSON.stringify(plans, null, 2) + '\n')
  plansCache = null
}

// Resolve a single plan id to its plan, or null when the id is blank/unknown.
export function getClaudePlan(id: string | null | undefined): ClaudePlan | null {
  if (!id) return null
  return readClaudePlans().find(p => p.id === id) ?? null
}

// The one place that decides an agent's effective CLAUDE_CONFIG_DIR. Named plan
// wins over the raw claudeConfigDir; neither set => null (Claude Code default).
// EVERY read path (launch env, activeModel/contextTokens transcript lookup,
// conversation viewer) must go through this so the dashboard reads from the
// same projects dir the launcher actually wrote to. `planUnresolved` is true
// when the agent has a claudePlan set that no longer resolves (registry entry
// removed/renamed) -- callers that launch should surface it rather than
// silently fall back to the host login.
export function resolveAgentConfigDir(
  name: string,
): { configDir: string | null; planUnresolved: boolean } {
  const planId = readAgentClaudePlan(name)
  if (planId) {
    const plan = getClaudePlan(planId)
    if (plan?.configDir) return { configDir: plan.configDir, planUnresolved: false }
    // Token-mode plans (ClaudePlan.tokenSecretId) are main-agent-only for now
    // -- there is no per-agent configDir to hand back for one, same shape as a
    // removed/renamed plan, so this reads as unresolved rather than silently
    // returning an undefined dir.
    return { configDir: readAgentClaudeConfigDir(name), planUnresolved: true }
  }
  return { configDir: readAgentClaudeConfigDir(name), planUnresolved: false }
}

// The config root a READER must look in to find an agent's transcripts.
//
// resolveAgentConfigDir() answers what the operator CONFIGURED. That is the
// right question for the launcher, which then goes on to auto-provision an
// isolated config dir when nothing was configured (agent-process.ts:
// ensureIsolatedChannelConfigDir -> agents/<name>/.claude-config). It is the
// WRONG question for a reader, because the launcher's second step is invisible
// to it: the agent is writing into the isolated dir while the reader looks in
// ~/.claude.
//
// MEASURED 2026-08-21 07:03: every sub-agent's contextTokens on the dashboard
// was byte-identical at 04:09 and at 07:00, across three hours in which one of
// them ran a 12 MB catalogue audit. The live transcripts (agents/<name>/
// .claude-config/projects/...) carried that morning's mtime and 3-7 MB; the
// files actually being read (~/.claude/projects/-home-...-agents-<name>/) had
// all stopped on 2026-08-18 15:44 at 0.2-0.5 MB.
//
// Why that is worse than a stale number on a screen: context-restart-gate-
// runner.ts treats a null contextTokens as a fail-closed BLOCK. Here nothing
// was null -- the old files still existed, so the gate got a confident,
// three-day-old value and could not tell that it was blind. The same number
// feeds the model suggestion (routes/agents.ts).
//
// This deliberately probes the filesystem rather than re-deriving the
// launcher's decision (fleet token present? channel agent? auth mode?):
// duplicating that logic is how the two paths drifted apart in the first
// place. The isolated dir EXISTS only because the launcher provisioned it, so
// its presence is the launcher's own answer, read back.
// `projectRootOverride` exists for the tests: the isolated dir is found by
// probing the filesystem, so the probe root has to be redirectable to a
// fixture. Production callers pass nothing.
export function resolveAgentConfigDirForRead(name: string, projectRootOverride?: string): string | null {
  const configured = resolveAgentConfigDir(name).configDir
  if (configured) return configured
  const isolated = join(projectRootOverride ?? PROJECT_ROOT, 'agents', name, '.claude-config')
  // `projects` is what a transcript reader is after. Requiring it (rather than
  // just the directory) keeps a half-provisioned dir from shadowing the shared
  // root that the agent may genuinely still be using.
  if (existsSync(join(isolated, 'projects'))) return isolated
  return null
}
