// DIGESTSTALE825: the heartbeat digest reported closed work as open (0/4 on
// the 10:13 round) and fabricated an owner decision. The prompt-layer fix was
// falsified live the same morning (the first run AFTER the SKILL.md freshness
// gate shipped all four errors), so the rule is enforced here in code, as a
// PreToolUse hook scoped to the heartbeat worker. These tests pin the gate's
// contract, including Marveen's three stipulations (msg 16050): legitimate
// traffic passes, internal failure is loud fail-closed, and the RED-BEFORE
// baseline is measured (the bad drafts pass the pre-existing gate stack, so
// only THIS gate blocks them).

import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, validateContent, extractPayload } from '../../scripts/digest-provenance-gate.mjs'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision as kanbanGateDecision } from '../../scripts/kanban-write-gate.mjs'
import { agentGetsKanbanWriteGate, injectDigestProvenanceGate } from '../web/agent-scaffold.js'
import { MAIN_AGENT_ID, HEARTBEAT_AGENT_ID } from '../config.js'

const ROOT = join(__dirname, '..', '..')

const deps = {
  allCards: () => [
    { id: 'OPENCARD1', status: 'in_progress', archived: false },
    { id: 'DONECARD1', status: 'done', archived: false },
    { id: 'ARCHCARD1', status: 'waiting', archived: true },
  ],
  getMessage: (id: number) =>
    ({
      100: { id: 100, from_agent: 'samu', content: 'PR kesz: build zold, mergelheto -- reszletek a kartyan' },
      200: { id: 200, from_agent: 'heartbeat', content: 'NYERSANYAG -- korabbi digest' },
    })[id] ?? null,
  prMerged: (n: number) => n === 1062,
  readFile: (p: string) => {
    if (p === '/stub/lelet.json') return JSON.stringify({ from: 'heartbeat', to: 'marveen', content: 'DONECARD1 | done | zard le | evidencia' })
    throw new Error(`ENOENT: ${p}`)
  },
}

const post = (content: string) =>
  `curl -s -X POST http://localhost:3420/api/messages -H "Content-Type: application/json" -d '${JSON.stringify({ from: 'heartbeat', to: 'marveen', content })}'`

const decide = (cmd: string) => gateDecision('Bash', { command: cmd }, deps)

describe('digest-provenance-gate: scope (legitimate traffic passes untouched)', () => {
  it('ignores non-Bash tools', () => {
    expect(gateDecision('Read', { file_path: '/x' }, deps).deny).toBe(false)
  })
  it('ignores Bash that does not touch /api/messages', () => {
    expect(decide('sqlite3 store/claudeclaw.db "SELECT 1"').deny).toBe(false)
  })
  it('ignores a GET on /api/messages (status polling has no data flag)', () => {
    expect(decide('curl -s -H "Authorization: Bearer x" "http://localhost:3420/api/messages?agent=heartbeat"').deny).toBe(false)
  })
  it('passes a REAL alert draft: no action rows, no citations', () => {
    expect(decide(post('RIASZTAS: a dashboard nem valaszol, HTTP 000 harom probalkozasra. Azonnali figyelem kell.')).deny).toBe(false)
  })
  it('passes a valid jelolt-tetel row: open card + existing citation + matching quote', () => {
    const draft = 'NYERSANYAG -- ellenorizetlen javaslatok\nOPENCARD1 | in_progress | done-ra | msg 100 >>build zold, mergelheto<<'
    expect(decide(post(draft)).deny).toBe(false)
  })
  it('passes prose that MENTIONS a merged PR outside an action row', () => {
    expect(decide(post('Kontextus: a #1062 mergelve, ez mar lezart munka.')).deny).toBe(false)
  })
  it('passes the sanctioned "kozben lezarult" summary line with closed ids', () => {
    expect(decide(post('kozben lezarult: DONECARD1 | ARCHCARD1 | #1062')).deny).toBe(false)
  })
})

describe('digest-provenance-gate: stale-state violations (the 10:13 failure modes)', () => {
  it('denies a done card proposed as actionable', () => {
    const r = decide(post('DONECARD1 | in_progress | zard done-ra | evidencia nelkul'))
    expect(r.deny).toBe(true)
    expect(r.reason).toContain('DONECARD1')
  })
  it('denies an archived card in an action row', () => {
    expect(decide(post('ARCHCARD1 | waiting | eszkalald | regi allapot')).deny).toBe(true)
  })
  it('denies a merged PR proposed as open work', () => {
    const r = decide(post('OPENCARD1 | in_progress | merge #1062 | varakozik'))
    expect(r.deny).toBe(true)
    expect(r.reason).toContain('#1062')
  })
})

describe('digest-provenance-gate: fabricated provenance', () => {
  it('denies a citation of a nonexistent message', () => {
    const r = decide(post('A gazda dontese szukseges, lasd msg 99999.'))
    expect(r.deny).toBe(true)
    expect(r.reason).toContain('99999')
  })
  it('denies self-citation (the digest citing its own previous digest)', () => {
    const r = decide(post('Forras: msg 200, a korabbi osszefoglalo.'))
    expect(r.deny).toBe(true)
    expect(r.reason).toContain('onhivatkozas')
  })
  it('denies a verbatim quote that is not in the cited message', () => {
    const r = decide(post('msg 100 szerint >>Szabolcs dontese szukseges a HBTELIT-hez<<'))
    expect(r.deny).toBe(true)
    expect(r.reason).toContain('idezet')
  })
  it('accepts the same citation when the quote IS verbatim', () => {
    expect(decide(post('msg 100 szerint >>build zold, mergelheto<<')).deny).toBe(false)
  })
})

describe('digest-provenance-gate: loud fail-closed on internal error (stipulation #2)', () => {
  it('denies with INTERNAL ERROR when the payload file is unreadable', () => {
    const r = decide('curl -s -X POST http://localhost:3420/api/messages -d @/stub/missing.json')
    expect(r.deny).toBe(true)
    expect(r.reason).toContain('INTERNAL ERROR')
  })
  it('denies with INTERNAL ERROR when the DB layer throws mid-validation', () => {
    const broken = { ...deps, allCards: () => { throw new Error('SQLITE_CANTOPEN') } }
    const r = gateDecision('Bash', { command: post('DONECARD1 | x | y | z') }, broken)
    expect(r.deny).toBe(true)
    expect(r.reason).toContain('INTERNAL ERROR')
    expect(r.reason).toContain('SQLITE_CANTOPEN')
  })
  it('denies when the POST body cannot be extracted at all', () => {
    const r = decide('curl -s -X POST http://localhost:3420/api/messages --data-urlencode content=x')
    expect(r.deny).toBe(true)
  })
  it('reads the body from -d @file (the SKILL-mandated form) and validates it', () => {
    const r = decide('curl -s -X POST http://localhost:3420/api/messages -d @/stub/lelet.json')
    expect(r.deny).toBe(true)
    expect(r.reason).toContain('DONECARD1')
  })
})

describe('RED-BEFORE baseline (stipulation #3): only THIS gate blocks the bad drafts', () => {
  const badDrafts = [
    post('DONECARD1 | in_progress | zard done-ra | evidencia nelkul'),
    post('A gazda dontese szukseges, lasd msg 99999.'),
    post('msg 100 szerint >>Szabolcs dontese szukseges<<'),
  ]
  it('every bad draft PASSES the pre-existing gate stack (kanban-write-gate)', () => {
    for (const cmd of badDrafts) {
      expect(kanbanGateDecision('Bash', { command: cmd }).deny).toBe(false)
    }
  })
  it('and every bad draft is DENIED by the provenance gate', () => {
    for (const cmd of badDrafts) {
      expect(decide(cmd).deny).toBe(true)
    }
  })
})

describe('digest-provenance-gate: wiring', () => {
  it('shares the heartbeat-only scope with the kanban-write gate', () => {
    expect(agentGetsKanbanWriteGate(HEARTBEAT_AGENT_ID)).toBe(true)
    expect(agentGetsKanbanWriteGate(MAIN_AGENT_ID)).toBe(false)
    expect(agentGetsKanbanWriteGate('samu')).toBe(false)
  })
  it('injects a Bash-matcher PreToolUse entry, idempotently', () => {
    const settings: Record<string, unknown> = {}
    injectDigestProvenanceGate(settings)
    injectDigestProvenanceGate(settings)
    const entries = (settings.hooks as { PreToolUse: unknown[] }).PreToolUse
      .filter((e) => JSON.stringify(e).includes('digest-provenance-gate.mjs'))
    expect(entries).toHaveLength(1)
    expect(JSON.stringify(entries[0])).toContain('"matcher":"Bash"')
  })
  it('does not clobber pre-existing PreToolUse entries', () => {
    const settings: Record<string, unknown> = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'other.sh' }] }] } }
    injectDigestProvenanceGate(settings)
    const all = (settings.hooks as { PreToolUse: unknown[] }).PreToolUse
    expect(all).toHaveLength(2)
    expect(JSON.stringify(all[0])).toContain('other.sh')
  })
})

describe('digest-provenance-gate: spawned entrypoint contract', () => {
  const SCRIPT = join(ROOT, 'scripts', 'digest-provenance-gate.mjs')
  const run = (stdin: string) => spawnSync('node', [SCRIPT], { input: stdin, encoding: 'utf-8', timeout: 15000 })

  it('malformed stdin (non-matching event) allows with exit 0 and no deny JSON', () => {
    const r = run('not json at all')
    expect(r.status).toBe(0)
    expect(r.stdout).not.toContain('deny')
  })
  it('out-of-scope Bash allows with exit 0', () => {
    const r = run(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls -la' } }))
    expect(r.status).toBe(0)
    expect(r.stdout).not.toContain('deny')
  })
  it('in-scope POST with unreadable @file emits a loud deny decision', () => {
    const r = run(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'curl -X POST http://localhost:3420/api/messages -d @/nonexistent/lelet.json' } }))
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('INTERNAL ERROR')
  })
})

describe('extractPayload / validateContent units', () => {
  it('extracts a single-quoted inline body', () => {
    expect(extractPayload(`curl -d '{"a":1}' u`, () => '')).toBe('{"a":1}')
  })
  it('extracts an @file body via the injected reader', () => {
    expect(extractPayload('curl --data @/tmp/x.json u', (p: string) => `read:${p}`)).toBe('read:/tmp/x.json')
  })
  it('POSITIVE CONTROL: validateContent flags a known-bad draft and stays quiet on a known-good one', () => {
    expect(validateContent('DONECARD1 | a | b | c', deps).length).toBeGreaterThan(0)
    expect(validateContent('OPENCARD1 | a | b | msg 100 >>build zold, mergelheto<<', deps)).toHaveLength(0)
  })
})
