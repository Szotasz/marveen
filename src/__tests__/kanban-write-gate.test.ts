// HBFUTTATOIR824: the heartbeat worker's skill has forbidden kanban writes in
// prompt text since 2026-08-22 ("A FUTTATO A TABLARA NEM IR. SEMMIT.") with
// zero enforcement -- three violating writes on 2026-08-24 alone, one
// auto-closing a card whose PR was still unreviewed. This gate is the
// technical enforcement: a PreToolUse hook wired ONLY for the heartbeat
// worker, blocking SQL and dashboard-API writes to the kanban tables while
// every read (and every report that merely QUOTES SQL-looking text in a data
// payload) passes.

import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/kanban-write-gate.mjs'
import {
  agentGetsKanbanWriteGate,
  injectKanbanWriteGate,
} from '../web/agent-scaffold.js'
import { MAIN_AGENT_ID, HEARTBEAT_AGENT_ID } from '../config.js'

const bash = (command: string) => gateDecision('Bash', { command })

describe('kanban-write-gate gateDecision: SQL writes (known positives)', () => {
  it('denies a direct sqlite3 UPDATE of kanban_cards (the 14:43 incident shape)', () => {
    expect(
      bash(`sqlite3 store/claudeclaw.db "UPDATE kanban_cards SET status='done', updated_at=unixepoch() WHERE id='KANBANCTXDEAD824'"`).deny
    ).toBe(true)
  })
  it('denies INSERT INTO kanban_comments', () => {
    expect(
      bash(`sqlite3 store/claudeclaw.db "INSERT INTO kanban_comments (card_id, author, content, created_at) VALUES ('X', 'heartbeat', 'auto-close', unixepoch())"`).deny
    ).toBe(true)
  })
  it('denies heredoc SQL: the write verb sits on its own body line', () => {
    expect(
      bash(`sqlite3 store/claudeclaw.db << 'EOF'\nUPDATE kanban_cards SET status='done' WHERE id='X';\nEOF`).deny
    ).toBe(true)
  })
  it('denies a python-driven kanban write (no sqlite3 CLI token anywhere)', () => {
    expect(
      bash(`python3 -c "import sqlite3; c=sqlite3.connect('store/claudeclaw.db'); c.execute('DELETE FROM kanban_cards WHERE id=?', ('X',)); c.commit()"`).deny
    ).toBe(true)
  })
  it('denies DROP/ALTER on kanban tables', () => {
    expect(bash(`sqlite3 db "DROP TABLE IF EXISTS kanban_comments"`).deny).toBe(true)
    expect(bash(`sqlite3 db "ALTER TABLE kanban_cards ADD COLUMN x TEXT"`).deny).toBe(true)
  })
})

describe('kanban-write-gate gateDecision: dashboard API writes', () => {
  it('denies POST to /api/kanban', () => {
    expect(
      bash(`curl -s -X POST http://localhost:3420/api/kanban/cards -H "Authorization: Bearer $TOK" -d '{"title":"x"}'`).deny
    ).toBe(true)
  })
  it('denies a data-flag call to /api/kanban even without explicit -X (curl defaults to POST)', () => {
    expect(
      bash(`curl -s http://localhost:3420/api/kanban/comments --data '{"card_id":"X"}'`).deny
    ).toBe(true)
  })
})

describe('kanban-write-gate gateDecision: the worker duties that MUST pass', () => {
  it('allows sqlite3 SELECT over kanban tables (the measuring read)', () => {
    expect(
      bash(`sqlite3 store/claudeclaw.db "SELECT id, status, substr(title,1,50) FROM kanban_cards WHERE archived_at IS NULL AND status IN ('in_progress','waiting')"`).deny
    ).toBe(false)
  })
  it('allows the scaffolded GET of /api/kanban/heartbeat-summary', () => {
    expect(
      bash(`python3 -c "import json,urllib.request; tok=open('store/.dashboard-token').read().strip(); d=json.load(urllib.request.urlopen(urllib.request.Request('http://localhost:3420/api/kanban/heartbeat-summary', headers={'Authorization':'Bearer '+tok})))"`).deny
    ).toBe(false)
  })
  it('allows writes to NON-kanban tables (memories, daily log)', () => {
    expect(
      bash(`sqlite3 store/claudeclaw.db "INSERT INTO memories (agent_id, content) VALUES ('heartbeat', 'x')"`).deny
    ).toBe(false)
  })
  it('allows the report message even when its payload QUOTES SQL-looking text', () => {
    // The worker's core duty: a jelolt-tetel message to the coordinator whose
    // CONTENT describes a proposed write. stripDataPayloads blanks the -d
    // literal, so describing a write is never treated as performing one.
    expect(
      bash(`curl -s -X POST http://localhost:3420/api/messages -H "Content-Type: application/json" -d '{"from":"heartbeat","to":"marveen","content":"NYERSANYAG: X kartya | waiting | javasolt: UPDATE kanban_cards SET status=done | evidencia msg 123"}'`).deny
    ).toBe(false)
  })
  it('allows plain non-kanban commands', () => {
    expect(bash('date && git status').deny).toBe(false)
  })
  it('ignores non-Bash tools', () => {
    expect(gateDecision('Write', { file_path: '/x', content: 'UPDATE kanban_cards SET' }).deny).toBe(false)
  })
})

describe('kanban-write-gate wiring', () => {
  it('gates the heartbeat worker and NOBODY else', () => {
    expect(agentGetsKanbanWriteGate(HEARTBEAT_AGENT_ID)).toBe(true)
    expect(agentGetsKanbanWriteGate(MAIN_AGENT_ID)).toBe(false)
    // Every normal sub-agent's kanban-first workflow requires board writes.
    expect(agentGetsKanbanWriteGate('samu')).toBe(false)
    expect(agentGetsKanbanWriteGate('geri')).toBe(false)
  })
  it('injects idempotently: respawn re-runs never accumulate duplicates', () => {
    const settings: Record<string, unknown> = {}
    injectKanbanWriteGate(settings)
    injectKanbanWriteGate(settings)
    const ptu = (settings.hooks as Record<string, unknown[]>).PreToolUse
    const mine = ptu.filter((e) => JSON.stringify(e).includes('kanban-write-gate.mjs'))
    expect(mine.length).toBe(1)
    expect((mine[0] as { matcher: string }).matcher).toBe('Bash')
  })
  it('keeps other PreToolUse entries intact', () => {
    const settings: Record<string, unknown> = {
      hooks: { PreToolUse: [{ matcher: 'WebFetch', hooks: [{ type: 'command', command: 'x/egress-gate.mjs' }] }] },
    }
    injectKanbanWriteGate(settings)
    const ptu = (settings.hooks as Record<string, unknown[]>).PreToolUse
    expect(ptu.length).toBe(2)
    expect(JSON.stringify(ptu[0])).toContain('egress-gate.mjs')
  })
})
