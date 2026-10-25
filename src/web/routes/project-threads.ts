import { APP_TZ, MAIN_AGENT_ID, currentOwnerName, currentBotName } from '../../config.js'
import { isKnownAgent } from '../agent-config.js'
import { sanitizeAgentIdent } from '../../prompt-safety.js'
import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import {
  OWNER_AUTHOR, projectExists, listProjectThread, listProjectThreadSummaries, markProjectThreadRead,
  getThreadAgentOverride, setThreadAgentOverride, resolveResponsibleAgent, parseToParty,
  postProjectThreadMessage, ThreadPostError,
} from '../project-threads.js'
import type { RouteContext } from './types.js'

// Project threads API (see src/web/project-threads.ts for the model and the
// delivery rules). Bearer-protected like every /api/* path by the auth gate.
//   GET  /api/project-threads/summary          per-project unread / waiting / last message
//   GET  /api/project-threads/:project         the thread + who is responsible
//   POST /api/project-threads/:project         post {author, content, to?, needs_owner?}
//   POST /api/project-threads/:project/read    the owner opened the thread
//   PUT  /api/project-threads/:project/agent   {agent: "<id>" | null} responsible-agent override

async function readJson(ctx: RouteContext): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse((await readBody(ctx.req)).toString() || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

export async function tryHandleProjectThreads(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx
  if (!path.startsWith('/api/project-threads')) return false

  if (path === '/api/project-threads/summary' && method === 'GET') {
    json(res, listProjectThreadSummaries())
    return true
  }

  const m = path.match(/^\/api\/project-threads\/([^/]+)(\/read|\/agent)?$/)
  if (!m) return false
  let project: string
  try {
    project = decodeURIComponent(m[1]).trim()
  } catch {
    json(res, { error: 'invalid project encoding' }, 400)
    return true
  }
  if (!project) {
    json(res, { error: 'project is required' }, 400)
    return true
  }
  const sub = m[2] ?? ''

  if (sub === '' && method === 'GET') {
    const responsible = resolveResponsibleAgent(project)
    json(res, {
      project,
      exists: projectExists(project),
      responsible,
      override: getThreadAgentOverride(project),
      owner: { id: OWNER_AUTHOR, label: currentOwnerName() },
      main: { id: MAIN_AGENT_ID, label: currentBotName() },
      timeZone: APP_TZ,
      messages: listProjectThread(project),
    })
    return true
  }

  if (sub === '' && method === 'POST') {
    const body = await readJson(ctx)
    if (!body) {
      json(res, { error: 'invalid JSON body' }, 400)
      return true
    }
    const { author, content, to, needs_owner } = body as { author?: unknown; content?: unknown; to?: unknown; needs_owner?: unknown }
    if (typeof author !== 'string' || !author.trim()) {
      json(res, { error: "author is required ('owner' or a fleet agent id)" }, 400)
      return true
    }
    if (typeof content !== 'string' || !content.trim()) {
      json(res, { error: 'content is required' }, 400)
      return true
    }
    if (needs_owner !== undefined && typeof needs_owner !== 'boolean') {
      json(res, { error: 'needs_owner must be a JSON boolean' }, 400)
      return true
    }
    const parsedTo = parseToParty(to, MAIN_AGENT_ID)
    if (parsedTo === 'invalid') {
      json(res, { error: "to must be one of 'owner', 'agent', 'main' (or the main agent id), 'both'" }, 400)
      return true
    }
    let storedAuthor: string
    if (author.trim() === OWNER_AUTHOR) {
      // The shared token cannot tell the owner's browser from an agent (the same limit
      // /api/messages has for from=<owner>). A caller that announced itself as an agent
      // (X-Agent-Id) and then claims the owner is refused: that is never the dashboard UI.
      if (ctx.auth?.agent) {
        logger.warn({ project, agent: ctx.auth.agent }, 'Rejected project thread post: an agent caller claimed author=owner')
        json(res, { error: "author 'owner' is the dashboard UI; an agent posts under its own id" }, 403)
        return true
      }
      storedAuthor = OWNER_AUTHOR
    } else {
      storedAuthor = sanitizeAgentIdent(author)
      if (!storedAuthor || storedAuthor !== author.trim() || !isKnownAgent(storedAuthor)) {
        json(res, { error: `unknown author '${author.trim()}' -- author must be 'owner' or a registered fleet agent id` }, 403)
        return true
      }
      if (ctx.auth?.agent && ctx.auth.agent !== storedAuthor) {
        json(res, { error: `X-Agent-Id '${ctx.auth.agent}' does not match author '${storedAuthor}'` }, 403)
        return true
      }
    }
    if (!projectExists(project)) {
      json(res, { error: `unknown project '${project}' -- it must be a project on the kanban board` }, 404)
      return true
    }
    try {
      const r = await postProjectThreadMessage({ project, author: storedAuthor, content, to: parsedTo, needsOwner: needs_owner === true })
      json(res, { ...r.message, responsible: r.responsible, deliveries: r.deliveries, ping: r.ping })
    } catch (err) {
      if (err instanceof ThreadPostError) {
        json(res, { error: err.message }, err.status)
        return true
      }
      throw err
    }
    return true
  }

  if (sub === '/read' && method === 'POST') {
    json(res, { ok: true, changed: markProjectThreadRead(project) })
    return true
  }

  if (sub === '/agent' && method === 'PUT') {
    const body = await readJson(ctx)
    if (!body || !('agent' in body)) {
      json(res, { error: 'agent is required (a fleet agent id, or null to clear the override)' }, 400)
      return true
    }
    const agent = body.agent
    if (agent !== null && (typeof agent !== 'string' || !isKnownAgent(sanitizeAgentIdent(agent)) || sanitizeAgentIdent(agent) !== agent.trim())) {
      json(res, { error: `unknown agent '${String(agent)}'` }, 400)
      return true
    }
    if (!projectExists(project)) {
      json(res, { error: `unknown project '${project}'` }, 404)
      return true
    }
    setThreadAgentOverride(project, agent === null ? null : (agent as string).trim())
    json(res, { ok: true, responsible: resolveResponsibleAgent(project), override: getThreadAgentOverride(project) })
    return true
  }

  return false
}
