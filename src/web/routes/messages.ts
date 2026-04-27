import {
  createAgentMessage, getPendingMessages, listAgentMessages,
  markMessageDone, markMessageFailed,
  type AgentMessage,
} from '../../db.js'
import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

export async function tryHandleMessages(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  if (path === '/api/messages' && method === 'POST') {
    const body = await readBody(req)
    const { from, to, content } = JSON.parse(body.toString()) as { from: string; to: string; content: string }
    if (!from?.trim() || !to?.trim() || !content?.trim()) {
      json(res, { error: 'from, to, and content are required' }, 400)
      return true
    }
    const msg = createAgentMessage(from.trim(), to.trim(), content.trim())
    logger.info({ id: msg.id, from: msg.from_agent, to: msg.to_agent }, 'Agent message created')
    json(res, msg)
    return true
  }

  if (path === '/api/messages' && method === 'GET') {
    const agent = url.searchParams.get('agent') || ''
    const status = url.searchParams.get('status') || ''
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200)

    let messages: AgentMessage[]
    if (status === 'pending' && agent) {
      messages = getPendingMessages(agent)
    } else if (status === 'pending') {
      messages = getPendingMessages()
    } else {
      messages = listAgentMessages(limit)
    }

    if (agent && status !== 'pending') {
      messages = messages.filter(m => m.from_agent === agent || m.to_agent === agent)
    }

    json(res, messages)
    return true
  }

  const msgUpdateMatch = path.match(/^\/api\/messages\/(\d+)$/)
  if (msgUpdateMatch && method === 'PUT') {
    const id = parseInt(msgUpdateMatch[1], 10)
    const body = await readBody(req)
    const { status: newStatus, result } = JSON.parse(body.toString()) as { status: string; result?: string }

    let ok = false
    if (newStatus === 'done') ok = markMessageDone(id, result)
    else if (newStatus === 'failed') ok = markMessageFailed(id, result)

    if (ok) { json(res, { ok: true }); return true }
    json(res, { error: 'Message not found or invalid status' }, 404)
    return true
  }

  return false
}
