#!/usr/bin/env tsx
// Thin CLI over src/graph-mail.ts, for operating the scoped M365 mailbox by
// hand (smoke test, quick read, one-off send) without writing code.
//
//   tsx scripts/graph-mail.ts verify
//   tsx scripts/graph-mail.ts list [--unread] [--top N] [--folder inbox|sentitems]
//   tsx scripts/graph-mail.ts send --to a@b.hu[,c@d.hu] --subject "..." --body "..." [--cc ...] [--html] [--attach FILE]
//
// --attach does NOT take an arbitrary path. The file must sit inside the
// attachment drop directory (GRAPH_MAIL_ATTACH_DIR, default
// <repo>/store/mail-attachments); anything outside it is refused. Putting a
// file there is the deliberate act that authorises sending it.
//
// Credentials come from the gitignored marveen-mail-ugyfelkod file (override
// with MARVEEN_MAIL_CREDS). Send is intentionally CLI-explicit; the sub-agent
// email-send-gate hook still applies to any programmatic use elsewhere.
//
// `send` runs scripts/hooks/sender_check.py on the exact letter it delivers
// (recipients, subject + body, render mode, the attachment's sha256) before
// any network call: the email_send level (level 1 refuses, level 2 needs the
// approval of THIS envelope or a live standing recipient, level 3 sends) and,
// when the install turned it on, the verified-recipient ledger. A refusal is
// exit 3 with the reason on stderr. `--flag value` and `--flag=value` are both
// read.

import { listMessages, sendMail, verifyAccess } from '../src/graph-mail.js'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { basename, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

/**
 * Resolve --attach against the attachment drop directory and refuse anything
 * outside it. Symlinks are resolved first (realpath on both sides), so a link
 * planted inside the directory cannot reach out of it, and the separator on
 * the prefix check keeps a sibling like `<dir>-evil` from matching.
 */
function readAttachment(rawPath: string): { name: string; contentBytes: string } {
  const dir = realpathSync(
    resolve(process.env.GRAPH_MAIL_ATTACH_DIR ?? resolve(REPO_ROOT, 'store/mail-attachments')),
  )
  let file: string
  try {
    file = realpathSync(resolve(dir, rawPath))
  } catch {
    throw new Error(`graph-mail: attachment not found: ${rawPath}`)
  }
  if (file !== dir && !file.startsWith(dir + sep)) {
    throw new Error(
      `graph-mail: refusing to attach a file outside the drop directory.\n` +
        `  requested: ${file}\n  allowed:   ${dir}\n` +
        'Copy the file into the drop directory (or set GRAPH_MAIL_ATTACH_DIR) and retry.',
    )
  }
  if (!statSync(file).isFile()) {
    throw new Error(`graph-mail: attachment is not a regular file: ${file}`)
  }
  return { name: basename(file), contentBytes: readFileSync(file).toString('base64') }
}

// The FIRST `--name value` or `--name=value`. The `=` form used to be ignored,
// while the main agent's hook reads it: `--cc=x@example.com` was anchored there and
// silently dropped here.
function flag(name: string): string | undefined {
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}`) return args[i + 1]
    if (args[i].startsWith(`--${name}=`)) return args[i].slice(name.length + 3)
  }
  return undefined
}
function has(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

// The interpreters the sender-side check may run under, by ABSOLUTE path (the
// Linux system python first, then the two macOS Homebrew prefixes), never
// resolved from PATH, and in isolated mode (-I) with every PYTHON* variable
// stripped: otherwise a `PATH=/x` or `PYTHONPATH=/x` prefix in front of the
// send could swap in a "check" that always passes.
const TRUSTED_PYTHONS = ['/usr/bin/python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3']
function trustedPython(): string | null {
  for (const p of TRUSTED_PYTHONS) {
    try {
      if (statSync(p).isFile()) return p
    } catch { /* not there, try the next one */ }
  }
  return null
}
function envWithoutPython(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.toUpperCase().startsWith('PYTHON')) env[k] = v
  }
  return env
}

/** Run scripts/hooks/sender_check.py on the letter; exit 3 unless it says send. */
function senderCheckOrExit(letter: Record<string, unknown>): void {
  const python = trustedPython()
  if (!python) {
    console.error('graph-mail: KULDES MEGTAGADVA -- nincs megbizhato python3 a kuldo-oldali ellenorzeshez ' +
      `(keresve: ${TRUSTED_PYTHONS.join(', ')}); a PATH-bol nem keresunk, fail-closed.`)
    process.exit(3)
  }
  const r = spawnSync(python, ['-I', resolve(REPO_ROOT, 'scripts', 'hooks', 'sender_check.py')],
    { input: JSON.stringify(letter), encoding: 'utf-8', timeout: 60_000, env: envWithoutPython() })
  const said = (r.stderr || '').trim()
  if (r.status !== 0) {
    console.error(`graph-mail: KULDES MEGTAGADVA -- ${said || (r.error ? String(r.error) : `exit ${r.status}`)}`)
    process.exit(3)
  }
  if (said) console.error(said)
}

// --- Daily-log entry after a successful send (card f90928e3, part B) --------
// One line in agent brainy's daily log: who got a letter, about what, when.
// Never the body, the cc/bcc list, or an attachment (or its name): the
// approval payload is erased on purpose when it is consumed, and this entry
// must not bring that content back. It is strictly best-effort and runs only
// AFTER sendMail returned: nothing in here can refuse, delay beyond its short
// timeout, or change the exit code or stdout of the send.
const DAILY_LOG_AGENT = 'brainy'
const DAILY_LOG_TIMEOUT_MS = 3000
const SUBJECT_MAX = 80

function truncateSubject(subject: string): string {
  const chars = Array.from(subject.replace(/\s+/g, ' ').trim())
  return chars.length <= SUBJECT_MAX ? chars.join('') : chars.slice(0, SUBJECT_MAX - 1).join('') + '…'
}

/** Local Europe/Budapest time, "YYYY-MM-DD HH:MM". */
function budapestNow(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Budapest', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(now).replace(',', '')
}

// Env first, then the install .env next to this script's checkout (the same
// order the hooks use), never an install-specific hardcode.
function installSetting(key: string, fallback: string): string {
  const fromEnv = process.env[key]?.trim()
  if (fromEnv) return fromEnv
  try {
    for (const line of readFileSync(resolve(REPO_ROOT, '.env'), 'utf-8').split('\n')) {
      if (line.startsWith(`${key}=`)) {
        const v = line.slice(key.length + 1).trim().replace(/^["']|["']$/g, '')
        if (v) return v
      }
    }
  } catch { /* no .env: the default stands */ }
  return fallback
}

function sentEntry(to: string[], subject: string): string {
  return `[Levél elküldve] ${to.join(', ')}, tárgy: ${truncateSubject(subject)}, ${budapestNow()}`
}

/** An error whose message WE wrote: the only exception text that may reach stderr. */
class DailyLogError extends Error {}

// The dashboard token is 64 hex chars when generated (src/web/dashboard-auth.ts);
// DASHBOARD_TOKEN may be any operator string, so allow the usual token alphabet
// and nothing that could break out of a header (CR, LF, NUL, spaces, non-ASCII).
const DASHBOARD_TOKEN_RE = /^[A-Za-z0-9._~+/=-]+$/
// The live CDP browser and its sibling: never a dashboard, never touched
// (same list as scripts/hooks/email-draft-log.py).
const FORBIDDEN_PORTS = new Set([18800, 18899])

/** The only text that may describe a failure: our own message, or the bare type name. */
function describeDailyLogFailure(err: unknown): string {
  if (err instanceof DailyLogError) return err.message
  const name = err instanceof Error ? (err.name || '') : ''
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout'
  const type = err instanceof Error ? (Object.getPrototypeOf(err)?.constructor?.name ?? '') : ''
  return /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(type) ? type : 'Error'
}

/** Never throws and never exits; any failure is one line on stderr that never
 * carries foreign exception text (a header-validation error can echo the token). */
async function postSentEntry(to: string[], subject: string): Promise<void> {
  try {
    let token: string
    try {
      token = readFileSync(resolve(REPO_ROOT, 'store', '.dashboard-token'), 'utf-8').trim()
    } catch {
      throw new DailyLogError('cannot read dashboard token file')
    }
    if (!token) throw new DailyLogError('empty dashboard token')
    if (!DASHBOARD_TOKEN_RE.test(token)) throw new DailyLogError('invalid dashboard token format')
    const port = Number(installSetting('WEB_PORT', '3420'))
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new DailyLogError('bad WEB_PORT')
    if (FORBIDDEN_PORTS.has(port)) throw new DailyLogError(`refused WEB_PORT ${port}`)
    const res = await fetch(`http://127.0.0.1:${port}/api/daily-log`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: DAILY_LOG_AGENT, content: sentEntry(to, subject) }),
      signal: AbortSignal.timeout(DAILY_LOG_TIMEOUT_MS),
    })
    if (!res.ok) throw new DailyLogError(`HTTP ${res.status}`)
  } catch (err) {
    console.error(`graph-mail: a levél elment, de a napló-bejegyzés nem készült el (${describeDailyLogFailure(err)})`)
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2]
  switch (cmd) {
    case 'verify': {
      const r = await verifyAccess()
      console.log(`OK -- reachable mailbox: ${r.mailbox}`)
      break
    }
    case 'list': {
      const msgs = await listMessages({
        top: flag('top') ? Number(flag('top')) : undefined,
        folder: flag('folder'),
        unreadOnly: has('unread'),
      })
      if (msgs.length === 0) {
        console.log('(no messages)')
        break
      }
      for (const m of msgs) {
        const from = m.from?.emailAddress?.address ?? '?'
        const when = m.receivedDateTime ?? ''
        const unread = m.isRead === false ? '● ' : '  '
        console.log(`${unread}${when}  ${from}\n    ${m.subject ?? '(no subject)'}\n    ${m.bodyPreview ?? ''}\n`)
      }
      break
    }
    case 'send': {
      const attachPath = flag('attach')
      const attachments = attachPath ? [readAttachment(attachPath)] : undefined
      const to = flag('to')
      const subject = flag('subject')
      const body = flag('body')
      if (!to || !subject || body === undefined) {
        console.error('send requires --to, --subject and --body')
        process.exit(2)
      }
      const toList = to.split(',').map((a) => a.trim()).filter(Boolean)
      const ccRaw = flag('cc')
      const ccList = ccRaw?.split(',').map((a) => a.trim()).filter(Boolean) ?? []
      senderCheckOrExit({
        to: toList,
        cc: ccList,
        text: `${subject}\n${body}`,
        render: has('html') ? '--html' : '',
        attachments: (attachments ?? []).map((a) => {
          const bytes = Buffer.from(a.contentBytes, 'base64')
          return { name: a.name, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }
        }),
        raw_to: to,
        raw_cc: ccRaw ?? null,
        explicit_to: [to],
        explicit_cc: ccRaw ? [ccRaw] : [],
      })
      await sendMail({
        attachments,
        to: toList,
        subject,
        body,
        cc: ccList.length ? ccList : undefined,
        contentType: has('html') ? 'HTML' : 'Text',
      })
      console.log(`sent to ${to}`)
      await postSentEntry(toList, subject)
      break
    }
    default:
      console.error('usage: graph-mail.ts <verify|list|send> [options] (see file header)')
      process.exit(2)
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
