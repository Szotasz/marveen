import { randomUUID } from 'node:crypto'
import { listIdeas, createIdea, updateIdea, deleteIdea, listIdeaCategories, createKanbanCard, getDb } from '../../db.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

export async function tryHandleIdeas(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  if (path === '/api/ideas' && method === 'GET') {
    const status = url.searchParams.get('status') || undefined
    const category = url.searchParams.get('category') || undefined
    json(res, listIdeas({ status, category }))
    return true
  }

  if (path === '/api/ideas/categories' && method === 'GET') {
    json(res, listIdeaCategories())
    return true
  }

  if (path === '/api/ideas' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as {
      title: string
      description?: string
      category?: string
      source?: string
    }
    if (!data.title) { json(res, { error: 'title required' }, 400); return true }
    const id = randomUUID().slice(0, 8)
    createIdea({
      id,
      title: data.title,
      description: data.description ?? null,
      category: data.category ?? 'Egyéb',
      status: 'new',
      source: data.source ?? 'manual',
      kanban_id: null,
    })
    json(res, { ok: true, id })
    return true
  }

  const ideaMatch = path.match(/^\/api\/ideas\/([^/]+)$/)

  if (ideaMatch && method === 'PUT') {
    const id = decodeURIComponent(ideaMatch[1])
    const body = await readBody(req)
    const data = JSON.parse(body.toString())
    if (updateIdea(id, data)) { json(res, { ok: true }); return true }
    json(res, { error: 'Ötlet nem található' }, 404)
    return true
  }

  if (ideaMatch && method === 'DELETE') {
    const id = decodeURIComponent(ideaMatch[1])
    if (deleteIdea(id)) { json(res, { ok: true }); return true }
    json(res, { error: 'Ötlet nem található' }, 404)
    return true
  }

  // Promote idea to kanban card
  const promoteMatch = path.match(/^\/api\/ideas\/([^/]+)\/promote$/)
  if (promoteMatch && method === 'POST') {
    const ideaId = decodeURIComponent(promoteMatch[1])
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as { phase?: 'detail' | 'plan' }
    const phase = data.phase ?? 'detail'

    const idea = (getDb().prepare('SELECT * FROM idea_box WHERE id = ?').get(ideaId) as import('../../db.js').IdeaBoxRow | undefined)
    if (!idea) { json(res, { error: 'Ötlet nem található' }, 404); return true }

    const cardId = randomUUID().slice(0, 8)
    const status = phase === 'plan' ? 'planned' : 'waiting'
    const title = phase === 'plan' ? idea.title : `[Részlet kidolgozás] ${idea.title}`
    createKanbanCard({
      id: cardId,
      title,
      description: idea.description ?? '',
      status,
      priority: 'normal',
      assignee: 'marveen',
      project: 'Fejlesztési ötletek',
    })
    updateIdea(ideaId, { status: 'kanban', kanban_id: cardId })
    json(res, { ok: true, kanban_id: cardId })
    return true
  }

  return false
}
