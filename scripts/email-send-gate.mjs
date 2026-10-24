#!/usr/bin/env node
// PreToolUse hard-gate: blocks outbound email-send for sub-agents.
//
// Governance control (Szabi 2026-06-25, after the Boni incident: a sub-agent
// autonomously emailed a fabricated address asking for money in Szabi's name).
// Sub-agents may NOT send outbound email; any email must be routed through the
// main agent (Marveen) for approval -- only Marveen retains email-send.
//
// STATED LIMIT (msg 14298): this gate catches the ACCIDENTAL send, not a
// determined evader. Static analysis of arbitrary interpreter code is
// undecidable, so a sub-agent CAN send through interpreter code the patterns
// do not model -- the premise "a sub-agent cannot send outbound" does NOT
// hold against intent, only against accident. The exec-heuristic below covers
// the naive shapes (process-spawn plus a known mailer name in one code
// string) and claims no more. Our sub-agents are not adversaries; if that
// assumption ever changes, this gate is the wrong tool.
//
// Why a hook and not a permissions deny-list: the hook is version- and
// mode-independent, and it can analyze command CONTENT (the Bash send-shape
// heuristics below), which a name/prefix deny rule cannot express.
// CORRECTION (SKIPDENY910, measured 2026-09-10): this comment used to claim
// that --dangerously-skip-permissions BYPASSES the settings.json deny list.
// That is false on every CLI version we measured (2.1.63, 2.1.110, 2.1.267;
// marker-file ground truth, deny arm vs no-deny control, -p AND interactive
// TUI): the deny list IS enforced under the flag, and a tool-name deny is
// enforced by removing the tool from the session entirely. The hook remains
// the primary gate anyway -- future CLI behavior is not a contract, and the
// deny list stays a second, independent layer, not the load-bearing one.
//
// This file is wired into every sub-agent's .claude/settings.json by
// writeAgentSettingsFromProfile() (agent-scaffold.ts), guarded by
// name !== MAIN_AGENT_ID, and re-applied on every spawn (respawn-safe).

import { closeSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'

// HOOKDEPLOAD1008: the ledger module is a DYNAMIC import. As a static import, a
// broken recipient-ledger.mjs (a syntax error, a conflicted merge, a missing
// export) failed the module link before any line of this file ran: node exited
// 1, which PreToolUse treats as NON-blocking, so EVERY call went through
// unchecked -- the send_email deny included, which never needs the ledger.
// Now the failure is kept, only a decision that needs the ledger hits it, and
// that one fails closed at the entrypoint (exit 2, the reason on stderr).
let loadLedger, isVerifiedIn, splitAddresses, parseAddresses, SOURCE_HELP
let LEDGER_LOAD_ERROR = null
try {
  ({ loadLedger, isVerifiedIn, splitAddresses, parseAddresses, SOURCE_HELP } = await import('./recipient-ledger.mjs'))
  const missing = Object.entries({ loadLedger, isVerifiedIn, splitAddresses, parseAddresses })
    .filter(([, fn]) => typeof fn !== 'function').map(([name]) => name)
  if (missing.length) throw new Error(`missing export: ${missing.join(', ')}`)
} catch (err) {
  LEDGER_LOAD_ERROR = err
  const unavailable = () => { throw new Error(`recipient-ledger.mjs did not load: ${err?.message ?? err}`) }
  loadLedger = isVerifiedIn = splitAddresses = parseAddresses = unavailable
  SOURCE_HELP = '(a ledger modul nem toltheto be)'
}

// Bash command patterns that send mail. SUBGATEPOZ822 (2026-08-22): these are
// no longer the primary trigger -- they matched CONTENT anywhere in the
// command string, and the header's old premise ("a sub-agent has no
// legitimate need to invoke these") broke measurably: the developer of the
// mail tooling IS a sub-agent, and the gate blocked the delivery of the
// mail-gate fix three times in one afternoon (commit message, PR body,
// card-comment sqlite write), plus five more content hits across the fleet
// the same day. The primary trigger is now isSendInvocation() below
// (command-position analysis); this list remains ONLY as the conservative
// fallback when a command cannot be tokenized (unbalanced quote) -- on
// unparseable input the gate behaves exactly as before, never weaker.
const SEND_PATTERNS = [
  /support-mail\/send\.py/i,
  /\bsend\.py\b/i,
  /api\.resend\.com/i,
  /\bresend\b[^\n]*\b(email|send|message)\b/i,
  /\bsendmail\b/i,
  /\bmsmtp\b/i,
  /\bswaks\b/i,
  /\bsmtplib\b|SMTP\s*\(/i,
  /\bmail\.send\b|\bsendEmail\b/i,
  // graph-mail.ts (PR #668, M365/Exchange Online client-credentials mailbox):
  // its CLI is `tsx scripts/graph-mail.ts send ...`, which none of the above
  // patterns catch (no "sendmail"/"mail.send" substring). Also gate any direct
  // call to the exported sendMail() (e.g. a one-off `node -e`/`tsx -e` that
  // imports the module without going through the CLI).
  /\bgraph-mail\b[^\n]*\bsend\b/i,
  /\bsendMail\s*\(/i,
]

// --- command-position analysis (SUBGATEPOZ822) ------------------------------
// Ported from scripts/hooks/outgoing-copy-gate.py (KAPUHATOKOR822, PR #1042,
// two adversarial rounds): quote-aware tokenization, then the INVOKED program
// of each pipeline/sequence segment decides. A quoted token keeps its
// POSITION, so a quoted provider URL in curl argument position still fires
// (the normal way curl is written), while the same domain inside a quoted -d
// payload stays content (the target pattern is anchored to the token start).
// Wrapper-shell -c strings recurse; interpreter code-string arguments
// (python -c / node -e) are scanned for code-level send calls -- code handed
// to an interpreter IS operation, not content.
// Order-independent heredoc stripping (round 3, msg 14286): the rest of
// the intro line (e.g. a redirect after the marker) is command text and
// is KEPT -- only the body is cut. Without this, marker-first spellings
// leaked the body into command position (FP), and dropping the intro
// would have lost a heredoc-fed real sender (FN).
const HEREDOC_RE = /(<<-?\s*'?(\w+)'?[^\n]*)\n[\s\S]*?\n\2(?=\s|$)/g
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z_0-9]*=/
// KWSPLIT924: shell reserved words that put the NEXT word in command position.
// Stripped only at the head of a segment, never used as separators -- see the
// full rationale at _CMD_POSITION_KEYWORDS in outgoing-copy-gate.py (the python
// twin); the shared send-invocation-cases.json binds the two copies.
const CMD_POSITION_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '{', '!'])
const SENDER_PROG = /^(sendmail|msmtp|swaks)$/i
const SENDPY = /^send\.py$/i
// SUBAGENTMAILGATE1016: a version-suffixed interpreter (python3.12, python3.13, and
// the free-threaded python3.13t) is the same python; the old /^python3?$/ let it
// through as "not an interpreter".
const PYTHON = /^python(3(\.\d+t?)?)?$/i
const NODEISH = /^(node|tsx|ts-node|deno|bun|npx)$/i
const GRAPHMAIL = /^graph-mail(\.ts|\.js)?$/i
const WRAPPER_SHELL = /^(sh|bash|zsh|dash)$/i
const CURLISH = /^(curl|wget|http)$/i
const RESEND_TARGET = /^(https?:\/\/)?([^/@\s]*\.)?api\.resend\.com(\/|$)/i
// RESENDGETTWIN1010: port of the python twin's method verdict (RESENDGATE826,
// outgoing-copy-gate.py :: _curl_resend_verdict). Until now this copy was
// method-blind and denied a read-only GET /domains the python copy passed.
// Strict direction kept: the method must be RECOGNIZED (explicit -X/--request/
// --method, or an implicit POST from a body flag); an undecidable method
// (variable, truncated flag, config file) stays a send. httpie (`http`) takes
// its method positionally and its body as `key=value` items, none of which this
// flag scan reads, so it is undecidable too and stays a send in both twins.
const HTTPIE = /^http$/i
const CURL_BODY_OPTS = new Set([
  '-d', '--data', '--data-raw', '--data-binary', '--data-urlencode',
  '--data-ascii', '-F', '--form', '--form-string', '--json',
  '-T', '--upload-file',
  // wget body flags
  '--post-data', '--post-file', '--body-data', '--body-file',
])
const SAFE_METHODS = new Set(['GET', 'HEAD'])
const ALPHA = /^\p{L}+$/u // python str.isalpha()

// 'read' | 'send' | 'unknown' -- the caller treats unknown as a send.
function curlResendVerdict(prog, rest) {
  if (HTTPIE.test(prog)) return 'unknown'
  let method = null
  let hasBody = false
  let getForced = false
  const n = rest.length
  for (let i = 0; i < n; i++) {
    const t = rest[i]
    if (t === '-X' || t === '--request' || t === '--method') {
      if (i + 1 >= n || !ALPHA.test(rest[i + 1])) return 'unknown'
      method = rest[i + 1].toUpperCase()
      i++
      continue
    }
    if (t.startsWith('--request=') || t.startsWith('--method=')) {
      const m = t.split('=').slice(1).join('=')
      if (!ALPHA.test(m)) return 'unknown'
      method = m.toUpperCase()
      continue
    }
    if (t === '-G' || t === '--get') { getForced = true; continue }
    if (t === '-K' || t === '--config') return 'unknown' // a config file can carry a hidden method or body
    if (CURL_BODY_OPTS.has(t) ||
        [...CURL_BODY_OPTS].some((o) => o.startsWith('--') && t.startsWith(o + '='))) {
      hasBody = true
      continue
    }
    if (t.startsWith('-') && !t.startsWith('--') && t.length > 1) {
      // single-dash cluster (-sS, -sX POST, -sd '{}'): the letters are bundled
      const letters = t.slice(1)
      if (letters.includes('X')) {
        const after = letters.slice(letters.indexOf('X') + 1)
        if (after) {
          if (!ALPHA.test(after)) return 'unknown'
          method = after.toUpperCase()
        } else {
          if (i + 1 >= n || !ALPHA.test(rest[i + 1])) return 'unknown'
          method = rest[i + 1].toUpperCase()
          i++
        }
      } else if (letters.includes('d') || letters.includes('F') || letters.includes('T')) {
        hasBody = true
      } else if (letters.includes('G')) {
        getForced = true
      } else if (letters.includes('K')) {
        return 'unknown'
      }
    }
  }
  if (method !== null && !SAFE_METHODS.has(method)) return 'send'
  // implicit POST (the default of curl -d/-F/--json/-T), or a suspicious
  // "GET with a body" -- both are treated as a send
  if (hasBody && !getForced) return 'send'
  return 'read'
}
const CODE_SEND = /\bsmtplib\b|SMTP\s*\(|\bsendMail\s*\(|\bsendEmail\b|\bmail\.send\b/i
// Naive-shape exec heuristic (msg 14298): process-spawn AND a known mailer
// name together in one interpreter code string. Covers the accidental shapes;
// see the STATED LIMIT in the header for what it deliberately does not claim.
const CODE_EXECISH = /\bsubprocess\b|os\.system|\bpopen\b|child_process|\bexec[A-Za-z]*\s*\(|\bspawn[A-Za-z]*\s*\(/i
const CODE_SENDER_LIT = /sendmail|msmtp|swaks|send\.py/i
// Issue #1853 (stylnet): the support-mail sender LOADED AS A MODULE (`import send`,
// `from send import main`, runpy, __import__/import_module, a spec built from send.py).
// Case-sensitive on purpose; `send` must be the whole module name. Mirrors
// _CODE_SEND_MODULE in hooks/outgoing-copy-gate.py; send-invocation-cases.json binds them.
const CODE_SEND_MODULE = new RegExp(
  String.raw`\bimport\s+(?:[\w.]+\s*,\s*)*send\b(?![\w.])` +
  String.raw`|\bfrom\s+send\s+import\b` +
  String.raw`|\brunpy\b[^\n]*\bsend\b` +
  String.raw`|\b(?:__import__|import_module)\s*\(\s*['"]send['"]` +
  String.raw`|\bspec_from_file_location\b[^\n]*\bsend\.py\b` +
  // The same class on the Graph sender (export sendMail): renamed on import, or a string key.
  String.raw`|\bsendMail\s+as\b|\[\s*['"]sendMail['"]\s*\]`,
)
const codeStringSends = (code) =>
  CODE_SEND.test(code) || CODE_SEND_MODULE.test(code) || (CODE_EXECISH.test(code) && CODE_SENDER_LIT.test(code))

// Unquoted newline / backtick / `$(` become segment separators; quoted text is
// untouched (it is content). Tracks quote state by hand -- no shell involved.
export function maskSubshellMarkers(cmd) {
  let out = ''
  let q = null
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (q) {
      if (ch === '\\' && q === '"' && i + 1 < cmd.length) { out += cmd[i] + cmd[i + 1]; i++; continue }
      if (ch === q) q = null
      out += ch
      continue
    }
    if (ch === "'" || ch === '"') { q = ch; out += ch; continue }
    if (ch === '\\' && i + 1 < cmd.length) { out += cmd[i] + cmd[i + 1]; i++; continue }
    if (ch === '\n' || ch === '`') { out += ';'; continue }
    if (ch === '$' && cmd[i + 1] === '(') { out += ';'; i++; continue }
    out += ch
  }
  return out
}

// Quote-aware tokenizer -> [[token, ...], ...] per segment. Throws on an
// unbalanced quote (the caller falls back to the legacy content patterns).
export function segmentsTokens(cmd) {
  const s = maskSubshellMarkers(cmd.replace(HEREDOC_RE, '$1'))
  const segments = []
  let cur = []
  let tok = ''
  let hasTok = false
  let q = null
  const pushTok = () => { if (hasTok) { cur.push(tok); tok = ''; hasTok = false } }
  const pushSeg = () => { pushTok(); if (cur.length) { segments.push(cur); cur = [] } }
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (q) {
      if (ch === '\\' && q === '"' && i + 1 < s.length) { tok += s[++i]; continue }
      if (ch === q) { q = null; continue }
      tok += ch
      continue
    }
    if (ch === "'" || ch === '"') { q = ch; hasTok = true; continue }
    if (ch === '\\' && i + 1 < s.length) { tok += s[++i]; hasTok = true; continue }
    if (ch === ' ' || ch === '\t') { pushTok(); continue }
    if ('|&;()'.includes(ch)) { pushSeg(); continue }
    tok += ch
    hasTok = true
  }
  if (q) throw new Error('unbalanced quote')
  pushSeg()
  return segments
}

const basename = (t) => t.split('/').pop()

// SENDWRAP924: a wrapper in front of the sender is stepped over WITH its own
// flags -- see the full rationale at _WRAPPERS in outgoing-copy-gate.py (the
// python twin). An unknown long flag without `=` is read both ways, so it errs
// toward auditing. send-invocation-cases.json binds the two copies.
const WRAPPERS = new Map([
  ['time', ['fo', ['format', 'output'], 0]],
  ['sudo', ['ughpCUrtDRT', ['user', 'group', 'host', 'prompt', 'close-from', 'other-user',
    'role', 'type', 'chdir', 'chroot', 'command-timeout'], 0]],
  ['env', ['uCS', ['unset', 'chdir', 'split-string'], 0]],
  ['nohup', ['', [], 0]],
  ['nice', ['n', ['adjustment'], 0]],
  ['exec', ['a', [], 0]],
  ['command', ['', [], 0]],
  ['xargs', ['ILnPsdEa', ['arg-file', 'delimiter', 'eof', 'replace', 'max-lines', 'max-args',
    'max-procs', 'max-chars', 'process-slot-var'], 0]],
  ['timeout', ['sk', ['signal', 'kill-after'], 1]],
  ['setsid', ['', [], 0]],
])
const HEAD_DEPTH = 8

// MAILGATEUV1020: a project launcher's `run` subcommand in front of the sender --
// see the full rationale at _LAUNCHERS in outgoing-copy-gate.py (the python twin).
// name -> [subcommand, short flags taking a value, long flags taking a value,
// module flags, flag lists measured as complete].
const UV_RUN_LONG_VAL = ['extra', 'no-extra', 'group', 'no-group', 'only-group', 'env-file', 'with',
  'with-editable', 'with-requirements', 'package', 'python-platform', 'index', 'default-index',
  'index-url', 'extra-index-url', 'find-links', 'index-strategy', 'keyring-provider',
  'upgrade-package', 'resolution', 'prerelease', 'fork-strategy', 'exclude-newer',
  'exclude-newer-package', 'no-sources-package', 'reinstall-package', 'link-mode',
  'config-setting', 'config-settings-package', 'no-build-isolation-package', 'no-build-package',
  'no-binary-package', 'cache-dir', 'refresh-package', 'python', 'color', 'allow-insecure-host',
  'directory', 'project', 'config-file']
const LAUNCHERS = new Map([
  ['uv', ['run', 'wifPCp', UV_RUN_LONG_VAL, ['-m', '--module'], true]],
  ['pipx', ['run', '', ['index-url', 'pip-args', 'python', 'spec', 'with'], [], true]],
  ...['poetry', 'pdm', 'hatch', 'pipenv', 'rye', 'conda', 'mamba', 'micromamba']
    .map((n) => [n, ['run', '', [], [], false]]),
])

function launcherHeads(toks, spec, d) {
  const [sub, shortVal, longVal, moduleFlags, complete] = spec
  // The subcommand may follow the launcher's global options (`uv --directory d run`):
  // every word before it is an option or the value right after one.
  let j = -1
  for (let x = 1; x < toks.length; x++) {
    if (toks[x] === sub) { j = x; break }
    if (!toks[x].startsWith('-') && !(x > 1 && toks[x - 1].startsWith('-'))) break
  }
  if (j < 0) return [toks]
  const heads = []
  if (!complete) {
    // An unmeasured launcher's options are unknown, so every word in its option
    // run that could be the program is judged as the program: the word after an
    // option may be that option's value, or the command (Dani's #2086 review:
    // `conda run --no-capture-output -n base python send.py` mixes a flag and a
    // value option, which no single reading of all options fits).
    for (let x = j + 1; x < toks.length; x++) {
      if (toks[x] === '--') { heads.push(toks.slice(x + 1)); break }
      if (toks[x].startsWith('-') && toks[x].length > 1) continue
      heads.push(toks.slice(x))
      if (!(x > j + 1 && toks[x - 1].startsWith('-') && toks[x - 1].length > 1)) break
    }
    if (!heads.length) heads.push([])
    return heads.flatMap((h) => commandHeads(h, d + 1))
  }
  let i = j + 1
  let head = null
  while (i < toks.length) {
    const t = toks[i]
    if (t === '--') { i++; break }
    if (moduleFlags.includes(t)) { head = ['python3', '-m', ...toks.slice(i + 1)]; break }
    if (t.startsWith('--')) {
      const eq = t.indexOf('=')
      if (eq > 0 && moduleFlags.includes(t.slice(0, eq))) { head = ['python3', '-m', t.slice(eq + 1), ...toks.slice(i + 1)]; break }
      i += eq < 0 && longVal.includes(t.slice(2)) ? 2 : 1
      continue
    }
    if (t.startsWith('-') && t.length > 1) {
      let k = -1
      for (let x = 1; x < t.length; x++) if (shortVal.includes(t[x])) { k = x; break }
      i += k === t.length - 1 ? 2 : 1
      continue
    }
    break
  }
  heads.push(head ?? toks.slice(i))
  return heads.flatMap((h) => commandHeads(h, d + 1))
}

function commandHeads(toksIn, d = 0) {
  let toks = toksIn
  while (toks.length && (ENV_ASSIGN.test(toks[0]) || CMD_POSITION_KEYWORDS.has(toks[0]))) toks = toks.slice(1)
  if (!toks.length) return [toks]
  const w = basename(toks[0])
  // Still a wrapper at the depth bound: counts as a send (null), see the python twin.
  if (d >= HEAD_DEPTH) return (WRAPPERS.has(w) || LAUNCHERS.has(w) || w === 'function' || w === 'coproc') ? [null] : [toks]
  if (w === 'function') return commandHeads(toks.slice(2), d + 1)
  if (w === 'coproc') return [...commandHeads(toks.slice(1), d + 1), ...commandHeads(toks.slice(2), d + 1)]
  const launcher = LAUNCHERS.get(w)
  if (launcher) return launcherHeads(toks, launcher, d)
  const spec = WRAPPERS.get(w)
  if (!spec) return [toks]
  const [shortVal, longVal, positionals] = spec
  let i = 1
  const starts = []
  while (i < toks.length) {
    const t = toks[i]
    if (t === '--') { i++; break }
    if (t.startsWith('--')) {
      if (!t.includes('=') && longVal.includes(t.slice(2))) { i += 2; continue }
      if (!t.includes('=')) starts.push(i + 2)
      i++
      continue
    }
    if (t.startsWith('-') && t.length > 1) {
      if (w === 'command' && (t.includes('v') || t.includes('V'))) return []
      let k = -1
      for (let j = 1; j < t.length; j++) if (shortVal.includes(t[j])) { k = j; break }
      i += k === t.length - 1 ? 2 : 1
      continue
    }
    break
  }
  starts.unshift(i)
  return starts.flatMap((s) => commandHeads(toks.slice(s + positionals), d + 1))
}

// SUBAGENTMAILGATE1016 (measured on the sub-agent gate, 2026-10-16): the
// support-mail sender was recognised only as `python3 <path>/send.py --to ...`,
// that is, with the script as the FIRST argument and the exact `--to` flag. Six
// spellings ran the same sender past this gate: an interpreter option first
// (`python3 -u`, `python3 -X utf8`), a version-suffixed interpreter, a glob or a
// variable as the script path (`s?nd.py`, `$P`), and the program read from
// stdin (`python3 - --to ... < send.py`). argparse also takes `--t` for `--to`.
// The boundary, fail-closed where the command cannot be read statically:
//   - the script operand is found past the interpreter's own options (a
//     separate argument for -X / -W / --check-hash-based-pycs);
//   - a recipient flag is `--to` or any argparse abbreviation of it (`--t`),
//     with or without `=value` (the sender's --to is required, so every
//     delivering call carries one of these);
//   - send.py by basename + a recipient flag: a send (as before, now from any
//     operand position, interpreter spelling and flag spelling);
//   - a script operand that cannot be resolved statically (glob or brace
//     characters, or a `$` expansion) + a recipient flag: a send, because what
//     runs is undecidable here (until MAILGATEVARARGS1020 also "or another `$`
//     token", see below);
//   - a program read from stdin (`-`, or no script operand and a `<` redirect)
//     + a recipient flag: a send (a heredoc-fed program is judged by its body,
//     heredocProgramSends, as before).
// Anything else stays allowed: `python3 -u other.py`, `python3 -c "print(1)"`,
// `for f in *.py; do python3 $f; done`, `python3 x.py --to-date ...`,
// `python3 "$DIR/gen.py" "$OUT"`.
// Mirrors _python_head_sends in hooks/outgoing-copy-gate.py; the shared
// send-invocation-cases.json binds the two.
//
// MAILGATEVARARGS1020 (measured on a production install, 2026-10-19): the
// "or another `$` token" half denied ordinary scripted work. In one day 26
// sub-agent Bash calls, across four agents, were denied as mail sends; none
// of them was one (no recipient flag, no sender, no mail program). Each was a
// script run from a variable path with a variable argument:
// `python3 "$SP/gen.py" "$SP/out.json"`, `python3 "$L" /dev/null "$SP/o.txt"`,
// `python3 $A/check.py $S/x.json && python3 $A/stamp.py --note-file "$A/n.json"`.
// The agents lost turns on rewrites and workarounds. The extra `$` rule also
// guarded nothing the rest of the gate guards: a literal sender path with a
// variable argument (`python3 scripts/support-mail/send.py $ARGS`) has always
// passed, because a recipient flag inside a variable is not visible statically
// on ANY branch. So this branch now asks what the send.py and the stdin
// branches ask: is there a recipient flag. A variable path WITH one
// (`python3 $P --to ...`) is still a send; `python3 $SENDER $ARGS` passes,
// pinned as a documented limit in send-invocation-cases.json.
const PY_OPT_WITH_ARG = new Set(['-X', '-W', '--check-hash-based-pycs'])
const RECIPIENT_FLAG = /^--to?(=|$)/
const UNDECIDABLE_PATH = /[*?[{$]/
function pythonScriptOperand(rest) {
  let stdinRedirect = false
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]
    if (t === '--') return { script: rest[i + 1] ?? null, stdin: false, stdinRedirect }
    if (t === '-') return { script: null, stdin: true, stdinRedirect }
    if (/^-[cm]/.test(t)) return { script: null, stdin: false, stdinRedirect } // code string / module: judged elsewhere
    if (PY_OPT_WITH_ARG.has(t)) { i++; continue }
    if (t.startsWith('<')) { stdinRedirect = true; if (t === '<') i++; continue }
    if (/^\d*>/.test(t)) { if (/^\d*>>?$/.test(t)) i++; continue }
    if (t.startsWith('-') && t.length > 1) continue
    return { script: t, stdin: false, stdinRedirect }
  }
  return { script: null, stdin: false, stdinRedirect }
}
// A command or process substitution as a word of the command (`$(...)`, a
// backtick pair, `<(...)`, `>(...)`), with the substitution replaced by one
// placeholder word that carries a `$`. maskSubshellMarkers splits these into
// their own segments, which is right for judging the INNER command, but it
// leaves the outer one without the word: `python3 $(echo .../send.py) --to x`
// became `python3` and `--to x`. Judged on this form as well, the word is an
// undecidable script path (or interpreter) like a variable. Quoted text is left
// alone: a quoted `"$(...)"` already reaches the tokenizer as a `$` word.
export function flattenSubstitutions(cmd) {
  let out = ''
  let q = null
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (q) {
      if (ch === '\\' && q === '"' && i + 1 < cmd.length) { out += ch + cmd[++i]; continue }
      if (ch === q) q = null
      out += ch
      continue
    }
    if (ch === "'" || ch === '"') { q = ch; out += ch; continue }
    if (ch === '\\' && i + 1 < cmd.length) { out += ch + cmd[++i]; continue }
    const opens = (ch === '$' || ch === '<' || ch === '>') && cmd[i + 1] === '('
    if (opens || ch === '`') {
      let depth = 1
      let j = i + (opens ? 2 : 1)
      let iq = null
      for (; j < cmd.length && depth > 0; j++) {
        const c = cmd[j]
        if (iq) { if (c === iq) iq = null; continue }
        if (c === "'" || c === '"') { iq = c; continue }
        if (ch === '`') { if (c === '`') depth = 0; continue }
        if (c === '(') depth++
        else if (c === ')') depth--
      }
      out += ' $__SUBST__ '
      i = j - 1
      continue
    }
    out += ch
  }
  return out
}

function pythonHeadSends(rest) {
  const recipient = rest.some((t) => RECIPIENT_FLAG.test(t))
  const { script, stdin, stdinRedirect } = pythonScriptOperand(rest)
  if (script !== null && SENDPY.test(basename(script))) return recipient
  if (script !== null && UNDECIDABLE_PATH.test(script)) return recipient // MAILGATEVARARGS1020
  if (stdin || (script === null && stdinRedirect)) return recipient
  return false
}

function segmentIsSend(toksIn, depth) {
  return commandHeads(toksIn).some((h) => headIsSend(h, depth))
}

function headIsSend(toks, depth) {
  if (toks === null) return true // the depth bound was hit on a wrapper: audit it
  if (!toks.length) return false
  const prog = basename(toks[0])
  const rest = toks.slice(1)
  if (SENDER_PROG.test(prog)) return true
  if (WRAPPER_SHELL.test(prog) && depth < 3) {
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '-c' && rest[i + 1] && isSendInvocation(rest[i + 1], depth + 1)) return true
    }
  }
  if (PYTHON.test(prog) || NODEISH.test(prog)) {
    for (let i = 0; i < rest.length; i++) {
      if ((rest[i] === '-c' || rest[i] === '-e' || rest[i] === '--eval') &&
          rest[i + 1] && codeStringSends(rest[i + 1])) return true
    }
  }
  const candidates = [prog]
  if ((PYTHON.test(prog) || NODEISH.test(prog)) && rest.length) candidates.push(basename(rest[0]))
  // Issue #1853: `python3 -m send` (or -m pkg.send) is the same sender by module name.
  if (PYTHON.test(prog)) {
    for (let i = 0; i < rest.length - 1; i++) {
      if (rest[i] === '-m' && rest[i + 1].split('.').pop() === 'send') candidates.push('send.py')
    }
  }
  if (candidates.some((c) => SENDPY.test(c)) && rest.some((t) => RECIPIENT_FLAG.test(t))) return true
  if (PYTHON.test(prog) && pythonHeadSends(rest)) return true
  // An interpreter or program that cannot be resolved statically ($PY, a glob,
  // a substitution) with a recipient flag: what runs is undecidable here.
  if (UNDECIDABLE_PATH.test(toks[0]) && rest.some((t) => RECIPIENT_FLAG.test(t))) return true
  if (toks.some((t) => GRAPHMAIL.test(basename(t))) && rest.includes('send')) return true
  // RESENDGETTWIN1010: only an actual send (POST/PUT/..., or a body) fires; a
  // read-only GET/HEAD passes; an undecidable method stays fail-closed.
  if (CURLISH.test(prog) && rest.some((t) => RESEND_TARGET.test(t))) {
    return curlResendVerdict(prog, rest) !== 'read'
  }
  return false
}

// True when some segment is still a wrapper at the depth bound (HEADDEPTH924),
// so the deny says WHY -- see wrapper_depth_hit in outgoing-copy-gate.py.
export function wrapperDepthHit(cmd) {
  let segments
  try {
    segments = segmentsTokens(cmd)
  } catch {
    return false
  }
  // Only when the bound is the WHOLE reason: a visible send in another segment wins.
  const heads = segments.flatMap((toks) => commandHeads(toks))
  return heads.some((h) => h === null) && !heads.some((h) => h !== null && headIsSend(h, 0))
}

export function buildWrapperDepthMsg() {
  return (
    'TILTVA (governance hard-gate): a parancs valodi fejet nem latom. ' +
    `A parancs a burkolo-korlatnal (${HEAD_DEPTH} egymasba agyazott burkolo: sudo, time, env, nohup, nice, timeout...) ` +
    'is meg burkolo, tehat nem tudom eldonteni, hogy levelkuldes-e, es a kapu ilyenkor fail-closed. ' +
    `Ha ez NEM levelkuldes: csokkentsd a burkolok szamat ${HEAD_DEPTH} vagy kevesebb ala. ` +
    'Ha levelkuldes: sub-agentkent Bash-bol amugy sem kuldhetsz, a kimeno emailt a fo-agens kuldi.'
  )
}

// Issue #1853, the heredoc form: the segmenter drops heredoc BODIES, but when the
// command that opens one is an interpreter (`python3 - <<'PY'`, `node <<EOF`) the body
// IS the program. Mirrors _heredoc_program_sends in hooks/outgoing-copy-gate.py.
// NARROWED (Geri's #1855 review): inside a heredoc body the exec + sender-literal half takes
// the literal only as a lowercase, QUOTED command word (an argv item or an os.system command),
// so a card id like SENDMAIL... in a report's prose no longer matches. Mirrors
// _HEREDOC_SENDER_ARGV / _heredoc_body_sends in hooks/outgoing-copy-gate.py.
// NOT COVERED, named: a program the classifier never reads -- `python3 /tmp/x.py`,
// `python3 < /tmp/x.py`, `cat /tmp/x.py | python3 -`, `python3 -c "exec(open('/tmp/x.py').read())"`;
// also a here-string fed to an interpreter (`python3 <<<'import send'`) and a CommonJS
// destructuring rename of the Graph sender (`const { sendMail: s } = require(...)`).
// A heredoc fed to a SHELL (`bash <<EOF`) is a shell program: its body is judged with
// isSendInvocation itself, one level deeper (Geri/Samu, #1855).
// WRITTEN, THEN RUN IN THE SAME COMMAND (#1855): `cat > P <<TAG` / `cat <<TAG > P`, then an
// interpreter or a shell on the same path token P: the body is judged as if fed directly.
// Exact token match; a file run by ANOTHER Bash call stays out of reach.
// PIPED (#1855): `cat <<'EOF' | bash` or `| python3 -` hands the body over the pipe on the
// heredoc's opening line; it is judged the same way.
const HEREDOC_SENDER_ARGV = /['"](?:[^'"\s]*\/)?(?:sendmail|msmtp|swaks|send\.py)(?=['"\s])/
const heredocBodySends = (body) =>
  CODE_SEND.test(body) || CODE_SEND_MODULE.test(body) || (CODE_EXECISH.test(body) && HEREDOC_SENDER_ARGV.test(body))
const HEREDOC_SHELL = /(?:^|[\s;&|(])(?:\S*\/)?(?:bash|sh|zsh|dash)\b[^\n<]*$/i
const HEREDOC_INTERP = /(?:^|[\s;&|(])(?:\S*\/)?(python3?(?:\.\d+)?|node|tsx|ts-node|deno|bun)\b[^\n<]*$/i
const HEREDOC_PIPE = /\|\s*(?:\S*\/)?(python3?(?:\.\d+)?|node|tsx|ts-node|deno|bun|bash|sh|zsh|dash)\b/i
const HEREDOC_REDIRECT = /(?:^|[\s;&|(])(?:cat|tee)\b[^\n]*?(?:>>?|\btee(?:\s+-a)?)\s*(['"]?)([^\s'"<>;&|]+)\1/
function writtenThenRun(cmd, written, depth) {
  if (!written.size) return false
  let segments
  try { segments = segmentsTokens(cmd) } catch { return false }
  for (const toks of segments) {
    for (const head of commandHeads(toks)) {
      if (!head || !head.length) continue
      const prog = basename(head[0])
      let args = head.slice(1).filter((t) => !t.startsWith('-'))
      if (prog.toLowerCase() === 'npx' && args.length) args = args.slice(1) // npx <runner> <file>
      if (!args.length || !written.has(args[0])) continue
      const body = written.get(args[0])
      if ((PYTHON.test(prog) || NODEISH.test(prog)) && heredocBodySends(body)) return true
      if (WRAPPER_SHELL.test(prog) && depth < 3 && isSendInvocation(body, depth + 1)) return true
    }
  }
  return false
}
function heredocProgramSends(cmd, depth = 0) {
  const written = new Map()
  for (const m of cmd.matchAll(HEREDOC_RE)) {
    const opener = cmd.slice(cmd.lastIndexOf('\n', m.index - 1) + 1, m.index) + m[1]
    const w = HEREDOC_REDIRECT.exec(opener)
    if (w) written.set(w[2], cmd.slice(m.index + m[1].length + 1, m.index + m[0].length - m[2].length))
    const piped = HEREDOC_PIPE.exec(m[1])
    if (piped) {
      const pbody = cmd.slice(m.index + m[1].length + 1, m.index + m[0].length - m[2].length)
      if (WRAPPER_SHELL.test(piped[1])) {
        if (depth < 3 && isSendInvocation(pbody, depth + 1)) return true
      } else if (heredocBodySends(pbody)) return true
    }
    const lineStart = cmd.lastIndexOf('\n', m.index - 1) + 1
    const head = cmd.slice(lineStart, m.index)
    const bodyStart = m.index + m[1].length + 1
    const body = cmd.slice(bodyStart, m.index + m[0].length - m[2].length)
    if (HEREDOC_INTERP.test(head)) {
      if (heredocBodySends(body)) return true
    } else if (HEREDOC_SHELL.test(head) && depth < 3) {
      if (isSendInvocation(body, depth + 1)) return true
    }
  }
  return writtenThenRun(cmd, written, depth)
}

export function isSendInvocation(cmd, depth = 0) {
  if (heredocProgramSends(cmd, depth)) return true
  let segments
  try {
    segments = segmentsTokens(cmd)
  } catch {
    // Unparseable command: fall back to the LEGACY content patterns, so on
    // this path the gate is exactly as strict as before -- never weaker.
    return SEND_PATTERNS.some((re) => re.test(cmd))
  }
  if (segments.some((toks) => segmentIsSend(toks, depth))) return true
  // The same command with every substitution as one undecidable word (see
  // flattenSubstitutions): the outer command keeps the word it would run.
  const flat = flattenSubstitutions(cmd)
  if (flat === cmd) return false
  try {
    return segmentsTokens(flat).some((toks) => segmentIsSend(toks, depth))
  } catch {
    return SEND_PATTERNS.some((re) => re.test(cmd))
  }
}

// SCRIPTSENDGATE1020: a sender script under any name. isSendInvocation knows a
// Python sender only by the file name send.py, so `python3 helden_send.py --to
// x@y.hu < body.txt` -- a self-written SMTP script, the usual way a mail goes
// out on this fleet -- was no send for this gate (measured 2026-10-20). Cheap,
// local signals close it for the sub-agents. A run is a send when:
//   1. an interpreter (python, node, tsx, bun, deno) or a directly executed
//      script is given an e-mail address after --to / --cc / --bcc. This holds
//      with no script file too (`python3 -m pkg`, `python3 -c ...`);
//   2. the script file IMPORTS a mail library: an import statement of the
//      python SMTP modules (smtplib, aiosmtplib, yagmail), or a require /
//      import of nodemailer for a node script. A bare mention (a comment, a
//      mock, a regex like this file's own) is no import and passes;
//   3. one level of local helper modules imported by the script, resolved
//      next to it, imports one (`from mailhelper import send_mail`);
//   4. a shell `-c` string (sh, bash, zsh, dash) runs one of the above.
// A directly executed file (`./x`, `/abs/x`, `x.py`) is read as python or node
// by its #! line, else by its extension; an extensionless file without a
// python/node #! line is not judged.
// Deliberately NOT part of isSendInvocation: that function is the shared
// contract with the main agent's python gates (send-invocation-cases.json),
// and on the main agent the owner's single approval in the chat is the rule
// (owner decision, 2026-10-20). This narrowing is for the sub-agent hard gate
// only, where every recognised Bash send is denied anyway.
// Not seen, on purpose (docs/security-hardening.md lists them): mail sent
// without one of these libraries (Gmail API client, an HTTP mail API, raw
// socket SMTP, perl/ruby), a script read from stdin or named through a
// variable, a script reached after `cd dir &&` (resolved against the session
// cwd), helpers past the first level, an import after the first 1 MiB, and
// code assembled at runtime.
const PY_MAIL_MODULE = String.raw`(?:(?:aio)?smtplib|yagmail)`
const PY_MAIL_IMPORT = new RegExp(
  String.raw`^[ \t]*(?:import[ \t]+[^\n#]*\b${PY_MAIL_MODULE}\b|from[ \t]+${PY_MAIL_MODULE}\b[^\n]*\bimport\b)` +
  String.raw`|\bimport_module\(\s*['"]${PY_MAIL_MODULE}['"]`,
  'm',
)
const NODE_MAIL_MODULE = String.raw`['"]nodemailer['"]`
const NODE_MAIL_IMPORT = new RegExp(
  String.raw`\brequire\s*\(\s*${NODE_MAIL_MODULE}\s*\)|^[ \t]*import\b[^\n]*${NODE_MAIL_MODULE}|\bimport\s*\(\s*${NODE_MAIL_MODULE}\s*\)`,
  'm',
)
const PY_LOCAL_IMPORT = /^[ \t]*(?:from[ \t]+([\w.]+)[ \t]+import\b|import[ \t]+([\w., \t]+))/gm
const NODE_LOCAL_IMPORT = /(?:\brequire\s*\(\s*|^[ \t]*import\b[^\n]*?\bfrom\s*|^[ \t]*import\s*|\bimport\s*\(\s*)['"](\.{1,2}\/[^'"\n]+)['"]/gm
const NODE_EXTS = ['', '.js', '.mjs', '.cjs', '.ts', '/index.js', '/index.mjs', '/index.ts']
const HELPER_LIMIT = 40
const ADDRESS_FLAG = /^--(?:to|cc|bcc)(?:=(.*))?$/
const SCRIPT_FILE = /\.(?:py|mjs|cjs|js|ts)$/i
const SHELL_C_FLAG = /^-[a-zA-Z]*c[a-zA-Z]*$/
const SCRIPT_READ_LIMIT = 1024 * 1024
const SHEBANG_READ_LIMIT = 512
const SHELL_C_DEPTH = 3

function readScriptHead(path, limit = SCRIPT_READ_LIMIT) {
  let fd = null
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(limit)
    const n = readSync(fd, buf, 0, limit, 0)
    return buf.subarray(0, n).toString('utf-8')
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* already closed */ }
    }
  }
}

function resolveScriptPath(script, cwd) {
  if (!script || UNDECIDABLE_PATH.test(script)) return null
  let p = script
  if (p === '~' || p.startsWith('~/')) p = join(homedir(), p.slice(1))
  if (isAbsolute(p)) return p
  return cwd ? resolve(cwd, p) : null
}

// node/tsx/bun/deno: the first non-option word is the script; -e/--eval code
// strings are isSendInvocation's to judge.
function nodeScriptOperand(rest) {
  for (const t of rest) {
    if (t === '--') continue
    if (t.startsWith('-')) return null
    return t
  }
  return null
}

function addressFlagGiven(rest) {
  for (let i = 0; i < rest.length; i++) {
    const m = ADDRESS_FLAG.exec(rest[i])
    if (!m) continue
    const val = m[1] ?? rest[i + 1] ?? ''
    if (val.includes('@')) return true
  }
  return false
}

// 'py' | 'node' | null from a #! line (`#!/usr/bin/python3`, `#!/usr/bin/env -S node`).
function shebangKind(text) {
  const m = /^#!\s*(\S+)([^\n]*)/.exec(text ?? '')
  if (!m) return null
  let prog = basename(m[1])
  if (prog === 'env') prog = basename(m[2].trim().split(/\s+/).find((w) => w && !w.startsWith('-') && !w.includes('=')) ?? '')
  if (PYTHON.test(prog)) return 'py'
  if (NODEISH.test(prog) && prog !== 'npx') return 'node'
  return null
}

// One level of local helpers: modules the script imports, resolved next to it.
function localHelperPaths(path, text, kind) {
  const dir = dirname(path)
  const out = []
  if (kind === 'py') {
    for (const m of text.matchAll(PY_LOCAL_IMPORT)) {
      const names = m[1] ? [m[1]] : m[2].split(',').map((n) => n.trim().split(/\s+/)[0])
      for (const name of names) {
        if (!name || name.startsWith('.')) continue
        const rel = name.split('.').join('/')
        out.push(join(dir, `${rel}.py`), join(dir, rel, '__init__.py'))
      }
    }
  } else {
    for (const m of text.matchAll(NODE_LOCAL_IMPORT)) {
      for (const ext of NODE_EXTS) out.push(resolve(dir, m[1] + ext))
    }
  }
  return [...new Set(out)].filter((p) => p !== path).slice(0, HELPER_LIMIT)
}

function fileSends(path, text, kind, readScript) {
  const imports = kind === 'py' ? PY_MAIL_IMPORT : NODE_MAIL_IMPORT
  if (imports.test(text)) return true
  return localHelperPaths(path, text, kind).some((h) => {
    const t = readScript(h)
    return t !== null && imports.test(t)
  })
}

function headRunsSenderScript(toks, cwd, readScript, depth) {
  if (!toks || !toks.length) return false
  const prog = basename(toks[0])
  const rest = toks.slice(1)
  if (WRAPPER_SHELL.test(prog)) {
    if (depth >= SHELL_C_DEPTH) return false
    for (let i = 0; i < rest.length - 1; i++) {
      if (SHELL_C_FLAG.test(rest[i]) && scriptRunSends(rest[i + 1], cwd, readScript, depth + 1)) return true
    }
    return false
  }
  let script
  let kind
  if (PYTHON.test(prog)) {
    if (addressFlagGiven(rest)) return true // also under -m / -c, where no file is named
    script = pythonScriptOperand(rest).script
    kind = 'py'
  } else if (NODEISH.test(prog) && prog !== 'npx') {
    if (addressFlagGiven(rest)) return true
    script = nodeScriptOperand(rest)
    kind = 'node'
  } else if (SCRIPT_FILE.test(toks[0]) || toks[0].includes('/')) {
    // a directly executed file: its #! line picks the interpreter, else its extension
    const path = resolveScriptPath(toks[0], cwd)
    if (!path) return false
    kind = shebangKind(readScript(path, SHEBANG_READ_LIMIT)) ??
      (/\.py$/i.test(toks[0]) ? 'py' : SCRIPT_FILE.test(toks[0]) ? 'node' : null)
    if (!kind) return false
    if (addressFlagGiven(rest)) return true
    const text = readScript(path)
    return text !== null && fileSends(path, text, kind, readScript)
  } else {
    return false
  }
  if (script === null) return false
  const path = resolveScriptPath(script, cwd)
  if (!path) return false
  const text = readScript(path)
  return text !== null && fileSends(path, text, kind, readScript)
}

export function scriptRunSends(cmd, cwd = process.cwd(), readScript = readScriptHead, depth = 0) {
  let segments
  try {
    segments = segmentsTokens(cmd)
  } catch {
    return false // unparseable: isSendInvocation's legacy fallback already judged it
  }
  return segments.some((toks) => commandHeads(toks).some((h) => headRunsSenderScript(h, cwd, readScript, depth)))
}

// Outbound-shaped operations of the multiplexed manage_email tool. Each of
// these sends for real unless the call explicitly asks for a draft.
const MANAGE_EMAIL_SEND_OPS = new Set(['send', 'reply', 'replyall', 'forward'])

// --- tool-name classification ------------------------------------------------
// JS twin of email_extract.classify_mail_tool (scripts/hooks/email_extract.py,
// the main agent's gates). Both are bound by the shared case list
// scripts/hooks/mail-tool-name-cases.json, which
// src/__tests__/email-gate-matcher-drift.test.ts runs through BOTH copies; the
// full rationale is at the python twin.
//
// Classified by the base-name SUFFIX, never by what precedes it:
// vendor/gmail-mcp-fork prepends its tool prefix to every tool name verbatim
// (v2_, v2, work-, ...), so `(^|__)draft_email$`, `(^|__)manage_email$` and
// `gmail__reply_all$` missed every prefixed form: a prefixed draft skipped the
// recipient ledger, and a prefixed (or non-"gmail"-server) reply_all was no
// send at all. send_draft is a send this gate never knew. The classifier is a
// superset of the patterns this gate carried: send_email and the draft names
// keep a substring match, manage_email is the suffix (a look-alike such as
// manage_emails_bulk stays out); the generic connector words count only with
// "gmail" in the qualified name (the Telegram tool is `..._telegram__reply`).
// Kinds: 'send_email' | 'connector_send' | 'send_draft' | 'manage_email' |
// 'draft' | null (reads, search, labels, delete: not outbound).
const CONNECTOR_GENERIC_SUFFIXES = ['send_message', 'reply', 'forward']
const DRAFT_NAMES = ['draft_email', 'create_draft', 'update_draft', 'draft_gmail_message']
// The harder-mail MCP's sends (HARDERMAILGATES1019): connector_send, so the
// thread-reply narrowing (send_email only) can never release one.
const MAILBOX_SEND_SUFFIXES = ['send_mail', 'send_mail_auto']

export function classifyMailTool(toolName) {
  const n = String(toolName ?? '').toLowerCase()
  if (!n || n === 'bash') return null
  // send_gmail_message: the Google Workspace MCP's Gmail send tool
  if (n.includes('send_email') || n.includes('send_gmail_message')) return 'send_email'
  if (n.endsWith('reply_all')) return 'connector_send'
  if (n.includes('gmail') && CONNECTOR_GENERIC_SUFFIXES.some((b) => n.endsWith(b))) return 'connector_send'
  if (MAILBOX_SEND_SUFFIXES.some((b) => n.endsWith(b))) return 'connector_send'
  if (n.endsWith('send_draft')) return 'send_draft'
  if (n.endsWith('manage_email')) return 'manage_email'
  if (DRAFT_NAMES.some((d) => n.includes(d))) return 'draft'
  return null
}

// RECOVERYPATH920: the recovery command in the deny message used to be the
// relative `node scripts/recipient-ledger.mjs`. Sub-agents run with cwd
// agents/<name>/, which has NO scripts/ directory, so from a gated agent the
// command died with "Cannot find module .../agents/<name>/scripts/
// recipient-ledger.mjs" -- the one path the gate offers was unreachable from
// the only place it is ever read. Resolve it from this file's own location:
// the gate script and the ledger CLI ship in the same directory, so this is
// correct from any cwd.
const LEDGER_CLI = join(dirname(fileURLToPath(import.meta.url)), 'recipient-ledger.mjs')

// Tool-input fields that carry recipient addresses across the mail tools we
// have. A reply that only names a messageId has none of these -- it is
// addressed by the thread, not by us, so there is nothing to invent.
const RECIPIENT_FIELDS = ['to', 'cc', 'bcc', 'recipients', 'recipient', 'recipient_email']

// Every address in this call that the ledger does not know. Pure: the lookup is
// injected so tests never touch the real ledger file.
export function unverifiedRecipients(toolInput, isVerified) {
  const out = []
  for (const field of RECIPIENT_FIELDS) {
    const value = toolInput?.[field]
    if (value === undefined || value === null || value === '') continue
    for (const addr of parseAddresses(value).addresses) {
      if (!isVerified(addr) && !out.includes(addr)) out.push(addr)
    }
  }
  return out
}

// Every recipient piece of this call that is not exactly ONE address
// (recipient-ledger.mjs parseAddresses): two addresses in one array item, an
// address in the display name, two <...> pairs, an object value. The ledger
// cannot vouch for what it cannot read as one address, and the mail tool may
// still deliver to it, so the gate denies on any such piece.
export function unparseableRecipients(toolInput) {
  const out = []
  for (const field of RECIPIENT_FIELDS) {
    const value = toolInput?.[field]
    if (value === undefined || value === null || value === '') continue
    for (const piece of parseAddresses(value).unparseable) {
      if (!out.includes(piece)) out.push(piece)
    }
  }
  return out
}

// Default lookup for the live hook: read the ledger once per invocation. A
// missing or corrupt ledger means nothing is verified, so the gate blocks --
// an evidence store that cannot be read must never open the gate silently.
function ledgerLookup() {
  const ledger = loadLedger()
  return (addr) => isVerifiedIn(ledger, addr)
}

// Pure decision: does this tool call send (or attempt to send) email?
// Returns { deny, kind? }. `kind` selects the deny wording at the hook
// entrypoint: 'draft-required' is the manage_email case (drafting is fine,
// only the actual send is refused), 'send_email' is the direct MCP send tool
// (the only path the thread-reply capability below can narrow),
// 'unverified-recipient' is a draft/manage_email address with no recorded
// source, and everything else is the sub-agent governance block.
export function gateDecision(toolName, toolInput, isVerified = null, cwd = process.cwd()) {
  const name = String(toolName ?? '')
  // Lazy: only build the ledger lookup when a call actually carries addresses,
  // so a read-shaped tool call never pays a file read.
  const verify = isVerified ?? (() => {
    let cached = null
    return (addr) => (cached ??= ledgerLookup())(addr)
  })()
  // Any MCP send_email tool, name-agnostic (gmail or a differently-named
  // server in a customer install -> the matcher + this both key on send_email).
  // Deliberately NOT ledger-checked. This branch is either an unconditional
  // deny, or -- with --allow-thread-reply -- a narrowing that only passes
  // recipients read back from the live thread the reply belongs to. A
  // participant of a thread we can read IS a sourced address in the same sense
  // the ledger means it (the From header of a mail they sent us), so gating it
  // against the file would refuse a legitimately sourced reply. The ledger
  // guards the paths where an address can be typed from memory: drafting and
  // manage_email.
  const mailKind = classifyMailTool(name)
  if (mailKind === 'send_email') return { deny: true, kind: 'send_email' }
  // The claude.ai Gmail connector (mcp__claude_ai_Gmail__*) has no send_email:
  // its sends are send_message / reply / forward. Drafts stay allowed and the
  // reads are not sends, only the three send-shaped tools are denied
  // (GMAILCONNECTOR914 -- before this line a sub-agent could send through the
  // connector with no gate at all).
  // Kind is NOT 'send_email' on purpose: the thread-reply narrowing at the
  // entrypoint reads send_email-shaped fields (threadId/to), which a connector
  // reply does not carry, so the connector stays fully gated for every agent.
  // reply_all is a send on a server of any name, and a tool prefix does not
  // hide any of the four (classifyMailTool).
  if (mailKind === 'connector_send') return { deny: true, kind: 'connector-send' }
  // send_draft sends an existing draft by draftId: a send like any other, and
  // one whose recipients this gate cannot even see. Sub-agents may not send,
  // so it gets the governance deny, with no narrowing.
  if (mailKind === 'send_draft') return { deny: true, kind: 'send-draft' }
  // Draft-creating MCP tools. Drafting is allowed (that is the whole point of
  // the draft-required rule), but the ADDRESS in a draft still has to be
  // verified: the owner presses send on what we typed, so an invented address
  // reaches the outside world through a draft just as surely as through a send.
  if (mailKind === 'draft') {
    const unparseable = unparseableRecipients(toolInput)
    if (unparseable.length) return { deny: true, kind: 'unparseable-recipient', addresses: unparseable }
    const bad = unverifiedRecipients(toolInput, verify)
    if (bad.length) return { deny: true, kind: 'unverified-recipient', addresses: bad }
    return { deny: false }
  }
  // @aaronsb/google-workspace-mcp multiplexes read, draft and send behind one
  // manage_email tool, so the tool NAME cannot decide this one -- the operation
  // plus the draft flag can. This is what replaces the server's own
  // draft-only-email safety policy, which blocks drafting too: that policy keys
  // on ctx.operation alone and never looks at draft:true, so with it enabled the
  // mailbox is effectively read-only (verified live, 2026-08-10).
  if (mailKind === 'manage_email') {
    const op = String(toolInput?.operation ?? '').toLowerCase()
    if (!MANAGE_EMAIL_SEND_OPS.has(op)) return { deny: false }
    // The address check runs before the draft rule, so it applies to the send
    // AND to the draft the deny message would send us back to write.
    const unparseable = unparseableRecipients(toolInput)
    if (unparseable.length) return { deny: true, kind: 'unparseable-recipient', addresses: unparseable }
    const bad = unverifiedRecipients(toolInput, verify)
    if (bad.length) return { deny: true, kind: 'unverified-recipient', addresses: bad }
    // Fail safe: only an explicit draft request passes. A missing/ambiguous
    // flag is treated as a real send, even though the server would itself
    // force a draft when attachments are present.
    const draft = toolInput?.draft
    if (draft === true || draft === 'true') return { deny: false }
    return { deny: true, kind: 'draft-required' }
  }
  if (name === 'Bash') {
    const cmd = String(toolInput?.command ?? '')
    if (isSendInvocation(cmd)) return wrapperDepthHit(cmd) ? { deny: true, kind: 'wrapper-depth' } : { deny: true }
    if (scriptRunSends(cmd, cwd)) return { deny: true, kind: 'script-send' }
  }
  return { deny: false }
}

// Deny wording for the manage_email case. Unlike the sub-agent governance
// block this is not about who the agent is: drafting stays open, so the fix is
// to re-issue the same call with draft: true and hand the draft to the owner.
export function buildDraftOnlyMsg(ownerName) {
  return (
    'Kimeno email kuldese tiltott (draft-kapu). ' +
    'Ird meg ugyanezt draft: true kapcsoloval, es jelezd a tulajdonosnak ' +
    `(${ownerName}), hogy a Gmail piszkozatok kozott varja a jovahagyasat. ` +
    'Csak VERIFIKALT cimre. A kuldes gombot ember nyomja meg.'
  )
}

// Deny wording for an address the ledger does not know. This is the one deny
// the agent can clear on its own -- by going and finding where the address
// actually comes from. It names the exact command, so the cheap path is the
// correct path and not "write it anyway".
export function buildUnverifiedRecipientMsg(addresses) {
  const list = addresses.join(', ')
  const first = addresses[0] ?? 'cim@pelda.hu'
  return (
    `Nem igazolt cimzett: ${list}. ` +
    'Ez a kapu azert van, mert egy kitalalt cimre meno level neman elveszik ' +
    '(support@connectors.hu, 2026-08-14, 550 User doesn\'t exist). ' +
    'Ne talalgass es ne a support@/info@ szokast hasznald: keresd meg a cimet ' +
    'egy valodi forrasban -- a toluk kapott level From fejleceben ' +
    '(manage_email search: from:<domain> in:anywhere), az elo oldalukon, ' +
    'a Woo rendelesben vagy a Notion lapon. Aztan vedd fel a ledgerbe:\n' +
    `  node ${LEDGER_CLI} add ${first} --source <forras> --note "<honnan>"\n` +
    `  --source: ${SOURCE_HELP}\n` +
    'Ha nem talalsz forrast, a cim NINCS meg: mondd meg a gazdanak, ne kuldj levelet.'
  )
}

// Deny wording for a recipient piece that is not exactly one address. The fix
// is on the caller's side: one clean address per item.
export function buildUnparseableRecipientMsg(pieces) {
  return (
    `Nem ertelmezheto cimzett: ${pieces.join(' | ')}. ` +
    'A cimzett-mezo minden eleme (vesszovel vagy pontosvesszovel elvalasztva) ' +
    'pontosan EGY cim legyen: "cim@pelda.hu" vagy "Nev <cim@pelda.hu>". ' +
    'Ket cim egy elemben, cim a megjelenitett nevben vagy tobb <...> ' +
    'nem ellenorizheto a cimzett-ledgerrel, ezert a kapu tilt (fail-closed). ' +
    'Ird at a mezot tiszta cimekre, aztan kuldd ujra.'
  )
}

// Wording for a call that needs the ledger while the ledger MODULE does not
// load (HOOKDEPLOAD1008). It goes to stderr with exit 2, not as the JSON deny:
// no rewrite of the call helps, the module has to be repaired, and that is the
// main agent's job -- this gate does not run in its session.
export function buildLedgerUnavailableMsg(err) {
  return (
    'EMAIL-KAPU: TILTVA. A kapu fuggosege (scripts/recipient-ledger.mjs) nem toltheto be ' +
    `(${err?.message ?? err}) -- fail-closed: a cimzett nem ellenorizheto, ezert a hivas nem mehet at. ` +
    'A modult a fo ugynok javitja (ez a kapu az o munkameneteben nem fut): jelezd neki.\n'
  )
}

// Pure builder for the deny message, so the brand/owner substitution is
// provable without spawning the hook. With the stock defaults (botName
// 'Marveen', ownerName 'Szabolcs') the wording is byte-identical to before.
export function buildGateMsg(botName, ownerName) {
  return (
    'Email-kuldes sub-agentkent tiltott (governance hard-gate). ' +
    `Kuldd a tervezett emailt (CIMZETT + TARGY + TELJES SZOVEG) ${botName}nek inter-agent uzenetben ` +
    `jovahagyasra; a kimeno emailt ${botName} kuldi. Csak VERIFIKALT cimre (soha nem nevbol talalt cim). ` +
    `Soha ne irj ala ${ownerName} nevevel, es soha ne kerj penzt senki neveben.`
  )
}

// Resolve the brand + owner display names for the deny message. The hook runs
// standalone (no config.ts), so read the install's .env directly, keyed off
// this file's own location (<root>/scripts/email-send-gate.mjs -> <root>/.env).
// Any failure falls back to the stock defaults, so the gate never breaks and a
// bare install keeps the original wording.
export function readBrandEnv(readFile = (p) => readFileSync(p, 'utf-8')) {
  const fallback = { botName: 'Marveen', ownerName: 'Szabolcs' }
  try {
    const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.env')
    const raw = readFile(envPath)
    const pick = (key) => {
      const m = raw.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`, 'm'))
      if (!m) return ''
      return m[1].trim().replace(/^["']|["']$/g, '').trim()
    }
    return {
      botName: pick('BOT_NAME') || fallback.botName,
      ownerName: pick('OWNER_NAME') || fallback.ownerName,
    }
  } catch {
    return fallback
  }
}

// --- thread-scoped reply (BONIMAIL910) --------------------------------------
// Owner decision 2026-09-10: ONE named agent may send outbound email, but ONLY
// into an EXISTING Gmail thread and ONLY to addresses that already appear in
// that thread's headers. The capability is granted per agent in code
// (agent-scaffold.ts appends --allow-thread-reply to this hook's command when
// the agent's capability list contains EMAIL_THREAD_REPLY_CAPABILITY); every
// other agent keeps the unconditional deny above.
//
// Why THREAD-MEMBERSHIP and not a topic rule: the 2026-06-25 incident that
// created this gate was a sub-agent mailing a FABRICATED address in the
// owner's name. Membership in an existing thread is checkable in code; "is
// this financial" is not. The narrowing closes exactly the failure shape that
// created the rule: a new address can never be introduced.
//
// Every branch below fails CLOSED: missing threadId, unparseable recipient,
// empty participant list, credential/fetch/HTTP error, timeout -> deny.

// One address token. Deliberately simple: it must match what appears both in
// the tool input and in Gmail's From/To/Cc header values.
const ADDR_TOKEN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi

// Parse one recipient entry ("addr" or "Name <addr>") to a bare lowercase
// address. Returns '' when the entry is not a single clean address -- the
// caller treats that as deny (an unparseable recipient must never slip past
// the membership check).
export function extractAddress(raw) {
  const s = String(raw ?? '').trim()
  // More than one '@' is ONE clean address only when the display name IS the
  // bracketed address ("jane@example.com" <jane@example.com>, a common client
  // form). "invented@example.org <known@example.com>" would otherwise pass the
  // trailing-bracket test as known@example.com, with a second address in the
  // display name the membership check never looked at.
  if ((s.match(/@/g) ?? []).length > 1) {
    const m = s.match(/^([^<>]*)<([^<>]+)>$/)
    if (!m) return ''
    const display = m[1].trim().replace(/^"(.*)"$/, '$1').trim()
    if (display.toLowerCase() !== m[2].trim().toLowerCase()) return ''
  }

  const angle = s.match(/<([^<>]+)>$/)
  const cand = (angle ? angle[1] : s).trim()
  return /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(cand) ? cand.toLowerCase() : ''
}

// Validate the send_email tool input as a thread-reply request. Pure.
// Returns { ok: true, threadId, recipients } or { ok: false, reason }.
export function threadReplyRequest(toolInput) {
  const threadId = toolInput?.threadId
  if (typeof threadId !== 'string' || !threadId.trim()) {
    return { ok: false, reason: 'threadId hianyzik (uj szal nyitasa tiltott)' }
  }
  const raw = [toolInput?.to, toolInput?.cc, toolInput?.bcc]
    .flatMap((v) => (Array.isArray(v) ? v : v == null ? [] : [v]))
  if (!raw.length) return { ok: false, reason: 'nincs cimzett' }
  const recipients = []
  for (const r of raw) {
    const addr = extractAddress(r)
    if (!addr) return { ok: false, reason: `ertelmezhetetlen cimzett: ${String(r)}` }
    recipients.push(addr)
  }
  return { ok: true, threadId: threadId.trim(), recipients }
}

// The membership decision itself. Pure. Empty participant list denies: a
// thread we could not read participants from authorizes nothing.
export function threadMembershipDecision(recipients, participants) {
  const set = new Set((participants ?? []).map((p) => String(p).toLowerCase()).filter(Boolean))
  if (!set.size) return { allow: false, reason: 'a szal resztvevo-listaja ures (fail-closed)' }
  for (const r of recipients) {
    if (!set.has(r)) return { allow: false, reason: `cimzett nincs a szalban: ${r}` }
  }
  return { allow: true }
}

// Collect every address that appears in the thread's From/To/Cc/Reply-To
// headers. Pure over the Gmail API thread payload (format=metadata).
export function extractParticipants(threadData) {
  const out = new Set()
  for (const msg of threadData?.messages ?? []) {
    for (const h of msg?.payload?.headers ?? []) {
      const n = String(h?.name ?? '').toLowerCase()
      if (n === 'from' || n === 'to' || n === 'cc' || n === 'reply-to') {
        for (const m of String(h?.value ?? '').matchAll(ADDR_TOKEN)) out.add(m[0].toLowerCase())
      }
    }
  }
  return [...out]
}

// Fetch the thread's participant addresses with the same credentials the Gmail
// MCP server uses (same mailbox the send would go through, so the gate and the
// send see the same thread). Path resolution mirrors the MCP server's own:
// GMAIL_CREDENTIALS_PATH / GMAIL_OAUTH_PATH env overrides, else ~/.gmail-mcp.
// Throws on ANY failure; per-request timeouts keep the whole check well under
// the hook's 10s budget (a hook timeout would be a NON-blocking error, i.e.
// fail-open -- the script must always decide first).
export async function fetchThreadParticipants(threadId, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch
  const readFile = opts.readFile ?? ((p) => readFileSync(p, 'utf-8'))
  const now = opts.now ?? (() => Date.now())
  const home = process.env.HOME || homedir()
  const credPath = process.env.GMAIL_CREDENTIALS_PATH || join(home, '.gmail-mcp', 'credentials.json')
  const keysPath = process.env.GMAIL_OAUTH_PATH || join(home, '.gmail-mcp', 'gcp-oauth.keys.json')
  const creds = JSON.parse(readFile(credPath))
  let accessToken = creds.access_token
  const fresh = typeof creds.expiry_date === 'number' && creds.expiry_date > now() + 60_000
  if (!fresh) {
    const keys = JSON.parse(readFile(keysPath))
    const k = keys.installed ?? keys.web
    if (!k?.client_id || !k?.client_secret || !creds.refresh_token) {
      throw new Error('gmail credentials incomplete')
    }
    const res = await fetchImpl(k.token_uri || 'https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: k.client_id,
        client_secret: k.client_secret,
        refresh_token: creds.refresh_token,
        grant_type: 'refresh_token',
      }).toString(),
      signal: AbortSignal.timeout(3500),
    })
    if (!res.ok) throw new Error(`token refresh failed: ${res.status}`)
    accessToken = (await res.json())?.access_token
  }
  if (!accessToken) throw new Error('no gmail access token')
  const url = 'https://gmail.googleapis.com/gmail/v1/users/me/threads/'
    + encodeURIComponent(threadId)
    + '?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Reply-To'
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(3500),
  })
  if (!res.ok) throw new Error(`thread fetch failed: ${res.status}`)
  return extractParticipants(await res.json())
}

// Deny wording for the thread-reply case: the agent HAS a send right, the
// specific call fell outside it. Says what the right covers and the way out.
export function buildThreadDenyMsg(botName, detail) {
  return (
    'Kimeno email ezzel a jogosultsaggal CSAK meglevo szalba mehet, es csak a ' +
    `szalban mar szereplo cimzettnek (szal-kapu). Elutasitva: ${detail}. ` +
    `Uj cimzetthez vagy uj szalhoz kuldd a tervezett emailt ${botName}nek ` +
    'inter-agent uzenetben jovahagyasra.'
  )
}

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

// Run as the hook entrypoint only when invoked directly (not when imported by a
// test). Reads the PreToolUse payload from stdin and emits a deny decision for
// email-send tool calls. realpath both sides so a symlinked install path (the
// hook command is an absolute path that may traverse a symlink, e.g. /tmp ->
// /private/tmp on macOS, or a symlinked /home on Linux) still matches -- a raw
// url-vs-argv compare would silently no-op the gate (a security bypass).
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
  let decision
  try {
    decision = gateDecision(payload?.tool_name, payload?.tool_input, null, payload?.cwd || process.cwd())
  } catch (err) {
    // HOOKDEPLOAD1008: the call needed the ledger, and the ledger module did
    // not load. Anything else that throws here is not this branch's to judge.
    if (!LEDGER_LOAD_ERROR) throw err
    process.stderr.write(buildLedgerUnavailableMsg(LEDGER_LOAD_ERROR))
    process.exit(2)
  }
  const { deny: shouldDeny, kind, addresses } = decision
  if (shouldDeny) {
    const { botName, ownerName } = readBrandEnv()
    // An address with no recorded source loses before every other branch,
    // including the thread-reply narrowing below: a verified thread cannot
    // vouch for an unsourced recipient.
    if (kind === 'unparseable-recipient') deny(buildUnparseableRecipientMsg(addresses ?? []))
    if (kind === 'unverified-recipient') deny(buildUnverifiedRecipientMsg(addresses ?? []))
    if (kind === 'draft-required') deny(buildDraftOnlyMsg(ownerName))
    if (kind === 'wrapper-depth') deny(buildWrapperDepthMsg())
    // Thread-scoped narrowing: only when the scaffold wired this agent's hook
    // command with the flag (capability-driven, regenerated on every spawn),
    // and only for the direct send_email tool. Bash send routes and
    // manage_email stay fully gated even for the capable agent.
    if (kind === 'send_email' && process.argv.includes('--allow-thread-reply')) {
      const req = threadReplyRequest(payload?.tool_input)
      if (!req.ok) deny(buildThreadDenyMsg(botName, req.reason))
      let verdict
      try {
        const participants = await fetchThreadParticipants(req.threadId)
        verdict = threadMembershipDecision(req.recipients, participants)
      } catch {
        verdict = { allow: false, reason: 'a szal resztvevoi nem olvashatok (fail-closed)' }
      }
      if (verdict.allow) allow()
      deny(buildThreadDenyMsg(botName, verdict.reason))
    }
    deny(buildGateMsg(botName, ownerName))
  }
  allow()
}
