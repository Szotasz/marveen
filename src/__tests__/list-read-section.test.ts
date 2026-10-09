// c4e47223 (2): the list-read rule that ships to every agent's CLAUDE.md.
//
// A negative claim read off a list endpoint ("no such card", "0 pending") is only
// true when the response was complete. During a dashboard stop the request is cut
// or unanswered, `curl -s` stays quiet, and the head of a cut body can pass for a
// shorter list with a line counter. The rule tells the reader to measure the curl
// exit code and the HTTP code separately and to read the body with a strict JSON
// parser.
//
// Three parts: what the section says; the idempotent insert/update and the two
// call sites (mirrors message-close-section.test.ts); and the recipe itself RUN
// against a local server -- whole body, a connection cut mid-body, no server --
// so the codes the section quotes (0/200, 18, 7/000) are measured, not recalled.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-listread-test-'))

vi.mock('../config.js', () => ({
  STORE_DIR: '/nonexistent/claudeclaw-test-store',
  PROJECT_ROOT: tmpRoot,
  OWNER_NAME: 'TestOwner',
  MAIN_AGENT_ID: 'agent-a',
  BOT_NAME: 'agent-a',
  CHANNEL_PROVIDER: 'telegram',
  WEB_PORT: 3420,
  OWNER_DRIVE_FOLDER: '',
  DASHBOARD_PUBLIC_URL: '',
  AGENT_API_ORIGIN: '',
  APP_TZ: 'Europe/Budapest',
}))

vi.mock('../web/agent-config.js', () => ({
  agentDir: (name: string) => join(tmpRoot, 'agents', name),
  agentConfigRoot: () => join(tmpRoot, 'agents'),
  listAgentNames: () => ['agent-a', 'agent-b'],
  readAgentCapabilities: () => [],
}))

vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: (path: string, content: string) => writeFileSync(path, content, 'utf-8'),
}))

const { ensureListReadSection, buildListReadBody } = await import('../web/agent-scaffold.js')

const BEGIN = '<!-- BEGIN GENERATED: list-read (auto-generated, do not edit by hand) -->'
const END = '<!-- END GENERATED: list-read -->'

function setup(agent: string, content: string) {
  const dir = join(tmpRoot, 'agents', agent)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'CLAUDE.md'), content, 'utf-8')
}
const read = (agent: string) => readFileSync(join(tmpRoot, 'agents', agent, 'CLAUDE.md'), 'utf-8')

describe('list-read section: what it says (c4e47223)', () => {
  const body = buildListReadBody('agent-b')

  it('a negative claim only from a complete response', () => {
    expect(body).toMatch(/NEMLEGES[\s\S]{0,160}TELJES/)
    expect(body).toMatch(/nemleges lelet TILOS/)
  })

  it('the recipe measures the curl exit code and the HTTP code separately, body to a file', () => {
    // One file per agent, overwritten on every read: nothing piles up in /tmp and no cleanup `rm` is needed.
    expect(body).toMatch(/-o \/tmp\/lista-agent-b\.json -w '%\{http_code\}'/)
    expect(body).toMatch(/\); rc=\$\?/)
    expect(body).toMatch(/Authorization: Bearer \$\(cat /)
  })

  it('the body is read with a strict JSON parser, and counts come from it, not from grep', () => {
    expect(body).toContain('json.load(')
    expect(body).toMatch(/ne `grep`-pel/)
  })

  it('names the three failure codes the recipe can show', () => {
    expect(body).toMatch(/`rc=18` a félbeszakadt/)
    expect(body).toMatch(/`rc=7` a kapcsolat hiánya/)
    expect(body).toMatch(/`000` a válasz nélküli/)
  })

  // From the review: rc=0 + http=200 + a parsed body is a whole RESPONSE, and a
  // response the server cut at its limit passes all three. The section used to
  // call that a complete list, with /api/messages as its example.
  it('a whole response is not called a whole list any more', () => {
    expect(body).not.toMatch(/A lista csak akkor teljes, ha `rc=0`/)
    expect(body).toMatch(/A VÁLASZ csak akkor ép, ha `rc=0`, `http=200`/)
    expect(body).toMatch(/Az ép válasz még NEM teljes lista/)
    expect(body).toMatch(/a lista a korlátnál áll\), nemleges lelet TILOS/)
  })

  it('names each list endpoint\'s server-side limit (the numbers: list-read-limits.test.ts)', () => {
    const bullet = (endpoint: string) => {
      const start = body.indexOf(`  - \`GET ${endpoint}\``)
      expect(start, `no bullet for ${endpoint}`).toBeGreaterThanOrEqual(0)
      const next = body.indexOf('\n  - ', start + 1)
      const end = next >= 0 ? next : body.indexOf('\n- ', start + 1)
      return body.slice(start, end)
    }
    expect(bullet('/api/kanban')).toMatch(/korlát nélkül/)
    expect(bullet('/api/kanban')).toMatch(/X-Total-Count/)
    expect(bullet('/api/kanban/archived')).toMatch(/KANBAN_ARCHIVED_MAX_ROWS` beállítás \(alapérték 500,\s+legfeljebb 5000\)/)
    expect(bullet('/api/kanban/archived')).toMatch(/`total < limit` a teljes, `total = limit` csonka lehet/)
    // Only status=pending filters; every other value is silently ignored.
    expect(bullet('/api/messages?agent=')).toMatch(/CSAK a `status=pending` szűr, és az a teljes függő sort adja, korlát nélkül/)
    expect(bullet('/api/messages?agent=')).toMatch(/HATÁSTALAN/)
    expect(bullet('/api/messages?agent=')).toMatch(/alapból 50, legfeljebb 200 sor/)
    expect(bullet('/api/messages?agent=')).toMatch(/`before=<a kapott legkisebb id>`/)
    expect(bullet('/api/memories')).toMatch(/alapból 50, legfeljebb 200 sor/)
    expect(bullet('/api/memories')).toMatch(/`truncated=true`-t mond a korlátnál \(lapozás: `offset=`\)/)
  })
})

describe('list-read section: idempotent insert and update', () => {
  it('appends the block once, and a second run changes nothing', () => {
    setup('agent-b', '# Agent B\n\nexisting text\n')
    ensureListReadSection('agent-b')
    const once = read('agent-b')
    expect(once).toContain('existing text')
    expect(once.split(BEGIN).length - 1).toBe(1)
    expect(once).toContain(END)
    ensureListReadSection('agent-b')
    expect(read('agent-b')).toBe(once)
  })

  it('replaces a stale block in place instead of adding a second one', () => {
    setup('agent-c', `# C\n\n${BEGIN}\nold wording\n${END}\n\ntail\n`)
    ensureListReadSection('agent-c')
    const out = read('agent-c')
    expect(out).not.toContain('old wording')
    expect(out.split(BEGIN).length - 1).toBe(1)
    expect(out).toContain('tail')
  })

  it('the main agent is written at PROJECT_ROOT/CLAUDE.md', () => {
    writeFileSync(join(tmpRoot, 'CLAUDE.md'), '# Main\n', 'utf-8')
    ensureListReadSection('agent-a')
    expect(readFileSync(join(tmpRoot, 'CLAUDE.md'), 'utf-8')).toContain(BEGIN)
  })
})

describe('list-read section: wired to BOTH surfaces', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const live = (rel: string) => readFileSync(join(here, '..', rel), 'utf-8')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')

  it('web.ts ensures it for the main agent at boot', () => {
    expect(live('web.ts')).toMatch(/^\s*ensureListReadSection\(MAIN_AGENT_ID\)/m)
  })

  it('agent-process.ts ensures it for every agent start', () => {
    expect(live('web/agent-process.ts')).toMatch(/^\s*ensureListReadSection\(name\)/m)
  })
})

// The recipe's two shell lines, taken from the section itself and pointed at a
// local origin: the claims in the text are only as good as what the lines do.
function recipeFor(origin: string): string {
  const body = buildListReadBody('agent-b')
  const lines = body.split('\n')
  const start = lines.indexOf('```bash')
  const end = lines.indexOf('```', start + 1)
  expect(start).toBeGreaterThanOrEqual(0)
  const script = lines.slice(start + 1, end).join('\n')
  // The section interpolates the install's own origin; the probe server stands in for it.
  const m = script.match(/(\S+)\/api\/kanban\)/)
  expect(m).not.toBeNull()
  // ...and the body file lands in the test's own directory, not in the shared /tmp.
  expect(script.split('/tmp/lista-agent-b.json').length - 1).toBe(2)
  return script.replace(`${m![1]}/api/kanban`, `${origin}/api/kanban`).split('/tmp/lista-agent-b.json').join(join(tmpRoot, 'lista-agent-b.json'))
}

function runBash(script: string, tokenDir: string): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', script], { cwd: tokenDir })
    let stdout = ''
    child.stdout.on('data', (d) => { stdout += String(d) })
    child.on('close', (code) => resolve({ stdout, code }))
  })
}

const CARDS = JSON.stringify(Array.from({ length: 300 }, (_, i) => ({ id: `c${i}`, title: 'x'.repeat(2000) })))

async function withServer(handler: http.RequestListener, fn: (origin: string) => Promise<void>) {
  const server = http.createServer(handler)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const { port } = server.address() as AddressInfo
  try { await fn(`http://127.0.0.1:${port}`) } finally { server.close() }
}

describe('list-read section: the recipe, run (curl + bash)', () => {
  // The recipe reads the token with $(cat <token path>); the mocked config puts it under tmpRoot.
  mkdirSync(join(tmpRoot, 'store'), { recursive: true })
  writeFileSync(join(tmpRoot, 'store', '.dashboard-token'), 'test-token\n', 'utf-8')

  it('a whole list: rc=0, http=200, and the strict reader counts every card', async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(CARDS)
    }, async (origin) => {
      const { stdout } = await runBash(recipeFor(origin), tmpRoot)
      expect(stdout).toContain('rc=0 http=200')
      expect(stdout.trim().split('\n').pop()).toBe('300')
    })
  }, 20_000)

  it('a list cut mid-body: rc=18, and the strict reader refuses it (no count comes out)', async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.write(CARDS.slice(0, CARDS.length >> 1))
      setTimeout(() => res.socket?.destroy(), 20)
    }, async (origin) => {
      const { stdout } = await runBash(recipeFor(origin), tmpRoot)
      expect(stdout).toMatch(/rc=18 http=200/)
      expect(stdout.trim().split('\n').pop()).toMatch(/^rc=18/)
    })
  }, 20_000)

  it('no server at all: rc=7 and http=000', async () => {
    const probe = http.createServer()
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()))
    const { port } = probe.address() as AddressInfo
    await new Promise<void>((r) => probe.close(() => r()))
    const { stdout } = await runBash(recipeFor(`http://127.0.0.1:${port}`), tmpRoot)
    expect(stdout).toContain('rc=7 http=000')
  }, 20_000)
})
