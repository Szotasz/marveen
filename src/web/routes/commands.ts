// Owner slash commands over HTTP (CMD920, ELSOKOR922 spec D-4).
//
//   POST /api/commands/dispatch   {text, chatId} -> {handled, outcome, replies}
//   GET  /api/commands/menu       the Telegram command menu from the registry
//
// The caller is the main session's UserPromptSubmit hook
// (scripts/hooks/marveen-commands.py): it sees the owner's Telegram message
// BEFORE the model does, posts it here, sends `replies` back on the main bot
// and blocks the turn (exit 2) -- a registry command costs no model tokens.
//
// `handled: false` means "not ours, let the model have it": not a slash
// command, a slash word the registry does not know (/kanban, /ujchat -- the
// agent's own instruction-level commands), or a chat that is not the owner's.
// Nothing is run and nothing is replied in that case, so the hook can pass
// the prompt through unchanged.
//
// The dashboard token is the credential (the gate in web.ts answers 401
// without it). A call carrying an agent identity is refused: every fleet
// agent shares that token, so this is the only server-side line between
// "the owner typed it" and "an agent asked for it" (the same check as the
// custom-commands CRUD).

import type http from 'node:http'
import { json, readBody } from '../http-helpers.js'
import { parseCommand, resolveCommand, dispatchCommand, botCommandList, type DispatchOutcome } from '../commands.js'
import { resolveOwnerChatId } from '../../owner-chat.js'
import { logger } from '../../logger.js'
import type { RouteContext } from './types.js'

const AGENT_BODY_FIELDS = ['agent_id', 'agent', 'from_agent', 'updated_by', 'requested_by'] as const
const AGENT_HEADERS = ['x-agent-id', 'x-agent-name', 'x-marveen-agent'] as const

// Non-null = the call is refused, with the reason.
export function agentIdentityOf(req: http.IncomingMessage, body: unknown, auth: RouteContext['auth']): string | null {
  if (auth?.kind === 'federation') return `federation peer ${auth.peer ?? '?'}`
  for (const h of AGENT_HEADERS) {
    const v = req.headers[h]
    if (typeof v === 'string' && v.trim()) return `${h}: ${v.trim()}`
  }
  if (body && typeof body === 'object') {
    for (const f of AGENT_BODY_FIELDS) {
      const v = (body as Record<string, unknown>)[f]
      if (typeof v === 'string' && v.trim()) return `${f}: ${v.trim()}`
    }
  }
  return null
}

export interface DispatchResult {
  handled: boolean
  outcome: DispatchOutcome | 'not-owner'
  replies: string[]
}

// The route's decision, separated from HTTP for the tests. `ownerChatId` is
// the owner chat this install resolves (null = none configured: nothing runs).
export async function dispatchForChat(text: string, chatId: string, ownerChatId: string | null, now = Date.now()): Promise<DispatchResult> {
  const parsed = parseCommand(text)
  if (!parsed || !resolveCommand(parsed.name, parsed.args)) {
    return { handled: false, outcome: parsed ? 'unknown' : 'not-command', replies: [] }
  }
  if (!ownerChatId || chatId !== ownerChatId) {
    return { handled: false, outcome: 'not-owner', replies: [] }
  }
  const replies: string[] = []
  const outcome = await dispatchCommand(text, {
    reply: async (t: string) => { replies.push(t) },
    ownerId: Number(ownerChatId),
    now,
  })
  return { handled: true, outcome, replies }
}

export async function tryHandleCommands(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, auth } = ctx
  if (path === '/api/commands/menu' && method === 'GET') {
    json(res, { commands: botCommandList() })
    return true
  }
  if (path !== '/api/commands/dispatch') return false
  if (method !== 'POST') {
    json(res, { error: 'Method not allowed' }, 405)
    return true
  }
  let body: unknown
  try {
    body = JSON.parse((await readBody(req, { maxBytes: 64 * 1024 })).toString())
  } catch {
    json(res, { error: 'invalid JSON body' }, 400)
    return true
  }
  const refused = agentIdentityOf(req, body, auth)
  if (refused) {
    logger.warn({ refused }, 'commands: dispatch refused, the call carries an agent identity')
    json(res, { error: `agent identity refused (${refused})` }, 403)
    return true
  }
  const b = (body ?? {}) as Record<string, unknown>
  const text = typeof b.text === 'string' ? b.text : ''
  const chatId = typeof b.chatId === 'string' || typeof b.chatId === 'number' ? String(b.chatId) : ''
  if (!text || !chatId) {
    json(res, { error: 'text and chatId are required' }, 400)
    return true
  }
  const result = await dispatchForChat(text, chatId, resolveOwnerChatId())
  if (result.handled) logger.info({ command: parseCommand(text)?.name, outcome: result.outcome }, 'commands: dispatched')
  else if (result.outcome === 'not-owner') logger.warn({ chatId }, 'commands: registry command from a non-owner chat, passed to the model')
  json(res, result)
  return true
}
