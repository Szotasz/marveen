import { randomUUID } from 'node:crypto'
import {
  listWorkflowRecordings,
  createWorkflowRecording,
  updateWorkflowRecording,
  deleteWorkflowRecording,
  matchWorkflowRecordings,
  matchWorkflowRecordingsSemantic,
  backfillWorkflowEmbeddings,
  recordWorkflowBranchRun,
} from '../../db.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

export async function tryHandleWorkflowRecordings(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  if (path === '/api/workflow-recordings' && method === 'GET') {
    const agent = url.searchParams.get('agent') || undefined
    const q = url.searchParams.get('q')
    const semantic = url.searchParams.get('semantic') === '1'
    const threshold = parseFloat(url.searchParams.get('threshold') || '0.6')
    if (q && semantic) {
      const results = await matchWorkflowRecordingsSemantic(q, threshold)
      json(res, results)
    } else if (q) {
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
      trigger_description?: string
      steps?: unknown[]
      agent_id?: string
    }
    if (!data.name) { json(res, { error: 'name required' }, 400); return true }
    const id = randomUUID().slice(0, 8)
    createWorkflowRecording({
      id,
      name: data.name,
      description: data.description ?? null,
      trigger_keywords: data.trigger_keywords ?? '',
      trigger_description: data.trigger_description ?? null,
      embedding: null,
      branch_stats_json: '{}',
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

  // Branch stats: POST /api/workflow-recordings/:id/branch { branch_id, success }
  const branchMatch = path.match(/^\/api\/workflow-recordings\/([^/]+)\/branch$/)
  if (branchMatch && method === 'POST') {
    const id = decodeURIComponent(branchMatch[1])
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as { branch_id: string; success: boolean }
    if (!data.branch_id) { json(res, { error: 'branch_id required' }, 400); return true }
    if (recordWorkflowBranchRun(id, data.branch_id, !!data.success)) {
      json(res, { ok: true })
    } else {
      json(res, { error: 'Nem található' }, 404)
    }
    return true
  }

  // Backfill embeddings for all workflows missing them
  if (path === '/api/workflow-recordings/backfill-embeddings' && method === 'POST') {
    const count = await backfillWorkflowEmbeddings()
    json(res, { ok: true, count })
    return true
  }

  // Semantic suggest: best match above threshold for a given query
  if (path === '/api/workflow-recordings/suggest' && method === 'GET') {
    const q = url.searchParams.get('q') || ''
    const threshold = parseFloat(url.searchParams.get('threshold') || '0.6')
    if (!q) { json(res, { suggestion: null }); return true }
    const results = await matchWorkflowRecordingsSemantic(q, threshold)
    const best = results[0] || null
    if (!best) { json(res, { suggestion: null }); return true }
    // High confidence (>0.82): auto-suggest; medium (0.6-0.82): ask
    const confidence = best.score > 0.82 ? 'high' : 'medium'
    json(res, { suggestion: { workflow: best.workflow, score: best.score, source: best.source, confidence } })
    return true
  }

  return false
}
