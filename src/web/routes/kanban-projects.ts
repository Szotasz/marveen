import { listKanbanProjectSummaries, upsertKanbanProjectDescription } from '../../db.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

// Project-overview endpoints: a human-readable, project-grouped summary of the
// kanban board, distinct from the existing GET /api/kanban-projects (kanban.ts)
// which only returns the bare distinct project-name list for the card-modal
// datalist. Kept in its own file rather than folded into kanban.ts (already
// several hundred lines) so the project-summary concern stays easy to find and
// to port -- these two endpoints depend on nothing fleet-specific, only on the
// generic `project` string already stored on kanban_cards.
export async function tryHandleKanbanProjects(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path === '/api/kanban-projects/summary' && method === 'GET') {
    json(res, listKanbanProjectSummaries())
    return true
  }

  const descMatch = path.match(/^\/api\/kanban-projects\/([^/]+)$/)
  if (descMatch && method === 'PUT') {
    const project = decodeURIComponent(descMatch[1])
    const body = await readBody(req)
    const { description } = JSON.parse(body.toString()) as { description?: string }
    if (typeof description !== 'string') {
      json(res, { error: 'description mező kötelező (string, üres string is elfogadott)' }, 400)
      return true
    }
    const { changed } = upsertKanbanProjectDescription(project, description)
    json(res, { ok: true, changed })
    return true
  }

  return false
}
