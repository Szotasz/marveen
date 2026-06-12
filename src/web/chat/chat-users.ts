// Email -> agent mapping for the chat app. Operators maintain a plain JSON
// file at store/chat-users.json:
//
//   { "alice@example.com": "alice", "bob@example.com": "bob" }
//
// The file is re-read when its mtime changes, so entries can be added or
// removed without restarting the server. An email that is missing here gets a
// 403 at login even with a valid Workspace account -- the mapping doubles as
// the allowlist.
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../../config.js'
import { logger } from '../../logger.js'

export const CHAT_USERS_PATH = join(PROJECT_ROOT, 'store', 'chat-users.json')

let cache: { mtimeMs: number; map: Map<string, string> } | null = null

function loadMap(path: string): Map<string, string> {
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown
  const map = new Map<string, string>()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('chat-users.json must be a JSON object of "email": "agent" pairs')
  }
  for (const [email, agent] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof agent !== 'string' || !agent.trim() || !email.includes('@')) {
      logger.warn({ email }, 'chat-users.json: skipping invalid entry')
      continue
    }
    map.set(email.trim().toLowerCase(), agent.trim())
  }
  return map
}

export function resolveAgentForEmail(email: string, path = CHAT_USERS_PATH): string | null {
  let mtimeMs: number
  try {
    mtimeMs = statSync(path).mtimeMs
  } catch {
    return null // no mapping file -> nobody can log in
  }
  if (!cache || cache.mtimeMs !== mtimeMs) {
    try {
      cache = { mtimeMs, map: loadMap(path) }
    } catch (err) {
      logger.error({ err, path }, 'chat-users.json unreadable; keeping previous mapping')
      if (!cache) return null
    }
  }
  return cache.map.get(email.trim().toLowerCase()) ?? null
}

// Test hook: drop the mtime cache so a rewritten temp file is re-read even
// when the filesystem mtime granularity would hide the change.
export function resetChatUsersCache(): void {
  cache = null
}
