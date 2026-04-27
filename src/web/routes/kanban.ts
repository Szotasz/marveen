import { randomUUID } from 'node:crypto'
import {
  listKanbanCards, createKanbanCard, updateKanbanCard,
  deleteKanbanCard, moveKanbanCard, archiveKanbanCard,
  getKanbanComments, addKanbanComment,
} from '../../db.js'
import { OWNER_NAME } from '../../config.js'
import { listAgentNames } from '../agent-config.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

export async function tryHandleKanban(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path === '/api/kanban' && method === 'GET') {
    json(res, listKanbanCards())
    return true
  }

  if (path === '/api/kanban/assignees' && method === 'GET') {
    const agents = listAgentNames().map((name) => ({ name, type: 'agent' }))
    json(res, [
      { name: OWNER_NAME, type: 'owner' },
      { name: 'Marveen', type: 'bot' },
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
    if (moveKanbanCard(id, status, sort_order ?? 0)) { json(res, { ok: true }); return true }
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

  return false
}
