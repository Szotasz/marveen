// workspace.ts — /api/workspace CRUD for fleet-agent working documents.
//
// RBAC: GET = memories:read, POST/PATCH/DELETE = memories:write.
// Write access is restricted to fleet-agent callers (auth.kind === 'token').
// Session (user-token) callers get 403 on mutating requests.
//
// No SUSPICIOUS_PATTERNS filter -- workspace_docs accepts source code and
// incident reports that legitimately contain `rm -rf`, `bash -c`, etc.
// The only producer is a fleet agent; the trust boundary is the auth gate.

import { readBody, json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import {
  saveWorkspaceDoc, getWorkspaceDoc, getWorkspaceDocBlob,
  listWorkspaceDocs, patchWorkspaceDoc, deleteWorkspaceDoc,
  WORKSPACE_DOC_SIZE_LIMITS,
  type WorkspaceDocType, type WorkspaceContentType,
} from '../../workspace-store.js'
import type { RouteContext } from './types.js'

const VALID_TYPES = new Set<WorkspaceDocType>(['plan', 'brief', 'report', 'notes'])
const VALID_CONTENT_TYPES = new Set<WorkspaceContentType>(['text', 'code', 'binary'])

function agentOnly(ctx: RouteContext): boolean {
  return ctx.auth?.kind === 'token'
}

function effectiveTenant(ctx: RouteContext): string | null {
  const isAdmin = ctx.role === 'admin'
  return isAdmin
    ? (ctx.url.searchParams.get('tenant') ?? null)
    : (ctx.tenantId ?? 'default')
}

export async function tryHandleWorkspace(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  if (!path.startsWith('/api/workspace')) return false

  // ── GET /api/workspace — list ───────────────────────────────────────────────
  if (path === '/api/workspace' && method === 'GET') {
    const tenantId = effectiveTenant(ctx)
    const filter = {
      agentId:     url.searchParams.get('agent') ?? undefined,
      tenantId:    tenantId ?? undefined,
      type:        (url.searchParams.get('type') as WorkspaceDocType | null) ?? undefined,
      contentType: (url.searchParams.get('content_type') as WorkspaceContentType | null) ?? undefined,
      taskRef:     url.searchParams.get('task_ref') ?? undefined,
    }
    const docs = listWorkspaceDocs(filter)
    json(res, { items: docs, total: docs.length })
    return true
  }

  // ── POST /api/workspace — create / UPSERT ──────────────────────────────────
  if (path === '/api/workspace' && method === 'POST') {
    if (!agentOnly(ctx)) {
      json(res, { error: 'forbidden', hint: 'Only fleet agent tokens may write workspace docs' }, 403)
      return true
    }

    const body = await readBody(req)
    let parsed: Record<string, unknown>
    try { parsed = JSON.parse(body.toString()) } catch {
      json(res, { error: 'parse_error', hint: 'Invalid JSON body' }, 400); return true
    }

    const agentId   = typeof parsed.agent_id === 'string'    ? parsed.agent_id.trim()    : ''
    const title     = typeof parsed.title === 'string'       ? parsed.title.trim()       : ''
    const contentRaw = typeof parsed.content === 'string'    ? parsed.content            : null
    const docKey    = typeof parsed.doc_key === 'string'     ? parsed.doc_key.trim()     : null
    const taskRef   = typeof parsed.task_ref === 'string'    ? parsed.task_ref.trim()    : null
    const contentType = (typeof parsed.content_type === 'string' ? parsed.content_type : 'text') as WorkspaceContentType
    const docType   = (typeof parsed.type === 'string'       ? parsed.type             : 'plan') as WorkspaceDocType

    if (!agentId) { json(res, { error: 'required', field: 'agent_id' }, 400); return true }
    if (!title)   { json(res, { error: 'required', field: 'title' }, 400); return true }
    if (!VALID_CONTENT_TYPES.has(contentType)) {
      json(res, { error: 'invalid_value', field: 'content_type', hint: `Allowed: ${[...VALID_CONTENT_TYPES].join(', ')}` }, 400)
      return true
    }
    if (!VALID_TYPES.has(docType)) {
      json(res, { error: 'invalid_value', field: 'type', hint: `Allowed: ${[...VALID_TYPES].join(', ')}` }, 400)
      return true
    }

    let contentBlob: Buffer | null = null
    let effectiveContent: string | null = contentRaw

    if (contentType === 'binary') {
      const b64 = typeof parsed.content_blob_b64 === 'string' ? parsed.content_blob_b64 : null
      if (!b64) {
        json(res, { error: 'required', field: 'content_blob_b64', hint: 'binary content_type requires base64-encoded content_blob_b64' }, 400)
        return true
      }
      try { contentBlob = Buffer.from(b64, 'base64') } catch {
        json(res, { error: 'invalid_value', field: 'content_blob_b64', hint: 'Failed to decode base64' }, 400); return true
      }
    }

    const sizeBytes = effectiveContent
      ? Buffer.byteLength(effectiveContent, 'utf8')
      : (contentBlob ? contentBlob.byteLength : 0)
    const limit = WORKSPACE_DOC_SIZE_LIMITS[contentType]
    if (sizeBytes > limit) {
      json(res, { error: 'limit_exceeded', field: 'content', hint: `${contentType} content limit is ${limit} bytes` }, 413)
      return true
    }

    const tenantId = effectiveTenant(ctx) ?? 'default'
    try {
      const doc = saveWorkspaceDoc({
        agent_id: agentId, tenant_id: tenantId, doc_key: docKey,
        title, content: effectiveContent, content_blob: contentBlob,
        content_type: contentType, type: docType, task_ref: taskRef,
      })
      logger.info({ agent_id: agentId, id: doc.id, doc_key: docKey }, 'workspace_doc saved')
      json(res, doc, 201)
    } catch (err) {
      logger.error({ err }, 'workspace_doc save failed')
      json(res, { error: 'internal_error' }, 500)
    }
    return true
  }

  // ── GET /api/workspace/:id ─────────────────────────────────────────────────
  const idMatch = path.match(/^\/api\/workspace\/([^/]+)$/)
  if (idMatch && method === 'GET') {
    const id = idMatch[1]
    const doc = getWorkspaceDoc(id)
    if (!doc) { json(res, { error: 'not_found', field: 'id' }, 404); return true }

    // Tenant gate: non-admin may only read own tenant's docs.
    if (ctx.role !== 'admin' && doc.tenant_id !== (ctx.tenantId ?? 'default')) {
      json(res, { error: 'forbidden' }, 403); return true
    }

    // For binary docs, attach blob as base64 in the response.
    if (doc.content_type === 'binary') {
      const blob = getWorkspaceDocBlob(id)
      json(res, { ...doc, content_blob_b64: blob ? blob.toString('base64') : null })
    } else {
      json(res, doc)
    }
    return true
  }

  // ── PATCH /api/workspace/:id ───────────────────────────────────────────────
  if (idMatch && method === 'PATCH') {
    if (!agentOnly(ctx)) {
      json(res, { error: 'forbidden', hint: 'Only fleet agent tokens may write workspace docs' }, 403)
      return true
    }

    const id = idMatch[1]
    const existing = getWorkspaceDoc(id)
    if (!existing) { json(res, { error: 'not_found', field: 'id' }, 404); return true }

    const body = await readBody(req)
    let parsed: Record<string, unknown>
    try { parsed = JSON.parse(body.toString()) } catch {
      json(res, { error: 'parse_error', hint: 'Invalid JSON body' }, 400); return true
    }

    const patch: Parameters<typeof patchWorkspaceDoc>[1] = {}
    if ('title' in parsed)    patch.title    = String(parsed.title ?? '').trim() || existing.title
    if ('content' in parsed)  patch.content  = typeof parsed.content === 'string' ? parsed.content : null
    if ('type' in parsed) {
      const t = parsed.type as WorkspaceDocType
      if (!VALID_TYPES.has(t)) {
        json(res, { error: 'invalid_value', field: 'type' }, 400); return true
      }
      patch.type = t
    }
    if ('task_ref' in parsed) patch.task_ref = typeof parsed.task_ref === 'string' ? parsed.task_ref : null

    if (Object.keys(patch).length === 0) {
      json(res, { error: 'required', hint: 'At least one field required' }, 400); return true
    }

    if ('content' in patch && patch.content !== null && patch.content !== undefined) {
      const limit = WORKSPACE_DOC_SIZE_LIMITS[existing.content_type]
      const size = Buffer.byteLength(patch.content, 'utf8')
      if (size > limit) {
        json(res, { error: 'limit_exceeded', field: 'content', hint: `Limit is ${limit} bytes` }, 413)
        return true
      }
    }

    const updated = patchWorkspaceDoc(id, patch)
    if (!updated) { json(res, { error: 'not_found', field: 'id' }, 404); return true }
    json(res, updated)
    return true
  }

  // ── DELETE /api/workspace/:id ──────────────────────────────────────────────
  if (idMatch && method === 'DELETE') {
    if (!agentOnly(ctx)) {
      json(res, { error: 'forbidden', hint: 'Only fleet agent tokens may delete workspace docs' }, 403)
      return true
    }

    const id = idMatch[1]
    const existing = getWorkspaceDoc(id)
    if (!existing) { json(res, { error: 'not_found', field: 'id' }, 404); return true }

    // Only the owning agent may delete.
    const callerAgentId = ctx.auth?.device ?? null
    if (callerAgentId && callerAgentId !== existing.agent_id) {
      json(res, { error: 'forbidden', hint: 'Only the owning agent may delete this doc' }, 403)
      return true
    }

    deleteWorkspaceDoc(id)
    logger.info({ id, agent_id: existing.agent_id }, 'workspace_doc deleted')
    json(res, { ok: true })
    return true
  }

  return false
}
