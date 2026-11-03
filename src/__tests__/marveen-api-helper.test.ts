// #2232: scripts/marveen-api.sh is the one allow-listed command a strict-profile agent has for
// the dashboard API. These run the real script against a local fake server and check what
// reaches the wire: method, path, JSON body, the token header and X-Agent-Id. Also the failure
// paths, because an agent decides from the exit code: a bad call or a missing token must fail
// loudly before anything is sent, and a redirect must not carry the token to another host.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createServer, type Server, type IncomingMessage } from 'node:http'
import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const HELPER = join(REPO, 'scripts', 'marveen-api.sh')
const dir = mkdtempSync(join(tmpdir(), 'marveen-api-helper-test-'))
const TOKEN = 'test-token-0123456789'
const tokenFile = join(dir, '.dashboard-token')
writeFileSync(tokenFile, TOKEN + '\n', 'utf-8')

interface Seen { method: string; url: string; headers: IncomingMessage['headers']; body: string }
let seen: Seen[] = []
let reply: { status: number; body: string; headers?: Record<string, string> } = { status: 200, body: '{"ok":true}' }

function listen(handler: (req: IncomingMessage, body: string, res: import('node:http').ServerResponse) => void): Promise<Server> {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => handler(req, body, res))
    })
    srv.listen(0, '127.0.0.1', () => resolve(srv))
  })
}

let api: Server
let other: Server
let otherHits = 0
const port = (s: Server) => (s.address() as AddressInfo).port

beforeAll(async () => {
  api = await listen((req, body, res) => {
    seen.push({ method: req.method!, url: req.url!, headers: req.headers, body })
    res.writeHead(reply.status, { 'Content-Type': 'application/json', ...(reply.headers ?? {}) })
    res.end(reply.body)
  })
  other = await listen((_req, _body, res) => { otherHits++; res.writeHead(200); res.end('{}') })
})
afterAll(() => { api.close(); other.close() })
beforeEach(() => {
  seen = []
  otherHits = 0
  reply = { status: 200, body: '{"ok":true}' }
})

function run(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('bash', [HELPER, ...args], {
      env: { PATH: process.env.PATH!, MARVEEN_API_BASE: `http://127.0.0.1:${port(api)}`, MARVEEN_TOKEN_FILE: tokenFile, ...env },
      timeout: 20_000,
    }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout, stderr })
    })
  })
}

function file(name: string, content: string): string {
  const p = join(dir, name)
  writeFileSync(p, content, 'utf-8')
  return p
}

describe('marveen-api.sh: what each verb sends', () => {
  it('memory-save: POST with the file content, the token header and X-Agent-Id', async () => {
    const r = await run(['memory-save', 'dani', 'warm', 'k1, k2', file('m.txt', 'tartalom `backtick` és $(nem fut)\n')])
    expect(r.code).toBe(0)
    expect(seen).toHaveLength(1)
    const [s] = seen
    expect(s.method).toBe('POST')
    expect(s.url).toBe('/api/memories')
    expect(s.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(s.headers['x-agent-id']).toBe('dani')
    expect(JSON.parse(s.body)).toEqual({ agent_id: 'dani', content: 'tartalom `backtick` és $(nem fut)\n', category: 'warm', keywords: 'k1, k2' })
  })

  it('skill-propose: POST with the SKILL.md and the reason from files, the reason optional', async () => {
    const md = '---\nname: my-skill\n---\ntartalom `backtick` és $(nem fut)\n'
    const mdFile = file('s.md', md)
    const r = await run(['skill-propose', 'my-skill', mdFile, '--reason-file', file('why.txt', 'miért kell\n')])
    expect(r.code).toBe(0)
    expect(seen).toHaveLength(1)
    const [s] = seen
    expect(s.method).toBe('POST')
    expect(s.url).toBe('/api/skills/propose')
    expect(s.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(JSON.parse(s.body)).toEqual({ name: 'my-skill', skill_md: md, reason: 'miért kell\n' })
    expect((await run(['skill-propose', 'my-skill', mdFile])).code).toBe(0)
    expect(JSON.parse(seen[1].body)).toEqual({ name: 'my-skill', skill_md: md })
  })

  it('skill-propose --ref-file (SKILLSPLIT1101): each file goes as references/<its name>; a bad or repeated name is a usage error', async () => {
    const md = '---\nname: my-skill\n---\nsee references\n'
    const mdFile = file('s.md', md)
    const r = await run(['skill-propose', 'my-skill', mdFile, '--ref-file', file('details.md', 'részletek `x`\n'), '--ref-file', file('b-2.md', 'b')])
    expect(r.code).toBe(0)
    expect(JSON.parse(seen[0].body)).toEqual({ name: 'my-skill', skill_md: md, files: { 'references/details.md': 'részletek `x`\n', 'references/b-2.md': 'b' } })
    expect((await run(['skill-propose', 'my-skill', mdFile, '--ref-file', file('notes.txt', 'x')])).code).toBe(2)
    expect((await run(['skill-propose', 'my-skill', mdFile, '--ref-file', file('.hidden.md', 'x')])).code).toBe(2)
    expect((await run(['skill-propose', 'my-skill', mdFile, '--ref-file', file('Upper.md', 'x')])).code).toBe(2)
    expect((await run(['skill-propose', 'my-skill', mdFile, '--ref-file', file('dup.md', 'x'), '--ref-file', file('dup.md', 'y')])).code).toBe(2)
    expect((await run(['skill-propose', 'my-skill', mdFile, '--ref-file'])).code).toBe(2)
    expect(seen).toHaveLength(1)
  })

  it('memory-search: the accented query is encoded, and the label header is printed first', async () => {
    reply = { status: 200, body: '[]', headers: { 'X-Memory-Search': 'strict=true; relaxed=false; hits=0' } }
    const r = await run(['memory-search', 'dani', 'funkcionális', '--category', 'warm', '--strict', '--since', '2026-10-01'])
    expect(r.code).toBe(0)
    const url = new URL(seen[0].url, 'http://x')
    expect(url.pathname).toBe('/api/memories')
    expect(Object.fromEntries(url.searchParams)).toEqual({ agent: 'dani', q: 'funkcionális', category: 'warm', strict: '1', since: '2026-10-01' })
    expect(seen[0].url).toContain('q=funkcion%C3%A1lis')
    expect(r.stdout.split('\n')[0]).toBe('X-Memory-Search: strict=true; relaxed=false; hits=0')
  })

  it('memory-search: a missing label header is printed as MISSING, also on a 400', async () => {
    reply = { status: 400, body: '' }
    const r = await run(['memory-search', 'dani', 'x'])
    expect(r.code).toBe(1)
    expect(r.stdout.split('\n')[0]).toMatch(/^X-Memory-Search: MISSING/)
  })

  it('memory-move: a category-only PATCH, never agent_id', async () => {
    const r = await run(['memory-move', '4242', 'cold', 'dani'])
    expect(r.code).toBe(0)
    expect(seen[0].method).toBe('PATCH')
    expect(seen[0].url).toBe('/api/memories/4242')
    expect(JSON.parse(seen[0].body)).toEqual({ category: 'cold', updated_by: 'dani' })
    expect(seen[0].headers['x-agent-id']).toBe('dani')
  })

  it('memory-update and memory-list', async () => {
    expect((await run(['memory-update', '7', 'dani', file('u.txt', 'új')])).code).toBe(0)
    expect(seen[0].method).toBe('PUT')
    expect(seen[0].url).toBe('/api/memories/7')
    expect(JSON.parse(seen[0].body)).toEqual({ content: 'új', updated_by: 'dani' })
    expect((await run(['memory-list', 'dani', 'hot'])).code).toBe(0)
    expect(seen[1].method).toBe('GET')
    expect(seen[1].url).toBe('/api/memories?agent=dani&category=hot&limit=40')
  })

  it('message-close: notify is a real JSON boolean, the result comes from a file', async () => {
    expect((await run(['message-close', '43071', '--no-notify'])).code).toBe(0)
    expect(seen[0].method).toBe('PUT')
    expect(seen[0].url).toBe('/api/messages/43071')
    expect(JSON.parse(seen[0].body)).toEqual({ status: 'done', notify: false })
    expect((await run(['message-close', '5', '--failed', '--result-file', file('r.txt', 'mit csináltam')])).code).toBe(0)
    expect(JSON.parse(seen[1].body)).toEqual({ status: 'failed', result: 'mit csináltam' })
  })

  it('directive-verify, daily-log and the three approval verbs', async () => {
    await run(['directive-verify', '43081'])
    await run(['daily-log', 'dani', file('d.txt', '## 14:00 -- Téma\nMi történt')])
    await run(['approval-request', 'dani', 'email_send', '3600', file('a.txt', 'Mit és miért'), '--content-hash', 'sha256:abcdef12'])
    await run(['approval-status', 'ab12'])
    await run(['approval-consume', 'ab12', 'memory_maintenance', 'dani'])
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      'GET /api/messages/43081',
      'POST /api/daily-log',
      'POST /api/approvals',
      'GET /api/approvals/ab12',
      'POST /api/approvals/ab12/consume',
    ])
    expect(JSON.parse(seen[1].body)).toEqual({ agent_id: 'dani', content: '## 14:00 -- Téma\nMi történt' })
    expect(JSON.parse(seen[2].body)).toEqual({ agent_id: 'dani', category: 'email_send', action_description: 'Mit és miért', timeout_seconds: 3600, content_hash: 'sha256:abcdef12' })
    expect(JSON.parse(seen[4].body)).toEqual({ category: 'memory_maintenance', consumer: 'dani' })
  })

  it('taskstate-save: POST to the agent\'s own record with X-Agent-Id, the JSON object from the file (#2338)', async () => {
    const rec = { summary: 'mit csinálok `x` $(nem fut)', doneSteps: ['kész'], alreadyDelegated: [], nextAction: 'következő', pendingDecision: '' }
    const r = await run(['taskstate-save', 'dani', file('t.json', JSON.stringify(rec))])
    expect(r.code).toBe(0)
    expect(seen).toHaveLength(1)
    expect(seen[0].method).toBe('POST')
    expect(seen[0].url).toBe('/api/agent-taskstate/dani')
    expect(seen[0].headers['x-agent-id']).toBe('dani')
    expect(seen[0].headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(JSON.parse(seen[0].body)).toEqual(rec)
  })

  it('taskstate-save: a broken, empty or non-object JSON file exits 2 and sends nothing', async () => {
    for (const bad of ['{"summary": ', '{}', '[1,2]', '"szöveg"']) {
      const r = await run(['taskstate-save', 'dani', file('bad.json', bad)])
      expect(r.code).toBe(2)
    }
    expect((await run(['taskstate-save', '../x', file('ok.json', '{"summary":"a"}')])).code).toBe(2)
    expect(seen).toHaveLength(0)
  })

  it('kanban-assign: a PUT of the assignee (an agent name or the owner\'s name with accents), the actor optional (VOICETOKENLEAK1101)', async () => {
    let r = await run(['kanban-assign', 'card-1', 'marveen', '--actor', 'cody'])
    expect(r.code).toBe(0)
    expect(seen.at(-1)!.method).toBe('PUT')
    expect(seen.at(-1)!.url).toBe('/api/kanban/card-1')
    expect(JSON.parse(seen.at(-1)!.body)).toEqual({ assignee: 'marveen', actor: 'cody' })
    expect(seen.at(-1)!.headers.authorization).toBe(`Bearer ${TOKEN}`)
    r = await run(['kanban-assign', 'card-1', 'Sára Tüttő'])
    expect(r.code).toBe(0)
    expect(JSON.parse(seen.at(-1)!.body)).toEqual({ assignee: 'Sára Tüttő' })
  })

  it('kanban-assign: an assignee or a card id that is not one plain value exits 2 and sends nothing', async () => {
    for (const args of [['card-1', '../x'], ['card-1', 'a/b'], ['card-1', 'x\ny'], ['card-1', ''], ['card-1', '-lead'], ['card/1', 'marveen'], ['card-1', 'marveen', '--actor', 'Bad Actor']]) {
      const r = await run(['kanban-assign', ...args])
      expect(r.code, JSON.stringify(args)).toBe(2)
    }
    expect(seen).toEqual([])
  })

  it('message: goes through agent-msg.sh with the text from the file', async () => {
    reply = { status: 200, body: '{"id":99}' }
    const r = await run(['message', 'dani', 'samu', file('msg.txt', 'Szia, "idézet" és `kód`')])
    expect(r.code, r.stderr + r.stdout).toBe(0)
    expect(seen).toHaveLength(1)
    expect(seen[0].url).toBe('/api/messages')
    expect(JSON.parse(seen[0].body)).toEqual({ from: 'dani', to: 'samu', content: 'Szia, "idézet" és `kód`' })
  })
})

// VOICETOKENLEAK1101 PR-A1 (Dani 65157/1, Samu 65160): the generated recipes name one fixed file per kind
// (api-<kind>.txt); two texts prepared in one round would both send the second. Such a file is emptied after a
// successful send, an empty one stops the call, and a failed send keeps the text for the retry.
describe('marveen-api.sh: a recipe payload file is sent once', () => {
  const content = (p: string) => readFileSync(p, 'utf-8')

  it('emptied after a 2xx, and the next call on the empty file exits 2 and sends nothing', async () => {
    const p = file('api-memoria.txt', 'egyszer menjen ki')
    expect((await run(['memory-save', 'dani', 'warm', 'k', p])).code).toBe(0)
    expect(seen).toHaveLength(1)
    expect(content(p)).toBe('')
    const again = await run(['memory-save', 'dani', 'warm', 'k', p])
    expect(again.code).toBe(2)
    expect(again.stderr).toMatch(/is empty: a recipe payload file is emptied after each send/)
    expect(seen).toHaveLength(1)
  })

  it('a non-2xx answer keeps the text (the retry can send it); a whitespace-only file counts as empty', async () => {
    const p = file('api-naplo.txt', 'marad a hibánál')
    reply = { status: 500, body: '{"error":"x"}' }
    expect((await run(['daily-log', 'dani', p])).code).toBe(1)
    expect(content(p)).toBe('marad a hibánál')
    writeFileSync(p, ' \n\t\n')
    reply = { status: 200, body: '{"ok":true}' }
    expect((await run(['daily-log', 'dani', p])).code).toBe(2)
    expect(seen).toHaveLength(1)
  })

  // APPROVALSLACK1030 (2): the letter goes with the request, so the server can recompute its anchor.
  it('approval-request --payload-file sends the JSON object as action_payload; a broken file sends nothing', async () => {
    const env = { envelope: { to: ['a@example.com'], cc: [], text: 'Szia' } }
    await run(['approval-request', 'dani', 'email_send', '3600', file('pa.txt', 'Levél'), '--content-hash', 'a'.repeat(64), '--payload-file', file('p.json', JSON.stringify(env))])
    const body = JSON.parse(seen[seen.length - 1].body)
    expect(JSON.parse(body.action_payload)).toEqual(env)
    expect(body.content_hash).toBe('a'.repeat(64))
    const before = seen.length
    const bad = await run(['approval-request', 'dani', 'email_send', '3600', file('pb.txt', 'Levél'), '--payload-file', file('q.json', '{not json')])
    expect(bad.code).not.toBe(0)
    expect(seen.length).toBe(before)
  })

  it('every payload verb of the recipes empties it: message-close --result-file, approval-request, memory-update', async () => {
    const r = file('api-eredmeny.txt', 'kész')
    expect((await run(['message-close', '7', '--result-file', r])).code).toBe(0)
    const a = file('api-jovahagyas.txt', 'leírás')
    expect((await run(['approval-request', 'dani', 'memory_maintenance', '3600', a])).code).toBe(0)
    const m = file('api-memoria.txt', 'új')
    expect((await run(['memory-update', '5', 'dani', m])).code).toBe(0)
    for (const p of [r, a, m]) expect(content(p), p).toBe('')
    expect(seen).toHaveLength(3)
  })

  it('the message verb too: emptied after the send, an empty one exits 2 before agent-msg.sh runs', async () => {
    reply = { status: 200, body: '{"id":99}' }
    const p = file('api-uzenet.txt', 'Szia `kód`')
    const r = await run(['message', 'dani', 'samu', p])
    expect(r.code, r.stderr + r.stdout).toBe(0)
    expect(content(p)).toBe('')
    const again = await run(['message', 'dani', 'samu', p])
    expect(again.code).toBe(2)
    expect(again.stderr).toMatch(/is empty/)
    expect(seen).toHaveLength(1)
  })

  it('a file with any other name is left as it is (a kanban result, a skill draft)', async () => {
    const p = file('kanban-x-eredmeny.txt', 'marad')
    expect((await run(['memory-save', 'dani', 'warm', 'k', p])).code).toBe(0)
    expect(content(p)).toBe('marad')
  })
})

describe('marveen-api.sh: failures are loud, and nothing is sent on a bad call', () => {
  it('an unknown verb exits 2 and sends nothing', async () => {
    const r = await run(['memory-delete', '1'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('unknown verb')
    expect(seen).toHaveLength(0)
  })

  it('a malformed argument exits 2 and sends nothing', async () => {
    expect((await run(['memory-move', '12; rm', 'cold', 'dani'])).code).toBe(2)
    expect((await run(['memory-save', 'dani', 'lukewarm', 'k', file('x.txt', 'x')])).code).toBe(2)
    expect((await run(['memory-save', 'dani', 'warm', 'k', file('e.txt', '  \n')])).code).toBe(2)
    expect((await run(['message', 'dani', 'samu'])).code).toBe(2)
    expect((await run(['skill-propose', 'my-skill', file('e.md', '  \n')])).code).toBe(2)
    expect((await run(['skill-propose', '../x', file('s.md', 'x')])).code).toBe(2)
    expect((await run(['skill-propose', 'my-skill', file('s.md', 'x'), '--force'])).code).toBe(2)
    expect((await run(['skill-propose', 'my-skill'])).code).toBe(2)
    expect(seen).toHaveLength(0)
  })

  it('no token file exits 2 with a loud message and sends nothing', async () => {
    const r = await run(['directive-verify', '1'], { MARVEEN_TOKEN_FILE: join(dir, 'no-such-dir', '.dashboard-token') })
    expect(r.code).toBe(2)
    expect(r.stderr).toMatch(/no readable token file/)
    expect(seen).toHaveLength(0)
  })

  it('a set MARVEEN_TOKEN_FILE that is missing or empty never falls back to the shared token (VOICETOKENLEAK1101 PR-A0)', async () => {
    // The agent's own (narrowed) token is the only one it may send once the launch command names it: a copied
    // root WITH a shared store/.dashboard-token, so a fallback would be a request on the wire.
    const root = mkdtempSync(join(tmpdir(), 'marveen-api-fallback-'))
    mkdirSync(join(root, 'scripts', 'lib'), { recursive: true })
    mkdirSync(join(root, 'store'), { recursive: true })
    for (const f of ['marveen-api.sh', 'agent-msg.sh', join('lib', 'marveen_api.py')]) {
      copyFileSync(join(REPO, 'scripts', f), join(root, 'scripts', f))
    }
    const SHARED = 'shared-token-SHOULD-NOT-SEND'
    writeFileSync(join(root, 'store', '.dashboard-token'), SHARED + '\n', 'utf-8')
    const runIn = (args: string[], env: Record<string, string>) => new Promise<number>((resolve) => {
      execFile('bash', [join(root, 'scripts', 'marveen-api.sh'), ...args], {
        env: { PATH: process.env.PATH!, MARVEEN_API_BASE: `http://127.0.0.1:${port(api)}`, ...env }, timeout: 20_000,
      }, (err) => resolve(err ? (typeof err.code === 'number' ? err.code : -1) : 0))
    })
    // control: the fixture does reach the server with the shared token when nothing names another file
    expect(await runIn(['directive-verify', '1'], {})).toBe(0)
    expect(seen).toHaveLength(1)
    expect(seen[0].headers.authorization).toBe(`Bearer ${SHARED}`)
    seen = []
    const missing = join(root, 'agents', 'alfa', '.dashboard-token')
    mkdirSync(join(root, 'agents', 'empty'), { recursive: true })
    const empty = join(root, 'agents', 'empty', '.dashboard-token')
    writeFileSync(empty, '\n', 'utf-8')
    for (const tf of [missing, empty]) {
      expect(await runIn(['directive-verify', '1'], { MARVEEN_TOKEN_FILE: tf }), tf).toBe(2)
      expect(await runIn(['memory-save', 'alfa', 'warm', 'k', file('fb.txt', 'x')], { MARVEEN_TOKEN_FILE: tf }), tf).toBe(2)
      // the message verb (agent-msg.sh) is stopped by the same check before it starts
      expect(await runIn(['message', 'alfa', 'samu', file('fb2.txt', 'x')], { MARVEEN_TOKEN_FILE: tf }), tf).toBe(2)
    }
    expect(seen).toHaveLength(0)
  })

  it('a non-2xx answer exits 1 with the status', async () => {
    reply = { status: 409, body: '{"error":"already_consumed"}' }
    const r = await run(['approval-consume', 'ab12', 'memory_maintenance', 'dani'])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('HTTP 409')
  })

  it('a redirect is not followed, so the token never reaches another host', async () => {
    reply = { status: 302, body: '', headers: { Location: `http://127.0.0.1:${port(other)}/steal` } }
    const r = await run(['directive-verify', '1'])
    expect(r.code).toBe(1)
    expect(otherHits).toBe(0)
  })

  it('an unreachable dashboard exits 3', async () => {
    const r = await run(['directive-verify', '1'], { MARVEEN_API_BASE: 'http://127.0.0.1:9' })
    expect(r.code).toBe(3)
    expect(r.stderr).toContain('could not be reached')
  })

  it('an id carrying a path (../, %2f, /) exits 2 and sends nothing', async () => {
    for (const args of [
      ['directive-verify', '../1'],
      ['directive-verify', '1/../2'],
      ['memory-move', '..%2f1', 'cold', 'dani'],
      ['memory-update', '7/..', 'dani', file('p.txt', 'x')],
      ['message-close', '5/../../api/x'],
      ['approval-status', '../approvals'],
      ['approval-consume', 'ab12/..', 'memory_maintenance', 'dani'],
    ]) {
      const r = await run(args)
      expect(r.code, args.join(' ')).toBe(2)
    }
    expect(seen).toHaveLength(0)
  })

  it('a MARVEEN_API_BASE off loopback exits 2 and sends nothing, for the message verb too', async () => {
    const env = { MARVEEN_API_BASE: `http://example.invalid:${port(api)}` }
    const r1 = await run(['directive-verify', '1'], env)
    expect(r1.code).toBe(2)
    expect(r1.stderr).toContain('neither loopback')
    const r2 = await run(['message', 'dani', 'samu', file('m2.txt', 'x')], env)
    expect(r2.code).toBe(2)
    expect(seen).toHaveLength(0)
  })

  it('loopback means the exact host, not a name that starts with or contains one', async () => {
    // Review of #2239: a prefix match (localhost.evil.test) kept every other test green.
    const check = (base: string) => new Promise<number>((resolve) => {
      execFile('python3', ['-I', join(REPO, 'scripts', 'lib', 'marveen_api.py'), '--check-env'],
        { env: { PATH: process.env.PATH!, MARVEEN_API_BASE: base } }, (err) => resolve(err ? (err.code as number) : 0))
    })
    for (const near of ['http://localhost.evil.test:3420', 'http://127.0.0.1.nip.io:3420', 'http://localhostx:3420',
      'http://evil.test/localhost', 'http://localhost@evil.test:3420']) {
      expect(await check(near), near).toBe(2)
    }
    for (const exact of ['http://localhost:3420', 'http://127.0.0.1:1', 'http://[::1]:3420', 'https://LOCALHOST:3420']) {
      expect(await check(exact), exact).toBe(0)
    }
  })

  it('a MARVEEN_TOKEN_FILE that is not a .dashboard-token exits 2 and sends nothing', async () => {
    const other = file('notes.txt', 'first line of some other file\n')
    const r = await run(['directive-verify', '1'], { MARVEEN_TOKEN_FILE: other })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('.dashboard-token')
    expect((await run(['message', 'dani', 'samu', file('m3.txt', 'x')], { MARVEEN_TOKEN_FILE: other })).code).toBe(2)
    expect(seen).toHaveLength(0)
  })

  it("a remote base is accepted when it is exactly the install's own AGENT_API_ORIGIN or DASHBOARD_PUBLIC_URL", async () => {
    // The guard reads the install's .env next to scripts/, so the helper runs from a copied root.
    const root = mkdtempSync(join(tmpdir(), 'marveen-api-root-'))
    mkdirSync(join(root, 'scripts', 'lib'), { recursive: true })
    copyFileSync(join(REPO, 'scripts', 'lib', 'marveen_api.py'), join(root, 'scripts', 'lib', 'marveen_api.py'))
    writeFileSync(join(root, '.env'), 'WEB_PORT=3420\nAGENT_API_ORIGIN="https://dash.example.com/"\nDASHBOARD_PUBLIC_URL=https://public.example.com\n')
    const check = (base: string) => new Promise<number>((resolve) => {
      execFile('python3', ['-I', join(root, 'scripts', 'lib', 'marveen_api.py'), '--check-env'],
        { env: { PATH: process.env.PATH!, MARVEEN_API_BASE: base } }, (err) => resolve(err ? (err.code as number) : 0))
    })
    expect(await check('https://dash.example.com')).toBe(0)
    expect(await check('https://public.example.com/')).toBe(0)
    expect(await check('https://dash.example.com.evil.test')).toBe(2)
    expect(await check('http://dash.example.com')).toBe(2)
    expect(await check('http://[::1]:3420')).toBe(0)
  })

  it('the token is never in the argv the helper passes on', async () => {
    // The python core is started with the verb arguments only; the token is read inside it.
    const sh = (await import('node:fs')).readFileSync(HELPER, 'utf-8')
    expect(sh).not.toMatch(/dashboard-token|TOKEN=/)
  })
})

// VOICETOKENLEAK1101 PR-B (Dani 65425, Samu 65434): the helper READS the schedule list and never writes a schedule.
// The self-pace gate reads the command text, and a helper call names no route, so the guard is in the helper, the one
// place where the path is put together: any method but GET under the schedule route is refused before anything is
// sent, for every verb. The pin builds EVERY verb with sample arguments; the forged requests prove the guard holds for
// a verb or a path nobody wrote yet.
describe('marveen-api.sh: schedules are read only', () => {
  const API_PY = join(REPO, 'scripts', 'lib', 'marveen_api.py')
  const driver = file('sched-driver.py', [
    'import importlib.util, json, os, re, sys',
    'spec = importlib.util.spec_from_file_location("marveen_api", sys.argv[1])',
    'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    'mode = sys.argv[2]',
    'if mode == "pin":',
    '    d = sys.argv[3]',
    '    f = os.path.join(d, "pin-x.txt"); open(f, "w").write("x")',
    '    j = os.path.join(d, "pin-s.json"); open(j, "w").write("{\\"a\\": 1}")',
    '    s = {',
    '        "message-close": ["7", "--result-file", f], "directive-verify": ["1"], "memory-search": ["dani", "q"],',
    '        "memory-save": ["dani", "warm", "k", f], "memory-list": ["dani", "hot"], "memory-move": ["5", "cold", "dani"],',
    '        "memory-update": ["5", "dani", f], "daily-log": ["dani", f], "taskstate-save": ["dani", j],',
    '        "approval-request": ["dani", "memory_maintenance", "60", f], "approval-status": ["ap-1"],',
    '        "approval-consume": ["ap-1", "memory_maintenance", "dani"], "skill-propose": ["my-skill", f],',
    '        "kanban-list": [], "schedules-list": [], "kanban-create": ["dani", "normal", f],',
    '        "kanban-move": ["c-1", "done"], "kanban-claim": ["c-1", "dani"], "kanban-release": ["c-1", "dani"],',
    '        "kanban-comment": ["c-1", "dani", f], "kanban-assign": ["c-1", "dani"], "agents-list": [],',
    '    }',
    '    verbs = re.findall(r"^ {2}([a-z-]+)(?= |$)", m.USAGE, re.M)',
    '    built = [[v] + list(m.build_request(v, s[v])[:2]) for v in verbs if v != "message"]',
    '    print(json.dumps({"verbs": verbs, "samples": sorted(s), "built": built}))',
    'elif mode == "guard-base":',
    '    m.api_base = lambda: sys.argv[3]',
    '    print(m.schedule_write_refused("POST", sys.argv[4]) or "ALLOWED")',
    'else:',
    '    meth, path = sys.argv[3], sys.argv[4]',
    '    m.build_request = lambda verb, args: (meth, path, {"x": 1}, {}, {})',
    '    sys.exit(m.main(["kanban-list"]))',
  ].join('\n') + '\n')
  const SCHED = '/api/' + 'schedules'
  const py = (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => new Promise((resolve) => {
    execFile('python3', ['-I', driver, API_PY, ...args], {
      env: { PATH: process.env.PATH!, MARVEEN_API_BASE: `http://127.0.0.1:${port(api)}`, MARVEEN_TOKEN_FILE: tokenFile },
      timeout: 20_000,
    }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout, stderr }))
  })

  it('schedules-list: a GET of the schedule list with the token header, nothing else', async () => {
    const r = await run(['schedules-list'])
    expect(r.code, r.stderr).toBe(0)
    expect(seen).toHaveLength(1)
    expect([seen[0].method, seen[0].url, seen[0].body]).toEqual(['GET', SCHED, ''])
    expect(seen[0].headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect((await run(['schedules-list', 'extra'])).code).toBe(2)
    expect((await run(['schedules-list', '--agent', 'dani'])).code).toBe(2)
    expect(seen).toHaveLength(1)
  })

  it('pin: every verb, built with sample arguments, writes nothing under the schedule route', async () => {
    const r = await py(['pin', dir])
    expect(r.code, r.stderr).toBe(0)
    const { verbs, samples, built } = JSON.parse(r.stdout) as { verbs: string[]; samples: string[]; built: [string, string, string][] }
    // every verb of the usage has a sample here (a new verb fails until it gets one), and none is left over
    expect([...verbs.filter((v) => v !== 'message')].sort()).toEqual(samples)
    const writes = built.filter(([, method, path]) => path.split('?')[0]!.startsWith(SCHED) && method !== 'GET')
    expect(writes).toEqual([])
    expect(built.filter(([, , path]) => path.startsWith(SCHED))).toEqual([['schedules-list', 'GET', SCHED]])
  })

  it('a forged non-GET under the schedule route stops before the send, in every spelling; a GET goes', async () => {
    for (const [method, path] of [
      ['POST', SCHED], ['PUT', `${SCHED}/x`], ['DELETE', `${SCHED}/x`], ['PATCH', `${SCHED}/x/enable`],
      ['POST', '/api/x/../' + 'schedules'], ['POST', '/api/%73chedules'], ['post', `${SCHED}?a=1`], ['POST', `${SCHED}/`],
      ['POST', `/${SCHED}`], ['POST', `//${SCHED}/x`],
    ]) {
      const r = await py(['forged', method!, path!])
      expect(r.code, `${method} ${path}`).toBe(2)
      expect(r.stderr, `${method} ${path}`).toMatch(/only reads schedules.*nothing was sent/)
    }
    expect(seen).toHaveLength(0)
    const ok = await py(['forged', 'GET', SCHED])
    expect(ok.code, ok.stderr).toBe(0)
    expect(seen.map((s) => [s.method, s.url])).toEqual([['GET', SCHED]])
    // a non-GET elsewhere is not this guard's business
    expect((await py(['forged', 'POST', `${SCHED}x`])).code).toBe(0)
  })

  // Dani 65495: a base with a path, a query or a fragment turned the verb's own path into a query or a fragment, so a
  // kanban-comment went out as POST /api/schedules past the guard. The base is an origin only now, and the guard
  // looks at the path of the URL really sent.
  it('MARVEEN_API_BASE with a path, a query or a fragment exits 2 and sends nothing, for any verb', async () => {
    const origin = `http://127.0.0.1:${port(api)}`
    const c = file('c.txt', 'komment')
    for (const base of [`${origin}${SCHED}`, `${origin}${SCHED}?x=`, `${origin}${SCHED}#`, `${origin}/x`, `${origin}?a`, `${origin}#f`]) {
      const r = await run(['kanban-comment', 'c-1', 'dani', c], { MARVEEN_API_BASE: base })
      expect(r.code, base).toBe(2)
      expect(r.stderr, base).toMatch(/must be an origin only.*nothing was sent/)
      const m = await run(['message', 'dani', 'samu', file('m.txt', 'x')], { MARVEEN_API_BASE: base })
      expect(m.code, `message ${base}`).toBe(2)
    }
    expect(seen).toHaveLength(0)
    // the origin itself, with or without a trailing slash, still works
    for (const base of [origin, `${origin}/`]) {
      expect((await run(['kanban-list'], { MARVEEN_API_BASE: base })).code, base).toBe(0)
    }
    expect(seen.map((s) => s.url)).toEqual(['/api/kanban', '/api/kanban'])
  })

  it('the guard itself looks at the path of the URL really sent, even if a base with a path got past the env check', async () => {
    for (const base of [`http://127.0.0.1:1${SCHED}?x=`, `http://127.0.0.1:1${SCHED}#`, `http://127.0.0.1:1/${SCHED}?`]) {
      const r = await py(['guard-base', base, '/api/kanban/c-1/comments'])
      expect(r.stdout, base).toMatch(/only reads schedules/)
    }
    expect((await py(['guard-base', 'http://127.0.0.1:1', '/api/kanban/c-1/comments'])).stdout.trim()).toBe('ALLOWED')
  })
})
