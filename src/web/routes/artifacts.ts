import { readJsonBody, json } from '../http-helpers.js'
import {
  createArtifact, listArtifacts, getArtifact, deleteArtifact, getArtifactStats,
  renameArtifact, ARTIFACT_TITLE_MAX_LENGTH,
  ARTIFACT_KINDS, type ArtifactKind,
} from '../../artifacts-db.js'
import { signViewToken, verifyViewToken } from '../view-token.js'
import { logger } from '../../logger.js'
import type { RouteContext } from './types.js'

// Tenant scope helpers (mirrors kanban/memories pattern):
// - Admin with no ?tenant= filter sees all tenants (effectiveTenantId = null).
// - Admin with ?tenant=<id> sees only that tenant.
// - Non-admin is always restricted to their own tenant (ctx.tenantId ?? 'default').
function effectiveTenant(ctx: RouteContext): string | null {
  const isAdmin = ctx.role === 'admin'
  if (isAdmin) {
    const param = ctx.url.searchParams.get('tenant')
    return param ?? null
  }
  return ctx.tenantId ?? 'default'
}

// Cross-tenant guard for single-resource operations (peek-before-touch, anti-enum):
// returns true (and writes 404) if the caller may not access the artifact.
function crossTenantBlocked(ctx: RouteContext, artifactTenantId: string): boolean {
  const isAdmin = ctx.role === 'admin'
  if (isAdmin) return false
  const callerTenant = ctx.tenantId ?? 'default'
  if (artifactTenantId !== callerTenant) {
    json(ctx.res, { error: 'not_found', hint: 'Not found' }, 404)
    return true
  }
  return false
}

// GET /api/artifacts/stats  — aggregate counts for monitoring
// Returns artifact_count, vec_count (ANN index rows, -1 if unavailable),
// and vec_rebuild_suggested (true when vec_count >= 10 000).
function handleStats(ctx: RouteContext): boolean {
  json(ctx.res, getArtifactStats())
  return true
}

// POST /api/artifacts
// Body: { agent_id, title, kind, mime?, content, meta?, source?, tenant_id? }
// `content` is a plain string for text kinds, base64 for binary.
// Non-admin callers: any tenant_id in body is silently overridden with their
// own tenant. Admins may supply an explicit tenant_id.
async function handleCreate(ctx: RouteContext): Promise<boolean> {
  const { res } = ctx
  const body = await readJsonBody<{
    agent_id?: string
    tenant_id?: string
    title?: string
    kind?: string
    mime?: string
    content?: string
    meta?: Record<string, unknown>
    source?: string
    cloud_url?: string
  }>(ctx.req)

  if (!body.agent_id?.trim())   { json(res, { error: 'required', field: 'agent_id', hint: 'agent_id is required' },  400); return true }
  if (!body.title?.trim())      { json(res, { error: 'required', field: 'title', hint: 'title is required' },      400); return true }
  if (!body.kind)               { json(res, { error: 'required', field: 'kind', hint: 'kind is required' },        400); return true }
  if (!ARTIFACT_KINDS.has(body.kind as ArtifactKind)) {
    json(res, { error: 'invalid_value', field: 'kind', hint: `Invalid kind "${body.kind}". Allowed: ${[...ARTIFACT_KINDS].join(', ')}` }, 400)
    return true
  }
  if (body.content === undefined || body.content === null) {
    json(res, { error: 'required', field: 'content', hint: 'content is required' }, 400); return true
  }

  const isAdmin = ctx.role === 'admin'
  const tenantId = isAdmin
    ? (body.tenant_id?.trim() || ctx.tenantId || 'default')
    : (ctx.tenantId ?? 'default')

  const kind = body.kind as ArtifactKind
  let contentBuf: Buffer
  try {
    contentBuf = kind === 'binary'
      ? Buffer.from(body.content, 'base64')
      : Buffer.from(body.content, 'utf-8')
  } catch {
    json(res, { error: 'invalid_value', field: 'content', hint: 'Failed to encode content' }, 400); return true
  }

  try {
    const result = createArtifact({
      agent_id:  body.agent_id.trim(),
      tenant_id: tenantId,
      title:     body.title.trim(),
      kind,
      mime:      body.mime,
      content:   contentBuf,
      meta:      body.meta,
      source:    body.source,
      cloud_url: body.cloud_url?.trim() || undefined,
    })
    // 200 when an existing cloud artifact was updated via UPSERT; 201 for new inserts.
    json(res, { ok: true, id: result.id }, result.updated ? 200 : 201)
  } catch (err) {
    logger.error({ err }, 'artifact create failed')
    json(res, { error: 'internal_error', hint: 'Failed to save artifact' }, 500)
  }
  return true
}

// GET /api/artifacts  — list without content
// ?agent=&kind=&q=&limit=&offset=&tenant= (tenant param for admins only)
function handleList(ctx: RouteContext): boolean {
  const { res, url } = ctx
  const agent  = url.searchParams.get('agent')  ?? undefined
  const kind   = url.searchParams.get('kind')   ?? undefined
  const q      = url.searchParams.get('q')      ?? undefined
  const limit  = parseInt(url.searchParams.get('limit')  ?? '50',  10)
  const offset = parseInt(url.searchParams.get('offset') ?? '0',   10)

  const tenantScope = effectiveTenant(ctx)
  const tenant_id   = tenantScope !== null ? tenantScope : undefined

  const rows = listArtifacts({ agent, tenant_id, kind, q, limit, offset })
  json(res, rows)
  return true
}

// GET /api/artifacts/:id  — full content + mime
function handleGet(ctx: RouteContext, id: string): boolean {
  const { res } = ctx
  const row = getArtifact(id)
  if (!row) { json(res, { error: 'not_found', hint: 'Not found' }, 404); return true }
  if (crossTenantBlocked(ctx, row.tenant_id)) return true

  const contentStr = row.kind === 'binary'
    ? row.content.toString('base64')
    : row.content.toString('utf-8')

  json(res, {
    id:         row.id,
    agent_id:   row.agent_id,
    tenant_id:  row.tenant_id,
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

// POST /api/artifacts/:id/view-token  (Bearer required)
// Returns a short-lived HMAC token that lets a browser open the artifact
// content via GET /api/artifacts/:id/view without a Bearer header.
function handleViewToken(ctx: RouteContext, id: string): boolean {
  const { res } = ctx
  const row = getArtifact(id)
  if (!row) { json(res, { error: 'not_found', hint: 'Not found' }, 404); return true }
  if (crossTenantBlocked(ctx, row.tenant_id)) return true

  const nowSec = Math.floor(Date.now() / 1000)
  const { token, exp } = signViewToken(id, nowSec)
  const viewPath = `/api/artifacts/${encodeURIComponent(id)}/view?token=${token}&exp=${exp}`
  json(res, { token, exp, url: viewPath })
  return true
}

// GET /api/artifacts/:id/view?token=&exp=  (HMAC token, no Bearer)
// Serves the raw artifact content directly -- suitable for window.open().
// Strict CSP prevents any cross-context reads; nosniff closes MIME confusion.
// No tenant check: the signed token was issued by handleViewToken which
// already enforced the tenant gate.
function handleView(ctx: RouteContext, id: string): boolean {
  const { res, url } = ctx
  const token = url.searchParams.get('token') ?? ''
  const expStr = url.searchParams.get('exp') ?? ''
  const exp = parseInt(expStr, 10)

  if (!token || isNaN(exp)) {
    json(res, { error: 'required', hint: 'Missing token or exp' }, 400)
    return true
  }

  const nowSec = Math.floor(Date.now() / 1000)
  if (!verifyViewToken(id, token, exp, nowSec)) {
    json(res, { error: 'unauthorized', hint: 'Invalid or expired token' }, 401)
    return true
  }

  const row = getArtifact(id)
  if (!row) {
    json(res, { error: 'not_found', hint: 'Not found' }, 404)
    return true
  }

  res.writeHead(200, {
    'Content-Type': row.mime,
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:;",
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  })
  res.end(row.content)
  return true
}

// PATCH /api/artifacts/:id  — rename (title only)
// Body: { "title": "new name" }
async function handleRename(ctx: RouteContext, id: string): Promise<boolean> {
  const { res } = ctx

  const existing = getArtifact(id)
  if (!existing) { json(res, { error: 'not_found', hint: 'Not found' }, 404); return true }
  if (crossTenantBlocked(ctx, existing.tenant_id)) return true

  const body = await readJsonBody<{ title?: string }>(ctx.req)

  const title = body.title?.trim() ?? ''
  if (!title) {
    json(res, { error: 'required', field: 'title', hint: 'title is required and must not be empty' }, 400); return true
  }
  if (title.length > ARTIFACT_TITLE_MAX_LENGTH) {
    json(res, { error: 'limit_exceeded', field: 'title', hint: `title must not exceed ${ARTIFACT_TITLE_MAX_LENGTH} characters` }, 400); return true
  }

  renameArtifact(id, title)
  json(res, { ok: true })
  return true
}

// DELETE /api/artifacts/:id
function handleDelete(ctx: RouteContext, id: string): boolean {
  const { res } = ctx
  const existing = getArtifact(id)
  if (!existing) { json(res, { error: 'not_found', hint: 'Not found' }, 404); return true }
  if (crossTenantBlocked(ctx, existing.tenant_id)) return true

  deleteArtifact(id)
  json(res, { ok: true })
  return true
}

export async function tryHandleArtifacts(ctx: RouteContext): Promise<boolean> {
  const { path, method } = ctx

  if (path === '/api/artifacts/stats') {
    if (method === 'GET') return handleStats(ctx)
    return false
  }

  if (path === '/api/artifacts') {
    if (method === 'POST') return handleCreate(ctx)
    if (method === 'GET')  return handleList(ctx)
    return false
  }

  const idMatch = /^\/api\/artifacts\/([^/]+)$/.exec(path)
  if (idMatch) {
    const id = idMatch[1]
    if (method === 'GET')    return handleGet(ctx, id)
    if (method === 'PATCH')  return handleRename(ctx, id)
    if (method === 'DELETE') return handleDelete(ctx, id)
  }

  const viewTokenMatch = /^\/api\/artifacts\/([^/]+)\/view-token$/.exec(path)
  if (viewTokenMatch && method === 'POST') return handleViewToken(ctx, viewTokenMatch[1])

  const viewMatch = /^\/api\/artifacts\/([^/]+)\/view$/.exec(path)
  if (viewMatch && method === 'GET') return handleView(ctx, viewMatch[1])

  return false
}
