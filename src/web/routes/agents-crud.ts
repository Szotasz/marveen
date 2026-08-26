import { existsSync, readFileSync, mkdtempSync, rmSync, unlinkSync, writeFileSync, copyFileSync } from 'node:fs'
import { join, extname } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { logger } from '../../logger.js'
import { isModelProfileId, MODEL_PROFILE_IDS } from '../../model-profiles.js'
import { MAIN_AGENT_ID, currentBotName, PROJECT_ROOT } from '../../config.js'
import { createAgentMessage, getDb, writeAgentAuditLog } from '../../db.js'
import { ensureFederationClaudeMdSection } from '../federation/onboarding.js'
import { atomicWriteFileSync } from '../atomic-write.js'
import { setSecret, deleteSecret } from '../vault.js'
import {
  agentDir,
  agentConfigRoot,
  DEFAULT_MODEL,
  readFileOr,
  findAvatarForAgent,
  resolveModelId,
  readAgentModel,
  readModelProfileMap,
  writeAgentModelProfile,
  writeAgentModel,
  readAgentDisplayName,
  writeAgentDisplayName,
  readAgentSecurityProfile,
  writeAgentSecurityProfile,
  listAgentNames,
  isKnownAgent,
  writeAgentAuthMode,
  writeAgentClaudePlan,
  writeAgentMemoryIsolation,
  readAgentRemoteHost,
  readAgentVoiceConfig,
  writeAgentVoiceConfig,
  writeAgentMcpScope,
  KNOWN_VOICE_MODELS,
  type AuthMode,
} from '../agent-config.js'
import { parseMcpScope, type McpScope } from '../mcp-tool-registry.js'
import { readClaudePlans } from '../claude-plans.js'
import {
  readAgentTeam,
  writeAgentTeam,
  sanitizeTeamConfig,
  cleanupTeamReferences,
  reportsToCreatesCycle,
  type TeamConfig,
} from '../agent-team.js'
import { sendAvatarChangeMessage } from '../telegram.js'
import { isMainChannelsAgent, MAIN_CHANNELS_SESSION } from '../main-agent.js'
import {
  writeAgentSettingsFromProfile,
  scaffoldAgentDir,
  generateClaudeMd,
  generateSoulMd,
} from '../agent-scaffold.js'
import { isAgentRunning, agentSessionName, capturePane, stopAgentProcess } from '../agent-process.js'
import { removeDesiredAgent } from '../agent-desired-state.js'
import { readContextTokensFromProjectDir } from '../active-model.js'
import { detectPaneState, detectPermissionMode } from '../../pane-state.js'
import { checkAgentPutFields, AGENT_PUT_WRITABLE_FIELDS } from '../agent-put-fields.js'
import { loadProfileTemplate, resolveProfilePlaceholders } from '../profiles.js'
import { sanitizeAgentName } from '../sanitize.js'
import { parseMultipart } from '../multipart.js'
import { readBody, readJsonBody, json, jsonMaybeGzip, serveFile } from '../http-helpers.js'

// Dropped into the agent dir when personality generation failed and the agent was
// kept on a template instead of being deleted. Its presence means "this agent
// works, but its CLAUDE.md/SOUL.md are placeholders".
//
// It does NOT mean the agent is waiting for anything. NOTHING reads this file:
// there is no regeneration job, no queue, no retry. It is a marker for an
// operator (and for whoever builds regeneration later), and the way out today is
// editing, via PUT /api/agents/:name. Do not reword this into a promise -- three
// separate copies of "awaiting regeneration" had to be removed once already.
//
// Two things this text must keep. It says "ugynok", not "agens": this lands in
// the wizard's editor directly under the notice banner and under a modal titled
// "Uj ugynok letrehozasa", and two words for one thing on one screen reads as
// carelessness. And it does NOT promise regeneration -- an earlier wording said
// "Ujrageneralasig ez marad ervenyben", but nothing reads
// PERSONALITY_PENDING_SENTINEL, so there is no regeneration to wait for. It
// points at editing, which is what actually exists.
export const PERSONALITY_PENDING_SENTINEL = '.personality-pending'

// Minimal placeholders used when generateClaudeMd/generateSoulMd fail. Hungarian
// with accents, because that is what they stand in for: the generators produce
// Hungarian agent personalities (see agent-scaffold.ts, whose SOUL prompt states
// "Write ALL Hungarian text with proper accents"). Deliberately NOT an imitation
// of a generated personality -- the first line says it is a template, so a
// stand-in never silently becomes the agent's identity.
function fallbackClaudeMd(name: string, description: string, model: string): string {
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
  return `# ${name} - SOUL

> **FIGYELEM: ez egy SABLON.** A generálás nem sikerült, ez helyőrző szöveg.

${description}

Alapértelmezett hangnem: tömör, pontos, túlzás nélkül. A részletes személyiséget
itt írhatod meg.
`
}
import {
  exportAgentBundle,
  importAgentBundle,
  exportAllAgentsBundle,
  importAllAgentsBundle,
  peekBundleKind,
  bundleFilename,
  fleetBundleFilename,
} from '../agent-bundle.js'
import type { RouteContext } from './types.js'
import { suggestForAgent, type AgentSignals } from '../model-suggest.js'
import { getTokenSummary } from '../token-usage.js'
import { listScheduledTasks } from '../scheduled-tasks-io.js'
import { remotePaneCache, agentRunStateCached, getAgentDetail, listAgentSummaries, assertAgentExists } from './agents-helpers.js'

export async function tryHandleAgentsCrud(ctx: RouteContext, webDir: string): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path === '/api/agents' && method === 'GET') {
    jsonMaybeGzip(req, res, listAgentSummaries())
    return true
  }

  // Live activity panel: per-agent "what is it doing right now". Read-only,
  // polled by the dashboard every 3s; uses the same pane-state detector as the
  // scheduler (detectPaneState) and returns the last few output lines as a tail.
  // Includes the main agent's channels session so the operator sees the whole
  // fleet, not just sub-agents. Restored after #226 dropped this route while the
  // frontend kept calling /api/agents/activity (which then 404'd the panel).
  if (path === '/api/agents/activity' && method === 'GET') {
    const label = (running: boolean, pane: string | null): string => {
      if (!running) return 'stopped'
      if (pane === null) return 'unknown'
      const s = detectPaneState(pane)
      if (s === 'busy' || s === 'typing') return 'working'
      if (s === 'idle') return 'idle'
      return s // 'unknown' | 'error'
    }
    const tailOf = (pane: string | null): string[] =>
      pane === null
        ? []
        : pane
            .split('\n')
            .map(l => l.replace(/\s+$/, ''))
            .filter(l => l.trim().length > 0)
            .slice(-8)

    // The permission mode the agent is sitting in. Every mode counts as idle
    // for delivery, so `state` alone cannot distinguish "working normally" from
    // "will stop at its first tool call waiting for an approval nobody is
    // watching for" -- an agent spent hours in the second case on 2026-07-27
    // while the dashboard showed it as perfectly idle.
    const modeOf = (running: boolean, pane: string | null): string | null =>
      running && pane !== null ? detectPermissionMode(pane) : null

    const entries: Array<{ name: string; isMain: boolean; running: boolean; state: string; mode: string | null; tail: string[] }> = []

    // Main agent runs in the --channels session, not agent-<name>.
    {
      const mainPane = capturePane(MAIN_CHANNELS_SESSION)
      const running = mainPane !== null
      entries.push({
        name: MAIN_AGENT_ID,
        isMain: true,
        running,
        state: label(running, mainPane),
        mode: modeOf(running, mainPane),
        tail: tailOf(mainPane),
      })
    }

    for (const name of listAgentNames()) {
      // Remote agents: resolve run state + pane through the short-TTL caches so
      // this 3s-polled endpoint never blocks the event loop on an ssh timeout.
      const host = readAgentRemoteHost(name)
      const runState = agentRunStateCached(name, host != null)
      const running = runState === 'running'
      let pane: string | null = null
      if (running) {
        pane = host
          ? remotePaneCache.getOrRefresh(name, Date.now(), () => capturePane(agentSessionName(name), host), null)
          : capturePane(agentSessionName(name))
      }
      const state = runState === 'unreachable' ? 'unreachable' : label(running, pane)
      entries.push({ name, isMain: false, running, state, mode: modeOf(running, pane), tail: tailOf(pane) })
    }

    jsonMaybeGzip(req, res, entries)
    return true
  }

  if (path === '/api/agents/model-suggest' && method === 'POST') {
    // Collect runtime signals once, then classify per agent.
    // I/O is centralised here; the classifier (model-suggest.ts) stays pure.

    // Token usage: per-agent average input tokens/call over the last 30 days
    const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 24 * 3600
    const tokenSummaries = getTokenSummary(thirtyDaysAgo)
    const tokenMap = new Map(
      tokenSummaries.map(s => [s.agent, s.totalCalls > 0 ? s.totalInput / s.totalCalls : 0])
    )

    // Kanban: open and urgent/high card counts per assignee
    const db = getDb()
    type KanbanRow = { assignee: string | null; priority: string; cnt: number }
    const kanbanRows = db.prepare(
      `SELECT assignee, priority, COUNT(*) as cnt
       FROM kanban_cards
       WHERE archived_at IS NULL AND assignee IS NOT NULL
       GROUP BY assignee, priority`
    ).all() as KanbanRow[]
    const kanbanMap = new Map<string, { open: number; urgent: number }>()
    for (const row of kanbanRows) {
      if (!row.assignee) continue
      const cur = kanbanMap.get(row.assignee) ?? { open: 0, urgent: 0 }
      cur.open += row.cnt
      if (row.priority === 'urgent' || row.priority === 'high') cur.urgent += row.cnt
      kanbanMap.set(row.assignee, cur)
    }

    // Scheduled-task frequency: total estimated runs/day per agent (cron-derived)
    function cronFreqPerDay(cron: string): number {
      const parts = cron.trim().split(/\s+/)
      if (parts.length < 5) return 1
      const [min, hour] = parts
      if (min.startsWith('*/')) {
        const n = parseInt(min.slice(2), 10)
        if (!isNaN(n) && n > 0) return Math.round((60 / n) * 24)
      }
      if (hour === '*') return 24
      if (hour.startsWith('*/')) {
        const n = parseInt(hour.slice(2), 10)
        if (!isNaN(n) && n > 0) return Math.round(24 / n)
      }
      return 1
    }
    const schedFreqMap = new Map<string, number>()
    try {
      for (const task of listScheduledTasks()) {
        if (!task.enabled) continue
        const freq = cronFreqPerDay(task.schedule)
        schedFreqMap.set(task.agent, (schedFreqMap.get(task.agent) ?? 0) + freq)
      }
    } catch { /* scheduled-tasks dir may not exist yet */ }

    // MCP server count: read agents/<name>/.mcp.json
    function mcpServerCount(agentName: string): number {
      const mcpPath = join(agentDir(agentName), '.mcp.json')
      if (!existsSync(mcpPath)) return 0
      try {
        const cfg = JSON.parse(readFileSync(mcpPath, 'utf-8')) as { mcpServers?: Record<string, unknown> }
        return Object.keys(cfg.mcpServers ?? {}).length
      } catch { return 0 }
    }

    const names = listAgentNames()
    const results = [MAIN_AGENT_ID, ...names].map(name => {
      const dir = agentDir(name)
      const claudeMd = readFileOr(join(dir, 'CLAUDE.md'), '')
      const personaPath = join(PROJECT_ROOT, 'personas', `${name}.md`)
      const personaMd = existsSync(personaPath) ? readFileSync(personaPath, 'utf-8') : ''
      const personaText = [claudeMd, personaMd].filter(Boolean).join('\n')
      const currentModel = readAgentModel(name)
      const contextTokens = readContextTokensFromProjectDir(dir) ?? 0

      const kanban = kanbanMap.get(name)
      const signals: AgentSignals = {
        tokenAvgInputPerCall: tokenMap.has(name) ? tokenMap.get(name) : undefined,
        kanbanOpenCount: kanban?.open,
        kanbanUrgentCount: kanban?.urgent,
        scheduledFreqPerDay: schedFreqMap.has(name) ? schedFreqMap.get(name) : undefined,
        mcpServerCount: mcpServerCount(name),
      }

      return suggestForAgent(name, currentModel, personaText, contextTokens, signals)
    })
    json(res, { results })
    return true
  }

  if (path === '/api/agents' && method === 'POST') {
    const data = await readJsonBody<{ name: string; description: string; model?: string; profile?: string }>(req)
    const { description, model: rawModel, profile: rawProfile } = data
    const rawName = typeof data.name === 'string' ? data.name.trim() : ''
    const name = sanitizeAgentName(rawName)
    const model = resolveModelId(rawModel || DEFAULT_MODEL)
    const profileId = (rawProfile || 'default').trim() || 'default'

    if (!name) { json(res, { error: 'Name is required' }, 400); return true }
    if (!description) { json(res, { error: 'Description is required' }, 400); return true }
    if (existsSync(agentDir(name))) { json(res, { error: 'Agent already exists' }, 409); return true }

    scaffoldAgentDir(name)
    writeAgentModel(name, model)
    writeAgentSecurityProfile(name, profileId)
    writeAgentSettingsFromProfile(name, loadProfileTemplate(profileId))
    if (rawName && rawName !== name) writeAgentDisplayName(name, rawName)

    // Set when the personality fell back to a template. The response is deferred
    // to after the notification block so that BOTH outcomes announce the agent:
    // a template-personality agent exists and is usable, so the fleet has to hear
    // about it for the same reason a fully generated one does.
    let personalityPendingDetail: string | null = null

    logger.info({ name, description }, 'Generating agent CLAUDE.md and SOUL.md...')
    try {
      const [claudeMd, soulMd] = await Promise.all([
        generateClaudeMd(name, description, model),
        generateSoulMd(name, description),
      ])
      atomicWriteFileSync(join(agentDir(name), 'CLAUDE.md'), claudeMd)
      atomicWriteFileSync(join(agentDir(name), 'SOUL.md'), soulMd)
      logger.info({ name }, 'Agent created successfully')
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
      try {
        atomicWriteFileSync(join(agentDir(name), 'CLAUDE.md'), fallbackClaudeMd(name, description, model))
        atomicWriteFileSync(join(agentDir(name), 'SOUL.md'), fallbackSoulMd(name, description))
        atomicWriteFileSync(join(agentDir(name), PERSONALITY_PENDING_SENTINEL), `${new Date().toISOString()}\n${detail}\n`)
      } catch (fallbackErr) {
        // Even the template write failed (disk full, permissions). Still do NOT
        // delete: a half-built agent an operator can inspect beats a vanished
        // one they cannot.
        logger.error({ err: fallbackErr, name }, 'Fallback template write failed; agent left in place for inspection')
      }
      // Set when the personality fell back to a template. The response is deferred
      // to after the notification block so that BOTH outcomes announce the agent:
      // a template-personality agent exists and is usable, so the fleet has to hear
      // about it for the same reason a fully generated one does.
      personalityPendingDetail = detail
    }

    try {
      writeAgentAuditLog({ agent_id: 'system', entity: 'agent', action: 'create', entity_id: name, detail: { model, profileId } })
    } catch { /* audit failure must not abort agent creation */ }

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

    if (personalityPendingDetail !== null) {
      // The warning says what actually happens next. An earlier wording promised
      // "It is queued for regeneration", and there is no queue: the sentinel is
      // written by this handler and read by nothing (grep PERSONALITY_PENDING_SENTINEL).
      // What DOES exist is PUT /api/agents/:name with claudeMd/soulMd, so that is
      // what the message points at. The sentinel stays as a marker for whenever a
      // regeneration path gets built; it just must not be described as one today.
      json(res, { ok: true, name, personalityPending: true, warning: 'Agent created with a template personality because generation failed. Edit CLAUDE.md and SOUL.md to replace it.', detail: personalityPendingDetail }, 200)
      return true
    }

    json(res, { ok: true, name })
    return true
  }

  const avatarUploadMatch = path.match(/^\/api\/agents\/([^/]+)\/avatar$/)
  if (avatarUploadMatch && method === 'POST') {
    const name = decodeURIComponent(avatarUploadMatch[1])
    if (!assertAgentExists(name, res)) return true

    const body = await readBody(req)
    const contentType = req.headers['content-type'] || ''

    for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
      const p = join(agentDir(name), `avatar${ext}`)
      if (existsSync(p)) unlinkSync(p)
    }

    if (contentType.includes('application/json')) {
      const { galleryAvatar } = JSON.parse(body.toString()) as { galleryAvatar: string }
      if (!galleryAvatar) { json(res, { error: 'No avatar specified' }, 400); return true }
      if (galleryAvatar.includes('..') || galleryAvatar.includes('/') || galleryAvatar.includes('\\')) {
        json(res, { error: 'Invalid avatar name' }, 400); return true
      }
      const srcPath = join(webDir, 'avatars', galleryAvatar)
      if (!existsSync(srcPath)) { json(res, { error: 'Avatar not found' }, 404); return true }
      const ext = extname(galleryAvatar) || '.png'
      const destPath = join(agentDir(name), `avatar${ext}`)
      copyFileSync(srcPath, destPath)
      sendAvatarChangeMessage(name, destPath).catch(() => {})
      json(res, { ok: true })
      return true
    } else {
      const { file } = parseMultipart(body, contentType)
      if (!file) { json(res, { error: 'No file uploaded' }, 400); return true }
      const ext = extname(file.name) || '.png'
      const destPath = join(agentDir(name), `avatar${ext}`)
      writeFileSync(destPath, file.data)
      sendAvatarChangeMessage(name, destPath).catch(() => {})
      json(res, { ok: true })
      return true
    }
  }

  if (avatarUploadMatch && method === 'GET') {
    const name = decodeURIComponent(avatarUploadMatch[1])
    const avatarPath = findAvatarForAgent(name)
    // 1h client cache: see /api/marveen/avatar for the staleness trade-off.
    if (avatarPath) { serveFile(req, res, avatarPath, { cacheSeconds: 3600 }); return true }
    res.writeHead(404); res.end()
    return true
  }

  const secGetMatch = path.match(/^\/api\/agents\/([^/]+)\/security$/)
  if (secGetMatch && method === 'GET') {
    const name = decodeURIComponent(secGetMatch[1])
    if (!assertAgentExists(name, res)) return true
    const profileId = readAgentSecurityProfile(name)
    const profile = loadProfileTemplate(profileId)
    const placeholders = { HOME: homedir(), AGENT_DIR: agentDir(name) }
    json(res, {
      profile: profileId,
      label: profile.label,
      description: profile.description,
      permissionMode: profile.permissionMode,
      allow: profile.filesystem.allow.map(p => resolveProfilePlaceholders(p, placeholders)),
      deny: profile.filesystem.deny.map(p => resolveProfilePlaceholders(p, placeholders)),
    })
    return true
  }

  if (secGetMatch && method === 'PUT') {
    const name = decodeURIComponent(secGetMatch[1])
    if (!assertAgentExists(name, res)) return true
    const data = await readJsonBody<{ profile?: string }>(req)
    const requested = (data.profile || '').trim()
    if (!requested) { json(res, { error: 'profile is required' }, 400); return true }
    const profile = loadProfileTemplate(requested)
    if (profile.id !== requested) { json(res, { error: `Unknown profile: ${requested}` }, 400); return true }
    writeAgentSecurityProfile(name, requested)
    writeAgentSettingsFromProfile(name, profile)
    json(res, { ok: true, requiresRestart: isAgentRunning(name) })
    return true
  }

  if (path === '/api/team/graph' && method === 'GET') {
    const nodes: Array<{
      id: string
      label: string
      role: 'main' | 'leader' | 'member'
      reportsTo: string | null
      delegatesTo: string[]
      running?: boolean
      securityProfile?: string
    }> = []
    nodes.push({
      id: MAIN_AGENT_ID,
      label: currentBotName(),
      role: 'main',
      reportsTo: null,
      delegatesTo: [],
      running: true,
    })
    for (const agentName of listAgentNames()) {
      const team = readAgentTeam(agentName)
      nodes.push({
        id: agentName,
        label: readAgentDisplayName(agentName),
        role: team.role,
        reportsTo: team.reportsTo,
        delegatesTo: team.delegatesTo,
        running: isAgentRunning(agentName),
        securityProfile: readAgentSecurityProfile(agentName),
      })
    }
    const knownIds = new Set(nodes.map(n => n.id))
    const edges: Array<{ from: string; to: string }> = []
    for (const n of nodes) {
      const reports = n.reportsTo && knownIds.has(n.reportsTo)
        ? n.reportsTo
        : (n.id === MAIN_AGENT_ID ? null : MAIN_AGENT_ID)
      if (reports) edges.push({ from: reports, to: n.id })
    }
    jsonMaybeGzip(req, res, { nodes, edges, mainAgentId: MAIN_AGENT_ID })
    return true
  }

  const teamMatch = path.match(/^\/api\/agents\/([^/]+)\/team$/)
  if (teamMatch && method === 'GET') {
    const name = decodeURIComponent(teamMatch[1])
    if (!assertAgentExists(name, res)) return true
    json(res, readAgentTeam(name))
    return true
  }

  if (teamMatch && method === 'PUT') {
    const name = decodeURIComponent(teamMatch[1])
    if (!assertAgentExists(name, res)) return true
    const data = await readJsonBody<Record<string, unknown>>(req)
    const current = readAgentTeam(name)
    const proposed: TeamConfig = {
      role: data.role === 'leader' ? 'leader' : (data.role === 'member' ? 'member' : current.role),
      reportsTo: typeof data.reportsTo === 'string'
        ? (data.reportsTo.trim() || null)
        : (data.reportsTo === null ? null : current.reportsTo),
      delegatesTo: Array.isArray(data.delegatesTo)
        ? data.delegatesTo.filter((x: unknown) => typeof x === 'string')
        : current.delegatesTo,
      autoDelegation: typeof data.autoDelegation === 'boolean' ? data.autoDelegation : current.autoDelegation,
      trustFrom: Array.isArray(data.trustFrom)
        ? data.trustFrom.filter((x: unknown) => typeof x === 'string')
        : (current.trustFrom ?? []),
    }
    // Reject a reportsTo that would create a reporting cycle (e.g. dragging a
    // manager under its own report in the Team graph). Keep the current parent
    // and flag it so the UI can explain why the drop was ignored.
    let cycleRejected = false
    if (
      proposed.reportsTo &&
      proposed.reportsTo !== current.reportsTo &&
      reportsToCreatesCycle(name, proposed.reportsTo, readAgentTeam, MAIN_AGENT_ID)
    ) {
      proposed.reportsTo = current.reportsTo
      cycleRejected = true
    }
    const { team: next, warnings } = sanitizeTeamConfig(name, proposed)
    writeAgentTeam(name, next)
    json(res, { ok: true, team: next, warnings, cycleRejected })
    return true
  }

  // --- Per-agent export/import bundle (move an agent to another machine) ---
  //
  // GET  /api/agents/:name/export?secrets=1   -> downloads a .tar.gz bundle
  // POST /api/agents/import                   -> uploads a bundle (multipart)
  //
  // The bundle is the portable subset of agents/<name>/ (identity + behaviour),
  // with channel tokens included only when ?secrets=1 is set explicitly. See
  // src/web/agent-bundle.ts. The main agent lives at PROJECT_ROOT (not under
  // agents/) so it is not exportable this way -- use scripts/backup.sh for a
  // whole-host move.
  // GET /api/agents/export-all?secrets=1 -> a single .tar.gz of EVERY sub-agent
  // (the main agent lives at PROJECT_ROOT and is excluded). Must be matched
  // before the generic /api/agents/:name GET further down, or "export-all"
  // would be read as an agent name.
  if (path === '/api/agents/export-all' && method === 'GET') {
    const names = listAgentNames().filter((n) => n !== MAIN_AGENT_ID)
    if (names.length === 0) { json(res, { error: 'No agents to export' }, 404); return true }
    const includeSecrets = /[?&]secrets=(1|true)\b/.test(req.url || '')
    const work = mkdtempSync(join(tmpdir(), 'marveen-fleet-dl-'))
    const outPath = join(work, fleetBundleFilename())
    try {
      exportAllAgentsBundle(outPath, names, {
        includeSecrets,
        exportedBy: MAIN_AGENT_ID,
        exportedAt: new Date().toISOString(),
      })
      const data = readFileSync(outPath)
      res.writeHead(200, {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="${fleetBundleFilename()}"`,
        'Content-Length': String(data.length),
        'Cache-Control': 'private, no-store',
      })
      res.end(data)
    } catch (err) {
      logger.error({ err }, 'Fleet export failed')
      json(res, { error: 'Export failed', detail: err instanceof Error ? err.message : String(err) }, 500)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
    return true
  }

  const exportMatch = path.match(/^\/api\/agents\/([^/]+)\/export$/)
  if (exportMatch && method === 'GET') {
    const name = decodeURIComponent(exportMatch[1])
    if (name === MAIN_AGENT_ID) {
      json(res, { error: 'The main agent cannot be exported as a bundle; use scripts/backup.sh for a whole-host move.' }, 400)
      return true
    }
    if (!assertAgentExists(name, res)) return true
    const includeSecrets = /[?&]secrets=(1|true)\b/.test(req.url || '')
    const work = mkdtempSync(join(tmpdir(), 'marveen-agent-dl-'))
    const outPath = join(work, bundleFilename(name))
    try {
      exportAgentBundle(name, outPath, {
        includeSecrets,
        exportedBy: MAIN_AGENT_ID,
        exportedAt: new Date().toISOString(),
      })
      const data = readFileSync(outPath)
      res.writeHead(200, {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="${bundleFilename(name)}"`,
        'Content-Length': String(data.length),
        'Cache-Control': 'private, no-store',
      })
      res.end(data)
    } catch (err) {
      logger.error({ err, name }, 'Agent export failed')
      json(res, { error: 'Export failed', detail: err instanceof Error ? err.message : String(err) }, 500)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
    return true
  }

  if (path === '/api/agents/import' && method === 'POST') {
    const body = await readBody(req)
    const contentType = req.headers['content-type'] || ''
    let bundle: Buffer | undefined
    let overrideName = ''
    let overwrite = false
    if (contentType.includes('multipart/form-data')) {
      const { file, fields } = parseMultipart(body, contentType)
      if (file) bundle = file.data
      overrideName = (fields.name || '').trim()
      overwrite = fields.overwrite === '1' || fields.overwrite === 'true'
    } else {
      // Raw .tar.gz body; name/overwrite from query string.
      bundle = body
      const url = req.url || ''
      const nameMatch = url.match(/[?&]name=([^&]+)/)
      if (nameMatch) overrideName = decodeURIComponent(nameMatch[1]).trim()
      overwrite = /[?&]overwrite=(1|true)\b/.test(url)
    }
    if (!bundle || bundle.length === 0) { json(res, { error: 'No bundle uploaded' }, 400); return true }
    try {
      // One endpoint accepts either format: peek the manifest, then dispatch to
      // the single-agent or whole-fleet importer.
      if (peekBundleKind(bundle) === 'fleet') {
        const result = importAllAgentsBundle(bundle, { overwrite })
        logger.info(
          { imported: result.imported.map((a) => a.name), skipped: result.skipped, secrets: result.includesSecrets },
          'Fleet imported from bundle',
        )
        // Any collision (even with some fresh agents already imported) returns
        // 409 so the UI can offer to overwrite the rest; re-POSTing with
        // overwrite=1 is idempotent for the already-imported ones.
        const hasCollision = result.skipped.some((s) => s.reason === 'already exists')
        json(res, {
          ok: true,
          kind: 'fleet',
          imported: result.imported,
          skipped: result.skipped,
          includedSecrets: result.includesSecrets,
        }, hasCollision ? 409 : 200)
        return true
      }

      const result = importAgentBundle(bundle, { overrideName: overrideName || undefined, overwrite })
      logger.info({ name: result.name, overwritten: result.overwritten, secrets: result.manifest.includesSecrets }, 'Agent imported from bundle')
      json(res, {
        ok: true,
        kind: 'agent',
        name: result.name,
        overwritten: result.overwritten,
        includedSecrets: result.manifest.includesSecrets,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // A name collision without overwrite is a 409 the UI can offer to resolve;
      // everything else (malformed bundle, bad name) is a 400.
      const status = /already exists/.test(msg) ? 409 : 400
      json(res, { error: msg }, status)
    }
    return true
  }

  // GET /api/agents/:name/voice-config
  const voiceConfigMatch = path.match(/^\/api\/agents\/([^/]+)\/voice-config$/)
  if (voiceConfigMatch && method === 'GET') {
    const name = decodeURIComponent(voiceConfigMatch[1])
    if (name !== MAIN_AGENT_ID && !existsSync(agentDir(name))) { json(res, { error: 'Agent not found' }, 404); return true }
    json(res, { ...readAgentVoiceConfig(name), availableVoices: Array.from(KNOWN_VOICE_MODELS) })
    return true
  }

  // PUT /api/agents/:name/voice-config
  // Body: { responseMode?: 'text'|'voice'|'auto', voiceModel?: string }
  if (voiceConfigMatch && method === 'PUT') {
    const name = decodeURIComponent(voiceConfigMatch[1])
    if (name !== MAIN_AGENT_ID && !existsSync(agentDir(name))) { json(res, { error: 'Agent not found' }, 404); return true }
    const body = await readBody(req)
    let data: { responseMode?: string; voiceModel?: string }
    try { data = JSON.parse(body.toString()) } catch { json(res, { error: 'invalid JSON' }, 400); return true }
    try {
      writeAgentVoiceConfig(name, {
        responseMode: data.responseMode as 'text' | 'voice' | 'auto' | undefined,
        voiceModel: data.voiceModel,
      })
    } catch (err: unknown) {
      json(res, { error: err instanceof Error ? err.message : 'invalid config' }, 400)
      return true
    }
    json(res, { ok: true, ...readAgentVoiceConfig(name) })
    return true
  }

  // Master :name CRUD must be last -- the generic pattern would swallow any
  // more-specific /:name/<suffix> route that was not already handled above.
  const agentMatch = path.match(/^\/api\/agents\/([^/]+)$/)
  if (agentMatch && method === 'GET') {
    const name = decodeURIComponent(agentMatch[1])
    if (!isKnownAgent(name)) { json(res, { error: 'Agent not found' }, 404); return true }
    json(res, getAgentDetail(name))
    return true
  }

  if (agentMatch && method === 'PUT') {
    const name = decodeURIComponent(agentMatch[1])
    if (!isKnownAgent(name)) { json(res, { error: 'Agent not found' }, 404); return true }
    if (isMainChannelsAgent(name)) {
      json(res, { error: 'Main agent configuration is read-only through the dashboard API' }, 400)
      return true
    }
    const configRoot = agentConfigRoot(name)
    const data = await readJsonBody<{
      claudeMd?: string; soulMd?: string; mcpJson?: string; model?: string; modelProfile?: string | null
      authMode?: AuthMode; apiKey?: string; claudePlan?: string; memoryIsolation?: boolean
      mcpScope?: McpScope
    }>(req)
    // Unknown fields are rejected rather than silently dropped -- see
    // agent-put-fields.ts for why, and for the securityProfile redirect.
    const fieldCheck = checkAgentPutFields(name, data)
    if (!fieldCheck.ok) {
      json(res, {
        error: fieldCheck.code,
        field: fieldCheck.rejected[0],
        hint: fieldCheck.message,
      }, 400)
      return true
    }
    if (data.memoryIsolation !== undefined) {
      // The main agent's cwd IS the install repo root, which is already a git
      // root: a memory boundary there is meaningless, and exposing the knob
      // for it would invite the classic main-agent footgun. Sub-agents only.
      if (isMainChannelsAgent(name)) {
        json(res, { error: 'memoryIsolation is not applicable to the main agent' }, 400)
        return true
      }
      writeAgentMemoryIsolation(name, data.memoryIsolation === true)
    }
    if (data.claudeMd !== undefined) {
      atomicWriteFileSync(join(configRoot, 'CLAUDE.md'), data.claudeMd)
      // A stale dashboard-editor buffer can carry a pre-federation snapshot
      // (or a block from a since-disabled state): reconcile the managed
      // federation section right after the write, not just at boot -- the
      // service runs for weeks between restarts. No-op for sub-agents.
      if (name === MAIN_AGENT_ID) ensureFederationClaudeMdSection()
    }
    if (data.soulMd !== undefined) atomicWriteFileSync(join(agentDir(name), 'SOUL.md'), data.soulMd)
    if (data.mcpJson !== undefined) atomicWriteFileSync(join(agentDir(name), '.mcp.json'), data.mcpJson)
    if (data.model !== undefined) writeAgentModel(name, data.model)
    // Card c755f4b2 Block B: optional generic capability tier. An unknown id
    // is a 400, never a persisted value -- storing one would leave the UI
    // showing a profile while resolution silently fell back to the install
    // default, i.e. a model change nobody asked for. Empty string clears it.
    if ((data as { modelProfile?: string | null }).modelProfile !== undefined) {
      const mp = (data as { modelProfile?: string | null }).modelProfile
      if (mp === '' || mp === null) {
        writeAgentModelProfile(name, null)
      } else if (typeof mp === 'string' && isModelProfileId(mp)) {
        const mapState = readModelProfileMap()
        if (!mapState) {
          json(res, { error: 'No model-profile map is provisioned on this deployment; a modelProfile cannot be honoured yet.' }, 400)
          return true
        }
        if (!mapState.ok) {
          json(res, { error: `Model-profile map is unusable: ${mapState.error}` }, 400)
          return true
        }
        writeAgentModelProfile(name, mp)
      } else {
        json(res, { error: `modelProfile must be one of ${MODEL_PROFILE_IDS.join('|')}` }, 400)
        return true
      }
    }
    if (data.mcpScope !== undefined) {
      const parsed = parseMcpScope(data.mcpScope)
      if (parsed !== null) writeAgentMcpScope(name, parsed)
    }
    if (data.authMode !== undefined) {
      writeAgentAuthMode(name, data.authMode)
      if (data.authMode === 'api' && typeof data.apiKey === 'string' && data.apiKey.trim()) {
        setSecret(`agent-${name}-api-key`, `API key for agent ${name}`, data.apiKey.trim())
      }
      if (data.authMode !== 'api') {
        deleteSecret(`agent-${name}-api-key`)
      }
    }
    // Named Claude plan id. Empty string clears it (-> raw claudeConfigDir /
    // default). A non-empty id MUST exist in the registry, otherwise the
    // dashboard would show the agent as plan-assigned while launch silently
    // falls back to a different login (state/launch drift). Reject unknown ids
    // rather than persist them.
    if (data.claudePlan !== undefined) {
      // The main agent's Claude login comes up via channels.sh (hardcoded
      // CLAUDE_CONFIG_DIR), not this per-agent path, so a plan set here would be
      // a silent no-op at launch. Reject loudly rather than mislead the UI.
      if (name === MAIN_AGENT_ID) {
        json(res, { error: 'main agent plan is managed via channels.sh, not settable here' }, 400)
        return true
      }
      const planId = data.claudePlan.trim()
      if (planId && !readClaudePlans().some(p => p.id === planId)) {
        json(res, { error: `Ismeretlen Claude plan id: ${planId}` }, 400)
        return true
      }
      writeAgentClaudePlan(name, planId)
    }
    json(res, { ok: true })
    return true
  }

  if (agentMatch && method === 'DELETE') {
    const name = decodeURIComponent(agentMatch[1])
    const dir = agentDir(name)
    if (!existsSync(dir)) { json(res, { error: 'Agent not found' }, 404); return true }
    // Stop the running session BEFORE removing the dir (#842). Otherwise the
    // orphaned session survives, rewrites a minimal .claude-config under the
    // agent dir, and the agent "returns" as an empty draft that still reports
    // running=true. stopAgentProcess() reads config from the dir for its orphan
    // reap, so it must run while the dir still exists.
    if (isAgentRunning(name)) stopAgentProcess(name)
    // Clear the desired run-state so the reconciler stops trying to start a
    // non-existent agent (#857). A stale entry also starts a same-named new
    // agent immediately on next create -- unasked.
    removeDesiredAgent(name)
    rmSync(dir, { recursive: true, force: true })
    cleanupTeamReferences(name)
    try {
      writeAgentAuditLog({ agent_id: 'system', entity: 'agent', action: 'delete', entity_id: name })
    } catch { /* audit failure must not abort agent deletion */ }
    json(res, { ok: true })
    return true
  }

  return false
}
