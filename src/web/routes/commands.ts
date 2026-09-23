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
import { onMainTurnEnded } from '../main-model.js'
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

// The hook's own identity claim, not an "agent identity" in the sense
// agentIdentityOf() above refuses -- that check is about a caller
// impersonating a fleet agent; this one is the same hook (main or
// sub-agent) telling the server which session it runs in, so a WRITE
// resolved for a sub-agent can be refused server-side (see dispatchForChat).
// Missing/non-boolean defaults to true (older hook builds that predate this
// field, or a manual call): the strict behaviour is to trust the caller,
// not to widen the refusal to callers that never claimed anything.
export function mainSessionFromBody(b: Record<string, unknown>): boolean {
  return typeof b.mainSession === 'boolean' ? b.mainSession : true
}

export interface DispatchResult {
  handled: boolean
  outcome: DispatchOutcome | 'not-owner' | 'sub-agent-write-refused' | 'deferred' | 'forwarded-refused'
  replies: string[]
}

// The route's decision, separated from HTTP for the tests. `ownerChatId` is
// the owner chat this install resolves (null = none configured: nothing runs).
// `mainSession` is the caller's own identity claim (the hook knows which
// session it runs in; the server does not) -- a WRITE resolved for a
// non-main caller is refused HERE, one line, without ever running it. A
// sub-agent's READ commands go through unchanged (ELSOKOR922 fix-forward
// (3): the old gate lived in the Python hook and blocked every non-/usage
// command for a sub-agent, reads included, sending them to the model at
// full token cost instead of the free hook round trip).
//
// `deferWrites`: the hook's first call. A runnable WRITE is not run now but
// answered `deferred` -- while the UserPromptSubmit hook is still running,
// Claude Code already shows the owner's own (about to be blocked) turn as
// live (spinner + `esc to interrupt`), so every write's quiet gate read its
// OWN turn as "pane-busy" and refused, every time (measured on the test bot,
// ELSOKOR922 Phase 7). The hook then re-sends the command once, from a
// detached watcher that wakes on the hook process's exit.
// `forwarded`: the Telegram message was forwarded (the plugin patch marks it,
// scripts/patch-telegram-plugin.py). The owner forwarding someone else's
// "/model opus keep" must not run it (ELSOKOR922 spec 5.; measured on the
// test bot before the patch: a forwarded /status ran).
export const FORWARDED_REPLY = (name: string) => `Továbbított üzenetből nem futtatok parancsot: /${name}. Ha kell, írd be magad.`

export async function dispatchForChat(text: string, chatId: string, ownerChatId: string | null, now = Date.now(), mainSession = true, deferWrites = false, forwarded = false): Promise<DispatchResult> {
  const parsed = parseCommand(text)
  const spec = parsed ? resolveCommand(parsed.name, parsed.args) : null
  if (!parsed || !spec) {
    return { handled: false, outcome: parsed ? 'unknown' : 'not-command', replies: [] }
  }
  if (!ownerChatId || chatId !== ownerChatId) {
    return { handled: false, outcome: 'not-owner', replies: [] }
  }
  if (forwarded) {
    return { handled: true, outcome: 'forwarded-refused', replies: [FORWARDED_REPLY(spec.name)] }
  }
  if (spec.kind === 'write' && !mainSession) {
    return {
      handled: true,
      outcome: 'sub-agent-write-refused',
      replies: [`/${spec.name} csak a fő chatből írható; ez a parancs mást állítana, és ez a session nem a fő session.`],
    }
  }
  if (spec.kind === 'write' && !spec.planned && deferWrites) {
    return { handled: true, outcome: 'deferred', replies: [] }
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
  // The main session's Stop hook (marveen-commands.py --stop): a turn ended.
  // Only acts when a model hold is past its expiry (the session was busy
  // then); it arms one revert retry -- nothing else reads this.
  if (path === '/api/commands/turn-ended' && method === 'POST') {
    json(res, { armed: onMainTurnEnded(Date.now()) })
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
  const mainSession = mainSessionFromBody(b)
  if (!text || !chatId) {
    json(res, { error: 'text and chatId are required' }, 400)
    return true
  }
  const deferWrites = b.deferWrites === true
  const result = await dispatchForChat(text, chatId, resolveOwnerChatId(), Date.now(), mainSession, deferWrites, b.forwarded === true)
  if (result.handled) logger.info({ command: parseCommand(text)?.name, outcome: result.outcome }, 'commands: dispatched')
  else if (result.outcome === 'not-owner') logger.warn({ chatId }, 'commands: registry command from a non-owner chat, passed to the model')
  json(res, result)
  return true
}
