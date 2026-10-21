import type { RouteContext } from '../routes/types.js'
import { readLimited, sendJson, BodyTooLargeError } from './util.js'
import * as store from './store.js'
import { listTools, runTool, buildSource } from './tools.js'
import type { Mode } from './store.js'

const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
const MAX_BODY = 1024 * 1024

const INSTRUCTIONS: Record<Mode, string> = {
  rw: 'Long-term memory of the signed-in user. Search it before answering when personal context matters; save durable new facts with remember (one fact per call); correct outdated ones with update_memory. Never store secrets.',
  r: "Read-only access to a user's long-term memory. Present what you find as that user's facts. You cannot write to it.",
  w: "Write-only access to a user's long-term memory. Save durable facts with remember, one per call. You cannot read the memory. Never store secrets.",
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

export async function handleMcp(ctx: RouteContext, publicUrl: string): Promise<void> {
  const { req, res } = ctx
  if (ctx.method !== 'POST') {
    return sendJson(res, 405, { error: 'Method not allowed' }, { Allow: 'POST' })
  }

  const header = String(req.headers.authorization ?? '')
  const m = /^Bearer\s+(\S+)$/i.exec(header)
  const now = store.nowSec()
  const principal = m ? store.authenticateAccessToken(m[1]!, now) : undefined
  if (!principal) {
    // Drain the request so the connection stays usable.
    req.resume()
    return sendJson(res, 401, { error: 'invalid_token' }, {
      'WWW-Authenticate': `Bearer resource_metadata="${publicUrl}/.well-known/oauth-protected-resource"`,
    })
  }

  let raw: string
  try {
    raw = (await readLimited(req, MAX_BODY)).toString('utf8')
  } catch (err) {
    if (err instanceof BodyTooLargeError) return sendJson(res, 413, { error: 'Payload too large' })
    throw err
  }
  let msg: unknown
  try { msg = JSON.parse(raw) } catch { return sendJson(res, 400, rpcError(null, -32700, 'Parse error')) }
  if (Array.isArray(msg)) return sendJson(res, 400, rpcError(null, -32600, 'Batch requests are not supported'))
  if (!msg || typeof msg !== 'object') return sendJson(res, 400, rpcError(null, -32600, 'Invalid Request'))

  store.touchGrant(principal.grant.id, now, principal.grant.last_used_at)

  const body = msg as { id?: unknown; method?: unknown; params?: unknown }
  if (body.id === undefined || body.id === null) {
    res.writeHead(202)
    res.end()
    return
  }
  const id = body.id
  const mode = principal.grant.mode
  const params = (body.params && typeof body.params === 'object' ? body.params : {}) as Record<string, unknown>
  const ok = (result: unknown) => sendJson(res, 200, { jsonrpc: '2.0', id, result })

  switch (body.method) {
    case 'initialize': {
      const pv = typeof params.protocolVersion === 'string' && VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : VERSIONS[0]
      return ok({
        protocolVersion: pv,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'marveen-memory', version: '1.0.0' },
        instructions: INSTRUCTIONS[mode],
      })
    }
    case 'ping':
      return ok({})
    case 'tools/list':
      return ok({ tools: listTools(mode) })
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : ''
      const args = (params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {}) as Record<string, unknown>
      const out = runTool(name, args, {
        owner: 'mcp:' + principal.username,
        mode,
        source: buildSource(principal.clientName, principal.grant.label),
      })
      if (!out) return sendJson(res, 200, rpcError(id, -32602, `Tool not available: ${name}`))
      if (!out.ok) return ok({ content: [{ type: 'text', text: out.message }], isError: true })
      return ok({ content: [{ type: 'text', text: JSON.stringify(out.result) }], structuredContent: out.result })
    }
    default:
      return sendJson(res, 200, rpcError(id, -32601, 'Method not found'))
  }
}
