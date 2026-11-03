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
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

describe('kanban-write-gate gateDecision: the marveen-api.sh kanban verbs (#2080)', () => {
  // #2080 moved the kanban recipes onto scripts/marveen-api.sh: a write is now a verb of the helper,
  // with no /api/kanban URL and no SQL on the command line, so neither rule above sees it. The helper
  // path -- or a bash / sh / python runner or a parameter expansion, since the path may sit in a variable --
  // followed by a write verb denies; the read verbs, the help and the report message pass.
  const denied = (command: string) => {
    const v = bash(command)
    expect({ command, deny: v.deny, reason: v.reason }).toEqual({ command, deny: true, reason: 'kanban-helper-write' })
  }
  it('denies every write verb of the helper', () => {
    for (const command of [
      'bash scripts/marveen-api.sh kanban-create heartbeat normal /tmp/title.txt',
      'bash scripts/marveen-api.sh kanban-move abcd1234 done --evidence-file /tmp/ev.txt',
      'bash scripts/marveen-api.sh kanban-claim abcd1234 heartbeat',
      'bash scripts/marveen-api.sh kanban-release abcd1234 heartbeat',
      'bash scripts/marveen-api.sh kanban-comment abcd1234 heartbeat /tmp/c.txt',
    ]) denied(command)
  })
  it('denies the other spellings of the same call', () => {
    for (const command of [
      'bash /home/marveen/marveen/scripts/marveen-api.sh kanban-move abcd1234 done',
      "bash '/home/x y/marveen/scripts/marveen-api.sh' 'kanban-move' abcd1234 done",
      'cd /home/marveen/marveen && MARVEEN_API_BASE=http://127.0.0.1:3420 bash scripts/marveen-api.sh kanban-comment abcd1234 heartbeat /tmp/c.txt',
      'scripts/marveen-api.sh kanban-claim abcd1234 heartbeat',
      'timeout 30 bash scripts/marveen-api.sh kanban-release abcd1234 heartbeat',
      'python3 scripts/lib/marveen_api.py kanban-create heartbeat high /tmp/t.txt',
      'H=scripts/marveen-api.sh; bash "$H" kanban-move abcd1234 done',
      // the shell joins what the quotes split, and a quoted space keeps NAME=value one word
      'H=scripts/marveen-api.sh; bash "$H" kanban-"move" abcd1234 done',
      "bash scripts/marveen-api.sh 'kanban'-move abcd1234 done",
      "H=scripts/marveen-api.sh; X='a b' bash \"$H\" kanban-move abcd1234 done",
      'H=scripts/marveen-api.sh; timeout 30 bash "$H" kanban-move abcd1234 done',
      // the helper run straight from a variable: a parameter expansion is a runner, too
      'H=scripts/marveen-api.sh; "$H" kanban-move abcd1234 done',
      'H=scripts/marveen-api.sh; ${H} kanban-claim abcd1234 heartbeat',
      'P=scripts/lib/marveen_api.py; python3.11 "$P" kanban-create heartbeat high /tmp/t.txt',
      // a backslash-newline is joined by the shell before it splits words
      'bash scripts/marveen-api.sh kanban-mo\\\nve abcd1234 done',
    ]) denied(command)
  })
  it('allows the read verbs, the help and the report message', () => {
    for (const command of [
      'bash scripts/marveen-api.sh kanban-list',
      'bash scripts/marveen-api.sh agents-list',
      'bash scripts/marveen-api.sh --help',
      'bash scripts/marveen-api.sh message heartbeat marveen /tmp/jelolt.txt',
      "bash scripts/marveen-api.sh message heartbeat marveen - <<'EOF'\nabcd1234 | waiting | javasolt: kanban-move abcd1234 done | msg 123\nEOF",
      'grep -n kanban-move scripts/lib/marveen_api.py',
    ]) expect({ command, deny: bash(command).deny }).toEqual({ command, deny: false })
  })
  // The word boundaries (maintainer mutants on #2080): the shell drops a backslash anywhere in a word, not only
  // before a newline; the runner and the verb count only as whole words.
  it('denies a verb with a backslash inside the word', () => {
    for (const command of [
      'bash scripts/marveen-api.sh kanban-mo\\ve abcd1234 done',
      'bash scripts/marveen-api.sh kanban\\-claim abcd1234 heartbeat',
    ]) denied(command)
  })
  it('allows a runner name inside a longer word: git push, git show, a path ending in .sh, $VAR/path', () => {
    for (const command of [
      'git push fork kanban-move',
      'git show kanban-move',
      './scripts/agent-msg.sh lead "kanban-move done"',
      'cat "$TMPDIR/kanban.txt" kanban-move',
    ]) expect({ command, deny: bash(command).deny }).toEqual({ command, deny: false })
  })
  it('allows a verb inside a longer word: a path, a file name, a plural', () => {
    for (const command of [
      'bash scripts/marveen-api.sh message heartbeat marveen /tmp/kanban-move',
      'bash scripts/marveen-api.sh message heartbeat marveen kanban-comment.txt',
      'bash scripts/marveen-api.sh message heartbeat marveen kanban-moves',
    ]) expect({ command, deny: bash(command).deny }).toEqual({ command, deny: false })
  })
  it('the hook process: deny-JSON for a helper write; empty output for kanban-list and for broken input; exit 0', () => {
    const gate = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'kanban-write-gate.mjs')
    const run = (input: string) => spawnSync(process.execPath, [gate], { input, encoding: 'utf-8' })
    const call = (command: string) => run(JSON.stringify({ tool_name: 'Bash', tool_input: { command } }))
    const w = call('bash scripts/marveen-api.sh kanban-move abcd1234 done')
    expect({ status: w.status, decision: JSON.parse(w.stdout).hookSpecificOutput.permissionDecision }).toEqual({ status: 0, decision: 'deny' })
    const r = call('bash scripts/marveen-api.sh kanban-list')
    expect({ status: r.status, stdout: r.stdout }).toEqual({ status: 0, stdout: '' })
    const c = call('bash scripts/marveen-api.sh kanban-mo\\\nve abcd1234 done')
    expect({ status: c.status, decision: JSON.parse(c.stdout).hookSpecificOutput.permissionDecision }).toEqual({ status: 0, decision: 'deny' })
    const b = run('{not json')
    expect({ status: b.status, stdout: b.stdout }).toEqual({ status: 0, stdout: '' })
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
