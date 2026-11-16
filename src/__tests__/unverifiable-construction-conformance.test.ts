// EMAILGATESUBST1116: a send command built by process substitution, a here-string, a stdin heredoc or xargs is refused
// as unverifiable by every gate that classifies Bash sends. The predicate has two copies (outgoing-copy-gate.py ::
// unverifiable_send_construction for the copy gate and the main agent's approval gate, email-send-gate.mjs ::
// unverifiableSendConstruction for the sub-agent gate); scripts/hooks/unverifiable-construction-cases.json binds them.
// The fixture files of script-run-cases.json are written into a fresh directory and every case runs from it through
// BOTH copies. Nothing is executed: the commands are gate input only.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, unverifiableSendConstruction } from '../../scripts/email-send-gate.mjs'

const ROOT = join(__dirname, '..', '..')
const GATE_PY = join(ROOT, 'scripts', 'hooks', 'outgoing-copy-gate.py')
const FIXTURES = JSON.parse(readFileSync(join(ROOT, 'scripts', 'hooks', 'script-run-cases.json'), 'utf-8')) as {
  files: Record<string, string>; executable: string[]
}
const TABLE = JSON.parse(readFileSync(join(ROOT, 'scripts', 'hooks', 'unverifiable-construction-cases.json'), 'utf-8')) as {
  cases: Array<{ name: string; cmd: string; expected: boolean }>
}

let dir = ''
let py: boolean[] = []
beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'unverifiable-construction-')))
  for (const [rel, body] of Object.entries(FIXTURES.files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), body)
  }
  for (const rel of FIXTURES.executable) chmodSync(join(dir, rel), 0o755)
  const out = execFileSync('python3', ['-c', `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("gate", ${JSON.stringify(GATE_PY)})
g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)
inp = json.load(sys.stdin)
print(json.dumps([g.unverifiable_send_construction(c, inp["cwd"]) for c in inp["cmds"]]))
`], { encoding: 'utf-8', input: JSON.stringify({ cmds: TABLE.cases.map((c) => c.cmd), cwd: dir }) })
  py = JSON.parse(out.trim())
})
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

describe('a send command built by process substitution, a here-string, a stdin heredoc or xargs is refused as unverifiable', () => {
  TABLE.cases.forEach((c, i) => {
    it(`${c.name} -> ${c.expected}`, () => {
      expect(unverifiableSendConstruction(c.cmd, dir), `JS (sub-agent gate) verdict for: ${c.cmd}`).toBe(c.expected)
      expect(py[i], `python (copy gate, approval gate) verdict for: ${c.cmd}`).toBe(c.expected)
    })
  })

  it('the table is non-trivial in both directions', () => {
    expect(TABLE.cases.filter((c) => c.expected).length).toBeGreaterThan(20)
    expect(TABLE.cases.filter((c) => !c.expected).length).toBeGreaterThan(10)
  })

  it('a run of unknown xargs options costs linear time in both copies (the option reading is memoized)', () => {
    const cmd = 'echo x | xargs ' + Array(40).fill('-Z').join(' ') + ' true'
    const t0 = Date.now()
    expect(unverifiableSendConstruction(cmd, dir)).toBe(false)
    expect(Date.now() - t0).toBeLessThan(1000)
    const pyMs = Number(execFileSync('python3', ['-c', `
import importlib.util, sys, time
spec = importlib.util.spec_from_file_location("gate", ${JSON.stringify(GATE_PY)})
g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)
t = time.time(); assert g.unverifiable_send_construction(sys.argv[1], sys.argv[2]) is False
print(int((time.time() - t) * 1000))
`, cmd, dir], { encoding: 'utf-8' }).trim())
    expect(pyMs).toBeLessThan(1000)
  })

  it('the sub-agent gate denies such a command with its own reason, before the send checks', () => {
    for (const c of TABLE.cases.filter((x) => x.expected)) {
      expect(gateDecision('Bash', { command: c.cmd }, null, dir), c.cmd).toEqual({ deny: true, kind: 'unverifiable-construction' })
    }
    for (const c of TABLE.cases.filter((x) => !x.expected)) {
      expect(gateDecision('Bash', { command: c.cmd }, null, dir).kind, c.cmd).not.toBe('unverifiable-construction')
    }
  })
})
