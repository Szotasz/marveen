#!/usr/bin/env node
// PreToolUse SOFT-gate: AUTO-APPROVES the marketer profile's own safe Bash
// command families for a STRICT (web-reading) sub-agent -- in ANY shape the
// static allowlist matcher misses (shell-variable binaries, heredocs, compound
// commands, `cd A && cd B` directory-change heuristics).
//
// Why this exists (2026-07-23, Brandon presentation workflow): the marketer
// profile is `strict`, so the agent launches WITHOUT
// --dangerously-skip-permissions and honours its allow/deny list. Some prompt
// classes are UNFIXABLE by allowlist entries alone, because they do not come
// from the allow/deny list at all:
//   (a) built-in CC heuristics ("Multiple directory changes in one command"),
//   (b) shell-variable binaries: `VP=/.../.venv/bin/python; $VP - <<PY` -- the
//       matcher never resolves $VP, so `*/.venv/bin/python:*` does not match,
//   (c) heredoc / compound commands whose body tokens confuse the matcher.
//
// CONTRACT (identical to the two hard-gates): stdin is the PreToolUse payload
// JSON {tool_name, tool_input:{command}}. To ALLOW, write
// {hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',...}}
// and exit 0. To pass through (NOT recognised as safe): exit 0 with NO output --
// the normal permission flow then prompts/denies. This gate NEVER emits 'deny';
// the email-send / self-pace hard-gates own that, and a 'deny' from any hook
// wins over an 'allow' from this one, so an approval here can never override a
// governance block.
//
// LEAST PRIVILEGE -- this gate grants NOTHING beyond the families already in the
// marketer allowlist; it only makes matching robust across var/heredoc/compound
// forms, and it is STRICTER than the profile in three places:
//   - curl is approved ONLY for localhost:3420 / 127.0.0.1:3420 (external curl
//     is an exfiltration surface -> falls through to a prompt),
//   - rm is approved ONLY under the agent's own write-roots (passed in via argv)
//     or /tmp/claude* -- never an arbitrary path,
//   - sudo anywhere, any secret path (.env/.ssh/.aws/.gnupg), or a command
//     substitution ($(...) / backticks) we cannot statically classify -> never
//     approved (pass through).
// ALL segments of a compound command must be safe, or the whole command passes
// through. The safe families below are EXACTLY the marketer allowlist families
// (templates/profiles/marketer.json) -- keep them in sync; this gate is wired
// ONLY onto the marketer profile (agent-scaffold.ts), never fleet-wide, so a
// narrower strict profile (researcher, developer-junior) is never broadened.
//
// Wired into the marketer sub-agent's .claude/settings.json by
// writeAgentSettingsFromProfile() (agent-scaffold.ts), re-applied on every spawn
// (respawn-safe). The install-specific rm write-roots are passed as a base64url
// argv token so the script stays self-contained (no config.ts import).

import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
// Defense-in-depth: reuse the governance HARD-gates' own decision logic so this
// soft-gate never approves a command they would deny. CC's precedence for
// conflicting allow/deny PreToolUse decisions is UNDOCUMENTED, so we do not rely
// on "deny beats allow" -- we make the hard-gates decisive by construction.
import { gateDecision as selfPaceDecision } from './self-pace-gate.mjs'
import { gateDecision as emailDecision } from './email-send-gate.mjs'

// Bare simple binaries (token must have NO slash and equal one of these). These
// mirror the marketer allowlist's bare `Bash(<name>:*)` families. curl / rm /
// command are handled separately (extra narrowing); soffice / libreoffice are
// matched by basename (they have `*/` path forms in the profile); python paths
// are matched by the venv regex below.
const BARE_BINS = new Set([
  'ls', 'cat', 'head', 'tail', 'grep', 'rg', 'find', 'echo', 'wc', 'sort',
  'uniq', 'sed', 'awk', 'mkdir', 'cp', 'mv', 'touch', 'unzip', 'zip', 'tar',
  'cd', 'date', 'python', 'python3', 'pip', 'pip3', 'node', 'sqlite3',
  'convert', 'magick', 'pdftoppm', 'pdfinfo',
])

// venv python path forms the profile allows: `*/.venv/bin/python`,
// `*/venv/bin/python` (+ python3 in the same venv, same family).
const VENV_PYTHON_RX = /(?:^|\/)(?:\.venv|venv)\/bin\/python(?:3(?:\.\d+)?)?$/

// Any path whose basename is soffice/libreoffice (profile has bare, `*/`, and
// `/usr/bin/` forms -- basename match covers all three).
const OFFICE_BASENAMES = new Set(['soffice', 'libreoffice'])

// Secret paths the marketer profile denies for the Read tool. We refuse to
// auto-approve any Bash command that references one, so the gate never opens a
// new read hole for these (matches the profile's security posture).
const SECRET_PATH_RX = /\.(?:env|ssh|aws|gnupg)\b/

// Collapse line-continuations FIRST (so a single command split across lines
// stays ONE segment), then split a compound command into simple commands so a
// token in one segment cannot be misclassified against another. Same helper
// shape as self-pace-gate.splitSegments.
export function splitSegments(command) {
  return String(command ?? '')
    .replace(/\\\r?\n/g, ' ')
    .split(/&&|\|\||[;&|]|\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
}

// Remove heredoc BODIES before segmenting. Brandon's workflow is
// `$VP - <<PY ... PY`: the body is Python (or generated markdown) that can
// contain `;`, `&&`, backticks, `sudo`, `.env`, etc. as DATA -- never shell
// invocations of this command. Stripping the body first prevents those data
// tokens from fragmenting into false segments or tripping the sudo/secret/subst
// guards. The opener line (`$VP - <<PY`) is kept so the binary still classifies.
// Handles `<<WORD`, `<<-WORD` (leading-tab-stripped terminator), and quoted
// `<<'WORD'` / `<<"WORD"`. Multiple heredocs on one line are consumed in order.
export function stripHeredocs(command) {
  const lines = String(command ?? '').split(/\r?\n/)
  const out = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    out.push(line)
    const openers = [...line.matchAll(/<<(-?)\s*(['"]?)([A-Za-z_]\w*)\2/g)]
      .map((m) => ({ dash: m[1] === '-', delim: m[3] }))
    i++
    for (const op of openers) {
      while (i < lines.length) {
        const term = op.dash ? lines[i].replace(/^\t+/, '') : lines[i]
        i++
        if (term === op.delim) break
      }
    }
  }
  return out.join('\n')
}

// Blank out curl/HTTP -d/--data payloads before URL classification, so a URL or
// host that appears only INSIDE a literal data body is not read as a curl
// target. Same literal-only quote handling as self-pace-gate.stripDataPayloads
// (a double-quoted payload that can command-substitute is left intact and then
// blocked by the $(...) guard).
export function stripDataPayloads(seg) {
  return String(seg ?? '').replace(
    /((?:^|\s)(?:-d|--data(?:-(?:raw|binary|ascii|urlencode))?)(?:\s+|=))('[^']*'|\$'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/gi,
    (full, flag, arg) => {
      const dq = arg.startsWith('"')
      if (dq && (arg.includes('$(') || arg.includes('`'))) return full
      return flag + (dq ? '""' : "''")
    },
  )
}

// Collect VAR=value assignments across ALL segments (Brandon assigns
// `VP=/.../.venv/bin/python` in one segment and uses `$VP` in the next). Value
// quotes are stripped. Not quote-aware for spaces in values (a binary path has
// none) -- defense-in-depth, not an adversarial sandbox.
export function collectAssignments(segments) {
  const vars = {}
  for (const seg of segments) {
    for (const tok of seg.split(/\s+/)) {
      const m = tok.match(/^([A-Za-z_]\w*)=(.*)$/)
      if (!m) break // first non-assignment token ends the leading-assignment run
      vars[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
    }
  }
  return vars
}

// The effective binary of a segment: skip leading VAR=value tokens, then resolve
// a leading $VAR / ${VAR} against the collected assignments. Returns
// { bin, rest } where rest is the remaining tokens after the binary; bin is null
// for a pure-assignment segment, and false for an UNRESOLVED variable (which
// must NOT be approved).
export function resolveBinary(seg, vars) {
  const toks = seg.split(/\s+/).filter(Boolean)
  let idx = 0
  while (idx < toks.length && /^[A-Za-z_]\w*=/.test(toks[idx])) idx++
  if (idx >= toks.length) return { bin: null, rest: [] } // only assignments
  let bin = toks[idx].replace(/^['"]|['"]$/g, '')
  const varMatch = bin.match(/^\$\{?([A-Za-z_]\w*)\}?$/)
  if (varMatch) {
    if (!(varMatch[1] in vars)) return { bin: false, rest: [] } // unknown var
    bin = vars[varMatch[1]]
  }
  return { bin, rest: toks.slice(idx + 1) }
}

// curl is safe ONLY when every target is localhost:3420 / 127.0.0.1:3420.
export function curlLocalOnly(seg) {
  const s = stripDataPayloads(seg)
  const LOCAL = /(?:https?:\/\/)?(?:localhost|127\.0\.0\.1):3420(?![0-9])/i
  if (!LOCAL.test(s)) return false
  const schemeUrls = s.match(/\bhttps?:\/\/[^\s'"]+/gi) || []
  for (const u of schemeUrls) {
    if (!/^https?:\/\/(?:localhost|127\.0\.0\.1):3420(?![0-9])/i.test(u)) return false
  }
  return true
}

// rm is safe ONLY when every non-flag target is an ABSOLUTE path under one of
// the agent's write-roots (passed via config.rmRoots) or the /tmp/claude*
// scratchpad. Relative paths cannot be verified (cwd unknown) -> not safe. Any
// `..` in a target -> not safe (path-escape guard).
export function rmSafeRoots(rest, config = {}) {
  const home = process.env.HOME || ''
  const dirRoots = Array.isArray(config.rmRoots) ? config.rmRoots : []
  const targets = rest.filter((t) => !t.startsWith('-'))
  if (targets.length === 0) return false
  for (let t of targets) {
    t = t.replace(/^['"]|['"]$/g, '')
    if (t === '~') t = home
    else if (t.startsWith('~/')) t = home + t.slice(1)
    if (!t.startsWith('/')) return false
    if (t.includes('..')) return false
    const okDir = dirRoots.some((r) => r && (t === r || t.startsWith(r.replace(/\/$/, '') + '/')))
    const okTmp = t.startsWith('/tmp/claude')
    if (!okDir && !okTmp) return false
  }
  return true
}

// Classify one segment. Returns true only if its binary is a marketer-safe
// family AND passes any per-binary narrowing.
export function segmentSafe(seg, vars, config) {
  const { bin, rest } = resolveBinary(seg, vars)
  if (bin === null) return true // pure VAR=value assignment
  if (bin === false) return false // unresolved $VAR
  const basename = bin.split('/').pop()
  const hasSlash = bin.includes('/')
  if (bin === 'command') return rest[0] === '-v' // profile: `command -v`
  if (bin === 'curl' && !hasSlash) return curlLocalOnly(seg)
  if (bin === 'rm' && !hasSlash) return rmSafeRoots(rest, config)
  if (VENV_PYTHON_RX.test(bin)) return true
  if (OFFICE_BASENAMES.has(basename)) return true // bare, */, /usr/bin/ forms
  if (!hasSlash && BARE_BINS.has(bin)) return true
  return false
}

// Pure decision: should this tool call be AUTO-APPROVED?
export function gateDecision(toolName, toolInput, config = {}) {
  if (String(toolName ?? '') !== 'Bash') return { allow: false }
  const raw = String(toolInput?.command ?? '')
  if (!raw.trim()) return { allow: false }
  // DEFENSE IN DEPTH (do not depend on CC's undocumented allow/deny precedence):
  // refuse to auto-approve ANY command the governance hard-gates would deny
  // (self-pace: /api/schedules POST, tmux send-keys, scheduled_tasks.json write,
  // crontab/at, /loop; email-send: outbound mail). This guarantees the hard-gates
  // stay decisive regardless of hook ordering/precedence -- an 'allow' from here
  // can never let a self-pace or email-send command through.
  if (selfPaceDecision(toolName, toolInput).deny) return { allow: false }
  if (emailDecision(toolName, toolInput).deny) return { allow: false }
  // Strip heredoc bodies BEFORE the whole-command guards, so a data token inside
  // a heredoc body (python/markdown) never trips sudo/secret/substitution.
  const stripped = stripHeredocs(raw)
  if (/\bsudo\b/.test(stripped)) return { allow: false }
  if (/\$\(|`/.test(stripped)) return { allow: false } // unclassifiable substitution
  if (SECRET_PATH_RX.test(stripped)) return { allow: false }
  const segments = splitSegments(stripped)
  if (segments.length === 0) return { allow: false }
  const vars = collectAssignments(segments)
  for (const seg of segments) {
    if (!segmentSafe(seg, vars, config)) return { allow: false }
  }
  return { allow: true }
}

const GATE_MSG =
  'Auto-approve (marketer workflow gate): minden szegmens a marketer allowlist ' +
  'biztonsagos parancscsaladjaba esik (valtozo/heredoc/compound feloldva). A hook ' +
  'nem ad tobb jogot az allowlistnal; curl csak localhost:3420, rm csak az irhato ' +
  'gyokerek alatt, sudo/titok/command-substitution atesik a normal flow-ra.'

function allow(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: reason,
    },
  }))
  process.exit(0)
}

// Pass through: exit 0 with NO output -> normal permission flow decides.
function passThrough() { process.exit(0) }

// argv[2] is a base64url JSON config { rmRoots: string[] }. Absent/invalid ->
// empty config (rm then never auto-approves -> fail-safe to a prompt).
function readConfig() {
  try {
    const tok = process.argv[2]
    if (!tok) return {}
    return JSON.parse(Buffer.from(tok, 'base64url').toString('utf-8')) || {}
  } catch {
    return {}
  }
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
    passThrough() // malformed/empty input must never break the agent's tool calls
  }
  const { allow: shouldAllow } = gateDecision(payload?.tool_name, payload?.tool_input, readConfig())
  if (shouldAllow) allow(GATE_MSG)
  passThrough()
}
