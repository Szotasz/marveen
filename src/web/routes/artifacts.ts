import { readJsonBody, json } from '../http-helpers.js'
import {
  createArtifact, listArtifacts, getArtifact, deleteArtifact,
  ARTIFACT_KINDS, type ArtifactKind,
} from '../../artifacts-db.js'
import { logger } from '../../logger.js'
import type { RouteContext } from './types.js'

// POST /api/artifacts
// Body: { agent_id, title, kind, mime?, content, meta?, source? }
// `content` is a plain string for text kinds, base64 for binary.
async function handleCreate(ctx: RouteContext): Promise<boolean> {
  const { res } = ctx
  const body = await readJsonBody<{
    agent_id?: string
    title?: string
    kind?: string
    mime?: string
    content?: string
    meta?: Record<string, unknown>
    source?: string
  }>(ctx.req)

  if (!body.agent_id?.trim())   { json(res, { error: 'agent_id is required' },  400); return true }
  if (!body.title?.trim())      { json(res, { error: 'title is required' },      400); return true }
  if (!body.kind)               { json(res, { error: 'kind is required' },        400); return true }
  if (!ARTIFACT_KINDS.has(body.kind as ArtifactKind)) {
    json(res, { error: `Invalid kind "${body.kind}". Allowed: ${[...ARTIFACT_KINDS].join(', ')}` }, 400)
    return true
  }
  if (body.content === undefined || body.content === null) {
    json(res, { error: 'content is required' }, 400); return true
  }

  const kind = body.kind as ArtifactKind
  let contentBuf: Buffer
  try {
    contentBuf = kind === 'binary'
      ? Buffer.from(body.content, 'base64')
      : Buffer.from(body.content, 'utf-8')
  } catch {
    json(res, { error: 'Failed to encode content' }, 400); return true
  }

  try {
    const result = createArtifact({
      agent_id: body.agent_id.trim(),
      title:    body.title.trim(),
      kind,
      mime:     body.mime,
      content:  contentBuf,
      meta:     body.meta,
      source:   body.source,
    })
    json(res, { ok: true, id: result.id }, 201)
  } catch (err) {
    logger.error({ err }, 'artifact create failed')
    json(res, { error: 'Failed to save artifact' }, 500)
  }
  return true
}

// GET /api/artifacts  — list without content
// ?agent=&kind=&q=&limit=&offset=
function handleList(ctx: RouteContext): boolean {
  const { res, url } = ctx
  const agent  = url.searchParams.get('agent')  ?? undefined
  const kind   = url.searchParams.get('kind')   ?? undefined
  const q      = url.searchParams.get('q')      ?? undefined
  const limit  = parseInt(url.searchParams.get('limit')  ?? '50',  10)
  const offset = parseInt(url.searchParams.get('offset') ?? '0',   10)

  const rows = listArtifacts({ agent, kind, q, limit, offset })
  json(res, rows)
  return true
}

// GET /api/artifacts/:id  — full content + mime
function handleGet(ctx: RouteContext, id: string): boolean {
  const { res } = ctx
  const row = getArtifact(id)
  if (!row) { json(res, { error: 'Not found' }, 404); return true }

  const contentStr = row.kind === 'binary'
    ? row.content.toString('base64')
    : row.content.toString('utf-8')

  json(res, {
    id:         row.id,
    agent_id:   row.agent_id,
    title:      row.title,
    kind:       row.kind,
    mime:       row.mime,
    content:    contentStr,
    meta:       JSON.parse(row.meta) as Record<string, unknown>,
    source:     row.source,
    created_at: row.created_at,
    updated_at: row.updated_at,
  })
  return true
}

// DELETE /api/artifacts/:id
function handleDelete(ctx: RouteContext, id: string): boolean {
  const { res } = ctx
  const deleted = deleteArtifact(id)
  if (!deleted) { json(res, { error: 'Not found' }, 404); return true }
  json(res, { ok: true })
  return true
}

export async function tryHandleArtifacts(ctx: RouteContext): Promise<boolean> {
  const { path, method } = ctx

  if (path === '/api/artifacts') {
    if (method === 'POST') return handleCreate(ctx)
    if (method === 'GET')  return handleList(ctx)
    return false
  }

  const idMatch = /^\/api\/artifacts\/([^/]+)$/.exec(path)
  if (idMatch) {
    const id = idMatch[1]
    if (method === 'GET')    return handleGet(ctx, id)
    if (method === 'DELETE') return handleDelete(ctx, id)
  }

  return false
}
