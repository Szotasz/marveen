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

import { listMessages, sendMail, verifyAccess } from '../src/graph-mail.js'
import { readFileSync, realpathSync, statSync } from 'node:fs'
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

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 ? process.argv[i + 1] : undefined
}
function has(name: string): boolean {
  return process.argv.includes(`--${name}`)
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
      await sendMail({
        attachments,
        to: to.split(','),
        subject,
        body,
        cc: flag('cc')?.split(','),
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
