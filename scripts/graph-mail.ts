#!/usr/bin/env tsx
// Thin CLI over src/graph-mail.ts, for operating the scoped M365 mailbox by
// hand (smoke test, quick read, one-off send) without writing code.
//
//   tsx scripts/graph-mail.ts verify
//   tsx scripts/graph-mail.ts list [--unread] [--top N] [--folder inbox|sentitems] [--since 2h|30m|3d|ISO]
//   tsx scripts/graph-mail.ts read --id <id from list> [--html]
//   tsx scripts/graph-mail.ts send --to a@b.hu[,c@d.hu] --subject "..." --body "..." [--cc ...] [--html] [--attach FILE]
//                                  [--signature] [--reply-to <id>]
//
// --signature: --body is plain text; it is sent as the house HTML letter with
// the graphic signature (store/email-signature: signature.html,
// bekezdes-sablon.html, and optionally images.json listing the inline images).
// --reply-to: answer that message of this mailbox in its own conversation
// (Graph /reply). The original is read first (src/mail-reply.ts): every --to
// and --cc must be one of its participants, its Reply-To (else From) must be
// among them, and the subject is the one Graph sets, "RE: <original subject>".
// That is the subject the gates read and the approval binds; --subject may be
// left out, and a different one is refused.
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
// (recipients, subject + body, render mode, the attachment's sha256 and, with
// --signature, the sha256 of every signature file it puts in the letter) before
// any network call: the email_send level (level 1 refuses, level 2 needs the
// approval of THIS envelope or a live standing recipient, level 3 sends) and,
// when the install turned it on, the verified-recipient ledger. A refusal is
// exit 3 with the reason on stderr. `--flag value` and `--flag=value` are both
// read.

// Only the three calls every subcommand shares are imported statically. read
// (getMessage) and --signature (graph-client, mail-html) load their modules
// on use, so a plain send needs nothing beyond sendMail -- which is also what
// the shipped sender-check test's stub transport provides.
import { listMessages, sendMail, verifyAccess, type InlineImage } from '../src/graph-mail.js'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { basename, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const SIGNATURE_DIR = resolve(REPO_ROOT, 'store/email-signature')
// The address the signature file was written for (MAIL_SIGNATURE_OLD_ADDRESS); replaced by the M365 mailbox. Empty: no swap.
const SIGNATURE_OLD_ADDRESS = process.env.MAIL_SIGNATURE_OLD_ADDRESS ?? ''

/**
 * --signature: the plain-text --body becomes the house HTML letter with the
 * graphic signature and the inline images its images.json lists. The text itself still comes
 * from the command line, so the outgoing gates read the same words that go out.
 *
 * The signature files are read ONCE, before the sender check, and the letter is
 * built from those same bytes: their sha256 goes into the checked envelope, so
 * an approval binds the signature that was approved, and a file changed between
 * the approval and the send (or between the check and the read) refuses.
 */
type SignatureParts = {
  template: string
  signatureHtml: string
  images: Array<{ cid: string; file: string; contentType: string; bytes: Buffer }>
  /** What the sender check binds: each file's sha256, and the address swap. */
  digest: { files: Array<{ name: string; sha256: string }>; old_address: string }
}

async function loadSignature(): Promise<SignatureParts> {
  const { parseSignatureImages } = await import('../src/mail-html.js')
  const read = (name: string) => readFileSync(resolve(SIGNATURE_DIR, name))
  const template = read('bekezdes-sablon.html')
  const signatureHtml = read('signature.html')
  // The install's image list (cid -> file), optional; its bytes are bound too.
  let manifest: Buffer | null = null
  try {
    manifest = read('images.json')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  const images = parseSignatureImages(manifest ? manifest.toString('utf-8') : null).map((img) => ({
    ...img,
    bytes: read(img.file),
  }))
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
  return {
    template: template.toString('utf-8'),
    signatureHtml: signatureHtml.toString('utf-8'),
    images,
    digest: {
      files: [
        { name: 'bekezdes-sablon.html', sha256: sha(template) },
        { name: 'signature.html', sha256: sha(signatureHtml) },
        ...(manifest ? [{ name: 'images.json', sha256: sha(manifest) }] : []),
        ...images.map((img) => ({ name: img.file, sha256: sha(img.bytes) })),
      ],
      old_address: SIGNATURE_OLD_ADDRESS,
    },
  }
}

async function signedLetter(text: string, parts: SignatureParts): Promise<{ html: string; inlineImages: InlineImage[] }> {
  const { loadCredentials } = await import('../src/graph-client.js')
  const { renderLetterHtml } = await import('../src/mail-html.js')
  const html = renderLetterHtml(
    text,
    parts.template,
    parts.signatureHtml,
    SIGNATURE_OLD_ADDRESS,
    loadCredentials('graph-mail').mailbox,
  )
  const inlineImages = parts.images.map((img) => ({
    cid: img.cid,
    name: img.file,
    contentType: img.contentType,
    contentBytes: img.bytes.toString('base64'),
  }))
  return { html, inlineImages }
}

/** --since 2h / 30m / 3d, or an ISO timestamp. */
function parseSince(raw: string): string {
  const m = /^(\d+)([mhd])$/.exec(raw)
  if (m) {
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 'm' | 'h' | 'd']
    return new Date(Date.now() - Number(m[1]) * unit).toISOString()
  }
  const t = new Date(raw)
  if (Number.isNaN(t.getTime())) throw new Error(`graph-mail: cannot read --since ${raw} (use 2h, 30m, 3d or ISO)`)
  return t.toISOString()
}

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
        since: flag('since') ? parseSince(flag('since')!) : undefined,
      })
      if (msgs.length === 0) {
        console.log('(no messages)')
        break
      }
      for (const m of msgs) {
        const from = m.from?.emailAddress?.address ?? '?'
        const when = m.receivedDateTime ?? ''
        const unread = m.isRead === false ? '● ' : '  '
        const clip = m.hasAttachments ? ' [melleklet]' : ''
        console.log(
          `${unread}${when}  ${from}${clip}\n    ${m.subject ?? '(no subject)'}\n    ${m.bodyPreview ?? ''}\n    id: ${m.id}\n`,
        )
      }
      break
    }
    case 'read': {
      const id = flag('id')
      if (!id) {
        console.error('read requires --id (from list)')
        process.exit(2)
      }
      const { getMessage } = await import('../src/graph-mail.js')
      const m = await getMessage(id, !has('html'))
      const addr = (xs?: Array<{ emailAddress?: { address?: string } }>) =>
        (xs ?? []).map((x) => x.emailAddress?.address ?? '?').join(', ')
      const header = [
        `From: ${m.from?.emailAddress?.name ?? ''} <${m.from?.emailAddress?.address ?? '?'}>`,
        `To: ${addr(m.toRecipients)}`,
        ...(m.ccRecipients?.length ? [`Cc: ${addr(m.ccRecipients)}`] : []),
        `Date: ${m.receivedDateTime ?? ''}`,
        `Subject: ${m.subject ?? ''}`,
        `Id: ${m.id}`,
        `Message-ID: ${m.internetMessageId ?? ''}`,
        `Conversation: ${m.conversationId ?? ''}`,
        ...(m.hasAttachments ? ['Attachments: yes'] : []),
      ]
      console.log(`${header.join('\n')}\n\n${m.body?.content ?? ''}`)
      break
    }
    case 'send': {
      const attachPath = flag('attach')
      const attachments = attachPath ? [readAttachment(attachPath)] : undefined
      const to = flag('to')
      const replyToId = flag('reply-to')
      const typedSubject = flag('subject')
      const body = flag('body')
      if (!to || (!typedSubject && !replyToId) || body === undefined) {
        console.error('send requires --to, --subject and --body (--subject may be left out with --reply-to)')
        process.exit(2)
      }
      if (has('signature') && has('html')) {
        console.error('--signature builds the HTML from a plain-text --body; do not combine it with --html')
        process.exit(2)
      }
      const signature = has('signature') ? await loadSignature() : undefined
      const toList = to.split(',').map((a) => a.trim()).filter(Boolean)
      const ccRaw = flag('cc')
      const ccList = ccRaw?.split(',').map((a) => a.trim()).filter(Boolean) ?? []
      // A threaded reply: bounded by the original, before the check and the send.
      let subject = typedSubject ?? ''
      if (replyToId) {
        const { getMessage } = await import('../src/graph-mail.js')
        const { checkReply, replySubject } = await import('../src/mail-reply.js')
        const orig = await getMessage(replyToId, true)
        const why = checkReply(orig, toList, ccList, typedSubject)
        if (why) {
          console.error(`graph-mail: KULDES MEGTAGADVA -- ${why}`)
          process.exit(3)
        }
        subject = replySubject(orig)
      }
      // The check reads the plain words the caller typed (--body), as the
      // outgoing gates do; the render mode names how they go out, so an
      // approval of a plain letter does not cover the signed HTML one, and a
      // threaded reply names its original so the approval binds to it too.
      senderCheckOrExit({
        to: toList,
        cc: ccList,
        text: `${subject}\n${body}`,
        render: has('signature') ? '--signature' : has('html') ? '--html' : '',
        ...(replyToId ? { reply_to: ['graph', replyToId] } : {}),
        ...(signature ? { signature: signature.digest } : {}),
        attachments: (attachments ?? []).map((a) => {
          const bytes = Buffer.from(a.contentBytes, 'base64')
          return { name: a.name, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }
        }),
        raw_to: to,
        raw_cc: ccRaw ?? null,
        explicit_to: [to],
        explicit_cc: ccRaw ? [ccRaw] : [],
      })
      const signed = signature ? await signedLetter(body, signature) : undefined
      await sendMail({
        attachments,
        to: toList,
        subject,
        body: signed ? signed.html : body,
        cc: ccList.length ? ccList : undefined,
        contentType: signed || has('html') ? 'HTML' : 'Text',
        inlineImages: signed?.inlineImages,
        replyToId,
      })
      console.log(replyToId ? `replied to ${replyToId} -> ${to}` : `sent to ${to}`)
      break
    }
    default:
      console.error('usage: graph-mail.ts <verify|list|read|send> [options] (see file header)')
      process.exit(2)
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
