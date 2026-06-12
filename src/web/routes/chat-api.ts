// Per-user chat API (/chat-api/threads*). Cookie-session auth (PR: chat-auth),
// thread machinery (PR: chat-threads). THE authorization invariant of the
// whole chat app lives here: every endpoint resolves the agent EXCLUSIVELY
// from the logged-in user's session row (getChatUser), never from the request
// path or body, and a thread belonging to another agent 404s without
// existence leakage. The admin /api/* surface is unreachable with a chat
// cookie by construction (separate namespace, separate auth).
import { randomUUID } from 'node:crypto'
import {
  CHAT_APP_ENABLED, CHAT_MAX_OPEN_THREADS_PER_AGENT,
} from '../../config.js'
import { logger } from '../../logger.js'
import { json, readBody } from '../http-helpers.js'
import { getChatUser, type ChatUser } from '../chat/chat-session.js'
import {
  createChatThread, getChatThread, listChatThreads, countOpenChatThreads,
  renameChatThread, touchChatThread, type ChatThread,
} from '../../db.js'
import {
  startThreadSession, suspendThread, closeThread, sendPromptToThread,
  isThreadRunning, transcriptPathForThread,
} from '../chat/thread-process.js'
import { readThreadTimeline, deriveThreadTitle, DEFAULT_TIMELINE_LIMIT } from '../chat/thread-transcript.js'
import type { RouteContext } from './types.js'

const MAX_BODY_BYTES = 256 * 1024
const MAX_TITLE_LEN = 120
const MAX_MESSAGE_LEN = 64 * 1024

function threadView(t: ChatThread, agentName: string): Record<string, unknown> {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    running: t.status === 'open' && isThreadRunning(agentName, t.id),
    created_at: t.created_at,
    last_activity_at: t.last_activity_at,
  }
}

// Scope guard: a thread id from the URL is only visible when it belongs to
// the session user's own agent. Foreign and nonexistent ids are the same 404.
function ownedThread(user: ChatUser, threadId: string): ChatThread | null {
  const t = getChatThread(threadId)
  if (!t || t.agent_id !== user.agentId) return null
  return t
}

export async function tryHandleChatApi(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx
  if (!path.startsWith('/chat-api/threads')) return false

  if (!CHAT_APP_ENABLED) {
    json(res, { error: 'Chat app is not enabled' }, 404)
    return true
  }

  const user = getChatUser(req)
  if (!user) {
    json(res, { error: 'Unauthorized' }, 401)
    return true
  }

  if (path === '/chat-api/threads' && method === 'GET') {
    const includeClosed = url.searchParams.get('include_closed') === '1'
    const threads = listChatThreads(user.agentId, { includeClosed })
    json(res, {
      agent: user.agentId,
      open_count: countOpenChatThreads(user.agentId),
      max_open: CHAT_MAX_OPEN_THREADS_PER_AGENT,
      threads: threads.map(t => threadView(t, user.agentId)),
    })
    return true
  }

  if (path === '/chat-api/threads' && method === 'POST') {
    if (countOpenChatThreads(user.agentId) >= CHAT_MAX_OPEN_THREADS_PER_AGENT) {
      json(res, { error: `Elérted a nyitott szálak felső határát (${CHAT_MAX_OPEN_THREADS_PER_AGENT}). Zárj le egyet, mielőtt újat nyitsz.` }, 409)
      return true
    }
    let title = ''
    try {
      const body = await readBody(req, { maxBytes: MAX_BODY_BYTES })
      if (body.length) {
        const parsed = JSON.parse(body.toString()) as { title?: string }
        if (typeof parsed.title === 'string') title = parsed.title.trim().slice(0, MAX_TITLE_LEN)
      }
    } catch { /* empty/invalid body -> untitled thread */ }

    const thread = createChatThread(user.agentId, randomUUID(), title)
    const started = startThreadSession(user.agentId, thread)
    if (!started.ok) {
      // Keep the row reopenable instead of vanishing the user's thread.
      suspendThread(user.agentId, thread.id)
      logger.error({ agent: user.agentId, threadId: thread.id, error: started.error }, 'Thread spawn failed at creation')
      json(res, { error: started.error ?? 'A szál indítása nem sikerült', thread: threadView(getChatThread(thread.id)!, user.agentId) }, 502)
      return true
    }
    logger.info({ email: user.email, agent: user.agentId, threadId: thread.id }, 'Chat thread created')
    json(res, { thread: threadView(getChatThread(thread.id)!, user.agentId) }, 201)
    return true
  }

  const threadMatch = path.match(/^\/chat-api\/threads\/([0-9a-f-]{36})(\/messages|\/reopen)?$/)
  if (!threadMatch) {
    json(res, { error: 'Not found' }, 404)
    return true
  }
  const thread = ownedThread(user, threadMatch[1])
  if (!thread) {
    json(res, { error: 'Not found' }, 404)
    return true
  }
  const sub = threadMatch[2] ?? ''

  if (sub === '' && method === 'PATCH') {
    try {
      const body = JSON.parse((await readBody(req, { maxBytes: MAX_BODY_BYTES })).toString()) as { title?: string }
      const title = typeof body.title === 'string' ? body.title.trim().slice(0, MAX_TITLE_LEN) : ''
      if (!title) {
        json(res, { error: 'title is required' }, 400)
        return true
      }
      renameChatThread(thread.id, title)
      json(res, { thread: threadView(getChatThread(thread.id)!, user.agentId) })
    } catch {
      json(res, { error: 'Invalid JSON body' }, 400)
    }
    return true
  }

  if (sub === '' && method === 'DELETE') {
    closeThread(user.agentId, thread.id)
    logger.info({ email: user.email, threadId: thread.id }, 'Chat thread closed')
    json(res, { ok: true })
    return true
  }

  if (sub === '/reopen' && method === 'POST') {
    if (thread.status === 'open' && isThreadRunning(user.agentId, thread.id)) {
      json(res, { thread: threadView(thread, user.agentId) })
      return true
    }
    if (countOpenChatThreads(user.agentId) >= CHAT_MAX_OPEN_THREADS_PER_AGENT && thread.status !== 'open') {
      json(res, { error: `Elérted a nyitott szálak felső határát (${CHAT_MAX_OPEN_THREADS_PER_AGENT}).` }, 409)
      return true
    }
    const started = startThreadSession(user.agentId, thread)
    if (!started.ok) {
      json(res, { error: started.error ?? 'A szál újranyitása nem sikerült' }, 502)
      return true
    }
    json(res, { thread: threadView(getChatThread(thread.id)!, user.agentId) })
    return true
  }

  if (sub === '/messages' && method === 'GET') {
    const limitRaw = Number(url.searchParams.get('limit'))
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 2000) : DEFAULT_TIMELINE_LIMIT
    const entries = readThreadTimeline(transcriptPathForThread(user.agentId, thread.claude_session_id), limit)
    json(res, {
      thread: threadView(thread, user.agentId),
      count: entries.length,
      entries,
    })
    return true
  }

  if (sub === '/messages' && method === 'POST') {
    let text = ''
    try {
      const body = JSON.parse((await readBody(req, { maxBytes: MAX_BODY_BYTES })).toString()) as { text?: string }
      text = typeof body.text === 'string' ? body.text.trim() : ''
    } catch { /* handled below */ }
    if (!text) {
      json(res, { error: 'text is required' }, 400)
      return true
    }
    if (text.length > MAX_MESSAGE_LEN) {
      json(res, { error: `Az üzenet túl hosszú (max ${MAX_MESSAGE_LEN} karakter)` }, 413)
      return true
    }

    // Suspended/closed thread: auto-reopen and tell the client to retry. The
    // session needs seconds to boot, so delivering in the same request would
    // hold the connection hostage; 202 + retry keeps the API snappy.
    if (!isThreadRunning(user.agentId, thread.id)) {
      if (countOpenChatThreads(user.agentId) >= CHAT_MAX_OPEN_THREADS_PER_AGENT && thread.status !== 'open') {
        json(res, { error: `Elérted a nyitott szálak felső határát (${CHAT_MAX_OPEN_THREADS_PER_AGENT}).` }, 409)
        return true
      }
      const started = startThreadSession(user.agentId, thread)
      if (!started.ok) {
        json(res, { error: started.error ?? 'A szál indítása nem sikerült' }, 502)
        return true
      }
      json(res, { status: 'starting', retry_after_ms: 5000 }, 202)
      return true
    }

    const sent = sendPromptToThread(user.agentId, thread.id, text)
    if (!sent.ok) {
      const busy = sent.error === 'Thread is busy'
      json(res, { error: busy ? 'A szál még az előző üzeneten dolgozik' : (sent.error ?? 'Küldés sikertelen'), retry_after_ms: busy ? 2000 : undefined }, busy ? 409 : 502)
      return true
    }
    touchChatThread(thread.id)
    if (!thread.title) renameChatThread(thread.id, deriveThreadTitle(text))
    json(res, { ok: true, thread: threadView(getChatThread(thread.id)!, user.agentId) })
    return true
  }

  json(res, { error: 'Not found' }, 404)
  return true
}
