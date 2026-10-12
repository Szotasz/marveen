#!/usr/bin/env node
// PreToolUse hard-gate: the heartbeat worker's outgoing digest must cite REAL,
// CURRENT state -- provenance enforced in code, not prose.
//
// DIGESTSTALE825 (2026-08-26): the delegalt-feladat-figyelo digest reported
// closed work as open (0/4 accuracy on the 10:13 round), fabricated an owner
// decision that never existed, and misattributed an agent. The instruction
// layer was PROVEN insufficient the same morning: a "re-measure before
// emitting" gate was added to the task's SKILL.md at 09:34 and the very first
// run after it (10:13) still shipped all four errors. Same lesson as
// kanban-write-gate (HBFUTTATOIR824): a rule that lives only in prompt text is
// the never-installed-guard pattern. This hook is the technical enforcement,
// wired ONLY for the heartbeat worker (same scope as kanban-write-gate in
// agent-scaffold.ts) -- every other agent's /api/messages traffic is not
// digest traffic and must stay untouched.
//
// What is validated (ONLY on Bash commands that POST to /api/messages):
//   1. ACTION ROWS (the jelolt-tetel format: `card_id | status | javasolt
//      atmenet | evidencia`, i.e. lines with >=2 " | " separators): any kanban
//      card id in the row must be an OPEN card (not done, not archived), and
//      any #NNNN PR reference must not already be merged to origin/develop.
//      Prose mentions outside action rows are free -- a real alert saying
//      "a #1062 mergelve" must pass (the failure mode is proposing CLOSED work
//      as actionable, not mentioning it). A line starting with "kozben
//      lezarult" is the sanctioned way to mention just-closed items (exempt).
//   2. MESSAGE CITATIONS anywhere in the draft (`msg 16014` / `msg_id:16014`):
//      the cited id must exist in agent_messages, must NOT be a message the
//      heartbeat itself authored (self-citation is how a digest cited its own
//      previous digest as a source), and when the same line carries a
//      >>verbatim quote<<, the quote must be a substring of that message's
//      content (whitespace-normalized). A fabricated attribution cannot carry
//      a verifiable citation.
//
// KNOWN LIMIT (accepted by Marveen, msg 16050): a wrong-AGENT-name in prose
// (the Dani/geri error) is not mechanically catchable; mandatory verbatim
// citations only constrain it, they do not eliminate it.
//
// Failure posture (Marveen stipulation, msg 16050): an INTERNAL error while
// validating an in-scope POST (DB unreadable, payload file missing) DENIES
// loudly with the error in the reason -- never fail-open, never a silent
// swallow. Empty/malformed stdin (a non-matching hook event) allows, same as
// the sibling gates: that path never had a digest to validate.

import { readFileSync, realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = process.env.DIGEST_GATE_ROOT || join(SCRIPT_DIR, '..')
const DB_PATH = process.env.DIGEST_GATE_DB || join(PROJECT_ROOT, 'store', 'claudeclaw.db')
const HEARTBEAT_ID = process.env.HEARTBEAT_AGENT_ID || 'heartbeat'

// ---- payload extraction ---------------------------------------------------

const API_MESSAGES_RX = /\/api\/messages\b/
const DATA_FLAG_RX = /(?:^|\s)(?:-d|--data(?:-(?:raw|binary|ascii))?|--json)\b/

// Extract the JSON body a curl command sends: either inline (-d '...' /
// -d "...") or from a file (-d @path / --data-binary @path -- the task's own
// SKILL instructs `--data @/tmp/lelet.json`).
export function extractPayload(command, readFile) {
  const fileRef = command.match(/(?:-d|--data(?:-(?:raw|binary|ascii))?|--json)[\s=]+@([^\s'"]+)/)
  if (fileRef) return readFile(fileRef[1])
  const single = command.match(/(?:-d|--data(?:-(?:raw|binary|ascii))?|--json)[\s=]+'((?:[^'\\]|\\.)*)'/)
  if (single) return single[1]
  const dbl = command.match(/(?:-d|--data(?:-(?:raw|binary|ascii))?|--json)[\s=]+"((?:[^"\\]|\\.)*)"/)
  if (dbl) return dbl[1].replace(/\\(["\\$`])/g, '$1')
  return null
}

// ---- content validation ---------------------------------------------------

const norm = (s) => s.replace(/\s+/g, ' ').trim()

// A jelolt-tetel action row: at least two " | " column separators.
const isActionRow = (line) => line.split(' | ').length >= 3
const isClosedNoteLine = (line) => /^\s*kozben lezarult/i.test(line)

const MSG_CITE_RX = /\bmsg(?:_id)?[:\s#]+(\d{2,8})\b/gi
const PR_REF_RX = /#(\d{3,5})\b/g
const QUOTE_RX = />>([^<]{4,}?)<</g

export function validateContent(content, deps) {
  const violations = []
  const cards = deps.allCards() // [{id, status, archived}]
  const closedIds = cards.filter((c) => c.status === 'done' || c.archived).map((c) => c.id)

  for (const line of content.split('\n')) {
    if (isActionRow(line) && !isClosedNoteLine(line)) {
      for (const c of closedIds) {
        if (new RegExp(`\\b${c}\\b`).test(line)) {
          violations.push(`lezart kartya (${c}) akcio-sorban -- a 6a kapu szerint az ilyen tetel KIESIK`)
        }
      }
      for (const m of line.matchAll(PR_REF_RX)) {
        if (deps.prMerged(Number(m[1]))) {
          violations.push(`mergelt PR (#${m[1]}) akcio-sorban -- mar nem nyitott munka`)
        }
      }
    }
    const cites = [...line.matchAll(MSG_CITE_RX)]
    if (cites.length === 0) continue
    const quotes = [...line.matchAll(QUOTE_RX)].map((q) => norm(q[1]))
    for (const cite of cites) {
      const msg = deps.getMessage(Number(cite[1]))
      if (!msg) {
        violations.push(`nem letezo uzenet-hivatkozas (msg ${cite[1]})`)
        continue
      }
      if (msg.from_agent === HEARTBEAT_ID) {
        violations.push(`onhivatkozas (msg ${cite[1]} a heartbeat sajat uzenete) -- digest nem forras`)
        continue
      }
      for (const q of quotes) {
        if (!norm(msg.content).includes(q)) {
          violations.push(`az idezet nem talalhato a hivatkozott uzenetben (msg ${cite[1]}: ">>${q.slice(0, 60)}<<")`)
        }
      }
    }
  }
  return violations
}

// ---- default deps (live DB / repo) ----------------------------------------

function sqliteJson(sql) {
  const out = execFileSync('sqlite3', [DB_PATH, '-json', sql], { encoding: 'utf-8', timeout: 8000 })
  return out.trim() ? JSON.parse(out) : []
}

export const defaultDeps = {
  allCards: () =>
    sqliteJson('SELECT id, status, archived_at FROM kanban_cards').map((r) => ({
      id: r.id,
      status: r.status,
      archived: r.archived_at != null,
    })),
  getMessage: (id) => {
    const rows = sqliteJson(`SELECT id, from_agent, content FROM agent_messages WHERE id=${Number(id)}`)
    return rows[0] || null
  },
  // Best-effort: a PR squash-merged to develop leaves "(#N)" in the subject.
  // If the local origin/develop ref lags, a just-merged PR can slip through --
  // documented, the card-status check is the authoritative half.
  prMerged: (n) => {
    try {
      const out = execFileSync(
        'git',
        ['-C', PROJECT_ROOT, 'log', 'origin/develop', '--oneline', '-n', '1', '--fixed-strings', '--grep', `(#${n})`],
        { encoding: 'utf-8', timeout: 8000 },
      )
      return out.trim() !== ''
    } catch {
      return false
    }
  },
  readFile: (p) => readFileSync(p, 'utf-8'),
}

// ---- gate decision ---------------------------------------------------------

export function gateDecision(toolName, toolInput, deps = defaultDeps) {
  if (toolName !== 'Bash') return { deny: false }
  const command = toolInput?.command
  if (typeof command !== 'string' || command.trim() === '') return { deny: false }
  if (!API_MESSAGES_RX.test(command) || !DATA_FLAG_RX.test(command)) return { deny: false }

  // From here the command IS an in-scope digest send: internal failures deny.
  let payloadRaw
  try {
    payloadRaw = extractPayload(command, deps.readFile)
  } catch (err) {
    return { deny: true, reason: `INTERNAL ERROR (payload beolvasas): ${err?.message || err} -- fail-closed` }
  }
  if (payloadRaw == null) {
    return { deny: true, reason: 'a /api/messages POST torzse nem nyerheto ki a parancsbol -- fail-closed (hasznalj -d @file vagy -d \'json\' alakot)' }
  }
  let payload
  try {
    payload = JSON.parse(payloadRaw)
  } catch (err) {
    return { deny: true, reason: `INTERNAL ERROR (payload nem valid JSON): ${err?.message || err} -- fail-closed` }
  }
  const content = payload?.content
  if (typeof content !== 'string' || content.trim() === '') return { deny: false }

  let violations
  try {
    violations = validateContent(content, deps)
  } catch (err) {
    return { deny: true, reason: `INTERNAL ERROR (provenancia-ellenorzes): ${err?.message || err} -- fail-closed` }
  }
  if (violations.length > 0) return { deny: true, reason: violations.join('; ') }
  return { deny: false }
}

// ---- hook entrypoint -------------------------------------------------------

const GATE_PREFIX =
  'Digest-provenancia kapu (DIGESTSTALE825): a lelet-uzenet ellenorzese elbukott. ' +
  'Merd ujra az erintett tetelt (kartya-statusz / gh pr view / agent_messages), ' +
  'javitsd a draftot, es kuldd ujra. Reszletek: '

function allow() { process.exit(0) }

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: GATE_PREFIX + reason,
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
    allow() // malformed/empty stdin = not a matching hook event, nothing to validate
  }
  const result = gateDecision(payload?.tool_name, payload?.tool_input)
  if (result.deny) deny(result.reason)
  allow()
}
