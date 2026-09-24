import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// INTERAGENTHOMOGLIF923 (decision: Marveen, msg 28870): inter-agent messages
// get a HOMOGLYPH-ONLY check, and nothing else from the copy gate.
//
// Before this, `curl .../api/messages` was outside the gate entirely (it is not
// an email send; send-invocation-cases.json pins that, and it stays). Measured
// 2026-09-16: four Cyrillic lookalikes in the lead agent's own messages, caught
// only by a manual scan. In a card id or an agent name such a character does
// not look wrong -- it silently points at something that does not exist.
//
// The failure direction is the OPPOSITE of the email branch, on purpose:
//   found -> BLOCK;   uninterpretable body -> PASS, loud (systemMessage + log).
// A false block here mutes an agent; the threat is our own agent emitting a
// lookalike by accident, not an attacker.
// All three shapes, or the concept is not closed: quoted heredoc, @file, -d.

const ROOT = join(__dirname, '..', '..')
const GATE = join(ROOT, 'scripts', 'hooks', 'outgoing-copy-gate.py')

// Built from code points so this file never carries a literal lookalike.
const CYR_A = String.fromCodePoint(0x430)
const CLEAN = 'PROMPTCSONK923 kesz, a kartyan a reszletek, kerlek nezd meg -- koszonom'
const HOMO = `PROMPTCSONK923 kesz, a k${CYR_A}rtyan a reszletek`
const TOK = 'Authorization: Bearer $(cat ~/ClaudeClaw/store/.dashboard-token)'
const POST = `curl -s -X POST http://localhost:3420/api/messages -H "Content-Type: application/json" -H "${TOK}"`

let dir: string
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'iahomo-')) })
afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

const msg = (content: string, to = 'marveen') => JSON.stringify({ from: 'samu', to, content })
function file(name: string, content: string): string {
  const p = join(dir, name)
  writeFileSync(p, content)
  return p
}
function gate(cmd: string): { code: number | null; out: string; err: string } {
  const r = spawnSync('python3', [GATE], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: cmd }, hook_event_name: 'PreToolUse' }),
    encoding: 'utf-8',
    // hermetic: rules path (and so the gate log) inside the test dir
    env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT, OUTGOING_COPY_GATE_RULES: join(dir, 'rules.json') },
  })
  return { code: r.status, out: r.stdout, err: r.stderr }
}
const heredoc = (body: string) => `${POST} --data-binary @- <<'JSON'\n${body}\nJSON`

describe('inter-agent message: homoglyph BLOCKS in every shape', () => {
  it('quoted heredoc', () => {
    const r = gate(heredoc(msg(HOMO)))
    expect(r.code).toBe(2)
    expect(r.err).toContain('homoglifa')
    expect(r.err).toContain('CYRILLIC SMALL LETTER A')
  })
  it('@file', () => {
    expect(gate(`${POST} --data-binary @${file('h.json', msg(HOMO))}`).code).toBe(2)
  })
  it('@file with \\u escapes (the JSON is decoded before the scan)', () => {
    const escaped = msg(HOMO).replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
    expect(gate(`${POST} --data-binary @${file('esc.json', escaped)}`).code).toBe(2)
  })
  it("inline -d '...' and -d@file", () => {
    expect(gate(`${POST} -d '${msg(HOMO)}'`).code).toBe(2)
    expect(gate(`${POST} -d@${file('g.json', msg(HOMO))}`).code).toBe(2)
  })
  it('the fleet form S=/abs; ... @$S/m.json is resolved, not warned about', () => {
    file('s.json', msg(HOMO))
    expect(gate(`S=${dir}; ${POST} --data-binary @$S/s.json`).code).toBe(2)
    file('s2.json', msg(CLEAN))
    const r = gate(`SCR="${dir}" && ${POST} --data-binary @\${SCR}/s2.json`)
    expect(r.code).toBe(0)
    expect(r.out).toBe('')
    // a run-time value stays unresolved -> loud pass
    expect(JSON.parse(gate(`S=$(mktemp -d); ${POST} --data-binary @$S/s.json`).out.trim()).systemMessage).toMatch(/fel nem oldhato/)
  })
  it('a lookalike in the AGENT NAME blocks too (silent misrouting)', () => {
    expect(gate(heredoc(msg(CLEAN, `m${CYR_A}rveen`))).code).toBe(2)
  })
})

describe('inter-agent message: clean traffic PASSES, and only the homoglyph rule runs', () => {
  it('clean in every shape', () => {
    expect(gate(heredoc(msg(CLEAN))).code).toBe(0)
    expect(gate(`${POST} --data-binary @${file('c.json', msg(CLEAN))}`).code).toBe(0)
    expect(gate(`${POST} -d '${msg(CLEAN)}'`).code).toBe(0)
  })
  it('accentless Hungarian and " -- " pass: the accent / copy rules do NOT run here', () => {
    const r = gate(heredoc(msg('kerlek nezd meg a kartyat -- koszonom, tehat mehet es kesz')))
    expect(r.code).toBe(0)
    expect(r.out).toBe('')
  })
  it('a GET of the queue (no body) passes silently', () => {
    const r = gate(`curl -s -H "${TOK}" "http://localhost:3420/api/messages?agent=samu"`)
    expect(r.code).toBe(0)
    expect(r.out).toBe('')
  })
})

describe('inter-agent message: an UNINTERPRETABLE body PASSES, loudly (fail-open-loud)', () => {
  const cases: Array<[string, string, RegExp]> = [
    ['missing @file', `${POST} --data-binary @/nincs/ilyen/fajl.json`, /nem olvashato/],
    ['$-path', `${POST} --data-binary @$S/msg.json`, /fel nem oldhato @utvonal/],
    ['@- from a pipe', `cat x.json | ${POST} --data-binary @-`, /stdin/],
    ['run-time -d', `${POST} -d "{\\"content\\":\\"$(cat x)\\"}"`, /shell-behelyettesitest/],
    ['not JSON', `${POST} -d 'hello'`, /nem ervenyes JSON/],
    ['JSON array', `${POST} -d '["a"]'`, /nem objektum/],
  ]
  for (const [name, cmd, reason] of cases) {
    it(name, () => {
      const r = gate(cmd)
      expect(r.code).toBe(0)
      const sm = JSON.parse(r.out.trim()).systemMessage as string
      expect(sm).toMatch(reason)
      expect(sm).toContain('homoglifa-ellenorzes NELKUL')
    })
  }
  it('and leaves a line in the gate log', () => {
    gate(`${POST} --data-binary @/nincs/ilyen/log-proba.json`)
    const log = join(dir, 'outgoing-copy-gate.log')
    expect(existsSync(log)).toBe(true)
    expect(readFileSync(log, 'utf-8')).toContain('log-proba.json')
  })
})

describe('scope: the email contract is unchanged', () => {
  it('the conformance list keeps inter-agent curls expected:false, and SAYS what changed outside it', () => {
    const cases = JSON.parse(readFileSync(join(ROOT, 'scripts', 'hooks', 'send-invocation-cases.json'), 'utf-8'))
    const ia = cases.cases.filter((c: { cmd: string }) => c.cmd.includes('/api/messages'))
    expect(ia.length).toBeGreaterThan(0)
    for (const c of ia) expect(c.expected).toBe(false)
    expect(cases._comment).toContain('INTERAGENTHOMOGLIF923')
    expect(cases._comment).toContain('homoglyph-only')
  })
})
