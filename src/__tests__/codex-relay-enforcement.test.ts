import { describe, it, expect } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { type AddressInfo } from 'node:net'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, linkSync, symlinkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const RELAY_MJS = fileURLToPath(new URL('../../scripts/codex-relay/relay.mjs', import.meta.url))
const MCP_SHIM_MJS = fileURLToPath(new URL('../../scripts/codex-relay/mcp-shim.mjs', import.meta.url))
const AGENT = 'relay-agent'

async function waitFor<T>(probe: () => T | null | undefined | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value) return value as T
    if (Date.now() >= deadline) throw new Error('waitFor timed out')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

const readJson = (path: string): any => JSON.parse(readFileSync(path, 'utf-8'))
function exited(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode)
  return new Promise(resolve => child.on('exit', code => resolve(code)))
}

type Seen = { method?: string; url?: string; body: string; authorization?: string }
type Res = { id: string; status: number; error?: string; body?: any }

async function withRelay(
  fn: (h: {
    send: (method: string, path: string, body?: unknown, id?: string) => Promise<Res>
    sendMany: (reqs: Array<{ method: string; path: string; body?: unknown }>) => Promise<Res[]>
    seen: Seen[]
    cards: Map<string, string>
    listBody: { value: unknown }
    auditPath: string
    relayDir: string
    token: string
    stderr: () => string
    hold: { ms: number }
    child: ChildProcess
  }) => Promise<void>,
  opts?: { preload?: string },
) {
  const work = mkdtempSync(join(tmpdir(), 'marveen-relay-enf-'))
  const relayDir = join(work, 'relay')
  const tokenFile = join(work, 'agent.token')
  const auditPath = join(work, 'audit.log')
  const token = `tok-${randomBytes(16).toString('hex')}`
  writeFileSync(tokenFile, `${token}\n`)
  const seen: Seen[] = []
  const cards = new Map<string, string>()
  const listBody: { value: unknown } = { value: [] }
  const hold = { ms: 0 }
  let stderrText = ''
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body, authorization: req.headers.authorization })
      setTimeout(() => {
        res.setHeader('content-type', 'application/json')
        const m = /^\/api\/kanban\/([^/?]+)$/.exec(req.url ?? '')
        if (req.method === 'GET' && m) {
          const assignee = cards.get(m[1])
          if (assignee === undefined) { res.statusCode = 404; res.end(JSON.stringify({ error: 'nf' })); return }
          res.end(JSON.stringify({ id: m[1], assignee })); return
        }
        if (req.method === 'GET' && (req.url ?? '').startsWith('/api/kanban?')) { res.end(JSON.stringify(listBody.value)); return }
        res.end(JSON.stringify({ ok: true }))
      }, hold.ms)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const dashboardUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const child = spawn(process.execPath, [
    ...(opts?.preload ? ['--import', pathToFileURL(opts.preload).href] : []),
    RELAY_MJS,
    '--agent', AGENT, '--relay-dir', relayDir, '--token-file', tokenFile,
    '--dashboard-url', dashboardUrl, '--audit-log', auditPath,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', () => {})
  child.stderr.on('data', c => { stderrText += c })
  let n = 0
  try {
    await waitFor(() => existsSync(join(relayDir, 'relay.ready')))
    const requestsDir = join(relayDir, 'requests')
    const responsesDir = join(relayDir, 'responses')
    const collect = (id: string) => waitFor(() => (existsSync(join(responsesDir, `${id}.json`)) ? readJson(join(responsesDir, `${id}.json`)) : null)) as Promise<Res>
    const send = async (method: string, path: string, body?: unknown, id = `r-${n++}`) => {
      writeFileSync(join(requestsDir, `${id}.json`), JSON.stringify({ id, method, path, body }))
      return collect(id)
    }
    const sendMany = async (reqs: Array<{ method: string; path: string; body?: unknown }>) => {
      const ids = reqs.map(() => `m-${String(n++).padStart(4, "0")}`)
      ids.forEach((id, i) => writeFileSync(join(requestsDir, `${id}.json`), JSON.stringify({ id, ...reqs[i] })))
      return Promise.all(ids.map(collect))
    }
    await fn({ send, sendMany, seen, cards, listBody, auditPath, relayDir, token, stderr: () => stderrText, hold, child })
  } finally {
    child.kill('SIGTERM')
    await exited(child)
    await new Promise(resolve => server.close(resolve))
    rmSync(work, { recursive: true, force: true })
  }
}

const T = 60_000

describe('relay enforcement', () => {
  it('N1 off-list endpoints are refused without a fetch', async () => {
    await withRelay(async ({ send, seen }) => {
      const cases: Array<[string, string]> = [
        ['GET', '/api/agents'], ['POST', '/api/approvals/1/approve'], ['GET', '/api/vault'],
        ['PUT', '/api/settings'], ['GET', '/api/hooks'], ['GET', '/api/config'],
        ['POST', '/api/agents/x/start'], ['POST', '/api/email/send'], ['DELETE', '/api/memories/1'],
        ['PUT', '/api/kanban/c1'], ['GET', '/api/kanban/assignees'], ['POST', '/api/telegram/reply'],
      ]
      for (const [method, path] of cases) {
        const r = await send(method, path, method === 'GET' ? undefined : {})
        expect([method, path, r.status, r.error]).toEqual([method, path, 403, 'endpoint not allowed'])
      }
      expect(seen).toEqual([])
    })
  }, T)

  it('N2 foreign identity is refused', async () => {
    await withRelay(async ({ send, seen, cards }) => {
      cards.set('c1', AGENT)
      const cases: Array<[string, string, unknown]> = [
        ['POST', '/api/memories', { agent_id: 'other', content: 'x' }],
        ['POST', '/api/messages', { from: 'other', to: 'a', content: 'x' }],
        ['POST', '/api/kanban/c1/comments', { author: 'other', content: 'x' }],
        ['POST', '/api/kanban/c1/move', { status: 'done', actor: 'other' }],
        ['GET', '/api/memories?agent=other', undefined],
        ['POST', '/api/memories/1/retract', { agent_id: 'other' }],
        ['POST', '/api/daily-log', { agent_id: 'other', content: 'x' }],
      ]
      for (const [method, path, body] of cases) {
        const r = await send(method, path, body)
        expect([path, r.status, r.error]).toEqual([path, 403, 'identity mismatch'])
      }
      expect(seen).toEqual([])
    })
  }, T)

  it('N3 not own card', async () => {
    await withRelay(async ({ send, seen, cards }) => {
      cards.set('theirs', 'other')
      for (const id of ['theirs', 'ghost']) {
        const c = await send('POST', `/api/kanban/${id}/comments`, { author: AGENT, content: 'hi' })
        expect([c.status, c.error]).toEqual([403, 'not your card'])
        const m = await send('POST', `/api/kanban/${id}/move`, { status: 'done', actor: AGENT })
        expect([m.status, m.error]).toEqual([403, 'not your card'])
      }
      expect(seen.length).toBe(4)
      expect(seen.every(s => s.method === 'GET' && /^\/api\/kanban\/(theirs|ghost)$/.test(s.url ?? ''))).toBe(true)
    })
  }, T)

  it('P1 each allowed row reaches the dashboard as built by the relay', async () => {
    await withRelay(async ({ send, seen, cards, token }) => {
      cards.set('c1', 'Relay-Agent')
      const ok = (r: Res) => expect([r.status, r.error]).toEqual([200, undefined])
      ok(await send('GET', '/api/kanban?status=planned&limit=5'))
      ok(await send('POST', '/api/kanban/c1/comments', { author: AGENT, content: 'hello' }))
      ok(await send('POST', '/api/kanban/c1/move', { status: 'done', actor: AGENT, expected_status: 'waiting', evidence: 'e' }))
      ok(await send('POST', '/api/memories', { agent_id: AGENT, content: 'm', category: 'hot', keywords: 'k', supersedes: [1, 2], allow_duplicate: true }))
      ok(await send('GET', `/api/memories?agent=${AGENT}&q=foo%20bar&mode=fts&category=warm&limit=10`))
      ok(await send('POST', '/api/memories/12/retract', { agent_id: AGENT }))
      ok(await send('POST', '/api/daily-log', { agent_id: AGENT, content: 'log' }))
      ok(await send('POST', '/api/messages', { from: AGENT, to: 'peer/sub', content: 'msg' }))
      const calls = seen.map(s => [s.method, s.url, s.body ? JSON.parse(s.body) : null])
      expect(calls).toEqual([
        ['GET', '/api/kanban?assignee=relay-agent&status=planned', null],
        ['GET', '/api/kanban/c1', null],
        ['POST', '/api/kanban/c1/comments', { author: AGENT, content: 'hello' }],
        ['GET', '/api/kanban/c1', null],
        ['POST', '/api/kanban/c1/move', { status: 'done', actor: AGENT, expected_status: 'waiting', evidence: 'e' }],
        ['POST', '/api/memories', { agent_id: AGENT, content: 'm', category: 'hot', keywords: 'k', supersedes: [1, 2], allow_duplicate: true }],
        ['GET', '/api/memories?agent=relay-agent&q=foo+bar&mode=fts&category=warm&limit=10', null],
        ['POST', '/api/memories/12/retract', { agent_id: AGENT }],
        ['POST', '/api/daily-log', { agent_id: AGENT, content: 'log' }],
        ['POST', '/api/messages', { from: AGENT, to: 'peer/sub', content: 'msg' }],
      ])
      expect(seen.every(s => s.authorization === `Bearer ${token}`)).toBe(true)
    })
  }, T)

  it('P2 kanban.list filters to own cards and honours limit', async () => {
    await withRelay(async ({ send, seen, listBody }) => {
      listBody.value = [
        { id: 'a', assignee: 'other' }, { id: 'b', assignee: 'Relay-Agent' },
        { id: 'c', assignee: 'relay-agent' }, { id: 'd', assignee: 'other' },
      ]
      const all = await send('GET', '/api/kanban')
      expect(all.body.map((c: any) => c.id)).toEqual(['b', 'c'])
      const one = await send('GET', '/api/kanban?status=waiting&limit=1')
      expect(one.body.map((c: any) => c.id)).toEqual(['b'])
      expect(seen[1].url).toBe('/api/kanban?assignee=relay-agent&status=waiting')
    })
  }, T)

  it('S1 schema violations', async () => {
    await withRelay(async ({ send, seen, cards }) => {
      cards.set('c1', AGENT)
      let r = await send('POST', '/api/daily-log', { agent_id: AGENT, content: 'x', bogus: 1 })
      expect([r.status, r.error]).toEqual([400, 'schema: bogus'])
      r = await send('POST', '/api/kanban/c1/move', { status: 'nope', actor: AGENT })
      expect([r.status, r.error]).toEqual([400, 'schema: status'])
      r = await send('POST', '/api/daily-log?x=1', { agent_id: AGENT, content: 'x' })
      expect(r.status).toBe(400)
      r = await send('POST', '/api/memories', { agent_id: AGENT, content: 'x', scope: 'fleet' })
      expect([r.status, r.error]).toEqual([400, 'schema: scope'])
      r = await send('GET', '/api/kanban?foo=1')
      expect(r.status).toBe(400)
      expect(seen).toEqual([])
    })
  }, T)

  it('Z1 size limits', async () => {
    await withRelay(async ({ send, seen, relayDir }) => {
      let r = await send('POST', '/api/memories', { agent_id: AGENT, content: 'a'.repeat(8193) })
      expect([r.status, r.error]).toEqual([413, 'too large: content'])
      r = await send('POST', '/api/messages', { from: AGENT, to: 'p', content: 'a'.repeat(16385) })
      expect([r.status, r.error]).toEqual([413, 'too large: content'])
      r = await send('POST', '/api/daily-log', { agent_id: AGENT, content: 'a'.repeat(70000) })
      expect([r.status, r.error]).toEqual([413, 'body too large'])
      const id = 'huge-1'
      writeFileSync(join(relayDir, 'requests', `${id}.json`), JSON.stringify({ id, method: 'POST', path: '/api/daily-log', body: { agent_id: AGENT, content: 'a'.repeat(140000) } }))
      r = await waitFor(() => (existsSync(join(relayDir, 'responses', `${id}.json`)) ? readJson(join(relayDir, 'responses', `${id}.json`)) : null))
      expect([r.status, r.error]).toEqual([413, 'request too large'])
      expect(readdirSync(join(relayDir, 'requests'))).toEqual([])
      expect(seen).toEqual([])
    })
  }, T)

  it('R1 rate limits', async () => {
    await withRelay(async ({ sendMany, seen }) => {
      const res = await sendMany(Array.from({ length: 31 }, () => ({ method: 'POST', path: '/api/daily-log', body: { agent_id: AGENT, content: 'x' } })))
      const limited = res.filter(r => r.status === 429)
      expect(limited.length).toBe(1)
      expect(limited[0].error).toBe('rate limited')
      expect(seen.length).toBe(30)
    })
    await withRelay(async ({ sendMany, seen }) => {
      const res = await sendMany(Array.from({ length: 61 }, () => ({ method: 'GET', path: `/api/memories?agent=${AGENT}` })))
      expect(res.filter(r => r.status === 429).length).toBe(1)
      expect(res[60].status).toBe(429)
      expect(seen.length).toBe(60)
    })
  }, T)

  it('A1 audit log', async () => {
    await withRelay(async ({ send, auditPath, relayDir, token }) => {
      const secret = 'SECRET-BODY-CONTENT-xyz'
      await send('POST', '/api/daily-log', { agent_id: AGENT, content: secret })
      await send('GET', '/api/vault?key=QUERYSECRET')
      const text = await waitFor(() => (existsSync(auditPath) ? readFileSync(auditPath, 'utf-8') : null))
      const lines = text.trim().split('\n')
      expect(lines.length).toBe(2)
      const [a, b] = lines.map(l => JSON.parse(l))
      expect([a.decision, a.reason, a.route, a.status]).toEqual(['forwarded', null, 'daily.log', 200])
      expect([b.decision, b.reason, b.route, b.status, b.path]).toEqual(['denied', 'off-list', null, 403, '/api/vault'])
      expect(a.agent).toBe(AGENT)
      for (const bad of [token, secret, 'QUERYSECRET', 'Authorization']) expect(text).not.toContain(bad)
      expect(auditPath.startsWith(relayDir)).toBe(false)
    })
  }, T)

  it('A2 argv handling', async () => {
    const work = mkdtempSync(join(tmpdir(), 'marveen-relay-argv-'))
    try {
      const base = ['--agent', AGENT, '--relay-dir', join(work, 'relay'), '--token-file', join(work, 't'), '--dashboard-url', 'http://127.0.0.1:1']
      const run = async (args: string[]) => {
        const child = spawn(process.execPath, [RELAY_MJS, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
        let err = ''
        child.stderr.on('data', c => { err += c })
        const code = await exited(child)
        return { code, err }
      }
      const noAudit = await run(base)
      expect(noAudit.code).toBe(2)
      expect(noAudit.err).toContain('usage')
      const badDir = await run([...base, '--audit-log', join(work, 'missing', 'a.log')])
      expect(badDir.code).toBe(1)
      expect(badDir.err).toContain('audit')
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }, T)
})

describe('mcp-shim.mjs enforcement-side changes', () => {
  it('SH1 tool list and forced fields', async () => {
    const work = mkdtempSync(join(tmpdir(), 'marveen-shim-enf-'))
    const relayDir = join(work, 'relay')
    const requestsDir = join(relayDir, 'requests')
    const responsesDir = join(relayDir, 'responses')
    mkdirSync(requestsDir, { recursive: true })
    mkdirSync(responsesDir, { recursive: true })
    const child = spawn(process.execPath, [MCP_SHIM_MJS], { env: { MARVEEN_AGENT_NAME: 'shim-agent', MARVEEN_RELAY_DIR: relayDir } })
    let buf = ''
    const queue: any[] = []
    const waiters: Array<(m: any) => void> = []
    const drain = () => { while (queue.length && waiters.length) waiters.shift()!(queue.shift()) }
    child.stdout.on('data', chunk => {
      buf += chunk
      let nl
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line) { queue.push(JSON.parse(line)); drain() }
      }
    })
    const next = () => new Promise<any>(resolve => { waiters.push(resolve); drain() })
    const send = (m: unknown) => { child.stdin.write(`${JSON.stringify(m)}\n`) }
    let nextId = 1
    // Call a tool and answer its request file ourselves; returns the request.
    const call = async (name: string, args: Record<string, unknown>) => {
      const id = nextId++
      send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
      const file = await waitFor(() => {
        const files = readdirSync(requestsDir).filter(f => f.endsWith('.json'))
        return files.length ? join(requestsDir, files[0]) : null
      })
      const req = readJson(file)
      writeFileSync(join(responsesDir, `${req.id}.json`), JSON.stringify({ id: req.id, status: 200, body: { ok: true } }))
      await next()
      rmSync(file, { force: true })
      return req
    }
    try {
      send({ jsonrpc: '2.0', id: nextId++, method: 'initialize', params: {} })
      await next()
      send({ jsonrpc: '2.0', id: nextId++, method: 'tools/list' })
      const listed = await next()
      expect(listed.result.tools.map((t: { name: string }) => t.name)).toEqual([
        'marveen_kanban_query', 'marveen_kanban_comment_post', 'marveen_kanban_move', 'marveen_memory_save',
        'marveen_memory_search', 'marveen_memory_retract', 'marveen_daily_log_append', 'marveen_inter_agent_message',
      ])
      const search = await call('marveen_memory_search', { q: 'x', agent: 'other' })
      expect(new URLSearchParams(search.path.split('?')[1]).get('agent')).toBe('shim-agent')
      const save = await call('marveen_memory_save', { content: 'c', scope: 'fleet' })
      expect(save.body).not.toHaveProperty('scope')
      const move = await call('marveen_kanban_move', { card_id: 'c9', status: 'done', evidence: 'ev' })
      expect([move.method, move.path]).toEqual(['POST', '/api/kanban/c9/move'])
      expect(move.body).toEqual({ status: 'done', actor: 'shim-agent', evidence: 'ev' })
    } finally {
      child.kill()
      await exited(child)
      rmSync(work, { recursive: true, force: true })
    }
  }, T)
})

describe('relay request-file hardening', () => {
  const daily = (id: string) => JSON.stringify({ id, method: 'POST', path: '/api/daily-log', body: { agent_id: AGENT, content: 'log' } })
  const hasMkfifo = (() => { try { execFileSync('mkfifo', ['--version'], { stdio: 'ignore' }); return true } catch { return false } })()
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
  const collectFile = (relayDir: string, name: string) =>
    waitFor(() => (existsSync(join(relayDir, 'responses', name)) ? readJson(join(relayDir, 'responses', name)) : null)) as Promise<Res>

  it.skipIf(!hasMkfifo)('H1 FIFO entry does not stall the poll loop', async () => {
    await withRelay(async ({ send, seen, relayDir }) => {
      execFileSync('mkfifo', [join(relayDir, 'requests', 'a0.json')])
      const r = await send('POST', '/api/daily-log', { agent_id: AGENT, content: 'log' }, 'b1')
      expect(r.status).toBe(200)
      const a0 = await collectFile(relayDir, 'a0.json')
      expect([a0.status, a0.error]).toEqual([400, 'invalid request'])
      expect(existsSync(join(relayDir, 'requests', 'a0.json'))).toBe(false)
      expect(seen.length).toBe(1)
    })
  }, T)

  it('H2 symlink entry is not followed', async () => {
    await withRelay(async ({ seen, relayDir }) => {
      const outside = mkdtempSync(join(tmpdir(), 'marveen-relay-out-'))
      try {
        const target = join(outside, 't.json')
        const content = '{"id":"hostid42","method":"GET","path":"/api/kanban"}'
        writeFileSync(target, content)
        symlinkSync(target, join(relayDir, 'requests', 's1.json'))
        const r = await collectFile(relayDir, 's1.json')
        expect([r.status, r.error]).toEqual([400, 'invalid request'])
        await waitFor(() => !existsSync(join(relayDir, 'requests', 's1.json')))
        expect(existsSync(join(relayDir, 'responses', 'hostid42.json'))).toBe(false)
        expect(readFileSync(target, 'utf-8')).toBe(content)
        expect(seen).toEqual([])
      } finally {
        rmSync(outside, { recursive: true, force: true })
      }
    })
  }, T)

  it('H3 hard-linked entry is refused', async () => {
    await withRelay(async ({ seen, relayDir }) => {
      const outside = mkdtempSync(join(tmpdir(), 'marveen-relay-out-'))
      try {
        const target = join(outside, 't.json')
        writeFileSync(target, daily('h1'))
        linkSync(target, join(relayDir, 'requests', 'h1.json'))
        const r = await collectFile(relayDir, 'h1.json')
        expect([r.status, r.error]).toEqual([400, 'invalid request'])
        expect(seen).toEqual([])
        expect(existsSync(target)).toBe(true)
      } finally {
        rmSync(outside, { recursive: true, force: true })
      }
    })
  }, T)

  it('H4 deeply nested body is refused as too large', async () => {
    await withRelay(async ({ seen, relayDir }) => {
      const n = 60000
      const raw = `{"id":"d1","method":"POST","path":"/api/daily-log","body":${'['.repeat(n)}${']'.repeat(n)}}`
      writeFileSync(join(relayDir, 'requests', 'd1.json'), raw)
      const r = await collectFile(relayDir, 'd1.json')
      expect([r.status, r.error]).toEqual([413, 'body too large'])
      expect(existsSync(join(relayDir, 'requests', 'd1.json'))).toBe(false)
      expect(seen).toEqual([])
    })
  }, T)

  it('H5 request is claimed before handling', async () => {
    await withRelay(async ({ seen, relayDir, auditPath }) => {
      mkdirSync(join(relayDir, 'responses', 'w1.json'))
      writeFileSync(join(relayDir, 'requests', 'w1.json'), daily('w1'))
      await sleep(2000)
      expect(seen.filter(s => s.method === 'POST' && s.url === '/api/daily-log').length).toBe(1)
      expect(existsSync(join(relayDir, 'requests', 'w1.json'))).toBe(false)
      expect(readFileSync(auditPath, 'utf-8')).toContain('"id":"w1"')
    })
  }, T)

  it('H6 invalid request method never reaches the audit log', async () => {
    await withRelay(async ({ relayDir, auditPath }) => {
      writeFileSync(join(relayDir, 'requests', 'a1.json'), '{"id":"a1","method":"QUERYSECRET","path":"/api/kanban"}')
      const r = await collectFile(relayDir, 'a1.json')
      expect([r.status, r.error]).toEqual([400, 'invalid request'])
      await waitFor(() => existsSync(auditPath) && readFileSync(auditPath, 'utf-8').includes('"a1"'))
      const audit = readFileSync(auditPath, 'utf-8')
      expect(audit).not.toContain('QUERYSECRET')
      expect(audit).toContain('"method":null')
    })
  }, T)

  it('H7 over-long id fails the structural check', async () => {
    await withRelay(async ({ seen, relayDir }) => {
      const id = 'x'.repeat(129)
      writeFileSync(join(relayDir, 'requests', 'long.json'), daily(id))
      const r = await collectFile(relayDir, 'invalid.json')
      expect([r.status, r.error]).toEqual([400, 'invalid request'])
      expect(seen).toEqual([])
    })
  }, T)

  it('H8 a non-empty directory entry is denied and audited once, not on every tick', async () => {
    await withRelay(async ({ send, relayDir, auditPath }) => {
      mkdirSync(join(relayDir, 'requests', 'dd1.json'))
      writeFileSync(join(relayDir, 'requests', 'dd1.json', 'keep'), 'x')
      const r = await collectFile(relayDir, 'dd1.json')
      expect([r.status, r.error]).toEqual([400, 'invalid request'])
      await sleep(2000)
      expect((await send('POST', '/api/daily-log', { agent_id: AGENT, content: 'log' }, 'e1')).status).toBe(200)
      expect(readFileSync(auditPath, 'utf-8').split('\n').filter(l => l.includes('"id":"dd1"')).length).toBe(1)
    })
  }, T)

  it('H9 an empty directory entry is removed', async () => {
    await withRelay(async ({ relayDir }) => {
      mkdirSync(join(relayDir, 'requests', 'dd2.json'))
      const r = await collectFile(relayDir, 'dd2.json')
      expect([r.status, r.error]).toEqual([400, 'invalid request'])
      await waitFor(() => !existsSync(join(relayDir, 'requests', 'dd2.json')))
    })
  }, T)

  it('H10 an unreadable empty directory entry is removed and denied once', async () => {
    await withRelay(async ({ relayDir, auditPath, stderr }) => {
      const d = join(relayDir, 'requests', 'u1.json')
      mkdirSync(d)
      chmodSync(d, 0o000)
      try {
        const r = await collectFile(relayDir, 'u1.json')
        expect([r.status, r.error]).toEqual([400, 'invalid request'])
        await waitFor(() => !existsSync(d))
        await sleep(1500)
        expect(readFileSync(auditPath, 'utf-8').split('\n').filter(l => l.includes('"id":"u1"')).length).toBe(1)
        expect(stderr().split('\n').filter(l => l.includes('u1.json')).length).toBe(0)
      } finally {
        try { chmodSync(d, 0o755) } catch { /* removed */ }
      }
    })
  }, T)

  it('H11 an unreadable non-empty directory entry is denied and audited once, without a stderr line on every tick', async () => {
    await withRelay(async ({ send, relayDir, auditPath, stderr }) => {
      const d = join(relayDir, 'requests', 'u2.json')
      mkdirSync(d)
      writeFileSync(join(d, 'keep'), 'x')
      chmodSync(d, 0o000)
      try {
        const r = await collectFile(relayDir, 'u2.json')
        expect([r.status, r.error]).toEqual([400, 'invalid request'])
        await sleep(2000)
        expect((await send('POST', '/api/daily-log', { agent_id: AGENT, content: 'log' }, 'e2')).status).toBe(200)
        expect(readFileSync(auditPath, 'utf-8').split('\n').filter(l => l.includes('"id":"u2"')).length).toBe(1)
        expect(stderr().split('\n').filter(l => l.includes('u2.json')).length).toBeLessThanOrEqual(1)
        expect(existsSync(d)).toBe(true)
      } finally {
        chmodSync(d, 0o755)
      }
    })
  }, T)

  it('H12 a request written under the same name while the first awaits the dashboard is not deleted unread', async () => {
    await withRelay(async ({ seen, relayDir, hold }) => {
      const p = join(relayDir, 'requests', 'n1.json')
      const body = (content: string) => JSON.stringify({ id: 'n1', method: 'POST', path: '/api/daily-log', body: { agent_id: AGENT, content } })
      hold.ms = 1500
      writeFileSync(p, body('first-one'))
      await waitFor(() => !existsSync(p))
      writeFileSync(p, body('second-one'))
      hold.ms = 0
      await sleep(4000)
      expect(seen.filter(s => s.url === '/api/daily-log' && s.body.includes('first-one')).length).toBe(1)
      expect(seen.filter(s => s.url === '/api/daily-log' && s.body.includes('second-one')).length).toBe(1)
      expect(existsSync(p)).toBe(false)
    })
  }, T)

  it('H13 a request the relay cannot remove is never forwarded, and is denied and audited once', async () => {
    await withRelay(async ({ seen, relayDir, auditPath, stderr }) => {
      writeFileSync(join(relayDir, 'requests', 'k1.json'), JSON.stringify({ id: 'k1', method: 'POST', path: '/api/daily-log', body: { agent_id: AGENT, content: 'unclaimable-k1' } }))
      chmodSync(join(relayDir, 'requests'), 0o555)
      try {
        const r = await collectFile(relayDir, 'k1.json')
        expect([r.status, r.error]).toEqual([500, 'request not claimable'])
        await sleep(2000)
        expect(seen.filter(s => s.body.includes('unclaimable-k1')).length).toBe(0)
        expect(readFileSync(auditPath, 'utf-8').split('\n').filter(l => l.includes('"id":"k1"')).length).toBe(1)
        expect(stderr().split('\n').filter(l => l.includes('k1.json')).length).toBeLessThanOrEqual(1)
      } finally {
        chmodSync(join(relayDir, 'requests'), 0o755)
      }
    })
  }, T)

  it('H14 an invalid request the relay cannot remove is denied and audited once, not on every tick', async () => {
    await withRelay(async ({ seen, relayDir, auditPath }) => {
      writeFileSync(join(relayDir, 'requests', 'k2.json'), JSON.stringify({ id: 'k2', method: 'POST', path: '/api/no-such-route', body: {} }))
      chmodSync(join(relayDir, 'requests'), 0o555)
      try {
        const r = await collectFile(relayDir, 'k2.json')
        expect([r.status, r.error]).toEqual([500, 'request not claimable'])
        await sleep(2000)
        expect(readFileSync(auditPath, 'utf-8').split('\n').filter(l => l.includes('"id":"k2"')).length).toBe(1)
        expect(seen.filter(s => s.url === '/api/no-such-route').length).toBe(0)
      } finally {
        chmodSync(join(relayDir, 'requests'), 0o755)
      }
    })
  }, T)

  it('a request whose claim loses with ENOENT is skipped without a forward, response or audit', async () => {
    await withRelay(async ({ seen, relayDir, auditPath }) => {
      const requestPath = join(relayDir, 'requests', 'claim1.json')
      writeFileSync(requestPath, JSON.stringify({
        id: 'claim1', method: 'POST', path: '/api/daily-log',
        body: { agent_id: AGENT, content: 'lost-claim1' },
      }))
      await waitFor(() => !existsSync(requestPath), 2000)
      await sleep(1500)
      expect(seen.filter(s => s.body.includes('lost-claim1'))).toHaveLength(0)
      expect(existsSync(join(relayDir, 'responses', 'claim1.json'))).toBe(false)
      expect(existsSync(auditPath) ? readFileSync(auditPath, 'utf-8') : '').not.toContain('"id":"claim1"')
    }, { preload: fileURLToPath(new URL('./fixtures/relay-claim-enoent-preload.mjs', import.meta.url)) })
  }, T)

  it('H15 a valid request written at the name of an entry the relay just removed is not deleted unread', async () => {
    await withRelay(async ({ seen, relayDir }) => {
      mkdirSync(join(relayDir, 'requests', 'race1.json'))
      await waitFor(() => seen.some(s => s.body.includes('INJECTED-race1')))
      expect(seen.filter(s => s.body.includes('INJECTED-race1')).length).toBe(1)
    }, { preload: fileURLToPath(new URL('./fixtures/relay-race-preload.mjs', import.meta.url)) })
  }, T)

  it('H16 two daemons on one spool forward every request exactly once (exclusive claim)', async () => {
    const work = mkdtempSync(join(tmpdir(), 'marveen-relay-two-'))
    const relayDir = join(work, 'relay')
    const requestsDir = join(relayDir, 'requests')
    const responsesDir = join(relayDir, 'responses')
    const tokenFile = join(work, 'agent.token')
    const auditPath = join(work, 'audit.log')
    const token = `tok-${randomBytes(16).toString('hex')}`
    writeFileSync(tokenFile, `${token}\n`)
    const seen: Seen[] = []
    const server: Server = createServer((req, res) => {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, body, authorization: req.headers.authorization })
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true }))
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const dashboardUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const args = ['--agent', AGENT, '--relay-dir', relayDir, '--token-file', tokenFile, '--dashboard-url', dashboardUrl, '--audit-log', auditPath]
    const spawnRelay = () => {
      const child = spawn(process.execPath, [RELAY_MJS, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout.on('data', () => {})
      child.stderr.on('data', () => {})
      return child
    }
    // The orphan case, not a simultaneous start: `b` starts only once the ready marker names `a`,
    // and then takes the marker over. Two daemons started at the same moment race on the marker's
    // exclusive create and the loser exits -- a start-order artefact, not the claim under test.
    const readyPid = () => { try { return readFileSync(join(relayDir, 'relay.ready'), 'utf8').trim() } catch { return null } }
    const a = spawnRelay()
    const started: ChildProcess[] = [a]
    try {
      await waitFor(() => readyPid() === String(a.pid))
      const b = spawnRelay()
      started.push(b)
      await waitFor(() => readyPid() === String(b.pid))
      // At most the relay's per-daemon write limit (WRITE_LIMIT, 30 per minute): one daemon may claim
      // every file, and past the limit it answers 429 without forwarding.
      const N = 30
      const ids = Array.from({ length: N }, (_, i) => `two-${String(i).padStart(3, '0')}`)
      ids.forEach(id => writeFileSync(join(requestsDir, `${id}.json`), JSON.stringify({ id, method: 'POST', path: '/api/daily-log', body: { agent_id: AGENT, content: id } })))
      await Promise.all(ids.map(id => waitFor(() => (existsSync(join(responsesDir, `${id}.json`)) ? id : null))))
      // One extra pass of the losing daemon's tick: a duplicate forward of an
      // already-answered request must land on the dashboard before we assert.
      await new Promise(resolve => setTimeout(resolve, 600))
      expect(a.exitCode).toBe(null)
      expect(b.exitCode).toBe(null)
      const forwards = seen.filter(s => (s.url ?? '').startsWith('/api/daily-log'))
      expect(forwards).toHaveLength(N)
      const counts = new Map<string, number>()
      for (const s of forwards) {
        const id = JSON.parse(s.body).content
        counts.set(id, (counts.get(id) ?? 0) + 1)
      }
      for (const id of ids) expect(counts.get(id)).toBe(1)
    } finally {
      for (const child of started) child.kill('SIGTERM')
      for (const child of started) await exited(child)
      await new Promise(resolve => server.close(resolve))
      rmSync(work, { recursive: true, force: true })
    }
  }, T)

  // The claimed directory is only the turnstile of the claim: the request entry is moved into it and
  // removed again at once, so no request content rests there, in flight or after the answer.
  const claimedDirOf = (relayDir: string, pid: number) => join(relayDir, 'claimed', String(pid))

  it('H17 nothing rests in the claimed directory, in flight or after the answer', async () => {
    await withRelay(async ({ send, seen, relayDir, hold, child }) => {
      if (child.pid === undefined) throw new Error('relay child has no pid')
      const claimedDir = claimedDirOf(relayDir, child.pid)
      const requestsDir = join(relayDir, 'requests')
      hold.ms = 1500
      const pending = send('POST', '/api/daily-log', { agent_id: AGENT, content: 'claimed-rest' }, 'rest1')
      await waitFor(() => (seen.some(s => s.body.includes('claimed-rest')) ? true : null))
      // The forward is in flight here (the dashboard holds its answer): the request is claimed already.
      expect(existsSync(join(requestsDir, 'rest1.json'))).toBe(false)
      expect(readdirSync(claimedDir)).toEqual([])
      expect((await pending).status).toBe(200)
      const denied = await send('POST', '/api/no-such-route', {}, 'rest2')
      expect([denied.status, denied.error]).toEqual([403, 'endpoint not allowed'])
      await sleep(500)
      expect(existsSync(join(requestsDir, 'rest2.json'))).toBe(false)
      expect(readdirSync(claimedDir)).toEqual([])
    })
  }, T)

  it('H18 the claimed directory of a daemon is removed when the daemon stops', async () => {
    await withRelay(async ({ relayDir, child }) => {
      if (child.pid === undefined) throw new Error('relay child has no pid')
      const claimedDir = claimedDirOf(relayDir, child.pid)
      expect(existsSync(claimedDir)).toBe(true)
      const stopped = exited(child)
      child.kill('SIGTERM')
      expect(await stopped).toBe(0)
      expect(existsSync(claimedDir)).toBe(false)
    })
  }, T)
})
