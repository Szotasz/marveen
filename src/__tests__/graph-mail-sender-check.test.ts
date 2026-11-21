import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// scripts/graph-mail.ts runs the sender-side checks itself
// (scripts/hooks/sender_check.py) on the exact letter it delivers, before any
// network call. The SHIPPED CLI and hooks are copied into a temp project whose
// src/graph-mail.ts is a stub transport that only prints what it would send,
// so no credential and no network is touched.
const ROOT = join(__dirname, '..', '..')
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx')
const CLI = 'scripts/graph-mai' + 'l.ts'

let dir = ''
function writeLevel(level: 1 | 2 | 3) {
  writeFileSync(join(dir, 'store', 'autonomy-config.json'),
    JSON.stringify({ version: 1, categories: [{ key: 'email_send', level }] }))
}
function writeEnv(lines: string[]) {
  writeFileSync(join(dir, '.env'), lines.map((l) => `${l}\n`).join(''))
}
function db() {
  return new Database(join(dir, 'store', 'claudeclaw.db'))
}
function approve(anchor: string, id = 'ap-1') {
  const d = db()
  d.prepare(`INSERT INTO approvals (id, agent_id, category, action_description, status, resolved_at, content_hash)
    VALUES (?, 'agent-a', 'email_send', 'x', 'approved', CAST(strftime('%s','now') AS INTEGER), ?)`).run(id, anchor)
  d.close()
}
function consumed(id = 'ap-1'): boolean {
  const d = db()
  const row = d.prepare('SELECT consumed_at FROM approvals WHERE id=?').get(id) as { consumed_at: number | null } | undefined
  d.close()
  return !!row?.consumed_at
}
function send(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(TSX, [join(dir, CLI), 'send', ...args], { encoding: 'utf-8', timeout: 60_000, env })
}
const LETTER = ['--to', 'a@example.com', '--subject', 'Tárgy', '--body', 'Kedves Ügyfél, ez a levél törzse.']
// A reply to the stub original: its Reply-To in --to, its From in --cc, no --subject (Graph sets "RE: Tárgy").
const REPLY = ['--to', 'r@example.com', '--cc', 'a@example.com', '--body', 'Kedves Ügyfél, ez a levél törzse.']
const stubSent = (out: string) => {
  const line = out.split('\n').find((l) => l.startsWith('STUB-SENT '))
  return line ? JSON.parse(line.slice('STUB-SENT '.length)) as { to: string[]; cc?: string[] } : null
}
const anchorOf = (err: string) => err.match(/\b([0-9a-f]{64})\b/)?.[1] ?? null

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'graph-sender-check-'))
  mkdirSync(join(dir, 'scripts'))
  mkdirSync(join(dir, 'src'))
  mkdirSync(join(dir, 'store'))
  cpSync(join(ROOT, CLI), join(dir, CLI))
  cpSync(join(ROOT, 'scripts', 'hooks'), join(dir, 'scripts', 'hooks'), { recursive: true })
  cpSync(join(ROOT, 'scripts', 'lib'), join(dir, 'scripts', 'lib'), { recursive: true })
  writeFileSync(join(dir, 'src', 'graph-mail.ts'), [
    'export async function sendMail(o: { to: string[]; cc?: string[]; subject: string; body: string }) {',
    "  console.log('STUB-SENT ' + JSON.stringify({ to: o.to, cc: o.cc }))",
    '}',
    'export async function listMessages() { return [] }',
    // --reply-to reads the original first: a fixed one, from a@example.com, Reply-To r@example.com
    'export async function getMessage(id: string) {',
    "  return { id, subject: 'Tárgy', from: { emailAddress: { address: 'a@example.com' } },",
    "    replyTo: [{ emailAddress: { address: 'r@example.com' } }],",
    "    toRecipients: [{ emailAddress: { address: 'me@example.com' } }], ccRecipients: [{ emailAddress: { address: 'c@example.com' } }] }",
    '}',
    "export async function verifyAccess() { return { mailbox: 'stub' } }",
    '',
  ].join('\n'))
  // --signature: the real renderer, a stub credential reader, and a signature folder
  cpSync(join(ROOT, 'src', 'mail-html.ts'), join(dir, 'src', 'mail-html.ts'))
  cpSync(join(ROOT, 'src', 'mail-reply.ts'), join(dir, 'src', 'mail-reply.ts'))
  writeFileSync(join(dir, 'src', 'graph-client.ts'),
    "export function loadCredentials() { return { mailbox: 'stub@example.com' } }\n")
  mkdirSync(join(dir, 'store', 'email-signature'))
  for (const [f, c] of [['signature.html', '<table>sig</table>'], ['bekezdes-sablon.html', '<div>{}</div>'],
    ['logo.png', 'L'], ['fb.png', 'F'], ['li.png', 'I'],
    ['images.json', JSON.stringify(['logo', 'fb', 'li'].map((n) => ({ cid: n, file: `${n}.png`, contentType: 'image/png' })))]])
    writeFileSync(join(dir, 'store', 'email-signature', f), c)
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'))
  mkdirSync(join(dir, 'store', 'mail-attachments'))
  writeFileSync(join(dir, 'store', 'mail-attachments', 'offer.pdf'), 'PDF-BYTES')
  const d = db()
  d.exec(`CREATE TABLE approvals (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, category TEXT NOT NULL,
    action_description TEXT NOT NULL, action_payload TEXT, status TEXT NOT NULL DEFAULT 'pending',
    timeout_at INTEGER, telegram_message_id INTEGER,
    requested_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
    resolved_at INTEGER, resolved_by TEXT, content_hash TEXT, consumed_at INTEGER)`)
  d.close()
})
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })
beforeEach(() => {
  writeEnv([])
  writeLevel(3)
  const d = db()
  d.exec('DELETE FROM approvals')
  d.close()
  rmSync(join(dir, 'store', 'verified-recipients.json'), { force: true })
})

describe('graph-mail.ts enforces the email_send level itself', () => {
  it('level 1: refused with exit 3, nothing sent', () => {
    writeLevel(1)
    const r = send(LETTER)
    expect(r.status, r.stderr).toBe(3)
    expect(r.stderr).toContain('KULDES MEGTAGADVA')
    expect(r.stderr).toContain('szint 1')
    expect(stubSent(r.stdout)).toBe(null)
  })

  it('level 2: refused with the anchor, sent once with the approval, the replay refused', () => {
    writeLevel(2)
    const first = send(LETTER)
    expect(first.status).toBe(3)
    const anchor = anchorOf(first.stderr)
    expect(anchor, first.stderr).not.toBe(null)
    approve(anchor!)
    const second = send(LETTER)
    expect(second.status, second.stderr).toBe(0)
    expect(stubSent(second.stdout)).toEqual({ to: ['a@example.com'] })
    expect(consumed()).toBe(true)
    const third = send(LETTER)
    expect(third.status).toBe(3)
    expect(stubSent(third.stdout)).toBe(null)
  })

  // Only an 'allowed' verdict passes: a pending approval and one outside the
  // window are refusals, and the expired one is not consumed.
  it('level 2: a PENDING approval is refused, nothing sent', () => {
    writeLevel(2)
    const anchor = anchorOf(send(LETTER).stderr)!
    const d = db()
    d.prepare(`INSERT INTO approvals (id, agent_id, category, action_description, status, resolved_at, content_hash)
      VALUES ('ap-p', 'agent-a', 'email_send', 'x', 'pending', NULL, ?)`).run(anchor)
    d.close()
    const r = send(LETTER)
    expect(r.status, r.stderr).toBe(3)
    expect(r.stderr).toContain('FUGGOBEN')
    expect(stubSent(r.stdout)).toBe(null)
  })

  it('level 2: an EXPIRED approval is refused and not consumed, nothing sent', () => {
    writeLevel(2)
    const anchor = anchorOf(send(LETTER).stderr)!
    const d = db()
    d.prepare(`INSERT INTO approvals (id, agent_id, category, action_description, status, resolved_at, content_hash)
      VALUES ('ap-e', 'agent-a', 'email_send', 'x', 'approved', CAST(strftime('%s','now') AS INTEGER) - 100000, ?)`).run(anchor)
    d.close()
    const r = send(LETTER)
    expect(r.status, r.stderr).toBe(3)
    expect(r.stderr).toContain('IDOABLAKA')
    expect(stubSent(r.stdout)).toBe(null)
    expect(consumed('ap-e')).toBe(false)
  })

  it('level 2: an approved plain letter cannot go out as --html, nor with an attachment', () => {
    writeLevel(2)
    approve(anchorOf(send(LETTER).stderr)!)
    for (const extra of [['--html'], ['--attach', 'offer.pdf']]) {
      const r = send([...LETTER, ...extra])
      expect(r.status, extra.join(' ')).toBe(3)
      expect(stubSent(r.stdout), extra.join(' ')).toBe(null)
    }
    expect(send(LETTER).status).toBe(0)
  })

  // Local flags (--signature: the signed house HTML letter; --reply-to: a
  // threaded Graph reply) are part of the anchored envelope: the plain
  // letter's approval covers neither, and each one has its own anchor.
  it('level 2: an approved plain letter cannot go out signed or as a threaded reply', () => {
    writeLevel(2)
    const plain = anchorOf(send(LETTER).stderr)!
    approve(plain)
    const signed = send([...LETTER, '--signature'])
    const reply = send([...REPLY, '--reply-to', 'AAMkAGI-orig'])
    const replyOther = send([...REPLY, '--reply-to', 'AAMkAGI-other'])
    for (const r of [signed, reply, replyOther]) {
      expect(r.status, r.stderr).toBe(3)
      expect(stubSent(r.stdout)).toBe(null)
    }
    const anchors = [plain, anchorOf(signed.stderr), anchorOf(reply.stderr), anchorOf(replyOther.stderr)]
    expect(anchors.every(Boolean), anchors.join(' ')).toBe(true)
    expect(new Set(anchors).size).toBe(4)
    expect(consumed()).toBe(false)
    approve(anchorOf(reply.stderr)!, 'ap-r')
    const ok = send([...REPLY, '--reply-to', 'AAMkAGI-orig'])
    expect(ok.status, ok.stderr).toBe(0)
    expect(consumed('ap-r')).toBe(true)
  })

  // PR #2983 (Dani B2): the approval binds the signature BYTES, not only the
  // --signature flag. A signature file changed after the approval is another
  // envelope; the approval is not consumed and nothing goes out.
  it('level 2: a signed letter is bound to the signature files it sends', () => {
    writeLevel(2)
    const sigFile = join(dir, 'store', 'email-signature', 'signature.html')
    const imgFile = join(dir, 'store', 'email-signature', 'logo.png')
    const first = anchorOf(send([...LETTER, '--signature']).stderr)!
    expect(first).toBeTruthy()
    writeFileSync(sigFile, '<table>sig <a href="https://evil.example">x</a></table>')
    const changed = anchorOf(send([...LETTER, '--signature']).stderr)!
    expect(changed).toBeTruthy()
    expect(changed).not.toBe(first)
    writeFileSync(sigFile, '<table>sig</table>')
    writeFileSync(imgFile, 'L2')
    const img = anchorOf(send([...LETTER, '--signature']).stderr)!
    expect(new Set([first, changed, img]).size).toBe(3)
    writeFileSync(imgFile, 'L')
    // approved with the original files: goes out once
    approve(first, 'ap-sig')
    writeFileSync(sigFile, '<table>other</table>')
    const refused = send([...LETTER, '--signature'])
    expect(refused.status, refused.stderr).toBe(3)
    expect(stubSent(refused.stdout)).toBe(null)
    expect(consumed('ap-sig')).toBe(false)
    writeFileSync(sigFile, '<table>sig</table>')
    const ok = send([...LETTER, '--signature'])
    expect(ok.status, ok.stderr).toBe(0)
    expect(stubSent(ok.stdout)).not.toBe(null)
    expect(consumed('ap-sig')).toBe(true)
  })

  // PR #2983 (Dani B1): a threaded reply is bounded by its original, before the
  // check (so no approval is asked for, and none consumed) and before any send.
  it('--reply-to: only the original\'s participants, its Reply-To included, and Graph\'s subject', () => {
    writeLevel(3)
    const cases: Array<[string[], RegExp]> = [
      [['--to', 'stranger@example.com', '--body', 'x'], /nem resztvevo: stranger@example\.com/],
      [['--to', 'r@example.com', '--cc', 'stranger@example.com', '--body', 'x'], /nem resztvevo/],
      [['--to', 'a@example.com', '--body', 'x'], /ide is kuldheti.*r@example\.com/],
      [['--to', 'r@example.com', '--subject', 'Mas targy', '--body', 'x'], /RE: Tárgy/],
    ]
    for (const [args, why] of cases) {
      const r = send([...args, '--reply-to', 'AAMkAGI-orig'])
      expect(r.status, r.stderr).toBe(3)
      expect(r.stderr).toMatch(why)
      expect(stubSent(r.stdout)).toBe(null)
    }
    for (const args of [REPLY, ['--to', 'R@example.com,c@example.com', '--subject', 'RE: Tárgy', '--body', 'x']]) {
      const ok = send([...args, '--reply-to', 'AAMkAGI-orig'])
      expect(ok.status, ok.stderr).toBe(0)
      expect(stubSent(ok.stdout)).not.toBe(null)
    }
  })

  it('level 2: the anchor carries the attachment digest', () => {
    writeLevel(2)
    const r = send([...LETTER, '--attach', 'offer.pdf'])
    expect(r.stderr).toContain(createHash('sha256').update('PDF-BYTES').digest('hex').slice(0, 16))
    approve(anchorOf(r.stderr)!)
    expect(send([...LETTER, '--attach', 'offer.pdf']).status).toBe(0)
  })

  it('standing list: only a delivery to exactly that one address rides it', () => {
    writeLevel(2)
    writeFileSync(join(dir, 'store', 'email-standing-recipients.json'), JSON.stringify({ recipients: ['standing@example.com'] }))
    const d = db()
    d.prepare(`INSERT INTO approvals (id, agent_id, category, action_description, status, resolved_at, content_hash)
      VALUES ('st-1', 'agent-a', 'email_standing_recipient', 'x', 'approved', CAST(strftime('%s','now') AS INTEGER), ?)`)
      .run(createHash('sha256').update('standing@example.com').digest('hex'))
    d.close()
    try {
      const ok = send(['--to', 'standing@example.com', '--subject', 'Tárgy', '--body', 'Kedves Ügyfél, ez a levél törzse.'])
      expect(ok.status, ok.stderr).toBe(0)
      // one address to the parser, two to graph-mail's comma split: not a standing letter
      const r = send(['--to', '"evil@example.org, x" <standing@example.com>', '--subject', 'Tárgy', '--body', 'Kedves Ügyfél, ez a levél törzse.'])
      expect(r.status, r.stderr).toBe(3)
      expect(stubSent(r.stdout)).toBe(null)
    } finally {
      rmSync(join(dir, 'store', 'email-standing-recipients.json'), { force: true })
    }
  })

  it('a PATH or PYTHONPATH prefix cannot swap the check for one that always passes', () => {
    writeLevel(1)
    const fake = join(dir, 'fakebin')
    mkdirSync(fake, { recursive: true })
    writeFileSync(join(fake, 'python3'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(fake, 'python3'), 0o755)
    const site = join(dir, 'fakesite')
    mkdirSync(site, { recursive: true })
    writeFileSync(join(site, 'sitecustomize.py'), 'import os\nos._exit(0)\n')
    for (const env of [{ ...process.env, PATH: `${fake}:${process.env.PATH}` }, { ...process.env, PYTHONPATH: site }]) {
      const r = send(LETTER, env)
      expect(r.status, r.stderr).toBe(3)
      expect(stubSent(r.stdout)).toBe(null)
    }
  })

  it('--cc=value is read (it used to be dropped while the hook read it)', () => {
    const r = send([...LETTER, '--cc=c@example.com'])
    expect(r.status, r.stderr).toBe(0)
    expect(stubSent(r.stdout)).toEqual({ to: ['a@example.com'], cc: ['c@example.com'] })
  })

  it('a missing sender_check.py refuses (exit 3)', () => {
    const p = join(dir, 'scripts', 'hooks', 'sender_check.py')
    const keep = `${p}.keep`
    cpSync(p, keep)
    rmSync(p)
    try {
      const r = send(LETTER)
      expect(r.status).toBe(3)
      expect(stubSent(r.stdout)).toBe(null)
    } finally {
      cpSync(keep, p)
      rmSync(keep)
    }
  })
})

describe('graph-mail.ts and the recipient ledger, when the install turns it on', () => {
  const ledger = (addrs: string[]) => writeFileSync(join(dir, 'store', 'verified-recipients.json'),
    JSON.stringify({ version: 1, recipients: Object.fromEntries(addrs.map((a) => [a, { source: 'owner' }])) }))

  it('off: an address not in the ledger still goes out (unchanged)', () => {
    ledger([])
    expect(send(LETTER).status).toBe(0)
  })

  it('on: a known address goes out, an unknown --to or --cc is refused', () => {
    writeEnv(['MAIN_AGENT_RECIPIENT_LEDGER=1'])
    ledger(['a@example.com'])
    expect(send(LETTER).status).toBe(0)
    const r = send([...LETTER, '--cc', 'b@example.org'])
    expect(r.status).toBe(3)
    expect(r.stderr).toContain('b@example.org')
    expect(stubSent(r.stdout)).toBe(null)
  })

  it('on: a missing ledger refuses', () => {
    writeEnv(['MAIN_AGENT_RECIPIENT_LEDGER=1'])
    expect(existsSync(join(dir, 'store', 'verified-recipients.json'))).toBe(false)
    expect(send(LETTER).status).toBe(3)
  })
})

describe('graph-mail.ts runs the outgoing-copy checks itself', () => {
  const DASH = ['--to', 'a@example.com', '--subject', 'Tárgy', '--body', 'Kedves Ügyfél — ez a levél.']

  it('an em dash is refused with exit 3, nothing sent', () => {
    writeFileSync(join(dir, 'store', 'outgoing-copy-gate-rules.json'), JSON.stringify({ no_name_rule: true }))
    const r = send(DASH)
    expect(r.status, r.stderr).toBe(3)
    expect(r.stderr).toContain('KIMENO-SZOVEG')
    expect(stubSent(r.stdout)).toBe(null)
    expect(send(LETTER).status).toBe(0)
  })

  it('a PYTHONPATH prefix cannot swap the copy check either', () => {
    const site = join(dir, 'fakesite2')
    mkdirSync(site, { recursive: true })
    writeFileSync(join(site, 'sitecustomize.py'), 'import os\nos._exit(0)\n')
    const r = send(DASH, { ...process.env, PYTHONPATH: site })
    expect(r.status).toBe(3)
    expect(stubSent(r.stdout)).toBe(null)
  })
})
