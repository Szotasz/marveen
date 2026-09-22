// CRM mail sync entry (CRM1MAILSYNC922):  node dist/crm/sync.js [--gmail-only|--imap-only]
// Runs the Gmail (assistant account) and support@ IMAP syncs into store/crm.db,
// keeps a small state file (store/crm-sync-state.json: last Gmail run, last
// IMAP uid per mailbox), prints one JSON stats line, exit 0. LEAD SOSEM
// SZINKRONBOL: the leads count is measured before and after, and a change is
// a hard failure (exit 5), not a warning.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from '../config.js'
import { initCrmDatabase } from './db.js'
import { createLiveGmailApi, syncGmail, type SyncStats } from './gmail-sync.js'
import { applyImapDump, runImapDump, type ImapSyncState } from './imap-sync.js'

export interface SyncState {
  gmail: { last_run: number | null; query: string; last_stats: SyncStats | null }
  imap: ImapSyncState
}

export const STATE_PATH = join(STORE_DIR, 'crm-sync-state.json')

export function readState(path = STATE_PATH): SyncState {
  const base: SyncState = {
    gmail: { last_run: null, query: 'newer_than:30d', last_stats: null },
    imap: { mailboxes: ['INBOX', 'INBOX.Sent'], last_uid: {}, last_run: null, last_stats: null, last_error: null },
  }
  if (!existsSync(path)) return base
  try {
    const j = JSON.parse(readFileSync(path, 'utf-8')) as Partial<SyncState>
    return { gmail: { ...base.gmail, ...(j.gmail ?? {}) }, imap: { ...base.imap, ...(j.imap ?? {}) } }
  } catch {
    return base
  }
}

export function writeState(state: SyncState, path = STATE_PATH): void {
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n')
}

async function main(): Promise<number> {
  const args = new Set(process.argv.slice(2))
  mkdirSync(STORE_DIR, { recursive: true })
  const db = initCrmDatabase(join(STORE_DIR, 'crm.db'))
  const leadsBefore = (db.prepare('SELECT count(*) AS n FROM leads').get() as { n: number }).n
  const state = readState()
  const now = Math.floor(Date.now() / 1000)
  const out: Record<string, unknown> = {}
  let rc = 0
  if (!args.has('--imap-only')) {
    try {
      const stats = await syncGmail(db, createLiveGmailApi(), { query: state.gmail.query, max: 500, now })
      state.gmail.last_run = now
      state.gmail.last_stats = stats
      out.gmail = stats
    } catch (err) {
      out.gmail = { error: (err as Error).message }
      rc = 4
    }
  }
  if (!args.has('--gmail-only')) {
    const dump = await runImapDump(state.imap.mailboxes, state.imap.last_uid)
    const r = applyImapDump(db, state.imap, dump, now)
    out.imap = r.out
    rc = rc || r.rc
  }
  const leadsAfter = (db.prepare('SELECT count(*) AS n FROM leads').get() as { n: number }).n
  out.leads = { before: leadsBefore, after: leadsAfter }
  if (leadsAfter !== leadsBefore) {
    process.stderr.write(`crm-sync: LEADS CHANGED DURING SYNC (${leadsBefore} -> ${leadsAfter}); a sync must never create leads\n`)
    rc = 5
  }
  writeState(state)
  process.stdout.write(JSON.stringify(out) + '\n')
  db.close()
  return rc
}

const invokedDirectly = process.argv[1] !== undefined && /[\\/]crm[\\/]sync\.[cm]?js$/.test(process.argv[1])
if (invokedDirectly) main().then((rc) => process.exit(rc))
