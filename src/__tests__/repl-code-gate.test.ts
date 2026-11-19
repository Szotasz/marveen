import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pythonHookCommand, isUnsafeHookCommand, resolveTemplatePlaceholders } from '../web/agent-scaffold.js'
import { PROJECT_ROOT } from '../config.js'

// CODEMODEFLAG1119: in Code Mode the REPL tool runs JS in a sealed vm (require, import, fetch and process are not
// there, measured on a live probe). If a later Claude Code version opens the vm, that would happen silently, so a
// PreToolUse gate on the REPL tool refuses code that names any of the four, and fails closed on input it cannot read.

const GATE = join(PROJECT_ROOT, 'scripts', 'hooks', 'repl-code-gate.py')
const FIXTURE = join(__dirname, 'fixtures', 'repl-code-gate-payloads.json')

function runRaw(input: string) {
  const r = spawnSync('python3', ['-I', '-S', GATE], { input, encoding: 'utf-8', timeout: 15_000 })
  return { rc: r.status, stderr: r.stderr }
}

function runShell(command: string, input: string) {
  const r = spawnSync('/bin/sh', ['-c', command], { input, encoding: 'utf-8', timeout: 15_000 })
  return { rc: r.status, stderr: r.stderr }
}

const repl = (code: unknown) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'REPL', tool_input: { code, description: 'x' } })

describe('repl-code-gate.py: the word rule', () => {
  const DENIED = [
    "require('fs')",
    "const cp = require('child_process')",
    "import('node:fs')",
    "const m = await import('x')",
    "import x from 'y'",
    'import.meta.url',
    "await fetch('https://example.invalid/')",
    'process.env.HOME',
    'globalThis.process',
    "globalThis['process']",
    'typeof require',
    '// process the list',
    'const s = "fetch"',
    'a;fetch(b)',
  ]
  for (const code of DENIED) {
    it(`denies with exit 2: ${code}`, () => {
      const r = runRaw(repl(code))
      expect(r.rc).toBe(2)
      expect(r.stderr).toContain('CODEMODEFLAG1119')
    })
  }

  const ALLOWED = [
    'const processed = 1',
    'imported.length',
    'prefetch()',
    'fetched',
    'requirement',
    'process_list',
    "importScripts('x')",
    '// Process the rows',
    'FETCH',
    '',
    'const d = await $`echo ok`.nothrow(); d.output',
    "await tools.mcp__probe__echo({ text: 'x' })",
  ]
  for (const code of ALLOWED) {
    it(`allows with exit 0: ${JSON.stringify(code)}`, () => {
      expect(runRaw(repl(code)).rc).toBe(0)
    })
  }

  it('names the matched words in the message', () => {
    const r = runRaw(repl("fetch(x); require('y'); process.exit()"))
    expect(r.rc).toBe(2)
    expect(r.stderr).toContain('fetch, process, require')
  })
})

describe('repl-code-gate.py: malformed input fails closed, other tools pass', () => {
  const MALFORMED: Array<[string, string]> = [
    ['unparseable stdin', 'this is not json'],
    ['empty stdin', ''],
    ['a JSON array', '[]'],
    ['a JSON string', '"REPL"'],
    ['no tool_name', JSON.stringify({ tool_input: { code: '1' } })],
    ['a non-string tool_name', JSON.stringify({ tool_name: 7, tool_input: { code: '1' } })],
    ['a REPL call without tool_input', JSON.stringify({ tool_name: 'REPL' })],
    ['a REPL call whose tool_input is a list', JSON.stringify({ tool_name: 'REPL', tool_input: ['code'] })],
    ['a REPL call without code', JSON.stringify({ tool_name: 'REPL', tool_input: { description: 'x' } })],
    ['a REPL call with a numeric code', JSON.stringify({ tool_name: 'REPL', tool_input: { code: 42 } })],
    ['a REPL call with a null code', JSON.stringify({ tool_name: 'REPL', tool_input: { code: null } })],
  ]
  for (const [label, input] of MALFORMED) {
    it(`denies with exit 2: ${label}`, () => {
      const r = runRaw(input)
      expect(r.rc).toBe(2)
      expect(r.stderr).toContain('CODEMODEFLAG1119')
    })
  }

  for (const tool of ['Bash', 'repl', 'Poll', 'mcp__probe__echo']) {
    it(`allows a ${tool} call whatever its input says`, () => {
      const input = JSON.stringify({ tool_name: tool, tool_input: { command: "require('fs'); fetch(x)", code: 'process.env' } })
      expect(runRaw(input).rc).toBe(0)
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
    expect(runShell(cmd, repl("require('fs')")).rc).toBe(2)
    expect(runShell(cmd, 'not json').rc).toBe(2)
    expect(runShell(cmd, repl('1 + 1')).rc).toBe(0)
  })
})

// The canary: real PreToolUse payloads from a live Code Mode session (ids and paths neutralised, tool_name and
// tool_input verbatim). If a Claude Code version changes the REPL call shape (the tool name, or code moving out of
// tool_input.code), the allowed payloads start failing closed here, or the denied ones stop being denied.
describe('canary: the real REPL call shape still reaches the gate', () => {
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf-8')) as { cases: Array<{ expect: 'allow' | 'deny'; payload: { tool_name: string; tool_input: { code: string } } }> }
  const wired = pythonHookCommand(GATE, [], 10)

  it('the fixture holds both allowed and denied real payloads', () => {
    expect(fixture.cases.filter((c) => c.expect === 'allow').length).toBeGreaterThanOrEqual(2)
    expect(fixture.cases.filter((c) => c.expect === 'deny').length).toBeGreaterThanOrEqual(1)
    for (const c of fixture.cases) expect(c.payload.tool_name).toBe('REPL')
  })

  fixture.cases.forEach((c, i) => {
    it(`real payload #${i} (${c.expect})`, () => {
      const want = c.expect === 'allow' ? 0 : 2
      expect(runRaw(JSON.stringify(c.payload)).rc).toBe(want)
      expect(runShell(wired, JSON.stringify(c.payload)).rc).toBe(want)
    })
  })

  for (const [label, extra] of [['fetch(', "\nawait fetch('https://example.invalid/')"], ['require(', "\nrequire('fs')"], ['process.env', '\nprocess.env.HOME']]) {
    it(`each allowed real payload, with ${label} added to its code, is denied with exit 2`, () => {
      for (const c of fixture.cases.filter((x) => x.expect === 'allow')) {
        const p = { ...c.payload, tool_input: { ...c.payload.tool_input, code: c.payload.tool_input.code + extra } }
        const r = runShell(wired, JSON.stringify(p))
        expect(r.rc).toBe(2)
        expect(r.stderr).toContain('CODEMODEFLAG1119')
      }
    })
  }
})
