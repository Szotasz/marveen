import { randomBytes } from 'node:crypto'
import { listTeamNotes, getTeamNote, createTeamNote, updateTeamNote, softDeleteTeamNote } from '../../db.js'
import { readBody, json, methodNotAllowed } from '../http-helpers.js'
import type { RouteContext } from './types.js'

// Team notes ("Jegyzetek"): the team's small follow-ups, kept off the kanban
// board. Every agent reviews the list morning and evening and deletes what is
// done or no longer relevant. Deletion is soft so the history stays auditable;
// GET ?include_deleted=1 returns the last 7 days of deletions as well.

const POST_FIELDS = ['assignee', 'content', 'due_date', 'created_by'] as const
const PUT_FIELDS = ['content', 'assignee', 'due_date'] as const
const DELETE_FIELDS = ['by', 'reason'] as const
const DELETED_WINDOW_SECONDS = 7 * 86400
const MAX_CONTENT_CHARS = 2000
const MAX_NAME_CHARS = 64

type Body = Record<string, unknown>

function newNoteId(): string {
  // 6 hex chars; retry on the (rare) collision instead of failing the insert.
  for (let i = 0; i < 10; i++) {
    const id = randomBytes(3).toString('hex')
    if (!getTeamNote(id)) return id
  }
  throw new Error('Could not allocate a unique note id')
}

/** YYYY-MM-DD that is also a real calendar date (rejects 2026-02-30). */
function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const d = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value
}

async function readJsonObject(ctx: RouteContext, allowEmpty: boolean): Promise<Body | null> {
  const raw = (await readBody(ctx.req)).toString().trim()
  if (!raw) {
    if (allowEmpty) return {}
    json(ctx.res, { error: 'JSON body required' }, 400); return null
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch {
    json(ctx.res, { error: 'Body is not valid JSON' }, 400); return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    json(ctx.res, { error: 'Body must be a JSON object' }, 400); return null
  }
  return parsed as Body
}

/** Loud 400 on unknown fields, naming the accepted set (same as PUT /api/kanban/:id). */
function rejectUnknownFields(ctx: RouteContext, body: Body, accepted: readonly string[]): boolean {
  const unknown = Object.keys(body).filter((k) => !accepted.includes(k))
  if (!unknown.length) return false
  json(ctx.res, { error: `Unknown field(s): ${unknown.join(', ')}. Accepted: ${accepted.join(', ')}` }, 400)
  return true
}

/**
 * Validates a required-or-optional non-empty string field. Returns the trimmed
 * value, undefined when absent and optional, or null after writing a 400.
 */
function stringField(ctx: RouteContext, body: Body, name: string, required: boolean, max: number): string | undefined | null {
  const v = body[name]
  if (v === undefined) {
    if (!required) return undefined
    json(ctx.res, { error: `${name} is required` }, 400); return null
  }
  if (typeof v !== 'string' || !v.trim()) {
    json(ctx.res, { error: `${name} must be a non-empty string` }, 400); return null
  }
  const trimmed = v.trim()
  if (trimmed.length > max) {
    json(ctx.res, { error: `${name} is too long (max ${max} characters)` }, 400); return null
  }
  return trimmed
}

/** due_date: absent -> undefined, null/'' -> null (clear), else YYYY-MM-DD. `false` means a 400 was written. */
function dueDateField(ctx: RouteContext, body: Body): string | null | undefined | false {
  const v = body.due_date
  if (v === undefined) return undefined
  if (v === null || v === '') return null
  if (typeof v !== 'string' || !isValidDate(v.trim())) {
    json(ctx.res, { error: 'due_date must be a date in YYYY-MM-DD format (or null)' }, 400); return false
  }
  return v.trim()
}

/**
 * A filter the route does not read is not a harmless extra: `?asignee=x` would
 * return every note with HTTP 200. Loud 400 instead, naming the accepted set.
 */
function rejectUnknownQueryParams(ctx: RouteContext, known: readonly string[]): boolean {
  const unknown = [...ctx.url.searchParams.keys()].filter((k) => !known.includes(k))
  if (!unknown.length) return false
  json(ctx.res, { error: 'unknown query parameter', unknown, known }, 400)
  return true
}

export async function tryHandleNotes(ctx: RouteContext): Promise<boolean> {
  const { res, path, method, url } = ctx

  if (path === '/api/notes') {
    if (method === 'GET') {
      if (rejectUnknownQueryParams(ctx, ['assignee', 'include_deleted'])) return true
      const assignee = url.searchParams.get('assignee')?.trim() || undefined
      const includeDeletedRaw = url.searchParams.get('include_deleted')
      if (includeDeletedRaw !== null && !['0', '1', 'true', 'false'].includes(includeDeletedRaw)) {
        json(res, { error: 'include_deleted must be 1 or 0' }, 400); return true
      }
      const includeDeleted = includeDeletedRaw === '1' || includeDeletedRaw === 'true'
      const notes = listTeamNotes({
        assignee,
        includeDeletedSince: includeDeleted ? Math.floor(Date.now() / 1000) - DELETED_WINDOW_SECONDS : undefined,
      })
      json(res, notes)
      return true
    }
    if (method === 'POST') {
      const body = await readJsonObject(ctx, false)
      if (!body) return true
      if (rejectUnknownFields(ctx, body, POST_FIELDS)) return true
      const assignee = stringField(ctx, body, 'assignee', true, MAX_NAME_CHARS)
      if (assignee === null) return true
      const content = stringField(ctx, body, 'content', true, MAX_CONTENT_CHARS)
      if (content === null) return true
      const createdBy = stringField(ctx, body, 'created_by', true, MAX_NAME_CHARS)
      if (createdBy === null) return true
      const dueDate = dueDateField(ctx, body)
      if (dueDate === false) return true
      const id = newNoteId()
      createTeamNote({ id, assignee: assignee!, content: content!, due_date: dueDate ?? null, created_by: createdBy! })
      json(res, { ok: true, id })
      return true
    }
    methodNotAllowed(res, method, ['GET', 'POST'])
    return true
  }

  const noteMatch = path.match(/^\/api\/notes\/([^/]+)$/)
  if (!noteMatch) return false
  const id = decodeURIComponent(noteMatch[1])

  if (method === 'PUT') {
    const body = await readJsonObject(ctx, false)
    if (!body) return true
    if (rejectUnknownFields(ctx, body, PUT_FIELDS)) return true
    const content = stringField(ctx, body, 'content', false, MAX_CONTENT_CHARS)
    if (content === null) return true
    const assignee = stringField(ctx, body, 'assignee', false, MAX_NAME_CHARS)
    if (assignee === null) return true
    const dueDate = dueDateField(ctx, body)
    if (dueDate === false) return true
    if (!updateTeamNote(id, { content, assignee, due_date: dueDate })) {
      json(res, { error: 'Note not found or already deleted' }, 404); return true
    }
    json(res, { ok: true, note: getTeamNote(id) })
    return true
  }

  if (method === 'DELETE') {
    const body = await readJsonObject(ctx, true)
    if (!body) return true
    if (rejectUnknownFields(ctx, body, DELETE_FIELDS)) return true
    const by = stringField(ctx, body, 'by', true, MAX_NAME_CHARS)
    if (by === null) return true
    let reason: string | null = null
    if (body.reason !== undefined && body.reason !== null) {
      if (typeof body.reason !== 'string') { json(res, { error: 'reason must be a string' }, 400); return true }
      reason = body.reason.trim().slice(0, MAX_CONTENT_CHARS) || null
    }
    if (!softDeleteTeamNote(id, by!, reason)) {
      json(res, { error: 'Note not found or already deleted' }, 404); return true
    }
    json(res, { ok: true })
    return true
  }

  methodNotAllowed(res, method, ['PUT', 'DELETE'])
  return true
}
