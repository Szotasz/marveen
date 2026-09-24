// TOOLLOGVAKSIKER921: tool_call_log.success was 1 on all 2948 rows of the
// live table, including rows for calls that had failed. Measured 2026-09-21 on
// Claude Code 2.1.278 with a payload-dumping hook in a scratch project: of
// three Bash calls (exit 1, exit 3, exit 0) PostToolUse fired ONCE, for the
// success; the two failures fired PostToolUseFailure, whose payload has an
// `error` string and `is_interrupt` and no `tool_response`. The capture hook
// was registered under PostToolUse only, so failures were never logged at all.
//
// These tests run the real hook script as a subprocess against a fake
// /api/tool-log endpoint and pin what it SENDS: success=false for a
// PostToolUseFailure payload, success=true for a plain Bash PostToolUse
// payload (whose tool_response has no is_error key), and the older
// tool_response.is_error signal still honoured. A copy of the hook runs from a
// temp project root so the test never touches the install's store/.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')

let tmpRoot: string
let hookCopy: string
let server: Server
let port: number
const posts: Array<{ path: string; body: any }> = []

beforeAll(async () => {
  // Hook copy under <tmp>/scripts/hooks so its own _project_root() resolves
  // to <tmp>, where we plant the dashboard token it insists on.
  tmpRoot = mkdtempSync(join(tmpdir(), 'toollog-'))
  const hooksDir = join(tmpRoot, 'scripts', 'hooks')
  mkdirSync(hooksDir, { recursive: true })
  mkdirSync(join(tmpRoot, 'store'), { recursive: true })
  for (const f of ['tool-log-capture.py', 'ledger_lib.py']) {
    copyFileSync(join(ROOT, 'scripts', 'hooks', f), join(hooksDir, f))
  }
  hookCopy = join(hooksDir, 'tool-log-capture.py')
  writeFileSync(join(tmpRoot, 'store', '.dashboard-token'), 'test-token\n')

  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      posts.push({ path: req.url ?? '', body: raw ? JSON.parse(raw) : null })
      res.setHeader('content-type', 'application/json')
      res.end('{"ok":true}')
    })
  })
  // No host: dual-stack listen. The hook connects to `localhost`, which on
  // macOS resolves to ::1 first -- a server bound to 127.0.0.1 alone is
  // unreachable for it and the hook swallows the refusal (measured 07:32).
  await new Promise<void>((resolve) => server.listen(0, resolve))
  port = (server.address() as { port: number }).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(tmpRoot, { recursive: true, force: true })
})

// Async on purpose: the fake endpoint lives in THIS process, and a synchronous
// spawn would block the event loop that has to answer the hook's POST -- the
// hook then hits its own 3 s timeout, swallows it, and nothing is recorded
// (measured 07:32: three 3-second tests, zero posts).
function runHook(payload: Record<string, unknown>): Promise<number> {
  return new Promise((resolve) => {
    const child = execFile(
      'python3',
      [hookCopy],
      { encoding: 'utf-8', env: { ...process.env, WEB_PORT: String(port), MARVEEN_AGENT_ID: 'test-agent' } },
      (err: any) => resolve(err ? (typeof err.code === 'number' ? err.code : 1) : 0),
    )
    child.stdin?.end(JSON.stringify(payload))
  })
}

function lastToolLogPost(): any {
  const rows = posts.filter((p) => p.path === '/api/tool-log')
  return rows[rows.length - 1]?.body
}

const base = {
  session_id: 'sess-1',
  cwd: '/nowhere',
  permission_mode: 'default',
  tool_name: 'Bash',
  tool_use_id: 'toolu_fail_1',
  duration_ms: 82,
}

describe('tool-log-capture: success is derived from the hook event', () => {
  it('logs success=false for a PostToolUseFailure payload (the real failure shape)', async () => {
    const status = await runHook({
      ...base,
      hook_event_name: 'PostToolUseFailure',
      tool_input: { command: 'ls /nincs-ilyen-konyvtar-42' },
      error: 'Exit code 1\nls: /nincs-ilyen-konyvtar-42: No such file or directory',
      is_interrupt: false,
    })
    expect(status).toBe(0)
    const sent = lastToolLogPost()
    expect(sent).toBeTruthy()
    expect(sent.success).toBe(false)
    expect(sent.tool_name).toBe('Bash')
    expect(sent.trace_id).toBe('toolu_fail_1')
    expect(sent.duration_ms).toBe(82)
    expect(sent.agent_id).toBe('test-agent')
  })

  it('logs success=true for a plain Bash PostToolUse payload, whose tool_response has no is_error', async () => {
    await runHook({
      ...base,
      tool_use_id: 'toolu_ok_1',
      hook_event_name: 'PostToolUse',
      tool_input: { command: 'echo positive-control-ok' },
      tool_response: { stdout: 'positive-control-ok', stderr: '', interrupted: false, isImage: false, noOutputExpected: false },
    })
    const sent = lastToolLogPost()
    expect(sent.trace_id).toBe('toolu_ok_1')
    expect(sent.success).toBe(true)
  })

  it('still honours tool_response.is_error inside a PostToolUse payload', async () => {
    await runHook({
      ...base,
      tool_use_id: 'toolu_iserr_1',
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__x__y',
      tool_input: { q: 'x' },
      tool_response: { is_error: true, content: 'boom' },
    })
    const sent = lastToolLogPost()
    expect(sent.trace_id).toBe('toolu_iserr_1')
    expect(sent.success).toBe(false)
  })

  it('exits 0 on the failure event too, so the hook never turns a failed call into a hook error', async () => {
    expect(await runHook({ ...base, hook_event_name: 'PostToolUseFailure', tool_input: {}, error: 'x' })).toBe(0)
  })
})
