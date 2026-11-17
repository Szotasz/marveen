// REPLAYNOENVELOPE1114: what scripts/watchdog.sh does after it restarted a sub-agent's session. It used to call
// scripts/watchdog-replay.py, which typed the raw content of every delivered, not completed message into the pane:
// no envelope, no sender, no id, system directives and seen rows too. Now it types nothing. It sends ONE request
// that carries only the agent's name (POST /api/agents/<id>/redeliver-open, no body, no query), the server chooses
// the rows and the router delivers them. Pinned here:
//   - the replay script is gone and watchdog.sh neither calls it nor types into a pane;
//   - the request: one POST, the agent name in the path, nothing else from the caller;
//   - no redelivery is never silent: no token, dashboard not reachable, a non-200 answer and a 200 without a count
//     each write a line to the watchdog log;
//   - a 200 writes the count the server returned, and stays quiet on zero.
// The function is cut out of the real file and run against a local capture server, with a tmux stub first on PATH
// that records every call (there must be none). watchdog.sh is not run whole: it restarts sessions.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, chmodSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const WATCHDOG = readFileSync(join(REPO, 'scripts', 'watchdog.sh'), 'utf-8')
const TOKEN = 'redeliver-test-token-0123456789abcdef'
const dir = mkdtempSync(join(tmpdir(), 'watchdog-redeliver-'))
const stubDir = join(dir, 'bin')
mkdirSync(stubDir)
const tmuxLog = join(dir, 'tmux-calls.log')
writeFileSync(join(stubDir, 'tmux'), `#!/bin/bash\nprintf '%s\\n' "$*" >> "${tmuxLog}"\n`)
chmodSync(join(stubDir, 'tmux'), 0o755)
const PATH = `${stubDir}:${process.env.PATH}`

interface Seen { method: string; url: string; body: string; contentLength: string | undefined }
let seen: Seen[] = []
let answer: { status: number; body: string } = { status: 200, body: '{"ok":true,"requeued":0,"ids":[]}' }
let api: Server
const port = () => (api.address() as AddressInfo).port

beforeAll(async () => {
  api = await new Promise((resolve) => {
    const s = createServer((req, res) => {
      let b = ''
      req.on('data', (c) => { b += c })
      req.on('end', () => {
        seen.push({ method: req.method!, url: req.url!, body: b, contentLength: req.headers['content-length'] })
        res.writeHead(answer.status, { 'Content-Type': 'application/json' })
        res.end(answer.body)
      })
    })
    s.listen(0, '127.0.0.1', () => resolve(s))
  })
})
afterAll(() => {
  api.close()
  rmSync(dir, { recursive: true, force: true })
})
beforeEach(() => {
  seen = []
  answer = { status: 200, body: '{"ok":true,"requeued":0,"ids":[]}' }
  writeFileSync(tmuxLog, '')
})

/** The real file's text from [start] (included) to [end] (excluded); both must be there exactly once. */
function cut(start: string, end: string): string {
  const a = WATCHDOG.indexOf(start)
  expect(a, start).toBeGreaterThanOrEqual(0)
  expect(WATCHDOG.indexOf(start, a + 1), `${start} twice`).toBe(-1)
  const b = WATCHDOG.indexOf(end, a + start.length)
  expect(b, end).toBeGreaterThan(a)
  return WATCHDOG.slice(a, b)
}

/** A fresh install root; runs the real function once for agent-a and returns what the watchdog log holds. */
async function run(opts: { token?: boolean; webPort?: number } = {}): Promise<{ code: number; out: string; log: string }> {
  const r = mkdtempSync(join(dir, 'root-'))
  mkdirSync(join(r, 'store'))
  if (opts.token !== false) writeFileSync(join(r, 'store', '.dashboard-token'), TOKEN + '\n')
  const body = cut('TOKEN=""\n', '\n# ── Dashboard')
  const h = join(r, 'harness.sh')
  writeFileSync(h, [`INSTALL_DIR="${r}"`, `LOG="${r}/watchdog.log"`, `WEB_PORT=${opts.webPort ?? port()}`,
    "timestamp() { echo 'TS'; }", body, 'request_open_redelivery agent-a', 'echo "harness done"'].join('\n') + '\n')
  const res = await new Promise<{ code: number; out: string }>((resolve) => {
    execFile('bash', [h], { env: { PATH }, timeout: 30_000 },
      (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, out: stdout + stderr }))
  })
  const logPath = join(r, 'watchdog.log')
  return { ...res, log: existsSync(logPath) ? readFileSync(logPath, 'utf-8') : '' }
}

describe('watchdog.sh types nothing into a pane any more', () => {
  it('the Python replay script is gone, and nothing in scripts/ calls it', () => {
    expect(existsSync(join(REPO, 'scripts', 'watchdog-replay.py'))).toBe(false)
    expect(WATCHDOG).not.toContain('watchdog-replay')
    expect(WATCHDOG).not.toContain('replay_unfinished_messages')
  })

  it('watchdog.sh has no tmux typing call at all, and does not read message content', () => {
    const code = WATCHDOG.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
    expect(code).not.toMatch(/\b(?:send-keys|paste-buffer|load-buffer|set-buffer)\b/)
    // the old path read the agent's message list; the script must not fetch message rows any more
    expect(code).not.toContain('/api/messages')
  })

  it('after a confirmed restart it calls the request with the agent id only', () => {
    // the sub-agent loop's line (the main session's own "restarted OK" never asked for a replay, and still does not)
    const at = WATCHDOG.indexOf('$AGENT_ID restarted OK')
    expect(at).toBeGreaterThan(0)
    expect(WATCHDOG.indexOf('$AGENT_ID restarted OK', at + 1)).toBe(-1)
    expect(WATCHDOG.slice(at, at + 200)).toMatch(/\n\s*request_open_redelivery "\$AGENT_ID"\n/)
    expect(WATCHDOG.match(/^\s*request_open_redelivery .*$/gm)).toEqual(['    request_open_redelivery "$AGENT_ID"'])
  })
})

describe('the request: one POST that carries only the agent name', () => {
  it('POST to the agent\'s redeliver-open path, no body, no query, and tmux is never called', async () => {
    const r = await run()
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('harness done')
    expect(seen.map((s) => [s.method, s.url, s.body])).toEqual([['POST', '/api/agents/agent-a/redeliver-open', '']])
    // curl sends no Content-Length (or a zero one) for a POST without data: nothing rides in the body
    expect(['0', undefined]).toContain(seen[0].contentLength)
    expect(readFileSync(tmuxLog, 'utf-8')).toBe('')
  })

  it('a 200 with nothing put back is quiet: no line in the watchdog log', async () => {
    const r = await run()
    expect(r.code, r.out).toBe(0)
    expect(seen).toHaveLength(1)
    expect(r.log).toBe('')
  })

  it('a 200 with rows put back writes one line with the server\'s count', async () => {
    answer = { status: 200, body: '{"ok":true,"requeued":3,"ids":[11,12,13]}' }
    const r = await run()
    expect(r.code, r.out).toBe(0)
    expect(r.log).toBe('TS [watchdog] agent-a: 3 uzenet visszateve ujrakezbesitesre (redeliver-open)\n')
    expect(readFileSync(tmuxLog, 'utf-8')).toBe('')
  })
})

describe('no redelivery is a line in the watchdog log, never silent', () => {
  it('no token file: nothing is sent, and the log says so', async () => {
    const r = await run({ token: false })
    expect(r.code, r.out).toBe(0)
    expect(seen).toHaveLength(0)
    expect(r.log).toBe('TS [watchdog] agent-a: nincs dashboard token, ujrakezbesites kihagyva\n')
  })

  it('the dashboard is not reachable: the log says so', async () => {
    // a port nothing listens on: bind one, read its number, close it
    const closed = await new Promise<number>((resolve) => {
      const s = createServer()
      s.listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => resolve(p)) })
    })
    const r = await run({ webPort: closed })
    expect(r.code, r.out).toBe(0)
    expect(seen).toHaveLength(0)
    expect(r.log).toBe('TS [watchdog] agent-a: dashboard nem erheto el, ujrakezbesites kihagyva\n')
  })

  it.each([400, 401, 404, 500, 503])('a %i answer: the log names the code, and its body is not read as a count', async (status) => {
    // the body carries a count on purpose: a non-200 must not be taken for a redelivery
    answer = { status, body: '{"error":"x","requeued":7}' }
    const r = await run()
    expect(r.code, r.out).toBe(0)
    expect(seen).toHaveLength(1)
    expect(r.log).toBe(`TS [watchdog] agent-a: redeliver-open HTTP ${status}, ujrakezbesites kihagyva\n`)
  })

  it('a 200 whose body has no count: the log says so instead of claiming a redelivery', async () => {
    answer = { status: 200, body: '<html>proxy page</html>' }
    const r = await run()
    expect(r.code, r.out).toBe(0)
    expect(r.log).toBe('TS [watchdog] agent-a: redeliver-open HTTP 200, de a valaszban nincs requeued szam\n')
  })
})
