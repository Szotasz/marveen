// CRUD for the owner's custom slash commands (CMD920 3.12).
//
//   GET    /api/custom-commands              list (+ the invalid ones with reasons)
//   POST   /api/custom-commands              create
//   PUT    /api/custom-commands/:name        update
//   DELETE /api/custom-commands/:name        delete
//   GET    /api/custom-commands/export       the commands.json shape
//   POST   /api/custom-commands/import       import into an EMPTY table only
//
// Writes carrying an agent identity are refused (403). This is the only
// server-side check the envelope can make here -- every fleet agent shares
// the dashboard token, so it is not a hard guarantee (see custom-commands.ts
// for the rest of the threat model). `updated_by` is set by the server from
// the auth principal, never taken from the body.

import type http from 'node:http'
import { json, readBody } from '../http-helpers.js'
import {
  listCustomCommands,
  getCustomCommand,
  insertCustomCommand,
  updateCustomCommand,
  deleteCustomCommand,
  countCustomCommands,
} from '../../db.js'
import { listCommands, listInvalidCustomCommands } from '../commands.js'
import {
  validateDefinition,
  definitionBody,
  rowToRaw,
  loadCustomCommands,
  importDefinitions,
  exportDefinitions,
} from '../custom-commands.js'
import type { RouteContext } from './types.js'
import { agentIdentityOf } from './commands.js'

// The agent-identity refusal is shared with the dispatch endpoint.
export { agentIdentityOf }

export function updatedByOf(auth: RouteContext['auth']): string {
  if (auth?.kind === 'session') return `owner:session:${auth.user ?? '?'}`
  if (auth?.kind === 'device') return `owner:device:${auth.device ?? '?'}`
  return 'dashboard-token'
}

function builtins(): Set<string> {
  return new Set(listCommands().filter(e => e.source !== 'custom').map(e => e.name))
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  return JSON.parse((await readBody(req, { maxBytes: 256 * 1024 })).toString())
}

export async function tryHandleCustomCommands(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, auth } = ctx
  if (path !== '/api/custom-commands' && !path.startsWith('/api/custom-commands/')) return false

  if (path === '/api/custom-commands' && method === 'GET') {
    json(res, { commands: listCustomCommands().map(r => ({ ...rowToRaw(r), updated_at: r.updated_at, updated_by: r.updated_by, last_run_at: r.last_run_at })), invalid: listInvalidCustomCommands() })
    return true
  }
  if (path === '/api/custom-commands/export' && method === 'GET') {
    json(res, exportDefinitions())
    return true
  }

  const isWrite = method === 'POST' || method === 'PUT' || method === 'DELETE'
  if (!isWrite) {
    json(res, { error: 'Not found' }, 404)
    return true
  }

  let body: unknown = null
  if (method !== 'DELETE') {
    try { body = await readJson(req) } catch {
      json(res, { error: 'Invalid JSON' }, 400)
      return true
    }
  }
  const agent = agentIdentityOf(req, body, auth)
  if (agent) {
    json(res, { error: `Custom commands are owner-only; a write carrying an agent identity is refused (${agent}).` }, 403)
    return true
  }
  const by = updatedByOf(auth)

  if (path === '/api/custom-commands/import' && method === 'POST') {
    if (countCustomCommands() > 0) {
      json(res, { error: 'Import only into an empty table; delete the existing commands first.' }, 409)
      return true
    }
    const defs = (body as { commands?: unknown })?.commands
    if (!Array.isArray(defs)) {
      json(res, { error: 'Body must be { "commands": [...] }' }, 400)
      return true
    }
    const r = importDefinitions(defs, by)
    loadCustomCommands()
    json(res, r)
    return true
  }

  if (path === '/api/custom-commands' && method === 'POST') {
    const v = validateDefinition(body, builtins())
    if (!v.ok) {
      json(res, { error: v.reason }, 400)
      return true
    }
    if (getCustomCommand(v.def.name)) {
      json(res, { error: `/${v.def.name} already exists` }, 409)
      return true
    }
    const row = insertCustomCommand({ name: v.def.name, description: v.def.description, kind: v.def.kind, body: definitionBody(v.def), enabled: v.def.enabled, updatedBy: by })
    loadCustomCommands()
    json(res, { ...rowToRaw(row), updated_at: row.updated_at, updated_by: row.updated_by }, 201)
    return true
  }

  const m = path.match(/^\/api\/custom-commands\/([a-z][a-z0-9_]{0,31})$/)
  if (!m) {
    json(res, { error: 'Not found' }, 404)
    return true
  }
  const name = m[1]
  const cur = getCustomCommand(name)
  if (!cur) {
    json(res, { error: 'Not found' }, 404)
    return true
  }

  if (method === 'DELETE') {
    deleteCustomCommand(name)
    loadCustomCommands()
    json(res, { deleted: name })
    return true
  }

  if (method === 'PUT') {
    const merged = { ...rowToRaw(cur), ...(body as Record<string, unknown>), name }
    const v = validateDefinition(merged, builtins())
    if (!v.ok) {
      json(res, { error: v.reason }, 400)
      return true
    }
    const row = updateCustomCommand(name, { description: v.def.description, kind: v.def.kind, body: definitionBody(v.def), enabled: v.def.enabled }, by)!
    loadCustomCommands()
    json(res, { ...rowToRaw(row), updated_at: row.updated_at, updated_by: row.updated_by })
    return true
  }

  json(res, { error: 'Not found' }, 404)
  return true
}
