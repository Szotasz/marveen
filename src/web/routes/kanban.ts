import { randomUUID } from 'node:crypto'
import {
  listKanbanCards, createKanbanCard, updateKanbanCard,
  deleteKanbanCard, moveKanbanCard, archiveKanbanCard,
  getKanbanComments, addKanbanComment, listKanbanProjects,
  getKanbanCard, getChildCards, getDb,
  createAgentMessage, markKanbanCardDispatched,
} from '../../db.js'
import { OWNER_NAME, BOT_NAME, MAIN_AGENT_ID } from '../../config.js'
import { listAgentNames, readAgentDisplayName } from '../agent-config.js'
import { isAgentRunning } from '../agent-process.js'
import { resolveKanbanDispatchTarget } from '../../kanban-dispatch.js'
import { generateBreakdown } from '../llm-breakdown.js'
import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

// Option D: kanban -> agent dispatch. When a card moves to in_progress, wake the
// assigned agent once via the inter-agent message router (createAgentMessage),
// which gives retry / dedup / trust-wrapping / busy-receiver handling for free.
// dispatched_at is the once-only guard; errors never block the card move.
function fireKanbanDispatch(id: string): void {
  try {
    const card = getKanbanCard(id)
    if (!card || card.dispatched_at) return
    const target = resolveKanbanDispatchTarget(card.assignee, {
      ownerName: OWNER_NAME,
      botName: BOT_NAME,
      mainAgentId: MAIN_AGENT_ID,
      agentNames: listAgentNames(),
      isRunning: isAgentRunning,
    })
    if (!target) return
    const desc = (card.description ?? '').trim()
    const content = `[Kanban feladat #${id}]: ${card.title}${desc ? ' — ' + desc : ''}\n\nA kártyát in_progress-re húzták. Ha kész vagy, húzd "done"-ra.`
    createAgentMessage(MAIN_AGENT_ID, target, content)
    markKanbanCardDispatched(id)
    logger.info({ id, target, assignee: card.assignee }, 'Kanban in_progress dispatch fired')
  } catch (err) {
    logger.warn({ err, id }, 'Kanban dispatch failed (card move still succeeded)')
  }
}

export async function tryHandleKanban(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path === '/api/kanban' && method === 'GET') {
    json(res, listKanbanCards())
    return true
  }

  if (path === '/api/kanban-projects' && method === 'GET') {
    json(res, listKanbanProjects())
    return true
  }

  if (path === '/api/kanban/assignees' && method === 'GET') {
    const agents = listAgentNames().map((name) => ({ name, type: 'agent', displayName: readAgentDisplayName(name) || name }))
    json(res, [
      { name: OWNER_NAME, type: 'owner' },
      { name: BOT_NAME, type: 'bot' },
      ...agents,
    ])
    return true
  }

  if (path === '/api/kanban' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString())
    const id = randomUUID().slice(0, 8)
    createKanbanCard({ id, ...data })
    json(res, { ok: true, id })
    return true
  }

  const kanbanCardMatch = path.match(/^\/api\/kanban\/([^/]+)$/)
  if (kanbanCardMatch && method === 'PUT') {
    const id = decodeURIComponent(kanbanCardMatch[1])
    const body = await readBody(req)
    const data = JSON.parse(body.toString())
    if (updateKanbanCard(id, data)) { json(res, { ok: true }); return true }
    json(res, { error: 'Kártya nem található' }, 404)
    return true
  }

  if (kanbanCardMatch && method === 'DELETE') {
    const id = decodeURIComponent(kanbanCardMatch[1])
    if (deleteKanbanCard(id)) { json(res, { ok: true }); return true }
    json(res, { error: 'Kártya nem található' }, 404)
    return true
  }

  const kanbanMoveMatch = path.match(/^\/api\/kanban\/([^/]+)\/move$/)
  if (kanbanMoveMatch && method === 'POST') {
    const id = decodeURIComponent(kanbanMoveMatch[1])
    const body = await readBody(req)
    const { status, sort_order } = JSON.parse(body.toString())
    if (moveKanbanCard(id, status, sort_order ?? 0)) {
      // Wake the assigned agent once when the card enters in_progress.
      if (status === 'in_progress') fireKanbanDispatch(id)
      json(res, { ok: true })
      return true
    }
    json(res, { error: 'Kártya nem található' }, 404)
    return true
  }

  const kanbanArchiveMatch = path.match(/^\/api\/kanban\/([^/]+)\/archive$/)
  if (kanbanArchiveMatch && method === 'POST') {
    const id = decodeURIComponent(kanbanArchiveMatch[1])
    if (archiveKanbanCard(id)) { json(res, { ok: true }); return true }
    json(res, { error: 'Kártya nem található' }, 404)
    return true
  }

  const kanbanCommentsMatch = path.match(/^\/api\/kanban\/([^/]+)\/comments$/)
  if (kanbanCommentsMatch && method === 'GET') {
    const cardId = decodeURIComponent(kanbanCommentsMatch[1])
    json(res, getKanbanComments(cardId))
    return true
  }
  if (kanbanCommentsMatch && method === 'POST') {
    const cardId = decodeURIComponent(kanbanCommentsMatch[1])
    const body = await readBody(req)
    const { author, content } = JSON.parse(body.toString())
    if (!author || !content) { json(res, { error: 'Szerző és tartalom kötelező' }, 400); return true }
    json(res, addKanbanComment(cardId, author, content))
    return true
  }

  const breakdownMatch = path.match(/^\/api\/kanban\/([^/]+)\/breakdown$/)
  if (breakdownMatch && method === 'POST') {
    const cardId = decodeURIComponent(breakdownMatch[1])
    const card = getKanbanCard(cardId)
    if (!card) { json(res, { error: 'Kártya nem található' }, 404); return true }
    const existing = getChildCards(cardId)
    if (existing.length > 0) { json(res, { error: 'A kártya már rendelkezik subtask-okkal' }, 409); return true }
    try {
      const result = await generateBreakdown(card.title, card.description)
      json(res, { subtasks: result.subtasks })
    } catch (err) {
      logger.error({ err, cardId }, 'Breakdown generation failed')
      json(res, { error: (err as Error).message }, 500)
    }
    return true
  }

  const acceptMatch = path.match(/^\/api\/kanban\/([^/]+)\/breakdown\/accept$/)
  if (acceptMatch && method === 'POST') {
    const parentId = decodeURIComponent(acceptMatch[1])
    const parent = getKanbanCard(parentId)
    if (!parent) { json(res, { error: 'Szülő kártya nem található' }, 404); return true }
    const body = await readBody(req)
    const { subtasks } = JSON.parse(body.toString()) as {
      subtasks: Array<{ title: string; description: string; assignee: string | null; priority: string }>
    }
    if (!Array.isArray(subtasks) || subtasks.length === 0) {
      json(res, { error: 'Subtask lista kötelező' }, 400)
      return true
    }
    const db = getDb()
    const created = db.transaction(() => {
      const ids: string[] = []
      for (const st of subtasks) {
        const id = randomUUID().slice(0, 8).toUpperCase()
        createKanbanCard({
          id,
          title: st.title,
          description: st.description,
          assignee: st.assignee ?? undefined,
          priority: (st.priority as any) ?? 'normal',
          project: parent.project ?? undefined,
          parent_id: parentId,
        })
        ids.push(id)
      }
      addKanbanComment(parentId, BOT_NAME, `Auto-breakdown: ${ids.length} subtask létrehozva (${ids.join(', ')})`)
      return ids
    })()
    json(res, { ok: true, created })
    return true
  }

  const childrenMatch = path.match(/^\/api\/kanban\/([^/]+)\/children$/)
  if (childrenMatch && method === 'GET') {
    const parentId = decodeURIComponent(childrenMatch[1])
    json(res, getChildCards(parentId))
    return true
  }

  return false
}
