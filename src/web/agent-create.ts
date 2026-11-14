// The base of creating an agent, apart from the HTTP handler: the refusals that must all pass before
// anything is written (checkAgentCreatable), and the synchronous writes that make a directory an agent
// (writeAgentBase). POST /api/agents calls both. They live here so that a second creator (the agent
// package installer, MIOAGENTINSTALL1114) writes the SAME base instead of a copy of it.
//
// Lifted out of routes/agents.ts without a change of behaviour: the order, the status codes and the
// texts of the refusals, and the order and the arguments of the writes, are pinned through the route
// by agent-create-characterization.test.ts.
import { existsSync } from 'node:fs'
import { MAIN_AGENT_ID, RESERVED_AGENT_IDS } from '../config.js'
import { isValidModelId, InvalidModelIdError } from '../model-id.js'
import { isModelUnsupportedByCli, CLAUDE_MODEL_MIN_CLI } from '../claude-cli-support.js'
import { measureClaudeCliVersion } from './claude-cli-version.js'
import { loadCustomProvider } from './custom-providers.js'
import { agentDir, writeAgentModel, writeAgentCustomProvider, writeAgentSecurityProfile, writeAgentDisplayName } from './agent-config.js'
import { scaffoldAgentDir, writeAgentSettingsFromProfile } from './agent-scaffold.js'
import { loadProfileTemplate } from './profiles.js'
import { seedContextGuardForNewAgent } from './context-guard-store.js'

/**
 * PICKERCLIKAPU923: refuse a Claude model the INSTALLED CLI is measured not to
 * launch. Returns the 422 body, or null when the write may proceed. Fail-OPEN:
 * an unmeasured version refuses nothing. The probe is fresh (cache bypassed)
 * so an operator who just upgraded the CLI is not blocked by a stale reading.
 */
export async function refuseIfCliCannotLaunch(model: string): Promise<Record<string, unknown> | null> {
  const cli = await measureClaudeCliVersion({ fresh: true })
  if (!isModelUnsupportedByCli(model, cli.version)) return null
  const req = CLAUDE_MODEL_MIN_CLI[model.replace(/\[[^\]]*\]$/, '')]
  return {
    error: 'model not launchable by the installed Claude Code CLI',
    model,
    installedCli: cli.version,
    minCli: req?.minCli ?? null,
    message: `A telepített Claude Code ${cli.version} nem futtatja a(z) ${model} modellt (legalább ${req?.minCli ?? '?'} kell; mérve: ${req?.measured ?? 'n/a'}). Frissítsd a CLI-t, vagy válassz olyan modellt, amit ez a verzió ismer.`,
  }
}

export interface AgentCreateRefusal { status: number; body: Record<string, unknown> }

export interface AgentCreatableOpts {
  /** POST /api/agents needs a description (the personality is generated from it). The check keeps its
   *  place in the order, between the CLI gate and the main-agent name, so the route's error order holds. */
  requireDescription: boolean
  description?: unknown
}

/**
 * Every refusal of creating an agent, in the order the create route has always answered them. Returns
 * the first one that applies, or null when the agent may be created. Writes nothing. `name` is the
 * sanitized id and `model` the resolved model id.
 */
export async function checkAgentCreatable(
  name: string, model: string, customProvider: string | null, opts: AgentCreatableOpts,
): Promise<AgentCreateRefusal | null> {
  if (!name) return { status: 400, body: { error: 'Name is required' } }
  // SECSZIVEK1007: the model id is checked BEFORE anything is created;
  // writeAgentModel used to be the first check, after scaffoldAgentDir, and a
  // malformed id left a half-created agent dir behind.
  if (!isValidModelId(model)) return { status: 400, body: { error: new InvalidModelIdError(model).message } }
  // Checked before anything is created, like the model: an agent on a missing provider would not start.
  if (customProvider && !loadCustomProvider(customProvider)) return { status: 400, body: { error: `Unknown custom provider: ${customProvider}` } }
  // PICKERCLIKAPU923: the API is a writer too, not only the picker. A fresh
  // probe, so a CLI upgraded a minute ago is not refused on a stale cache.
  const cliGate = await refuseIfCliCannotLaunch(model)
  if (cliGate) return { status: 422, body: cliGate }
  if (opts.requireDescription && !opts.description) return { status: 400, body: { error: 'Description is required' } }
  // The main agent lives in PROJECT_ROOT, not under agents/, so the existsSync
  // below never sees it: without this, a sub-agent named like the main one
  // is created and shares its id in messages, kanban and memories.
  if (name === MAIN_AGENT_ID) return { status: 409, body: { error: 'Name is reserved for the main agent' } }
  // An id the message layer owns (FLEETRESERVEDNAME1021, with the configured
  // voice channel id, VOICECHANNELID1022): a sub-agent under it could not
  // send, or would be framed as something it is not. And a fixed first path
  // segment of this API (AGENTROUTERESERVED1114: activity, status, ...): the
  // fixed handler would answer the agent's own /api/agents/<name> address.
  if (RESERVED_AGENT_IDS.includes(name)) return { status: 409, body: { error: 'Name is reserved by the system' } }
  if (existsSync(agentDir(name))) return { status: 409, body: { error: 'Agent already exists' } }
  return null
}

export interface AgentBase {
  model: string
  profileId: string
  customProvider: string | null
  /** The name as the operator typed it; stored only when it differs from the sanitized id. */
  displayName?: string
}

/**
 * The synchronous writes that make `agents/<name>` an agent: the scaffold, the model, the custom
 * provider (when one is given), the security profile and the settings written from it, the armed
 * context guard, and the display name (when it differs from the id). Checks nothing: the caller has
 * already decided that the agent may be created.
 */
export function writeAgentBase(name: string, base: AgentBase): void {
  scaffoldAgentDir(name)
  writeAgentModel(name, base.model)
  if (base.customProvider) writeAgentCustomProvider(name, base.customProvider)
  writeAgentSecurityProfile(name, base.profileId)
  writeAgentSettingsFromProfile(name, loadProfileTemplate(base.profileId))
  // A new agent comes up with the context guard ARMED (fleet policy, 2026-09-08).
  // Written as an explicit store row rather than by moving
  // DEFAULT_CONTEXT_GUARD: the default is also what hidden technical workers
  // and never-configured existing agents fall back to, and both are
  // deliberately proactive-tier-off. Placed here, before personality
  // generation, so the LLM step -- the one that can fail and fall back to a
  // template -- cannot leave an agent unguarded.
  seedContextGuardForNewAgent(name)
  if (base.displayName && base.displayName !== name) writeAgentDisplayName(name, base.displayName)
}
