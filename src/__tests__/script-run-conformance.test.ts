// JSCDSEND1104 (Samu 69478): the two mail gates' SCRIPT-RUN judgement (outgoing-copy-gate.py :: script_run_sends and
// email-send-gate.mjs :: scriptRunSends) on one shared table, scripts/hooks/script-run-cases.json. The fixture files
// are written into a fresh directory, and every case runs from it through BOTH implementations. Each row holds two
// verdicts (Samu 69623): `main` for the main agent's approval gate (python), `sub` for the sub-agent gate (JS). The
// input reading is shared; the two differ only where a fail-closed branch meets an unaddressed run. A divergence from
// the table fails here, not in production. Nothing is executed.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
// @ts-expect-error -- plain .mjs hook script, no types
import { scriptRunSends } from '../../scripts/email-send-gate.mjs'

const ROOT = join(__dirname, '..', '..')
const GATE_PY = join(ROOT, 'scripts', 'hooks', 'outgoing-copy-gate.py')
const TABLE = JSON.parse(readFileSync(join(ROOT, 'scripts', 'hooks', 'script-run-cases.json'), 'utf-8')) as {
  files: Record<string, string>; executable: string[]; cases: Array<{ name: string; cmd: string; main: boolean; sub: boolean }>
}

let dir = ''
let py: boolean[] = []
beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'script-run-conformance-')))
  for (const [rel, body] of Object.entries(TABLE.files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), body)
  }
  for (const rel of TABLE.executable) chmodSync(join(dir, rel), 0o755)
  const out = execFileSync('python3', ['-c', `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("gate", ${JSON.stringify(GATE_PY)})
g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)
inp = json.load(sys.stdin)
print(json.dumps([g.script_run_sends(c, inp["cwd"]) for c in inp["cmds"]]))
`], { encoding: 'utf-8', input: JSON.stringify({ cmds: TABLE.cases.map((c) => c.cmd), cwd: dir }) })
  py = JSON.parse(out.trim())
})
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

describe('script-run conformance: both mail gates match their column of the shared table on every case', () => {
  TABLE.cases.forEach((c, i) => {
    it(`${c.name}: ${c.cmd} -> main ${c.main}, sub ${c.sub}`, () => {
      expect(scriptRunSends(c.cmd, dir), `JS (sub-agent gate) verdict for: ${c.cmd}`).toBe(c.sub)
      expect(py[i], `python (main agent gate) verdict for: ${c.cmd}`).toBe(c.main)
    })
  })

  it('the table is non-trivial in both directions, and the two columns differ only by the stated rule', () => {
    for (const col of ['main', 'sub'] as const) {
      expect(TABLE.cases.filter((c) => c[col]).length).toBeGreaterThan(10)
      expect(TABLE.cases.filter((c) => !c[col]).length).toBeGreaterThan(5)
    }
    // the sub-agent gate is never stricter than the main agent's: a row the sub gate denies, the main gate asks about
    expect(TABLE.cases.filter((c) => c.sub && !c.main).map((c) => c.cmd)).toEqual([])
    // and the columns do differ (the unaddressed fail-closed rows)
    expect(TABLE.cases.filter((c) => c.main && !c.sub).length).toBeGreaterThan(5)
  })
})
