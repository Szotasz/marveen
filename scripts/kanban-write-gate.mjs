#!/usr/bin/env node
// PreToolUse hard-gate: the heartbeat worker must not WRITE the kanban board.
//
// HBFUTTATOIR824 (2026-08-24): the delegalt-feladat-figyelo skill has said,
// in capitals, since 2026-08-22: "A FUTTATO A TABLARA NEM IR. SEMMIT." --
// and nothing enforced it. Three violating writes happened on 2026-08-24
// alone (MIOFEED824 09:14, AIAMSUBMITSRC820 10:45, KANBANCTXDEAD824 14:43,
// the last auto-closing a card whose PR was still unreviewed). A rule that
// lives only in prompt text is the never-installed-guard pattern; this hook
// is the technical enforcement. Wired ONLY for the heartbeat worker
// (agentGetsKanbanWriteGate in agent-scaffold.ts) -- every other agent's
// kanban-first workflow REQUIRES board writes.
//
// What is blocked (per command segment, data payloads stripped first):
//   - SQL writes naming a kanban table (INSERT INTO / UPDATE..SET /
//     DELETE FROM / REPLACE INTO / DROP TABLE / ALTER TABLE kanban_*),
//     whatever binary runs them (sqlite3 CLI, python, node). Heredoc SQL
//     bodies are caught too: the naive segment split turns each body line
//     into its own segment, and the pattern needs no binary name.
//   - Write-method calls to the dashboard kanban API (/api/kanban with
//     -X POST/PUT/PATCH/DELETE or a data flag).
//
// What must PASS (the worker's actual duties):
//   - every kanban READ: sqlite3 SELECT, GET /api/kanban/heartbeat-summary;
//   - writes to NON-kanban tables (memories, daily log, agent_messages);
//   - its report messages: a curl -d payload QUOTING SQL-looking text (a
//     proposed transition) is stripped by stripDataPayloads before matching,
//     so describing a write is never treated as performing one.

import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { splitSegments, stripDataPayloads } from './self-pace-gate.mjs'

// SQL-shaped write patterns anchored on the kanban tables. Anchoring on the
// verb+table pair (not on the binary name) is what catches heredoc bodies and
// python/node DB writes with the same rule; prose has to reproduce the exact
// SQL shape (e.g. "UPDATE kanban_cards SET") to false-positive, and the one
// place that legitimately quotes such text -- a report payload -- is stripped
// before matching.
const KANBAN_SQL_WRITE_PATTERNS = [
  /\binsert\s+into\s+kanban_\w+/i,
  /\bupdate\s+kanban_\w+\s+set\b/i,
  /\bdelete\s+from\s+kanban_\w+/i,
  /\breplace\s+into\s+kanban_\w+/i,
  /\bdrop\s+table\s+(?:if\s+exists\s+)?kanban_\w+/i,
  /\balter\s+table\s+kanban_\w+/i,
]

// Dashboard kanban API write: the URL plus either an explicit write method or
// a data flag (curl defaults to POST when -d is present). A plain GET (the
// heartbeat-summary read) carries neither.
const KANBAN_API_RX = /\/api\/kanban\b/i
const WRITE_METHOD_RX = /(?:^|\s)(?:-X|--request)[\s=]*["']?(POST|PUT|PATCH|DELETE)\b/i
const DATA_FLAG_RX = /(?:^|\s)(?:-d|--data(?:-(?:raw|binary|ascii|urlencode))?|--json|-F|--form)\b/

export function gateDecision(toolName, toolInput) {
  if (toolName !== 'Bash') return { deny: false }
  const command = toolInput?.command
  if (typeof command !== 'string' || command.trim() === '') return { deny: false }

  // Strip data payloads BEFORE segmenting: a report payload legitimately
  // contains `|` (the jelolt-tetel column separator), and the naive splitter
  // would cut the quoted -d literal MID-STRING -- the piece carrying the
  // quoted SQL text would then lack the -d prefix and could never be blanked
  // (the same `<bar>` trap self-pace-gate documents on splitSegments).
  const stripped = stripDataPayloads(command)
  for (const seg of splitSegments(stripped)) {
    if (KANBAN_SQL_WRITE_PATTERNS.some((rx) => rx.test(seg))) {
      return { deny: true, reason: 'kanban-sql-write' }
    }
    if (KANBAN_API_RX.test(seg) && (WRITE_METHOD_RX.test(seg) || DATA_FLAG_RX.test(seg))) {
      return { deny: true, reason: 'kanban-api-write' }
    }
  }
  return { deny: false }
}

const GATE_MSG =
  'Kanban-iras TILTOTT a heartbeat-futtatonak (HBFUTTATOIR824 hard-gate). A sajat ' +
  'skilled (delegalt-feladat-figyelo, SCHEDSKIP817 szakasz) szerint a futtato a ' +
  'tablara nem ir SEMMIT: se statuszt, se kommentet, se cimet, se uj kartyat. ' +
  'Amit tenni akartal, az JELOLT-TETEL: ird bele a koordinatornak szolo ' +
  'lelet-uzenetbe (card_id | jelenlegi statusz | javasolt atmenet | evidencia), ' +
  'es a vegrehajtas a koordinatore. Olvasni tovabbra is szabad (SELECT, GET ' +
  '/api/kanban/heartbeat-summary).'

function allow() { process.exit(0) }

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }))
  process.exit(0)
}

function isInvokedDirectly() {
  try {
    const self = realpathSync(fileURLToPath(import.meta.url))
    const entry = process.argv[1] ? realpathSync(process.argv[1]) : ''
    return self === entry
  } catch {
    return false
  }
}

if (isInvokedDirectly()) {
  let payload
  try {
    payload = JSON.parse(readFileSync(0, 'utf-8'))
  } catch {
    allow() // malformed/empty input must never break the agent's tool calls
  }
  const { deny: shouldDeny } = gateDecision(payload?.tool_name, payload?.tool_input)
  if (shouldDeny) deny(GATE_MSG)
  allow()
}
