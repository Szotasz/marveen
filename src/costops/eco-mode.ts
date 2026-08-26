// CostOps v0.2 -- eco mode: one switch that moves the fleet to a cheap model.
//
// This module PLANS and WRITES configuration. It never restarts anything: a
// model change only takes effect on the next agent restart, and restarting is
// an operator decision (the main agent in particular cannot restart itself
// without dropping its own session and the channel with it). Callers get the
// list of agents whose restart is still pending and decide what to do with it.
//
// Pure planning is separated from I/O so the interesting decisions -- what to
// change, what to leave alone, what to restore -- are testable without touching
// a config file.

import { readFileSync, writeFileSync, existsSync, renameSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { logger } from '../logger.js'
import { PRICE_MAP } from './pricing.js'

export const ECO_STATE_PATH = join(PROJECT_ROOT, 'store', 'eco-mode.json')
export const MAIN_AGENT_SETTINGS_PATH = join(PROJECT_ROOT, '.claude', 'settings.json')
export const AGENTS_BASE_DIR = join(PROJECT_ROOT, 'agents')

/** Sentinel for the main agent, whose model lives in .claude/settings.json. */
export const MAIN_AGENT_KEY = '(main)'

/**
 * Default model eco mode switches to.
 *
 * Sonnet 5 rather than Haiku: it halves the fleet's most expensive model
 * (fable-5, $10 -> $3 per 1M input) and cuts opus-5 by 40%, while staying in
 * the tier the fleet's paid work already runs on. Haiku is a bigger saving and
 * a bigger capability drop, so it is a deliberate choice rather than a default
 * -- pass `target` explicitly for it.
 */
export const DEFAULT_ECO_MODEL = 'claude-sonnet-5'

/**
 * Strip the harness's context-variant suffix: `claude-opus-5[1m]` names the
 * same priced model as `claude-opus-5`. Agent configs carry the suffix; the
 * API reports the bare id, which is what PRICE_MAP is keyed on.
 */
export function baseModelId(model: string): string {
  const i = model.indexOf('[')
  return i === -1 ? model : model.slice(0, i)
}

/**
 * Relative expense of a model, as its input rate in USD per 1M tokens.
 *
 * Input rate rather than a blended figure because every other component is
 * priced as a multiple of it (cache reads at 0.1x, writes at 1.25x), so it
 * orders models identically while needing no assumption about token mix.
 * Unknown models return null and are then left alone -- moving a model we
 * cannot price is a change we cannot justify.
 */
export function modelExpense(model: string | null): number | null {
  if (!model) return null
  const rate = PRICE_MAP[baseModelId(model)]
  return rate ? rate.input : null
}

export interface EcoModeState {
  enabled: boolean
  /** Epoch seconds when eco mode was last switched on, else null. */
  since: number | null
  /** The model eco mode last switched the fleet to, else null. */
  target: string | null
  /**
   * What each agent was set to before eco mode touched it.
   *
   * `null` is meaningful and distinct from absent: it records that the agent
   * had NO explicit model field and was following DEFAULT_MODEL. Restoring
   * such an agent must DELETE the field again, not write today's default --
   * writing it would silently pin the agent to whatever the default happened
   * to be on the day eco mode ran, and it would stop tracking future changes.
   */
  saved: Record<string, string | null>
}

export const EMPTY_ECO_STATE: EcoModeState = { enabled: false, since: null, target: null, saved: {} }

/** One agent's configured model. `model: null` = no explicit field. */
export interface AgentModel {
  agent: string
  model: string | null
  /** Absolute path of the JSON file the model field lives in. */
  path: string
}

export type ChangeReason =
  | 'switched_to_eco'
  | 'restored'
  | 'already_cheaper_or_equal'
  | 'unpriced_model_left_alone'
  | 'nothing_saved_to_restore'
  | 'already_at_target'

export interface PlannedChange {
  agent: string
  from: string | null
  /** Target value; `null` means the explicit model field should be removed. */
  to: string | null
  reason: ChangeReason
}

export interface EcoPlan {
  target: string | null
  changes: PlannedChange[]
  unchanged: PlannedChange[]
  /**
   * Agents whose config now differs from what their running process was
   * started with. A config edit alone changes nothing until a restart, and
   * this module deliberately performs none.
   */
  needsRestart: string[]
}

/**
 * Decide what switching eco mode ON would change.
 *
 * Two agents are deliberately left alone. One already at or below the target's
 * price -- "move everything to X" would otherwise UPGRADE a cheaper agent and
 * raise the bill, which is the opposite of the point. One whose model has no
 * published rate, because a change we cannot price is a change we cannot
 * justify; it is reported rather than silently skipped.
 */
export function planEcoEnable(current: AgentModel[], target: string): EcoPlan {
  const targetExpense = modelExpense(target)
  const changes: PlannedChange[] = []
  const unchanged: PlannedChange[] = []

  for (const a of current) {
    const add = (to: string | null, reason: ChangeReason) => {
      const row = { agent: a.agent, from: a.model, to, reason }
      ;(reason === 'switched_to_eco' ? changes : unchanged).push(row)
    }
    if (a.model !== null && baseModelId(a.model) === baseModelId(target)) {
      add(a.model, 'already_at_target')
      continue
    }
    const expense = modelExpense(a.model)
    if (a.model !== null && expense === null) {
      add(a.model, 'unpriced_model_left_alone')
      continue
    }
    // A missing model field follows DEFAULT_MODEL, which we cannot assume is
    // cheap, so it is eligible; an explicitly cheaper model is not.
    if (expense !== null && targetExpense !== null && expense <= targetExpense) {
      add(a.model, 'already_cheaper_or_equal')
      continue
    }
    add(target, 'switched_to_eco')
  }

  return { target, changes, unchanged, needsRestart: changes.map(c => c.agent) }
}

/** Decide what switching eco mode OFF would restore, from the saved originals. */
export function planEcoDisable(current: AgentModel[], state: EcoModeState): EcoPlan {
  const changes: PlannedChange[] = []
  const unchanged: PlannedChange[] = []

  for (const a of current) {
    if (!Object.hasOwn(state.saved, a.agent)) {
      unchanged.push({ agent: a.agent, from: a.model, to: a.model, reason: 'nothing_saved_to_restore' })
      continue
    }
    const saved = state.saved[a.agent]
    if (saved === a.model) {
      unchanged.push({ agent: a.agent, from: a.model, to: a.model, reason: 'already_at_target' })
      continue
    }
    changes.push({ agent: a.agent, from: a.model, to: saved, reason: 'restored' })
  }

  return { target: null, changes, unchanged, needsRestart: changes.map(c => c.agent) }
}

/**
 * Originals to remember when enabling.
 *
 * Only for agents we are actually changing, and only when eco mode was OFF.
 * Re-running an enable while already on must NOT overwrite the saved originals
 * with the eco model itself -- that would make the switch a one-way door.
 */
export function nextSavedOriginals(
  plan: EcoPlan,
  current: AgentModel[],
  state: EcoModeState,
): Record<string, string | null> {
  if (state.enabled) return state.saved
  const byAgent = new Map(current.map(a => [a.agent, a.model]))
  const saved: Record<string, string | null> = {}
  for (const c of plan.changes) saved[c.agent] = byAgent.get(c.agent) ?? null
  return saved
}

// ---- I/O ------------------------------------------------------------------

function readJson(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
  } catch (err) {
    logger.warn({ err, path }, 'eco-mode: unreadable JSON config')
    return null
  }
}

/**
 * Write JSON via a temp file and a rename.
 *
 * `.claude/settings.json` is the live main-agent config; a half-written file
 * there would break the agent's next start. rename(2) is atomic within a
 * filesystem, so a reader sees either the old file or the new one.
 */
function writeJsonAtomic(path: string, data: unknown): void {
  const tmp = `${path}.eco-tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8')
  renameSync(tmp, path)
}

/** Current model of every agent, main agent first. */
export function readFleetModels(): AgentModel[] {
  const out: AgentModel[] = []
  const main = readJson(MAIN_AGENT_SETTINGS_PATH)
  if (main) {
    out.push({
      agent: MAIN_AGENT_KEY,
      model: typeof main.model === 'string' ? main.model : null,
      path: MAIN_AGENT_SETTINGS_PATH,
    })
  }
  let entries: string[] = []
  try { entries = readdirSync(AGENTS_BASE_DIR) } catch { entries = [] }
  for (const name of entries.sort()) {
    const path = join(AGENTS_BASE_DIR, name, 'agent-config.json')
    const cfg = readJson(path)
    if (!cfg) continue
    out.push({ agent: name, model: typeof cfg.model === 'string' ? cfg.model : null, path })
  }
  return out
}

/**
 * Set (or, with `null`, remove) one agent's model field.
 *
 * The file is read, one key is changed, and everything else is written back
 * untouched -- these configs carry hooks, plugins and per-agent settings this
 * module knows nothing about, and rewriting them from a typed shape would
 * quietly drop whatever it failed to model.
 */
export function writeAgentModel(path: string, model: string | null): boolean {
  const cfg = readJson(path)
  if (!cfg) return false
  if (model === null) delete cfg.model
  else cfg.model = model
  try {
    writeJsonAtomic(path, cfg)
    return true
  } catch (err) {
    logger.error({ err, path }, 'eco-mode: failed to write config')
    return false
  }
}

export function readEcoState(): EcoModeState {
  const raw = readJson(ECO_STATE_PATH)
  if (!raw) return { ...EMPTY_ECO_STATE }
  return {
    enabled: raw.enabled === true,
    since: typeof raw.since === 'number' ? raw.since : null,
    target: typeof raw.target === 'string' ? raw.target : null,
    saved: (raw.saved && typeof raw.saved === 'object') ? raw.saved as Record<string, string | null> : {},
  }
}

export function writeEcoState(state: EcoModeState): void {
  writeJsonAtomic(ECO_STATE_PATH, state)
}

export interface EcoApplyResult {
  ok: boolean
  enabled: boolean
  plan: EcoPlan
  applied: string[]
  failed: string[]
  /** Always true: this module never restarts an agent. */
  restart_required: boolean
  note: string
}

const NEVER_RESTARTS =
  'Config only. A model change takes effect on the next agent restart, which this endpoint deliberately does not perform -- restarting is an operator decision, and the main agent cannot restart itself without dropping its own session.'

/**
 * Switch eco mode on or off: plan, write the configs, persist the state.
 * Never restarts. `dryRun` returns the plan with nothing written.
 */
export function applyEcoMode(
  enable: boolean,
  target: string,
  opts: { dryRun?: boolean; now?: number } = {},
): EcoApplyResult {
  const now = opts.now ?? Math.floor(Date.now() / 1000)
  const state = readEcoState()
  const current = readFleetModels()
  const plan = enable ? planEcoEnable(current, target) : planEcoDisable(current, state)

  if (opts.dryRun) {
    return { ok: true, enabled: state.enabled, plan, applied: [], failed: [], restart_required: true, note: NEVER_RESTARTS }
  }

  const saved = enable ? nextSavedOriginals(plan, current, state) : state.saved
  const byAgent = new Map(current.map(a => [a.agent, a]))
  const applied: string[] = []
  const failed: string[] = []
  for (const c of plan.changes) {
    const entry = byAgent.get(c.agent)
    if (entry && writeAgentModel(entry.path, c.to)) applied.push(c.agent)
    else failed.push(c.agent)
  }

  writeEcoState(
    enable
      ? { enabled: true, since: state.enabled ? state.since : now, target, saved }
      : { enabled: false, since: null, target: null, saved: {} },
  )

  logger.warn(
    { context: { action: enable ? 'eco_mode_enabled' : 'eco_mode_disabled', target, applied, failed } },
    `Eco mode ${enable ? 'enabled' : 'disabled'}: ${applied.length} config(s) rewritten, restart still pending`,
  )

  return {
    ok: failed.length === 0,
    enabled: enable,
    plan,
    applied,
    failed,
    restart_required: true,
    note: NEVER_RESTARTS,
  }
}
