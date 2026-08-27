import { existsSync } from 'node:fs'
import { logger } from '../../logger.js'
import { MAIN_AGENT_ID } from '../../config.js'
import { agentDir, writeAgentRemoteConfig } from '../agent-config.js'
import { readAutoRestartConfig, writeAutoRestartConfig } from '../auto-restart-store.js'
import { readContextGuardConfig, writeContextGuardConfig } from '../context-guard-store.js'
import { getContextGuardStatus } from '../context-guard-runner.js'
import { setStoreWriteActor } from '../../store-watcher.js'
import {
  startAgentProcess,
  stopAgentProcess,
  restartAgentProcess,
  getAgentProcessInfo,
} from '../agent-process.js'
import { addDesiredAgent, removeDesiredAgent } from '../agent-desired-state.js'
import { isMainChannelsAgent } from '../main-agent.js'
import { hardRestartMarveenChannels } from '../channel-monitor.js'
import { checkConfigPutFields } from '../agent-put-fields.js'
import { DEFAULT_AUTO_RESTART } from '../../auto-restart.js'
import { DEFAULT_CONTEXT_GUARD } from '../../context-guard.js'
import { claimPendingForAgent, markMessageFailed } from '../../db.js'
import { classifyAgentMessage, wrapAgentMessageForDelivery } from '../agent-message-wrap.js'
import { readBody, json } from '../http-helpers.js'
import { remoteRunStateCache, remotePaneCache, assertAgentExists } from './agents-helpers.js'
import type { RouteContext } from './types.js'

// Max inter-agent messages a single main-agent inbox drain returns. The rest
// stay pending (FIFO) for the next turn's drain -- bounds the context a single
// turn absorbs, mirroring the router's MAX_MESSAGES_PER_TICK.
const INBOX_DRAIN_CAP = 10

export async function tryHandleAgentsProcess(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  const autoRestartMatch = path.match(/^\/api\/agents\/([^/]+)\/auto-restart$/)
  if (autoRestartMatch && method === 'PUT') {
    const name = decodeURIComponent(autoRestartMatch[1])
    if (name !== MAIN_AGENT_ID && !existsSync(agentDir(name))) { json(res, { error: 'not_found', hint: 'Agent not found' }, 404); return true }
    const body = await readBody(req)
    let data: unknown
    try { data = JSON.parse(body.toString()) } catch { json(res, { error: 'parse_error', hint: 'Invalid JSON body' }, 400); return true }
    const arFields = checkConfigPutFields(data, Object.keys(DEFAULT_AUTO_RESTART))
    if (!arFields.ok) {
      json(res, { error: arFields.code, field: arFields.rejected[0], hint: arFields.message }, 400)
      return true
    }
    setStoreWriteActor('dashboard')
    const saved = writeAutoRestartConfig(name, data)
    json(res, { ok: true, autoRestart: saved })
    return true
  }

  // GET/PUT /api/agents/:name/context-guard -- per-agent context-guard config
  // (kanban #81). Default-off (opt-in): a GET for an agent with no store entry
  // returns the disabled defaults. PUT normalizes server-side like auto-restart,
  // and like auto-restart it rejects unknown keys instead of swallowing them.
  const contextGuardMatch = path.match(/^\/api\/agents\/([^/]+)\/context-guard$/)
  if (contextGuardMatch && (method === 'GET' || method === 'PUT')) {
    const name = decodeURIComponent(contextGuardMatch[1])
    if (name !== MAIN_AGENT_ID && !existsSync(agentDir(name))) { json(res, { error: 'not_found', hint: 'Agent not found' }, 404); return true }
    if (method === 'GET') {
      json(res, { ok: true, contextGuard: readContextGuardConfig(name) })
      return true
    }
    const body = await readBody(req)
    let data: unknown
    try { data = JSON.parse(body.toString()) } catch { json(res, { error: 'parse_error', hint: 'Invalid JSON body' }, 400); return true }
    const cgFields = checkConfigPutFields(data, Object.keys(DEFAULT_CONTEXT_GUARD))
    if (!cgFields.ok) {
      json(res, { error: cgFields.code, field: cgFields.rejected[0], hint: cgFields.message }, 400)
      return true
    }
    setStoreWriteActor('dashboard')
    const saved = writeContextGuardConfig(name, data)
    json(res, { ok: true, contextGuard: saved })
    return true
  }

  // GET /api/context-guard -- live guard status (phase + measured context pct)
  // for every agent, main included.
  if (path === '/api/context-guard' && method === 'GET') {
    json(res, { ok: true, agents: getContextGuardStatus() })
    return true
  }

  // PUT /api/agents/:name/remote -- set or clear the remote host + workdir that
  // makes this agent's tmux session run on another machine over ssh. Empty
  // strings clear the fields (revert to local). The main agent is always local.
  const remoteCfgMatch = path.match(/^\/api\/agents\/([^/]+)\/remote$/)
  if (remoteCfgMatch && method === 'PUT') {
    const name = decodeURIComponent(remoteCfgMatch[1])
    if (name === MAIN_AGENT_ID) { json(res, { error: 'not_supported', hint: 'Main agent is always local' }, 400); return true }
    if (!assertAgentExists(name, res)) return true
    const body = await readBody(req)
    let data: { host?: string; workdir?: string }
    try { data = JSON.parse(body.toString() || '{}') } catch { json(res, { error: 'parse_error', hint: 'Invalid JSON body' }, 400); return true }
    const result = writeAgentRemoteConfig(name, data.host ?? '', data.workdir ?? '')
    if (!result.ok) { json(res, { error: result.error }, 400); return true }
    // Config changed -> drop any cached status so the next poll reflects it.
    remoteRunStateCache.invalidate(name)
    remotePaneCache.invalidate(name)
    json(res, { ok: true, remoteHost: result.remote.host, remoteWorkdir: result.remote.workdir })
    return true
  }

  const startMatch = path.match(/^\/api\/agents\/([^/]+)\/start$/)
  if (startMatch && method === 'POST') {
    const name = decodeURIComponent(startMatch[1])
    if (isMainChannelsAgent(name)) {
      json(res, { error: 'not_supported', hint: 'Main agent lifecycle is service-managed; use /api/marveen/restart for recovery' }, 400)
      return true
    }
    if (!assertAgentExists(name, res)) return true
    // Optional { "fresh": true } body -> no `--continue`. Required for channel
    // agents on Claude Code 2.1.193, where a `--continue` resume does not load
    // the --channels plugin MCP server (agent comes up deaf).
    let startFresh = false
    try { startFresh = JSON.parse((await readBody(req)).toString() || '{}').fresh === true } catch {}
    const result = startAgentProcess(name, { fresh: startFresh })
    // Record operator intent so the monitor keeps this agent up across shared
    // tmux-server restarts / reboots (see agent-desired-state.ts).
    if (result.ok || result.error === 'conflict') addDesiredAgent(name)
    if (result.ok) { json(res, { ok: true }); return true }
    json(res, { error: result.error, ...(result.hint ? { hint: result.hint } : {}) }, result.error === 'not_found' ? 404 : result.error === 'conflict' ? 409 : result.error === 'internal_error' ? 500 : 400)
    return true
  }

  const stopMatch = path.match(/^\/api\/agents\/([^/]+)\/stop$/)
  if (stopMatch && method === 'POST') {
    const name = decodeURIComponent(stopMatch[1])
    if (isMainChannelsAgent(name)) {
      json(res, { error: 'not_supported', hint: 'Main agent lifecycle is service-managed; use /api/marveen/restart for recovery' }, 400)
      return true
    }
    const result = stopAgentProcess(name)
    // Explicit stop clears intent so the monitor will not resurrect it.
    removeDesiredAgent(name)
    if (result.ok) { json(res, { ok: true }); return true }
    json(res, { error: result.error, ...(result.hint ? { hint: result.hint } : {}) }, result.error === 'conflict' ? 409 : result.error === 'internal_error' ? 500 : 400)
    return true
  }

  // Main-agent inbox PULL (drain-inbox): atomically CLAIM the main agent's
  // pending inter-agent messages and return them already WRAPPED (single-source
  // security framing via agent-message-wrap), for the UserPromptSubmit hook to
  // print into the agent's context. The router skips main-agent tmux delivery,
  // so this is the SOLE delivery path for the main agent -- which is why it is
  // restricted to the main agent (serving a sub-agent here would double-deliver
  // alongside the router's still-active tmux push). Auth is the global /api
  // bearer gate. One quick claim+wrap per turn (NOT a hot loop -> not the #498
  // self-HTTP event-loop hazard).
  const drainMatch = path.match(/^\/api\/agents\/([^/]+)\/drain-inbox$/)
  if (drainMatch && method === 'POST') {
    const name = decodeURIComponent(drainMatch[1])
    if (name !== MAIN_AGENT_ID) {
      json(res, { error: 'not_supported', hint: 'drain-inbox is main-agent only (sub-agents use the router push path)' }, 400)
      return true
    }
    const claimed = claimPendingForAgent(name, INBOX_DRAIN_CAP)
    const blocks: string[] = []
    for (const msg of claimed) {
      const cls = classifyAgentMessage(msg.from_agent, msg.to_agent)
      if (!cls) {
        // The claim already flipped the row to 'delivered'; a silent skip
        // here is invisible message loss (delivered in the DB, never shown
        // to the agent, no log, no retry). Surface it like the router does.
        logger.warn({ id: msg.id, rawFrom: msg.from_agent }, 'drain-inbox: message rejected, from_agent cannot be framed safely')
        if (!markMessageFailed(msg.id, 'Invalid or empty from_agent')) {
          logger.warn({ id: msg.id }, 'markMessageFailed affected 0 rows (deleted concurrently?)')
        }
        continue
      }
      const { prefix, wrapped } = wrapAgentMessageForDelivery(cls.category, cls.safeFrom, msg.from_agent, msg.content, msg.id, msg.origin_note)
      blocks.push(prefix + wrapped)
    }
    json(res, { count: blocks.length, text: blocks.join('\n\n') })
    return true
  }

  const restartMatch = path.match(/^\/api\/agents\/([^/]+)\/restart$/)
  if (restartMatch && method === 'POST') {
    const name = decodeURIComponent(restartMatch[1])
    // The main agent runs in the systemd/launchd-managed `<id>-channels` session,
    // not the `agent-<name>` template. Restart it through the channels helper --
    // the agent-process path would spawn a rogue duplicate session and fire
    // `/remote-control` (needs a full-scope login token the agent lacks). Mirror
    // the precedent in the channels-config handler above. Sub-agents unchanged.
    if (isMainChannelsAgent(name)) {
      const r = hardRestartMarveenChannels()
      if (r.ok) { json(res, { ok: true }); return true }
      json(res, { error: 'internal_error', hint: r.error || 'Restart failed' }, 500)
      return true
    }
    if (!assertAgentExists(name, res)) return true
    // Optional { "fresh": true } body -> no `--continue` (see /start note).
    let restartFresh = false
    try { restartFresh = JSON.parse((await readBody(req)).toString() || '{}').fresh === true } catch {}
    const result = restartAgentProcess(name, { fresh: restartFresh })
    if (result.ok) { json(res, { ok: true }); return true }
    json(res, { error: result.error, ...(result.hint ? { hint: result.hint } : {}) }, result.error === 'not_found' ? 404 : result.error === 'conflict' ? 409 : result.error === 'internal_error' ? 500 : 400)
    return true
  }

  const statusMatch = path.match(/^\/api\/agents\/([^/]+)\/status$/)
  if (statusMatch && method === 'GET') {
    const name = decodeURIComponent(statusMatch[1])
    if (!assertAgentExists(name, res)) return true
    json(res, getAgentProcessInfo(name))
    return true
  }

  return false
}
