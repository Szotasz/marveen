// The base of creating an agent, apart from the HTTP handler: the refusals that must all pass before
// anything is written (checkAgentCreatable), and the synchronous writes that make a directory an agent
// (writeAgentBase). POST /api/agents calls both. They live here so that a second creator (the agent
// package installer, MIOAGENTINSTALL1114) writes the SAME base instead of a copy of it.
//
// Lifted out of routes/agents.ts without a change of behaviour: the order, the status codes and the
// texts of the refusals, and the order and the arguments of the writes, are pinned through the route
// by agent-create-characterization.test.ts.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../logger.js'
import { createAgentMessage } from '../db.js'
import { MAIN_AGENT_ID, RESERVED_AGENT_IDS } from '../config.js'
import { isValidModelId, InvalidModelIdError } from '../model-id.js'
import { isModelUnsupportedByCli, CLAUDE_MODEL_MIN_CLI } from '../claude-cli-support.js'
import { measureClaudeCliVersion } from './claude-cli-version.js'
import { loadCustomProvider } from './custom-providers.js'
import { agentDir, writeAgentModel, writeAgentCustomProvider, writeAgentSecurityProfile, writeAgentDisplayName, resolveModelId, listAgentNames, DEFAULT_MODEL, readJsonObjectForWrite } from './agent-config.js'
import { scaffoldAgentDir, writeAgentSettingsFromProfile, generateClaudeMd, generateSoulMd, inheritedMcpConfigForNewAgent } from './agent-scaffold.js'
import { validateAgentEngine, preflightCodexHome, syncCodexInstructions, omitDefaultCodexIdentity, type AgentEngineConfig } from './agent-engine.js'
import { agentTextLang } from './agent-text-lang.js'
import { snapshotPersonaFile, writePersonaFileIfUnchanged } from './persona-write-guard.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { sanitizeAgentName } from './sanitize.js'
import { launchableInstallDefault } from './default-model-guard.js'
import { isAgentRunning } from './agent-process.js'
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
  /** The resolved engine of the agent being created. A codex-engine agent never runs the Claude CLI,
   *  so the CLI launch gate does not apply to it. */
  engine?: string
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
  const cliGate = opts.engine === 'codex' ? null : await refuseIfCliCannotLaunch(model)
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

// Dropped into the agent dir when personality generation failed and the agent was
// kept on a template instead of being deleted. Its presence means "this agent
// works, but its CLAUDE.md/SOUL.md are placeholders".
//
// It does NOT mean the agent is waiting for anything. NOTHING reads this file:
// there is no regeneration job, no queue, no retry. It is a marker for an
// operator (and for whoever builds regeneration later), and the way out today is
// editing, via PUT /api/agents/:name. Do not reword this into a promise -- three
// separate copies of "awaiting regeneration" had to be removed once already.
export const PERSONALITY_PENDING_SENTINEL = '.personality-pending'

// Minimal placeholders used when generateClaudeMd/generateSoulMd fail, in the language
// of what they stand in for: the generators write Hungarian, or English on an install
// whose AGENT_TEXT_LANG is en (PERSONAESC1107; the English twins below, same rules). Deliberately NOT an imitation
// of a generated personality -- the first line says it is a template, so a
// stand-in never silently becomes the agent's identity.
//
// Two things this text must keep. It says "ugynok", not "agens": this lands in
// the wizard's editor directly under the notice banner and under a modal titled
// "Uj ugynok letrehozasa", and two words for one thing on one screen reads as
// carelessness. And it does NOT promise regeneration -- an earlier wording said
// "Ujrageneralasig ez marad ervenyben", but nothing reads
// PERSONALITY_PENDING_SENTINEL, so there is no regeneration to wait for. It
// points at editing, which is what actually exists.
function fallbackClaudeMd(name: string, description: string, model: string): string {
  if (agentTextLang() === 'en') return fallbackClaudeMdEn(name, description, model)
  return `# ${name}

> **FIGYELEM: ez egy SABLON.** Az ügynök személyiségének generálása nem sikerült a
> létrehozáskor, ezért ez a fájl helyőrző. Az ügynök használható, de a saját
> CLAUDE.md-je még nem készült el. Írd át itt, vagy az ügynök beállításainál.

## Szerepkör

${description}

## Alapelvek

- Végrehajtás. Ne magyarázd el, mit fogsz csinálni, csak csináld.
- Tömör válaszok, lényegre törően.
- Ha nem tudsz valamit, mondd meg egyszerűen.
- Kód, kommentek, technikai dokumentáció angolul; a felhasználóval magyarul.

## Modell

${model}
`
}

function fallbackSoulMd(name: string, description: string): string {
  if (agentTextLang() === 'en') return fallbackSoulMdEn(name, description)
  return `# ${name} - SOUL

> **FIGYELEM: ez egy SABLON.** A generálás nem sikerült, ez helyőrző szöveg.

${description}

Alapértelmezett hangnem: tömör, pontos, túlzás nélkül. A részletes személyiséget
itt írhatod meg.
`
}

// The English twins: "agent" throughout, and no promise of regeneration either.
export function fallbackClaudeMdEn(name: string, description: string, model: string): string {
  return `# ${name}

> **NOTE: this is a TEMPLATE.** Generating the agent's personality failed when it
> was created, so this file is a placeholder. The agent can be used, but its own
> CLAUDE.md has not been written yet. Rewrite it here, or on the agent's page.

## Role

${description}

## Principles

- Execution. Do not explain what you are going to do, just do it.
- Short answers, to the point.
- If you do not know something, say so plainly.
- Code, comments and technical documentation in English; with the user, the user's language (English by default).

## Model

${model}
`
}

export function fallbackSoulMdEn(name: string, description: string): string {
  return `# ${name} - SOUL

> **NOTE: this is a TEMPLATE.** Generation failed, this is placeholder text.

${description}

Default tone: concise, precise, no exaggeration. You can write the detailed personality
here.
`
}

// AGENTCREATEPR2-1119: the owner-session branch of POST /api/agents, lifted out unchanged so that the approved
// agent_create consumer creates through the SAME code. The route keeps the owner gate and the HTTP answer; the order
// of the refusals, the base writes, the personality step, the notices and the answer bodies are pinned through the
// route by agent-create-characterization.test.ts and agent-create-characterization-second-half.test.ts.
export interface AgentCreateResult { status: number; body: Record<string, unknown> }

export async function createAgentFromSpec(data: Record<string, unknown>, engine?: { engineConfig: AgentEngineConfig; explicit: boolean }): Promise<AgentCreateResult> {
  const engineConfig: AgentEngineConfig = engine?.engineConfig ?? validateAgentEngine({})
  const { description, model: rawModel, profile: rawProfile } = data as { name: string; description: string; model?: string; profile?: string }
  // A custom provider is stored apart from the model id, as the editor's PUT does. The wizard used to send its
  // picker value ("custom:<id>") as the model, so the agent ran that string as a model and the provider was on no
  // record: its delete named no agent, and the agent could not start.
  const customProvider = typeof data.customProvider === 'string' && data.customProvider.trim() ? data.customProvider.trim() : null
  const rawName = typeof data.name === 'string' ? data.name.trim() : ''
  const name = sanitizeAgentName(rawName)
  // DEFAULTCLIGUARD927: no model in the request = the install default,
  // guarded (fresh probe, like the gate below) so a create on a CLI that
  // cannot run the shipped default gets the previous tier, not a 422 for a
  // model the caller never picked.
  // ENGINEPILOT: a codex agent has no launchable Claude install to guard, so it takes DEFAULT_MODEL directly.
  const model = resolveModelId(rawModel || (engineConfig.engine === 'codex' ? DEFAULT_MODEL : await launchableInstallDefault('agent-create', { fresh: true })))
  const profileId = (rawProfile || 'default').trim() || 'default'

  // Every refusal (name, model id, custom provider, the CLI gate, description, the main agent's id, a
  // reserved id, an existing directory), in that order and before anything is created: agent-create.ts.
  // The engine is passed so the CLI launch gate can skip a codex-engine agent (it never runs the Claude CLI).
  const refusal = await checkAgentCreatable(name, model, customProvider, { requireDescription: true, description, engine: engineConfig.engine })
  if (refusal) return { status: refusal.status, body: refusal.body }

  // The codex preflight (inherited MCP shape, CODEX_HOME) is a refusal like the ones above: it runs
  // before anything is created, so a rejected create leaves no agent directory behind.
  if (engineConfig.engine === 'codex') {
    try {
      const inherited = inheritedMcpConfigForNewAgent(name, { log: false }).mcpServers
      const servers = inherited && typeof inherited === 'object' && !Array.isArray(inherited)
        ? inherited as Record<string, unknown> : {}
      preflightCodexHome(engineConfig.codexConfigDir!, agentDir(name), servers, engineConfig.codexIdentity, { profile: engineConfig.codexSandbox, agentName: name })
    } catch (err) { return { status: 400, body: { error: (err as Error).message } } }
  }

  // The synchronous base writes (scaffold, model, provider, security profile and settings, the armed
  // context guard, display name). They come before the personality generation below, the one step
  // that can fail and fall back to a template.
  writeAgentBase(name, { model, profileId, customProvider, displayName: rawName })

  // A plain Claude agent's agent-config.json carries no engine fields. When the request carries
  // engine fields, merge them into the base config, never replace it.
  if (engine?.explicit) {
    const configPath = join(agentDir(name), 'agent-config.json')
    const currentConfig = readJsonObjectForWrite(configPath)
    atomicWriteFileSync(configPath, JSON.stringify(omitDefaultCodexIdentity({ ...currentConfig, ...engineConfig }), null, 2))
  }

  logger.info({ name, description }, 'Generating agent CLAUDE.md and SOUL.md...')
  // Set when the personality fell back to a template. The response is deferred
  // to after the notification block so that BOTH outcomes announce the agent:
  // a template-personality agent exists and is usable, so the fleet has to hear
  // about it for the same reason a fully generated one does.
  let personalityPendingDetail: string | null = null
  // PERSONANOCLOBBER923: the agent dir is visible from scaffoldAgentDir() on,
  // and generation below can take many minutes. Snapshot the personality files
  // NOW, and let both completion paths write only while each file is still
  // exactly this -- an operator who wrote it in the meantime wins. See
  // persona-write-guard.ts for the measured incident.
  const personaFiles = (['CLAUDE.md', 'SOUL.md'] as const).map(file => {
    const path = join(agentDir(name), file)
    return { file, path, baseline: snapshotPersonaFile(path) }
  })
  const [claudeMdFile, soulMdFile] = personaFiles
  // Files a completion path left alone because they changed under it.
  const personaSkipped: Array<{ file: string; sidecarPath: string | null }> = []
  // Files the success path already wrote, so a throw after the first write
  // does not have the fallback report our own generated file as "changed".
  const personaWrittenByUs = new Set<string>()
  try {
    const [claudeMd, soulMd] = await Promise.all([
      generateClaudeMd(name, description, model),
      generateSoulMd(name, description),
    ])
    for (const [f, content] of [[claudeMdFile, claudeMd], [soulMdFile, soulMd]] as const) {
      const r = writePersonaFileIfUnchanged(f.path, f.baseline, content, { saveSidecarOnSkip: true })
      if (r.written) personaWrittenByUs.add(f.file)
      else personaSkipped.push({ file: f.file, sidecarPath: r.sidecarPath })
    }
    if (personaSkipped.length > 0) {
      logger.warn({ name, skipped: personaSkipped }, 'Agent created; generated personality NOT written over files changed during generation (saved as *.generated.md)')
    } else {
      logger.info({ name }, 'Agent created successfully')
    }
  } catch (err) {
    // NO DESTRUCTIVE ROLLBACK. This used to be
    //   rmSync(agentDir(name), { recursive: true, force: true })
    // which deleted the WHOLE agent directory when personality generation
    // failed. Reported by a user whose agent card showed on the dashboard
    // while the terminal answered "Agent not found" and restarting could not
    // help, because there was nothing left to start.
    //
    // Deleting was disproportionate. By this point scaffoldAgentDir() has
    // already produced a COMPLETE, valid agent -- .claude/{skills,hooks,
    // agents}, the channel state dir, memory/MEMORY.md, .mcp.json, the
    // quarantine-reader sub-agent -- and the model, security profile,
    // settings and display name are all written. The only thing missing is
    // the two PERSONALITY files, produced by the single most failure-prone
    // step: an LLM call that can time out, hit missing auth, a CLI error or a
    // network fault. Throwing away everything that succeeded because the
    // least essential part failed turns a slow generation into silent data
    // loss.
    //
    // So fall back to a minimal template and keep the agent usable. The
    // sentinel marks that the personality is a placeholder, and the response
    // says so and points at editing -- not at a regeneration that does not
    // exist.
    const detail = err instanceof Error ? err.message : 'Unknown error'
    logger.error({ err, name }, 'Agent personality generation failed -- falling back to template, agent kept')
    // PERSONANOCLOBBER923: the template goes only where the file is still
    // untouched. A failed generation must NEVER replace content somebody
    // wrote while it ran -- that is exactly the measured incident. No sidecar
    // here: a placeholder has nothing worth keeping.
    let templateWritten = false
    try {
      for (const [f, content] of [
        [claudeMdFile, fallbackClaudeMd(name, description, model)],
        [soulMdFile, fallbackSoulMd(name, description)],
      ] as const) {
        if (personaWrittenByUs.has(f.file)) continue
        const r = writePersonaFileIfUnchanged(f.path, f.baseline, content, { saveSidecarOnSkip: false })
        if (r.written) templateWritten = true
        else personaSkipped.push({ file: f.file, sidecarPath: null })
      }
      // The sentinel says "this agent's personality is a placeholder", so it
      // is written only when a placeholder actually landed.
      if (templateWritten) {
        atomicWriteFileSync(join(agentDir(name), PERSONALITY_PENDING_SENTINEL), `${new Date().toISOString()}\n${detail}\n`)
      }
    } catch (fallbackErr) {
      // Even the template write failed (disk full, permissions). Still do NOT
      // delete: a half-built agent an operator can inspect beats a vanished
      // one they cannot.
      logger.error({ err: fallbackErr, name }, 'Fallback template write failed; agent left in place for inspection')
    }
    if (personaSkipped.length > 0) {
      logger.warn({ name, skipped: personaSkipped }, 'Personality generation failed; fallback template NOT written over files changed during generation')
    }
    if (templateWritten) personalityPendingDetail = detail
  }

  if (engineConfig.engine === 'codex') syncCodexInstructions(agentDir(name))

  // A skip is never silent: besides the log line, the main agent hears which
  // files were left alone, because the HTTP caller may be long gone by the
  // time a slow generation finishes.
  if (personaSkipped.length > 0) {
    try {
      const list = personaSkipped
        .map(s => s.sidecarPath ? `${s.file} (a generált változat: ${s.sidecarPath})` : s.file)
        .join(', ')
      createAgentMessage('system', MAIN_AGENT_ID, `Az új ügynök (${name}) személyiség-generálása NEM írta felül ezeket a fájlokat, mert a generálás közben valaki módosította őket: ${list}. A kézi tartalom maradt érvényben.`)
    } catch (err) {
      logger.warn({ err, name }, 'Personality write skipped, and the main-agent notice about it failed')
    }
  }

  // Notifications are deliberately OUTSIDE the try above. They used to sit
  // inside it, after the "Agent created successfully" log, so a failure here
  // (DB busy, a dead target session) ran the catch and deleted a fully
  // created agent. A greeting that does not go out must never cost the agent.
  //
  // This also runs on the template-fallback path, deliberately, and with the
  // SAME text. The agent exists and works either way, so a silent creation
  // would be a second silent outcome in the same handler. That the personality
  // is a placeholder is the response's job to say, not the greeting's: the
  // other agents are being told who joined, not how well it went.
  try {
    const runningAgents = listAgentNames().filter(a => a !== name && isAgentRunning(a))
    for (const target of [MAIN_AGENT_ID, ...runningAgents]) {
      createAgentMessage('system', target, `Uj csapattag erkezett: ${name}. Leirasa: ${description}. Udv neki ha legkozelebb beszeltek!`)
    }
  } catch (err) {
    logger.warn({ err, name }, 'Agent created, but the team notification failed')
  }

  const skippedField = personaSkipped.length > 0
    ? { personalitySkipped: personaSkipped.map(s => ({ file: s.file, generatedPath: s.sidecarPath })) }
    : {}

  if (personalityPendingDetail !== null) {
    // The warning says what actually happens next. An earlier wording promised
    // "It is queued for regeneration", and there is no queue: the sentinel is
    // written by this handler and read by nothing (grep PERSONALITY_PENDING_SENTINEL).
    // What DOES exist is PUT /api/agents/:name with claudeMd/soulMd, so that is
    // what the message points at. The sentinel stays as a marker for whenever a
    // regeneration path gets built; it just must not be described as one today.
    return { status: 200, body: { ok: true, name, personalityPending: true, warning: 'Agent created with a template personality because generation failed. Edit CLAUDE.md and SOUL.md to replace it.', detail: personalityPendingDetail, ...skippedField } }
  }

  if (personaSkipped.length > 0) {
    return { status: 200, body: { ok: true, name, ...skippedField } }
  }

  return { status: 200, body: { ok: true, name } }
}
