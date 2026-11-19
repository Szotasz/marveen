import { describe, it, expect, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pythonHookCommand, isUnsafeHookCommand, resolveTemplatePlaceholders } from '../web/agent-scaffold.js'
import { PROJECT_ROOT } from '../config.js'

// CODEMODEFLAG1119: in Code Mode the REPL tool runs JS in a vm that Claude Code seals (measured on 2.1.326, card
// CODEMODEFLAG1119 comment 33384). The seal is Claude Code's, so the gate is a version canary: a REPL call is allowed
// only when the running version (read from the tail of transcript_path) is in the measured set. A read error and a
// version mismatch deny with two distinct messages, since their fixes differ.

const GATE = join(PROJECT_ROOT, 'scripts', 'hooks', 'repl-code-gate.py')
const FIXTURE = join(__dirname, 'fixtures', 'repl-code-gate-payloads.json')
const TMP = mkdtempSync(join(tmpdir(), 'repl-code-gate-'))
afterAll(() => rmSync(TMP, { recursive: true, force: true }))

const READ_ERROR = 'OLVASASI HIBA, nem verzio-elteres'
const MISMATCH = 'MEASURED_VERSIONS'

function runRaw(input: string) {
  const r = spawnSync('python3', ['-I', '-S', GATE], { input, encoding: 'utf-8', timeout: 15_000 })
  return { rc: r.status, stderr: r.stderr }
}

function runShell(command: string, input: string) {
  const r = spawnSync('/bin/sh', ['-c', command], { input, encoding: 'utf-8', timeout: 15_000 })
  return { rc: r.status, stderr: r.stderr }
}

// Rows shaped like a real 2.1.326 Code Mode transcript (Dani's probe): bookkeeping rows carry no version, message,
// attachment and api-request rows do.
const SID = '00000000-0000-0000-0000-000000000000'
const row = {
  mode: () => ({ type: 'mode', mode: 'normal', sessionId: SID }),
  permissionMode: () => ({ type: 'permission-mode', permissionMode: 'bypassPermissions', sessionId: SID }),
  replMode: () => ({ type: 'repl-mode', replMode: true, sessionId: SID }),
  atisLatch: () => ({ type: 'atis-latch', atis: '', sessionId: SID }),
  snapshot: () => ({ type: 'file-history-snapshot', messageId: 'm0', snapshot: {}, isSnapshotUpdate: false }),
  user: (version: unknown) => ({ parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content: 'Say hello in one word.' }, uuid: 'u0', timestamp: '2026-11-19T05:38:29.421Z', userType: 'external', entrypoint: 'cli', cwd: '/neutral/work', sessionId: SID, version, gitBranch: 'HEAD' }),
  attachment: (version: string) => ({ parentUuid: 'u0', isSidechain: false, attachment: {}, type: 'attachment', uuid: 'a0', timestamp: '2026-11-19T05:38:29.421Z', sessionId: SID, version, gitBranch: 'HEAD' }),
  apiShape: (version: string) => ({ type: 'api-request-shape', sessionId: SID, shapeHash: 'h', timestamp: '2026-11-19T05:38:29.511Z', version, shape: {} }),
  apiBlob: (text = 'x') => ({ type: 'api-request-blob', sessionId: SID, hash: 'h', message: { role: 'user', content: [{ type: 'text', text }] } }),
  apiRequest: (version: string) => ({ type: 'api-request', sessionId: SID, id: 'r0', timestamp: '2026-11-19T05:38:29.511Z', version, querySource: 'repl_main_thread' }),
  lastPrompt: () => ({ type: 'last-prompt', lastPrompt: 'Say hello', leafUuid: 'u0', sessionId: SID }),
  aiTitle: () => ({ type: 'ai-title', aiTitle: 'Probe', sessionId: SID }),
  toolsUsed: () => ({ type: 'tools-used', tools: ['REPL'], sessionId: SID }),
  costState: () => ({ type: 'cost-state', sessionId: SID, totalCostUSD: 0.1 }),
}

let n = 0
function transcript(rows: unknown[], tail = ''): string {
  const p = join(TMP, `t${n++}.jsonl`)
  writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n' + tail)
  return p
}

// a real session start: everything Claude Code writes before the first tool call of the first turn
const sessionStart = (v = '2.1.326') => [
  row.mode(), row.permissionMode(), row.replMode(), row.atisLatch(), row.snapshot(), row.user(v), row.attachment(v),
  row.apiShape(v), row.apiBlob(), row.apiBlob(), row.apiRequest(v), row.lastPrompt(), row.mode(), row.permissionMode(),
  row.replMode(), row.atisLatch(), row.aiTitle(), row.toolsUsed(),
]

const replAt = (transcriptPath: unknown, code = '1 + 1') =>
  JSON.stringify({ hook_event_name: 'PreToolUse', transcript_path: transcriptPath, tool_name: 'REPL', tool_input: { code, description: 'x' } })

describe('repl-code-gate.py: the version canary', () => {
  it('allows REPL when the last versioned row says the measured version (a real session start)', () => {
    expect(runRaw(replAt(transcript(sessionStart()))).rc).toBe(0)
  })

  it("allows a fresh session's first REPL call: the prompt row is written before the first tool call", () => {
    const p = transcript([row.mode(), row.permissionMode(), row.replMode(), row.atisLatch(), row.snapshot(), row.user('2.1.326')])
    expect(runRaw(replAt(p)).rc).toBe(0)
  })

  it('allows when the last rows carry no version but an earlier one does', () => {
    const p = transcript([row.user('2.1.326'), row.lastPrompt(), row.aiTitle(), row.snapshot(), row.costState(), row.mode()])
    expect(runRaw(replAt(p)).rc).toBe(0)
  })

  it('searches backwards across chunks: a 300 KB versionless run after the versioned row still allows', () => {
    const p = transcript([row.user('2.1.326'), row.apiBlob('y'.repeat(150_000)), row.apiBlob('z'.repeat(150_000)), row.lastPrompt()])
    expect(runRaw(replAt(p)).rc).toBe(0)
  })

  it('skips a half-written last row and uses the complete one before it', () => {
    const p = transcript([row.user('2.1.326')], '{"type":"assistant","version":"9.9.9","message":{"con')
    expect(runRaw(replAt(p)).rc).toBe(0)
  })

  it('reads only the top-level version: a nested "version" key is not a version row', () => {
    const nested = { type: 'api-request-blob', sessionId: SID, message: { content: [{ type: 'tool_use', name: 'REPL', input: { version: '9.9.9' } }] } }
    const p = transcript([row.user('2.1.326'), nested])
    expect(runRaw(replAt(p)).rc).toBe(0)
  })

  it('does not look at the code: names a word check used to deny pass on the measured version', () => {
    const p = transcript(sessionStart())
    for (const code of ["import { x } from './y'", 'rg "^import "', 'process.env.HOME', "fetch('x')", "require('fs')", '// process the rows']) {
      expect(runRaw(replAt(p, code)).rc).toBe(0)
    }
  })

  for (const v of ['2.1.325', '2.1.327', '3.0.0']) {
    it(`denies a well-formed unmeasured version (${v}) with the mismatch message naming it and the measured set`, () => {
      const r = runRaw(replAt(transcript(sessionStart(v))))
      expect(r.rc).toBe(2)
      expect(r.stderr).toContain('CODEMODEFLAG1119')
      expect(r.stderr).toContain(`verzio ${v}`)
      expect(r.stderr).toContain('merve: 2.1.326')
      expect(r.stderr).toContain(MISMATCH)
      expect(r.stderr).not.toContain(READ_ERROR)
    })
  }

  it('the LAST versioned row decides: a session resumed under a newer Claude Code is denied', () => {
    const p = transcript([...sessionStart('2.1.326'), row.user('2.1.327'), row.lastPrompt()])
    const r = runRaw(replAt(p))
    expect(r.rc).toBe(2)
    expect(r.stderr).toContain('verzio 2.1.327')
  })
})

describe('repl-code-gate.py: a version that cannot be read fails closed as a READ error', () => {
  const unreadable = transcript(sessionStart())
  chmodSync(unreadable, 0o000)
  afterAll(() => chmodSync(unreadable, 0o600))

  const versionlessOnly = [row.mode(), row.snapshot(), row.lastPrompt(), row.aiTitle(), row.apiBlob(), row.costState()]
  const CASES: Array<[string, () => string]> = [
    ['no transcript_path', () => JSON.stringify({ tool_name: 'REPL', tool_input: { code: '1' } })],
    ['an empty transcript_path', () => replAt('')],
    ['a numeric transcript_path', () => replAt(7)],
    ['a transcript that does not exist', () => replAt(join(TMP, 'nope.jsonl'))],
    ['a directory as transcript', () => replAt(TMP)],
    ['an empty transcript', () => { const p = join(TMP, 'empty.jsonl'); writeFileSync(p, ''); return replAt(p) }],
    ['a tail with no version row at all', () => replAt(transcript(versionlessOnly))],
    ['a version row further back than the 4 MB cap', () => replAt(transcript([row.user('2.1.326'), row.apiBlob('q'.repeat(Math.floor(4.2 * 1024 * 1024)))]))],
    ['a numeric version value', () => replAt(transcript([row.user(2.1326)]))],
    ['a null version value', () => replAt(transcript([row.user(null)]))],
    ['an empty version string', () => replAt(transcript([row.user('')]))],
    ['a two-part version', () => replAt(transcript([row.user('2.1')]))],
    ['a suffixed version', () => replAt(transcript([row.user('2.1.326-beta')]))],
    ['a word as version', () => replAt(transcript([row.user('latest')]))],
  ]
  if (process.getuid?.() !== 0) CASES.push(['a transcript without read permission', () => replAt(unreadable)])

  for (const [label, input] of CASES) {
    it(`denies with exit 2 and the read-error message: ${label}`, () => {
      const r = runRaw(input())
      expect(r.rc).toBe(2)
      expect(r.stderr).toContain('CODEMODEFLAG1119')
      expect(r.stderr).toContain(READ_ERROR)
      expect(r.stderr).not.toContain(MISMATCH)
    })
  }

  const MALFORMED: Array<[string, string]> = [
    ['unparseable stdin', 'this is not json'],
    ['empty stdin', ''],
    ['a JSON array', '[]'],
    ['a JSON string', '"REPL"'],
    ['no tool_name', JSON.stringify({ tool_input: { code: '1' } })],
    ['a non-string tool_name', JSON.stringify({ tool_name: 7, tool_input: { code: '1' } })],
  ]
  for (const [label, input] of MALFORMED) {
    it(`denies with exit 2 and the read-error message: ${label}`, () => {
      const r = runRaw(input)
      expect(r.rc).toBe(2)
      expect(r.stderr).toContain(READ_ERROR)
    })
  }
})

describe('repl-code-gate.py: other tools pass', () => {
  for (const tool of ['Bash', 'repl', 'Poll', 'mcp__probe__echo']) {
    it(`allows a ${tool} call without a transcript and on an unmeasured version`, () => {
      expect(runRaw(JSON.stringify({ tool_name: tool, tool_input: { command: 'ls' } })).rc).toBe(0)
      const p = transcript(sessionStart('2.1.327'))
      expect(runRaw(JSON.stringify({ tool_name: tool, transcript_path: p, tool_input: { command: 'ls' } })).rc).toBe(0)
    })
  }
})

describe('the sub-agent template wires the gate once, fail closed', () => {
  const tpl = JSON.parse(resolveTemplatePlaceholders(readFileSync(join(PROJECT_ROOT, 'templates', 'settings.json.template'), 'utf-8')))
  const entries = (tpl.hooks.PreToolUse as Array<{ matcher?: string; hooks: Array<{ command: string; timeout?: number }> }>)
    .filter((e) => JSON.stringify(e).includes('repl-code-gate.py'))

  it('one PreToolUse entry, matcher REPL, the shared fail-closed python builder, timeout 10', () => {
    expect(entries).toHaveLength(1)
    expect(entries[0].matcher).toBe('REPL')
    expect(entries[0].hooks).toHaveLength(1)
    expect(entries[0].hooks[0].command).toBe(pythonHookCommand(GATE, [], 10))
    expect(entries[0].hooks[0].timeout).toBe(10)
  })

  it('no other event carries it', () => {
    const others = Object.entries(tpl.hooks as Record<string, unknown>)
      .filter(([event, groups]) => event !== 'PreToolUse' && JSON.stringify(groups).includes('repl-code-gate.py'))
    expect(others).toEqual([])
  })

  it('the registration guard accepts the rendered command (else the merge pass would skip it silently)', () => {
    expect(isUnsafeHookCommand(entries[0].hooks[0].command)).toBe(false)
  })

  it('the wired command denies with exit 2 and allows with exit 0, as the raw script does', () => {
    const cmd = entries[0].hooks[0].command
    expect(runShell(cmd, replAt(join(TMP, 'nope.jsonl'))).rc).toBe(2)
    expect(runShell(cmd, replAt(transcript(sessionStart('2.1.327')))).rc).toBe(2)
    expect(runShell(cmd, 'not json').rc).toBe(2)
    expect(runShell(cmd, replAt(transcript(sessionStart()))).rc).toBe(0)
  })
})

// The canary: real PreToolUse payloads from a live Code Mode session (ids and paths neutralised, tool_name and
// tool_input verbatim), pointed at a real-shaped transcript. If a Claude Code version renames the tool or drops
// transcript_path from the payload, the measured case starts failing here.
describe('canary: the real REPL payloads reach the version check', () => {
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf-8')) as { cases: Array<{ payload: { tool_name: string; transcript_path: string } }> }
  const wired = pythonHookCommand(GATE, [], 10)
  const measured = transcript(sessionStart('2.1.326'))
  const unmeasured = transcript(sessionStart('2.1.327'))

  it('the fixture holds real REPL payloads that carry a transcript_path', () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(3)
    for (const c of fixture.cases) {
      expect(c.payload.tool_name).toBe('REPL')
      expect(typeof c.payload.transcript_path).toBe('string')
    }
  })

  fixture.cases.forEach((c, i) => {
    it(`real payload #${i}: allowed on 2.1.326, denied on 2.1.327 and with no readable transcript`, () => {
      const at = (p: string) => JSON.stringify({ ...c.payload, transcript_path: p })
      expect(runRaw(at(measured)).rc).toBe(0)
      expect(runShell(wired, at(measured)).rc).toBe(0)
      const mismatch = runShell(wired, at(unmeasured))
      expect(mismatch.rc).toBe(2)
      expect(mismatch.stderr).toContain(MISMATCH)
      const unread = runShell(wired, JSON.stringify(c.payload)) // the neutralised path does not exist
      expect(unread.rc).toBe(2)
      expect(unread.stderr).toContain(READ_ERROR)
    })
  })
})
