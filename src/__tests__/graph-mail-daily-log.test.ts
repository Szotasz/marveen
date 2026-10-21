import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

// Card f90928e3 part B: after a SUCCESSFUL `graph-mail.ts send` one daily-log
// entry is posted for agent brainy. The shipped CLI and hooks run in a temp
// project with a stub transport (no Graph, no credential), and the dashboard
// is a mock HTTP server on a loopback ephemeral port. The entry can never
// change the send: exit code and stdout are compared with and without it.
const ROOT = join(__dirname, '..', '..')
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx')
const CLI = 'scripts/graph-mai' + 'l.ts'
// The live CDP browser ports: no test may ever talk to them.
const FORBIDDEN_PORTS = [18800, 18899]

const BODY_TEXT = 'Kedves Ügyfél, ez a levél törzse, titkos-torzs-szoveg.'
const LONG_SUBJECT = 'A'.repeat(100)

let dir = ''
type Run = { status: number | null; stdout: string; stderr: string }
type Hit = { auth: string | undefined; body: { agent_id: string; content: string } }

function run(args: string[], env: NodeJS.ProcessEnv = {}): Promise<Run> {
  return new Promise((done) => {
    const child = spawn(TSX, [join(dir, CLI), 'send', ...args], {
      env: { ...process.env, ...env, WEB_PORT: '' },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('close', (status) => done({ status, stdout, stderr }))
  })
}
function letter(subject = 'Tárgy', to = 'a@example.com') {
  return ['--to', to, '--subject', subject, '--body', BODY_TEXT]
}
function writeLevel(level: 1 | 2 | 3) {
  writeFileSync(join(dir, 'store', 'autonomy-config.json'),
    JSON.stringify({ version: 1, categories: [{ key: 'email_send', level }] }))
}
function pointDashboardAt(port: number) {
  writeFileSync(join(dir, '.env'), `WEB_PORT=${port}\n`)
  writeFileSync(join(dir, 'store', '.dashboard-token'), 'test-token-not-a-secret\n')
}
function db() {
  return new Database(join(dir, 'store', 'claudeclaw.db'))
}

let hits: Hit[] = []
let server: Server | null = null
let serverPort = 0
function startServer(handler: (respond: (code: number) => void, hang: () => void) => void): Promise<void> {
  return new Promise((ready) => {
    server = createServer((req, res) => {
      let raw = ''
      req.on('data', (d) => { raw += d })
      req.on('end', () => {
        if (req.method === 'POST' && req.url === '/api/daily-log') {
          hits.push({ auth: req.headers.authorization, body: JSON.parse(raw) })
        }
        handler((code) => { res.statusCode = code; res.end('{}') }, () => { /* never answer */ })
      })
    })
    server.listen(0, '127.0.0.1', () => {
      serverPort = (server!.address() as AddressInfo).port
      expect(FORBIDDEN_PORTS).not.toContain(serverPort)
      pointDashboardAt(serverPort)
      ready()
    })
  })
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'graph-daily-log-'))
  mkdirSync(join(dir, 'scripts'))
  mkdirSync(join(dir, 'src'))
  mkdirSync(join(dir, 'store'))
  cpSync(join(ROOT, CLI), join(dir, CLI))
  cpSync(join(ROOT, 'scripts', 'hooks'), join(dir, 'scripts', 'hooks'), { recursive: true })
  cpSync(join(ROOT, 'scripts', 'lib'), join(dir, 'scripts', 'lib'), { recursive: true })
  writeFileSync(join(dir, 'src', 'graph-mail.ts'), [
    'export async function sendMail(o: { to: string[]; cc?: string[]; subject: string; body: string }) {',
    "  if (process.env.STUB_SEND_FAILS) throw new Error('stub: graph refused the send')",
    "  console.log('STUB-SENT ' + JSON.stringify({ to: o.to, cc: o.cc }))",
    // Fault injection for the token-leak tests: a foreign fetch error that echoes the token.
    '  if (process.env.STUB_FETCH_THROWS) {',
    "    const echoed = process.env.STUB_FETCH_THROWS",
    "    globalThis.fetch = async () => { throw new TypeError('invalid header value: Bearer ' + echoed, { cause: new Error(echoed) }) }",
    '  }',
    '}',
    'export async function listMessages() { return [] }',
    "export async function verifyAccess() { return { mailbox: 'stub' } }",
    '',
  ].join('\n'))
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'))
  mkdirSync(join(dir, 'store', 'mail-attachments'))
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
  hits = []
  writeLevel(3)
  const d = db()
  d.exec('DELETE FROM approvals')
  d.close()
  rmSync(join(dir, 'store', 'verified-recipients.json'), { force: true })
  rmSync(join(dir, 'store', '.dashboard-token'), { force: true })
  rmSync(join(dir, '.env'), { force: true })
})
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  server = null
})

describe('graph-mail.ts send: daily-log entry after a successful send', () => {
  it('posts exactly one entry for brainy with recipient, truncated subject and local time, and no body', async () => {
    await startServer((respond) => respond(200))
    const r = await run(letter(LONG_SUBJECT))
    expect(r.status, r.stderr).toBe(0)
    expect(hits).toHaveLength(1)
    expect(hits[0].auth).toBe('Bearer test-token-not-a-secret')
    expect(hits[0].body.agent_id).toBe('brainy')
    const c = hits[0].body.content
    expect(c).toMatch(/^\[Levél elküldve\] a@example\.com, tárgy: A{79}…, \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    expect(Array.from(c.split('tárgy: ')[1].split(', ')[0])).toHaveLength(80)
    expect(c).not.toContain('titkos-torzs-szoveg')
    expect(c).not.toContain('Kedves')
    expect(JSON.stringify(hits[0].body)).not.toContain(BODY_TEXT)
    expect(c).not.toContain('message-id')
    expect(c).not.toContain('approval')
  })

  it('keeps a subject of exactly 80 characters whole, lists only the to-recipients, never cc or an attachment name', async () => {
    await startServer((respond) => respond(200))
    writeFileSync(join(dir, 'store', 'mail-attachments', 'titkos-melleklet.pdf'), 'PDF-BYTES')
    const subject = 'B'.repeat(80)
    const r = await run([...letter(subject, 'a@example.com,b@example.com'),
      '--cc', 'cc-ember@example.com', '--attach', 'titkos-melleklet.pdf'])
    expect(r.status, r.stderr).toBe(0)
    expect(hits).toHaveLength(1)
    const c = hits[0].body.content
    expect(c).toContain(`a@example.com, b@example.com, tárgy: ${subject}, `)
    expect(c).not.toContain('…')
    expect(c).not.toContain('cc-ember')
    expect(c).not.toContain('melleklet')
  })

  for (const [name, start] of [
    ['dashboard answers 500', () => startServer((respond) => respond(500))],
    ['dashboard never answers (timeout)', () => startServer((_respond, hang) => hang())],
    ['connection refused', async () => {
      await startServer((respond) => respond(200))
      await new Promise<void>((r) => server!.close(() => r()))
      server = null
    }],
  ] as const) {
    it(`${name}: send exit 0, stdout identical to a send without the entry, one stderr note`, async () => {
      // Baseline: no token file at all (the entry fails fast), same stub send.
      const baseline = await run(letter())
      expect(baseline.status, baseline.stderr).toBe(0)
      await start()
      const r = await run(letter())
      expect(r.status, r.stderr).toBe(0)
      expect(r.stdout).toBe(baseline.stdout)
      expect(r.stdout).toBe('STUB-SENT {"to":["a@example.com"]}\nsent to a@example.com\n')
      expect(r.stderr).toContain('a levél elment, de a napló-bejegyzés nem készült el')
    }, 30_000)
  }

  it('a missing dashboard token only costs a stderr note', async () => {
    const r = await run(letter())
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toBe('STUB-SENT {"to":["a@example.com"]}\nsent to a@example.com\n')
    expect(r.stderr).toContain('napló-bejegyzés nem készült el')
  })

  it('no entry when the transport fails (exit 1, nothing sent)', async () => {
    await startServer((respond) => respond(200))
    const r = await run(letter(), { STUB_SEND_FAILS: '1' })
    expect(r.status).toBe(1)
    expect(r.stdout).not.toContain('sent to')
    expect(hits).toHaveLength(0)
  })

  it('no entry when the level refuses the send (level 1, exit 3)', async () => {
    await startServer((respond) => respond(200))
    writeLevel(1)
    const r = await run(letter())
    expect(r.status, r.stderr).toBe(3)
    expect(hits).toHaveLength(0)
  })

  it('no entry for a level-2 send without approval, with a pending one, or with an expired one', async () => {
    await startServer((respond) => respond(200))
    writeLevel(2)
    const first = await run(letter())
    expect(first.status, first.stderr).toBe(3)
    const anchor = first.stderr.match(/\b([0-9a-f]{64})\b/)?.[1]
    expect(anchor, first.stderr).toBeTruthy()
    const d = db()
    d.prepare(`INSERT INTO approvals (id, agent_id, category, action_description, status, resolved_at, content_hash)
      VALUES ('ap-p', 'agent-a', 'email_send', 'x', 'pending', NULL, ?)`).run(anchor)
    d.close()
    const pending = await run(letter())
    expect(pending.status, pending.stderr).toBe(3)
    const d2 = db()
    d2.exec('DELETE FROM approvals')
    d2.prepare(`INSERT INTO approvals (id, agent_id, category, action_description, status, resolved_at, content_hash)
      VALUES ('ap-e', 'agent-a', 'email_send', 'x', 'approved', CAST(strftime('%s','now') AS INTEGER) - 100000, ?)`).run(anchor)
    d2.close()
    const expired = await run(letter())
    expect(expired.status, expired.stderr).toBe(3)
    expect(hits).toHaveLength(0)
  })

  it('level 2 with a live approval: sent and ONE entry; the approval is consumed exactly as before', async () => {
    await startServer((respond) => respond(200))
    writeLevel(2)
    const anchor = (await run(letter())).stderr.match(/\b([0-9a-f]{64})\b/)![1]
    const d = db()
    d.prepare(`INSERT INTO approvals (id, agent_id, category, action_description, status, resolved_at, content_hash)
      VALUES ('ap-1', 'agent-a', 'email_send', 'x', 'approved', CAST(strftime('%s','now') AS INTEGER), ?)`).run(anchor)
    d.close()
    const ok = await run(letter())
    expect(ok.status, ok.stderr).toBe(0)
    expect(hits).toHaveLength(1)
    const d2 = db()
    const row = d2.prepare('SELECT consumed_at FROM approvals WHERE id=?').get('ap-1') as { consumed_at: number | null }
    d2.close()
    expect(row.consumed_at).toBeTruthy()
    const replay = await run(letter())
    expect(replay.status).toBe(3)
    expect(hits).toHaveLength(1)
  })
})

// Card f90928e3 B-B1: the dashboard bearer token must not reach stdout or
// stderr on ANY error branch of the entry. A header-validation error from
// fetch echoes the header value, so the token is checked up front and only
// our own fixed messages or a bare exception type name are ever printed.
describe('graph-mail.ts send: the dashboard token never reaches the output', () => {
  const CORE = 'abc123XYZ'
  const TOKEN = `SECRETTOKEN-${CORE}`
  const EXPECTED_STDOUT = 'STUB-SENT {"to":["a@example.com"]}\nsent to a@example.com\n'

  function setToken(content: string) {
    writeFileSync(join(dir, 'store', '.dashboard-token'), content)
  }
  function expectNoLeak(r: Run, note: RegExp) {
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toBe(EXPECTED_STDOUT)
    for (const out of [r.stdout, r.stderr]) {
      expect(out).not.toContain(TOKEN)
      expect(out).not.toContain(CORE)
    }
    // Other stderr lines (sender check, gates) are not ours; the entry's note is exactly one line.
    const notes = r.stderr.split('\n').filter((l) => l.includes('napló-bejegyzés nem készült el'))
    expect(notes, r.stderr).toHaveLength(1)
    expect(notes[0]).toMatch(note)
  }

  for (const [name, content] of [
    ['CR/LF injected', `${TOKEN}\r\nX-Evil: 1`],
    ['LF injected', `${TOKEN}\nX-Evil: 1`],
    ['NUL', `${TOKEN}${String.fromCharCode(0)}tail`],
    ['non-ASCII char', `${TOKEN}-é`],
    ['a space', `${TOKEN} tail`],
  ] as const) {
    it(`token with ${name}: fixed "invalid dashboard token format", no request, send untouched`, async () => {
      await startServer((respond) => respond(200))
      setToken(content)
      const r = await run(letter())
      expectNoLeak(r, /\(invalid dashboard token format\)/)
      expect(hits).toHaveLength(0)
    })
  }

  it('empty token: fixed message', async () => {
    await startServer((respond) => respond(200))
    setToken('\n')
    expectNoLeak(await run(letter()), /\(empty dashboard token\)/)
    expect(hits).toHaveLength(0)
  })

  it('missing token file: fixed message', async () => {
    expectNoLeak(await run(letter()), /\(cannot read dashboard token file\)/)
  })

  it('a valid token still goes out as the Bearer header', async () => {
    await startServer((respond) => respond(200))
    setToken(`${TOKEN}\n`)
    const r = await run(letter())
    expect(r.status, r.stderr).toBe(0)
    expect(hits).toHaveLength(1)
    expect(hits[0].auth).toBe(`Bearer ${TOKEN}`)
    expect(r.stderr).not.toContain('napló-bejegyzés nem készült el')
  })

  it('a foreign fetch error that echoes the token: only the type name is printed', async () => {
    await startServer((respond) => respond(200))
    setToken(TOKEN)
    const r = await run(letter(), { STUB_FETCH_THROWS: TOKEN })
    expectNoLeak(r, /\(TypeError\)/)
  })

  it('dashboard answers 500: "HTTP 500", no token', async () => {
    await startServer((respond) => respond(500))
    setToken(TOKEN)
    expectNoLeak(await run(letter()), /\(HTTP 500\)/)
  }, 30_000)

  it('dashboard never answers: "timeout", no token', async () => {
    await startServer((_respond, hang) => hang())
    setToken(TOKEN)
    expectNoLeak(await run(letter()), /\(timeout\)/)
  }, 30_000)

  it('connection refused: a bare type name, no token', async () => {
    await startServer((respond) => respond(200))
    await new Promise<void>((r) => server!.close(() => r()))
    server = null
    setToken(TOKEN)
    expectNoLeak(await run(letter()), /\(TypeError\)/)
  }, 30_000)

  it('bad WEB_PORT: fixed message, no token', async () => {
    setToken(TOKEN)
    writeFileSync(join(dir, '.env'), 'WEB_PORT=not-a-port\n')
    expectNoLeak(await run(letter()), /\(bad WEB_PORT\)/)
  })
})
