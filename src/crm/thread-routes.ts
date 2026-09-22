// Thread read endpoints for the Szal view (CRM1MAILSYNC922). Read-only,
// framework-free like leads-routes.ts: db in, plain result out.
import { existsSync, readFileSync } from 'node:fs'
import type Database from 'better-sqlite3'

export type ApiResult = { status: number; body: Record<string, unknown> }

/** GET /api/threads?q=<address or subject fragment>&limit=N */
export function listThreads(db: Database.Database, q: string, limit = 50): ApiResult {
  const needle = q.trim()
  const lim = Math.max(1, Math.min(200, limit))
  const rows = needle
    ? db.prepare(
        `SELECT t.id, t.thread_key, t.subject, t.contact_id, t.first_at, t.last_at,
                count(m.id) AS message_count,
                sum(CASE WHEN m.direction = 'out' THEN 1 ELSE 0 END) AS out_count
           FROM threads t JOIN messages m ON m.thread_id = t.id
          WHERE m.from_addr LIKE ? OR m.to_addrs LIKE ? OR m.cc_addrs LIKE ? OR t.subject LIKE ?
          GROUP BY t.id ORDER BY t.last_at DESC LIMIT ?`,
      ).all(`%${needle}%`, `%${needle}%`, `%${needle}%`, `%${needle}%`, lim)
    : db.prepare(
        `SELECT t.id, t.thread_key, t.subject, t.contact_id, t.first_at, t.last_at,
                count(m.id) AS message_count,
                sum(CASE WHEN m.direction = 'out' THEN 1 ELSE 0 END) AS out_count
           FROM threads t LEFT JOIN messages m ON m.thread_id = t.id
          GROUP BY t.id ORDER BY t.last_at DESC LIMIT ?`,
      ).all(lim)
  const unthreaded = (db.prepare(`SELECT count(*) AS n FROM messages WHERE thread_id IS NULL`).get() as { n: number }).n
  return { status: 200, body: { threads: rows, unthreaded_messages: unthreaded } }
}

/** GET /api/threads/:id : the thread and its messages, oldest first. */
export function getThread(db: Database.Database, id: number): ApiResult {
  const t = db.prepare('SELECT id, thread_key, subject, contact_id, first_at, last_at FROM threads WHERE id = ?').get(id)
  if (!t) return { status: 404, body: { error: 'thread not found' } }
  const messages = db
    .prepare(
      `SELECT id, rfc_message_id, source, source_uid, direction, from_addr, to_addrs, cc_addrs, subject, sent_at, body_text
         FROM messages WHERE thread_id = ? ORDER BY sent_at ASC, id ASC`,
    )
    .all(id)
  return { status: 200, body: { thread: t, messages } }
}

/** GET /api/messages/unthreaded : copies that cannot be threaded (no Message-ID,
 *  no References): today every support@ Sent copy. Stated, not hidden. */
export function listUnthreaded(db: Database.Database, limit = 50): ApiResult {
  const rows = db
    .prepare(
      `SELECT id, rfc_message_id, source, source_uid, direction, from_addr, to_addrs, subject, sent_at
         FROM messages WHERE thread_id IS NULL ORDER BY sent_at DESC, id DESC LIMIT ?`,
    )
    .all(Math.max(1, Math.min(200, limit)))
  return { status: 200, body: { messages: rows, note: 'Message-ID nelkuli masolatok (ma minden support@ Sent-masolat ilyen): nem szalazhatok, amig a kuldo nem ir Message-ID-t a kuldes elott.' } }
}

/** GET /api/sync/status : the state file plus live counts. */
export function syncStatus(db: Database.Database, statePath: string): ApiResult {
  let state: unknown = null
  if (existsSync(statePath)) {
    try { state = JSON.parse(readFileSync(statePath, 'utf-8')) } catch { state = { error: 'state file unreadable' } }
  }
  const counts = {
    messages: (db.prepare('SELECT count(*) AS n FROM messages').get() as { n: number }).n,
    threads: (db.prepare('SELECT count(*) AS n FROM threads').get() as { n: number }).n,
    unthreaded: (db.prepare('SELECT count(*) AS n FROM messages WHERE thread_id IS NULL').get() as { n: number }).n,
    by_source: Object.fromEntries((db.prepare('SELECT source, count(*) AS n FROM messages GROUP BY source').all() as { source: string; n: number }[]).map((r) => [r.source, r.n])),
  }
  return { status: 200, body: { state, counts, not_visible: 'a szemelyes Gmail-fiok kuldottjei es a Resend-en kimeno aiam-levelek' } }
}
