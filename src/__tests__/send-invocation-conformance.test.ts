import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
// @ts-expect-error -- plain .mjs hook script, no types
import { isSendInvocation, setKnownAgentsOverride } from '../../scripts/email-send-gate.mjs'

// SUBGATEPOZ822 / msg 14289: the same command-position recognition now lives
// in TWO languages, in two files (the main-agent copy gate in python, the
// sub-agent hard-gate in JS). Several of today's findings came from exactly
// this pattern -- a parallel copy drifting silently. This test binds the two:
// EVERY case in the shared list runs through BOTH implementations, and both
// must equal the expected verdict. A future fix applied to only one copy
// fails here as a test, instead of surfacing weeks later as an incident.
//
// Deliberately NOT in the shared list: unparseable-input fallbacks. The two
// gates fall back differently by design (copy-gate: strong literals only;
// hard-gate: its full legacy pattern set, because it is a hard-deny that must
// never get weaker on that path) -- each pins its own fallback in its scope
// test. If that difference ever becomes a problem, unify there first.

const ROOT = join(__dirname, '..', '..')
const GATE_PY = join(ROOT, 'scripts', 'hooks', 'outgoing-copy-gate.py')
const CASES = JSON.parse(
  readFileSync(join(ROOT, 'scripts', 'hooks', 'send-invocation-cases.json'), 'utf-8'),
) as { known_agents: string[]; cases: Array<{ name: string; cmd: string; expected: boolean }> }

// One python process for the whole list: stdin carries the JSON cases, stdout
// returns the per-case verdicts. Spawning per-case would be ~30x slower.
// FLEETTOFLAG1025 v4: both twins get the SAME agent list (the table's known_agents) instead of the install's agents/ + .env;
// known = null leaves the install reader in place (the reader test below).
function pythonVerdicts(cmds: string[], known: string[] | null = CASES.known_agents, gatePy = GATE_PY): boolean[] {
  const out = execFileSync('python3', ['-c', `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("gate", ${JSON.stringify(gatePy)})
g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)
inp = json.load(sys.stdin)
if inp["known"] is not None:
    g.KNOWN_AGENTS_OVERRIDE = set(inp["known"])
print(json.dumps([g.is_send_invocation(c) for c in inp["cmds"]]))
`], { encoding: 'utf-8', input: JSON.stringify({ cmds, known }) })
  return JSON.parse(out.trim())
}

describe('send-invocation conformance: both gates agree with the shared contract on every case', () => {
  const py = pythonVerdicts(CASES.cases.map((c) => c.cmd))
  setKnownAgentsOverride(CASES.known_agents)

  CASES.cases.forEach((c, i) => {
    it(`${c.name} -> ${c.expected}`, () => {
      const js = isSendInvocation(c.cmd)
      expect(js, `JS verdict for: ${c.cmd}`).toBe(c.expected)
      expect(py[i], `python verdict for: ${c.cmd}`).toBe(c.expected)
    })
  })

  it('the shared list is non-trivial in both directions', () => {
    expect(CASES.cases.some((c) => c.expected)).toBe(true)
    expect(CASES.cases.some((c) => !c.expected)).toBe(true)
    expect(CASES.cases.length).toBeGreaterThanOrEqual(20)
  })
})

// FLEETTOFLAG1025 v4: the install reader of BOTH twins (no override) -- the agent names are the <root>/agents/* directories and
// MAIN_AGENT_ID in <root>/.env; a missing agents/ or .env means no exception (fail-closed). Each twin runs as a COPY under a temp
// root, so the result does not depend on the machine the test runs on.
describe('FLEETTOFLAG1025 v4: the known agents come from the install (agents/ + MAIN_AGENT_ID), fail-closed without them', () => {
  const CMDS = ['$F message post --to neo --content-stdin < x.txt', '$F message post --to merlin --content-stdin < x.txt',
    '$F message post --to diszpecser --content-stdin < x.txt', '$F message post --to fajl --content-stdin < x.txt']
  async function verdicts(root: string): Promise<{ py: boolean[]; js: boolean[] }> {
    mkdirSync(join(root, 'scripts', 'hooks'), { recursive: true })
    copyFileSync(GATE_PY, join(root, 'scripts', 'hooks', 'outgoing-copy-gate.py'))
    copyFileSync(join(ROOT, 'scripts', 'email-send-gate.mjs'), join(root, 'scripts', 'email-send-gate.mjs'))
    const mod = await import(pathToFileURL(join(root, 'scripts', 'email-send-gate.mjs')).href)
    return { py: pythonVerdicts(CMDS, null, join(root, 'scripts', 'hooks', 'outgoing-copy-gate.py')),
      js: CMDS.map((c) => mod.isSendInvocation(c)) }
  }
  it('agents/neo (directory) + MAIN_AGENT_ID=merlin: neo and merlin are agents; diszpecser and a plain FILE agents/fajl are not', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mailgate-v4-'))
    try {
      mkdirSync(join(root, 'agents', 'neo'), { recursive: true })
      writeFileSync(join(root, 'agents', 'fajl'), 'x')
      writeFileSync(join(root, '.env'), 'BOT_NAME=x\nMAIN_AGENT_ID=merlin\n')
      const v = await verdicts(root)
      expect(v.py).toEqual([false, false, true, true])
      expect(v.js).toEqual([false, false, true, true])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it('no agents/ and no .env: no name is known -- every undecidable --to is a send (fail-closed)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mailgate-v4-'))
    try {
      const v = await verdicts(root)
      expect(v.py).toEqual([true, true, true, true])
      expect(v.js).toEqual([true, true, true, true])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
