// support@ IMAP sync (CRM1MAILSYNC922): the dump is produced by
// scripts/crm/support-imap-dump.py (read-only, BODY.PEEK, password fetched
// inside that process); this side normalises the JSON lines and upserts.
// INBOX -> 'in', INBOX.Sent -> 'out'. A Sent copy without a Message-ID
// (measured 2026-09-22: every one of them today) is stored under a synthetic
// id with NO thread key, and the API says so; it is not threadable until
// send.py writes a Message-ID before sending.
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { PROJECT_ROOT } from '../config.js'
import { upsertMail, normalizeMessageId, parseReferences, htmlToText, type NormalizedMail } from './mail-model.js'
import type { SyncStats } from './gmail-sync.js'

export interface ImapDumpLine {
  mailbox: string
  uid: string
  message_id: string | null
  in_reply_to: string | null
  references: string | null
  from: string | null
  to: string[]
  cc: string[]
  subject: string | null
  date_epoch: number | null
  x_forwarded_to?: string | null
  body_text: string | null
  body_html?: string | null
}

export function normalizeImap(line: ImapDumpLine): NormalizedMail {
  const sent = /sent/i.test(line.mailbox)
  return {
    source: 'imap_support',
    source_uid: `${line.mailbox}:${line.uid}`,
    rfc_message_id: normalizeMessageId(line.message_id),
    provider_thread_id: null,
    direction: sent ? 'out' : 'in',
    from_addr: line.from ? line.from.toLowerCase() : null,
    to_addrs: (line.to ?? []).map((a) => a.toLowerCase()),
    cc_addrs: (line.cc ?? []).map((a) => a.toLowerCase()),
    subject: line.subject,
    sent_at: line.date_epoch ?? null,
    body_text: line.body_text ?? (line.body_html ? htmlToText(line.body_html) : null),
    in_reply_to: normalizeMessageId(line.in_reply_to),
    references: parseReferences(line.references),
  }
}

export interface ImapSyncResult extends SyncStats { maxUid: Record<string, number> }

/** Pure: apply dump lines to the DB. */
export function applyImapLines(db: Database.Database, lines: ImapDumpLine[], now: number): ImapSyncResult {
  const stats: ImapSyncResult = { fetched: 0, inserted: 0, updated: 0, unthreaded: 0, maxUid: {} }
  const tx = db.transaction(() => {
    for (const line of lines) {
      const r = upsertMail(db, normalizeImap(line), now)
      stats.fetched++
      if (r.inserted) stats.inserted++
      else stats.updated++
      if (!r.threadKey) stats.unthreaded++
      const uid = Number(line.uid)
      if (Number.isFinite(uid)) stats.maxUid[line.mailbox] = Math.max(stats.maxUid[line.mailbox] ?? 0, uid)
    }
  })
  tx()
  return stats
}

export function parseDumpOutput(stdout: string): ImapDumpLine[] {
  const out: ImapDumpLine[] = []
  for (const raw of stdout.split('\n')) {
    const l = raw.trim()
    if (!l.startsWith('{')) continue
    out.push(JSON.parse(l) as ImapDumpLine)
  }
  return out
}

export interface ImapDumpOutcome { lines: ImapDumpLine[]; stderr: string; code: number; killed: boolean }

/** execFile timeout for the dumper. Measured 2026-09-22: ~175 ms per letter, so a first run of
 *  --limit 500 over two mailboxes is ~175 s; the old 120 s cut it and the cut looked clean. */
export function resolveDumpTimeoutMs(raw: string | undefined): number {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 600_000
}
export const IMAP_DUMP_TIMEOUT_MS = resolveDumpTimeoutMs(process.env.CRM_IMAP_DUMP_TIMEOUT_MS)

/** Runs the dumper. The password never appears here: the child reads it from the vault.
 *  A killed child (timeout) comes back as killed=true with whatever stdout it produced. */
export function runImapDump(mailboxes: string[], sinceUid: Record<string, number>, limit = 500, timeoutMs = IMAP_DUMP_TIMEOUT_MS): Promise<ImapDumpOutcome> {
  const script = join(PROJECT_ROOT, 'scripts', 'crm', 'support-imap-dump.py')
  const args = [script]
  for (const mb of mailboxes) args.push('--mailbox', mb)
  for (const [mb, uid] of Object.entries(sinceUid)) args.push('--since', `${mb}=${uid}`)
  args.push('--limit', String(limit))
  return new Promise((resolve) => {
    execFile('python3', args, { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs }, (err, stdout, stderr) => {
      const killed = Boolean(err && (err as { killed?: boolean }).killed)
      const code = err && typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : err ? 1 : 0
      resolve({ lines: code === 0 || stdout ? parseDumpOutput(String(stdout)) : [], stderr: String(stderr), code, killed })
    })
  })
}

export interface ImapSyncState { mailboxes: string[]; last_uid: Record<string, number>; last_run: number | null; last_stats: SyncStats | null; last_error: string | null }

/** Pure: apply a dump outcome to the store AND the state. The rule (Samu review on #1475): a cut
 *  or failed dump still APPLIES the lines it produced (UIDs only grow, nothing is lost), but the
 *  status must carry the failure. last_error is null ONLY for a child that exited 0 and was not
 *  killed; anything else is rc 4 even when lines were applied. */
export function applyImapDump(db: Database.Database, state: ImapSyncState, dump: ImapDumpOutcome, now: number, timeoutMs = IMAP_DUMP_TIMEOUT_MS): { rc: 0 | 4; out: Record<string, unknown> } {
  const stats = applyImapLines(db, dump.lines, now)
  for (const [mb, uid] of Object.entries(stats.maxUid)) state.last_uid[mb] = Math.max(state.last_uid[mb] ?? 0, uid)
  state.last_run = now
  state.last_stats = stats
  const clean = dump.code === 0 && !dump.killed
  if (clean) {
    state.last_error = null
    return { rc: 0, out: { ...stats } }
  }
  const why = dump.killed ? `dump killed (timeout ${timeoutMs} ms)` : (dump.stderr.trim().slice(0, 300) || `exit ${dump.code}`)
  state.last_error = `${why}; ${dump.lines.length} lines applied, the run is PARTIAL`
  return { rc: 4, out: { ...stats, error: state.last_error, partial: true } }
}
