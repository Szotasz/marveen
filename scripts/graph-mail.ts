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
