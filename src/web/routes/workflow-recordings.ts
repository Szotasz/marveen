import { randomUUID } from 'node:crypto'
import {
  listWorkflowRecordings,
  createWorkflowRecording,
  updateWorkflowRecording,
  deleteWorkflowRecording,
  matchWorkflowRecordings,
} from '../../db.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

export async function tryHandleWorkflowRecordings(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  if (path === '/api/workflow-recordings' && method === 'GET') {
    const agent = url.searchParams.get('agent') || undefined
    const q = url.searchParams.get('q')
    if (q) {
      json(res, matchWorkflowRecordings(q))
    } else {
      json(res, listWorkflowRecordings(agent))
    }
    return true
  }

  if (path === '/api/workflow-recordings' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as {
      name: string
      description?: string
      trigger_keywords?: string
      steps?: Array<{ tool: string; description: string; command?: string }>
      agent_id?: string
    }
    if (!data.name) { json(res, { error: 'name required' }, 400); return true }
    const id = randomUUID().slice(0, 8)
    createWorkflowRecording({
      id,
      name: data.name,
      description: data.description ?? null,
      trigger_keywords: data.trigger_keywords ?? '',
      steps_json: JSON.stringify(data.steps ?? []),
      agent_id: data.agent_id ?? 'marveen',
    })
    json(res, { ok: true, id })
    return true
  }

  const recMatch = path.match(/^\/api\/workflow-recordings\/([^/]+)$/)

  if (recMatch && method === 'PUT') {
    const id = decodeURIComponent(recMatch[1])
    const body = await readBody(req)
    const data = JSON.parse(body.toString())
    if (data.steps !== undefined) data.steps_json = JSON.stringify(data.steps)
    if (updateWorkflowRecording(id, data)) { json(res, { ok: true }); return true }
    json(res, { error: 'Nem található' }, 404)
    return true
  }

  if (recMatch && method === 'DELETE') {
    const id = decodeURIComponent(recMatch[1])
    if (deleteWorkflowRecording(id)) { json(res, { ok: true }); return true }
    json(res, { error: 'Nem található' }, 404)
    return true
  }

  // Increment run/success counters
  const runMatch = path.match(/^\/api\/workflow-recordings\/([^/]+)\/(run|success)$/)
  if (runMatch && method === 'POST') {
    const id = decodeURIComponent(runMatch[1])
    const type = runMatch[2]
    const rec = listWorkflowRecordings().find(r => r.id === id)
    if (!rec) { json(res, { error: 'Nem található' }, 404); return true }
    if (type === 'run') updateWorkflowRecording(id, { run_count: rec.run_count + 1 })
    if (type === 'success') updateWorkflowRecording(id, { success_count: rec.success_count + 1 })
    json(res, { ok: true })
    return true
  }

  return false
}
