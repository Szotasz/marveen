#!/usr/bin/env node
// PreToolUse hard-gate: blocks SELF-PACE for sub-agents.
//
// Governance control (2026-06-26, after the autonom-kor incident: a sub-agent
// scheduled its own wakeups via ScheduleWakeup, fed itself prompts, and acted
// on a SELF-GENERATED "A) zárjuk le" decision -- dispatching real development
// -- while the operator slept. Two independent adversarial audits confirmed the
// root cause is the agent's own self-pace loop, not an external vector).
//
// A sub-agent must be INPUT-DRIVEN: it acts on operator / peer messages, never
// on prompts it scheduled for itself. This gate blocks every self-pace path:
//   - the Claude Code runtime tools ScheduleWakeup / CronCreate / CronList /
//     CronDelete / RemoteTrigger (the autonomous-loop machinery), AND
//   - the Bash escape routes that achieve the same self-injection: writing the
//     Claude scheduled_tasks.json directly, tmux send-keys into a session, or
//     creating/changing a dashboard schedule -- through /api/schedules with ANY
//     client, or by writing the scheduled-tasks store it lives in (Bash or the
//     native Write/Edit/NotebookEdit tools). See scheduleSurfaceDeny.
//
// Why a hook and not only a permissions deny-list: permissive profiles launch
// with --dangerously-skip-permissions. A whole-tool-name deny DOES survive that
// (deny is checked before the bypass allow), so the scaffold also adds these
// names to permissions.deny -- but the Bash-command routes can ONLY be caught
// by a PreToolUse hook, which runs regardless of permission mode. Defense in
// depth: deny-list for the tool names, this hook for the Bash routes (+ the
// names again, redundantly fail-closed).
//
// Wired into every sub-agent's .claude/settings.json by
// writeAgentSettingsFromProfile() (agent-scaffold.ts), guarded by
// name !== MAIN_AGENT_ID, re-applied on every spawn (respawn-safe).

import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { mcpFileTargets } from './hooks/mcp-file-targets.mjs'

// The allowlist this install's egress-gate.mjs reads (scripts/ -> repo root -> store/).
const DEFAULT_ALLOWLIST_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'store', 'egress-allowlist.json')

// Claude Code runtime self-pace / scheduling tools. A sub-agent has no
// legitimate need to schedule its own future turns -- it is input-driven.
const SELF_PACE_TOOLS = new Set([
  'ScheduleWakeup',
  'CronCreate',
  'CronDelete',
  'CronList',
  'RemoteTrigger',
])

// Bash command patterns that achieve self-pace by another route. These are
// tested per COMMAND SEGMENT (see splitSegments), so a token in one part of a
// compound command never trips a pattern that belongs to another part.
const SELF_PACE_BASH_PATTERNS = [
  // tmux pane injection -- every write-subcommand that can push keys/text/commands
  // into a pane (the actual incident vector), not just send-keys. [\s\S] (not
  // [^\n]) so an intra-segment newline cannot split the match.
  /\btmux\b[\s\S]*\b(send-keys|paste-buffer|run-shell|set-buffer)\b/i,
  // self-backgrounding that relaunches claude (nohup/setsid/disown + claude)
  /\b(nohup|setsid|disown)\b[\s\S]*\bclaude\b/i,
  // the loop slash-skill driven from a shell. `/loop` must be in SLASH-COMMAND
  // position -- a standalone token (segment-start / whitespace / quote before it,
  // whitespace / quote / end after it) -- never a PATH segment. The old
  // `\/loop\b` fired on any `loop`-prefixed path component whenever `.claude` was
  // in the same command (\bclaude\b matches the `.claude` in every memory/skill
  // path), so reading `.../memory/loop-stop-...md` or `~/.claude/skills/loop/...`
  // was denied (measured 2026-07-26, found by pg: Heli denied a harmless memory
  // read). Same bug class as the at/batch and launchctl fixes below: a keyword in
  // a PATH collided with a call pattern; the fix is to match the invocation SHAPE.
  // Every real form stays denied: `claude /loop 5m`, `claude -p "/loop x"`,
  // `claude '/loop'`, bare `claude /loop`.
  /\bclaude\b[\s\S]*(?:^|[\s'"])\/loop(?=[\s'"]|$)/i,
]

// OS-level schedulers + delayed exec (cron / launchd / systemd / at / batch): the
// shell route to the same self-pace the CronCreate tool-deny blocks at the runtime
// layer. Anchored to command position (segment start), but a leading wrapper is
// allowed before the binary -- sudo/env/command/nice, a VAR=val environment, and
// an absolute/relative path -- so `sudo crontab -r`, `/usr/bin/at now`,
// `PATH=/bin crontab -` are all caught. Trailing \b(?!-) so it never fires on
// "netstat" / "crontab-helper.sh"; (?!\s*=) so a bare NAME=value assignment
// (`at=$(...)`) is not mistaken for the `at` binary.
// The path-prefix branch must not START with an assignment (SELFPACEASSIGN1109). As
// `(?:\S*/)?` it swallowed a VARIABLE ASSIGNMENT too, because an assignment to an
// absolute path ends in a slash-separated word: in `SP=/tmp/.../scratchpad/batch;
// ls "$SP"` the prefix ate `SP=/tmp/.../scratchpad/` and left `batch` sitting at
// what looked like a command position -- AT_INVOCATION's end-of-segment branch then
// read it as a real batch(1) submit. Measured: the same `ls` was denied with the
// variable and allowed with the literal path, so an agent's choice of shell style
// had become a security decision. Same bug class as the at/batch, launchctl and
// /loop fixes above -- a keyword inside a PATH collided with a call pattern. An
// assignment prefix is already handled by the `[A-Za-z_]\w*=\S*\s+` alternative,
// which correctly demands the whitespace bash needs before the binary. Only a
// LEADING `NAME=` is refused: a directory name may contain `=` anywhere else, and
// `/tmp/d=1/at now` or `./a=b/crontab -` is a real scheduler call that must stay
// denied (excluding every `=` from the path, as a first draft did, let those through).
const SCHED_PREFIX = String.raw`(?:(?:[A-Za-z_]\w*=\S*|sudo|env|command|exec|nice|builtin|time)\s+)*(?:(?![A-Za-z_]\w*=)\S*/)?`
// The command-boundary anchor includes `(` so a $(...) command substitution
// (`X=$(crontab -)`) is caught, AND a backtick so a legacy `...` substitution
// (`X=`crontab -r``) is caught too -- both run the enclosed command in a shell
// context, so a scheduler binary immediately inside either is a real self-pace.
const SCHED_BOUNDARY = '[;&|(`]'
// `at` and `batch` are also ordinary English words, and splitSegments splits on
// NEWLINES -- so a PROSE line inside a multi-line commit body ("at least 80% of
// entries", "batch size is 50") lands at a segment start and looked exactly like
// the at(1)/batch(1) binaries. Measured 2026-07-25 (found by JogAsz): a heredoc
// commit message was denied for the words "at least"; the identical command
// passed after rewording that one line. The `-m "$(...)"` form is deliberately
// NOT blanked by stripGitCommitMessages (a real substitution could hide there),
// so the body does reach the splitter -- the fix belongs here, not there.
//
// For these two words ONLY, also require something that looks like an actual
// invocation: end of segment (a bare `batch` reads stdin -- still a real vector),
// a flag, an input redirect, or an at(1) TIMESPEC (which at(1) requires anyway,
// so a real submit can never omit it). crontab/launchctl/systemd-run keep the
// plain match: they are not English words, so prose cannot collide with them.
const AT_INVOCATION = String.raw`(?=\s*$|\s+-|\s*<|\s+(?:now|noon|midnight|teatime|today|tomorrow|next\b|\+\s*\d|\d{1,2}:\d{2}|\d{3,4}\b|\d{1,2}\s*(?:am|pm)\b|\d{1,2}[./]\d{1,2}|(?:mon|tue|wed|thu|fri|sat|sun)|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)))`
// `launchctl` needed the SAME narrowing, for a different reason than at/batch, and
// the comment above ("not English words, so prose cannot collide") was measured
// wrong on 2026-07-26 (found by Hacker). It is not an English word -- but the
// fleet's own heartbeats ORDER every agent to report `launchctl list | grep
// com.jarvis.channels` output, so a launchd JOB LABEL appears in prose constantly.
// splitSegments splits on `;`, so a report line "...; launchctl com.jarvis.channels
// PID 555" put `launchctl <label>` at a segment start and it read as a real
// invocation. His status message was denied; the finding is systemic, not his.
//
// The narrowing mirrors AT_INVOCATION: instead of enumerating dangerous
// subcommands (a denylist -- miss one and it is a hole), require the SHAPE of a
// real invocation. Every launchctl self-pace vector (load/bootstrap/submit/
// kickstart/start/enable/...) takes a SUBCOMMAND word first, so demand that the
// next token could be one: a bare lowercase word, no dot and no slash. A job
// label (`com.jarvis.channels`) and a path both fail that and pass through as
// prose. End-of-segment and a flag stay DENIED -- a bare `launchctl` is
// interactive, still a real vector.
const LAUNCHCTL_SUBCOMMAND = String.raw`(?=\s*$|\s+-|\s+[a-z][a-z-]*(?:\s|$))`
const SCHEDULER_RX = new RegExp(
  String.raw`(^|${SCHED_BOUNDARY}\s*)${SCHED_PREFIX}(?:(?:crontab|systemd-run)\b(?!-)(?!\s*=)|launchctl\b(?!-)(?!\s*=)${LAUNCHCTL_SUBCOMMAND}|(?:batch|at)\b(?!-)(?!\s*=)${AT_INVOCATION})`,
  'i',
)
// ...but allow a pure READ-listing of one's own schedule (parity with the store /
// schedule-API read exemptions): crontab -l, launchctl list/print, atq.
const SCHEDULER_READ_RX = new RegExp(String.raw`(^|${SCHED_BOUNDARY}\s*)${SCHED_PREFIX}(crontab\s+-l\b|launchctl\s+(?:list|print|dumpstate|blame|examine)\b|atq\b)`, 'i')

// Transient user unit exemption. A sub-agent's long test run started with setsid
// stays in the tmux-spawn scope cgroup, so a session restart kills it; a transient
// user unit (systemd-run --user --collect ...) runs outside that cgroup and
// survives. What the gate guards against is a SELF-TIMED FUTURE TURN, and an
// immediate unit with no timer option schedules nothing. So exactly ONE such
// invocation is allowed. The option check is an ALLOWLIST, not a denylist (same
// reasoning as the LAUNCHCTL_SUBCOMMAND comment: miss one dangerous option in a
// denylist and it is a hole). maskInertLiterals blanks quoted text, so the payload
// of `sh -c '...'` is invisible in the masked segments; the payload check therefore
// reads the RAW command text, never the masked text.
// Known limit: a deliberately hidden payload (a name assembled from variables, an
// encoded command, a script file) is not seen; the same is true of the existing
// setsid/nohup branch. The gate's threat model (see KNOWN LIMITATIONS near
// splitSegments) is a sub-agent that must not casually self-pace.
// StandardOutput/StandardError are left out on purpose: `file:PATH` makes systemd write
// PATH, and the store-write checks above only recognise a shell redirect as a write.
// A log goes through the payload instead: sh -c 'npm test > /tmp/x.log 2>&1'.
// RuntimeMaxSec is mandatory and bounded (whole seconds, 1 to TRANSIENT_UNIT_RUNTIME_MAX_SEC):
// without it, or with `infinity` or an empty value (which resets it to infinity),
// the unit is a process with no end the gate can see.
// TimeoutStopSec is left out for the same reason: when RuntimeMaxSec expires systemd sends
// SIGTERM and waits TimeoutStopSec before SIGKILL, so `infinity` lets a payload that
// ignores SIGTERM run on. Without it the user manager's default stop timeout applies.
// Environment, --setenv and -E are left out on purpose: they pass any variable name,
// and names such as BASH_ENV, ENV, NODE_OPTIONS, LD_PRELOAD, DYLD_*, PYTHONSTARTUP,
// PYTHONPATH or PATH make the payload's interpreter load code the payload check never reads.
// This puts the option channel in line with the existing known limit: a payload
// that runs a script file is not read either.
const TRANSIENT_UNIT_PROPERTIES = new Set([
  'WorkingDirectory', 'Nice', 'IOSchedulingClass', 'IOSchedulingPriority', 'CPUWeight', 'IOWeight',
  'CPUQuota', 'MemoryMax', 'MemoryHigh', 'TasksMax', 'RuntimeMaxSec',
])
const TRANSIENT_UNIT_RUNTIME_MAX_SEC = 7200
// A word ends at any character that cannot be part of a command name, so `${X}claude`
// is caught here as it is by the setsid/nohup branch's \bclaude\b.
const TRANSIENT_PAYLOAD_DENY_WORD_RX =
  /(?:^|[^A-Za-z0-9_-])(?:claude(?:-code)?|crontab|launchctl|systemd-run|at|batch|tmux|nohup|setsid|disown|sleep|watch|eval)(?=$|[^A-Za-z0-9_-])/i

// Split a string into shell words: [{ value (quotes removed), start (index of the
// word's first character, including an opening quote), expands (the word bash runs
// is not this text: `$` or a backtick outside single quotes, or a brace, glob or
// redirection character outside any quotes) }]; null if unterminated.
function transientShellWords(command) {
  const words = []
  const n = command.length
  let i = 0
  while (i < n) {
    if (command[i] === ' ' || command[i] === '\t') { i++; continue }
    const start = i
    let value = ''
    let expands = false
    while (i < n && command[i] !== ' ' && command[i] !== '\t') {
      const c = command[i]
      if (c === "'") {
        const end = command.indexOf("'", i + 1)
        if (end < 0) return null
        value += command.slice(i + 1, end)
        i = end + 1
      } else if (c === '"') {
        i++
        let closed = false
        while (i < n) {
          const d = command[i]
          if (d === '"') { closed = true; i++; break }
          if (d === '\\' && i + 1 < n && '"\\$`'.includes(command[i + 1])) {
            value += command[i + 1]
            i += 2
          } else {
            if (d === '$' || d === '`') expands = true
            value += d
            i++
          }
        }
        if (!closed) return null
      } else if (c === '\\') {
        if (i + 1 >= n) return null
        value += command[i + 1]
        i += 2
      } else {
        if ('$`{}*?[<>'.includes(c)) expands = true
        value += c
        i++
      }
    }
    words.push({ value, start, expands })
  }
  return words
}

export function transientUserUnitAllowed(command) {
  if (typeof command !== 'string' || /[\r\n]/.test(command)) return false
  // $'...' (ANSI-C) and $"..." quoting are not modelled by the word splitter below:
  // bash turns $'cl\x61ude' into `claude`, so a payload in that quoting gets no exemption.
  if (/\$['"]/.test(command)) return false
  const masked = maskInertLiterals(command)
  if (masked == null) return false
  if (/[;&|`<]|\$\(|>\(/.test(masked.replace(/\d*>&\d+/g, ' '))) return false
  const words = transientShellWords(command)
  if (words == null || words.length === 0) return false
  if (words[0].value !== 'systemd-run' || command.slice(words[0].start, words[0].start + 11) !== 'systemd-run') return false
  const FLAGS = new Set(['--user', '--collect', '-G', '--quiet', '-q', '--same-dir', '-d', '--wait', '--pipe', '-P'])
  const LONG_VALUE = new Set(['--unit', '--description', '--working-directory', '--nice', '--property'])
  const SHORT_VALUE = { '-u': '--unit', '-p': '--property' }
  let user = false
  let runtimeMax = false
  let collect = false
  let i = 1
  while (i < words.length && words[i].value.startsWith('-')) {
    const w = words[i].value
    i++
    if (w === '--') break
    if (FLAGS.has(w)) {
      if (w === '--user') user = true
      if (w === '--collect' || w === '-G') collect = true
      continue
    }
    let opt
    let val
    if (SHORT_VALUE[w] !== undefined) {
      opt = SHORT_VALUE[w]
    } else if (w.startsWith('--')) {
      const eq = w.indexOf('=')
      opt = eq < 0 ? w : w.slice(0, eq)
      if (!LONG_VALUE.has(opt)) return false
      if (eq >= 0) val = w.slice(eq + 1)
    } else {
      return false
    }
    if (val === undefined) {
      if (i >= words.length) return false
      val = words[i].value
      i++
    }
    if (opt === '--unit') {
      if (!/^[A-Za-z0-9][A-Za-z0-9_@:-]*(?:\.service)?$/.test(val)) return false
    } else if (opt === '--description' || opt === '--working-directory') {
      if (val === '') return false
    } else if (opt === '--nice') {
      if (!/^-?\d{1,2}$/.test(val)) return false
    } else {
      const m = /^([A-Za-z]+)=[\s\S]*$/.exec(val)
      if (!m || !TRANSIENT_UNIT_PROPERTIES.has(m[1])) return false
      if (m[1] === 'RuntimeMaxSec') {
        const text = val.slice(val.indexOf('=') + 1)
        if (!/^[1-9][0-9]{0,3}$/.test(text) || Number(text) > TRANSIENT_UNIT_RUNTIME_MAX_SEC) return false
        runtimeMax = true
      }
    }
  }
  if (!user || !collect || !runtimeMax || i >= words.length) return false
  // systemd-run reads options up to its first non-option argument ("+" getopt), so a
  // word bash still splits or expands there can turn into an option this loop never
  // saw: --description=x${IFS}--on-active=5m, {--on-active=5m,true}, an empty $X, or a
  // redirection that bash drops from argv (>/tmp/l --on-active=5m).
  if (words.slice(0, i + 1).some((w) => w.expands)) return false
  const rawPayload = command.slice(words[i].start)
  const joined = words.slice(i).map((w) => w.value).join(' ')
  for (const s of [rawPayload, joined]) {
    if (TRANSIENT_PAYLOAD_DENY_WORD_RX.test(s) || /\/api\//i.test(s) || /\$\(|`|</.test(s)) return false
  }
  return true
}

// The Claude self-schedule store. Blocked for WRITE on any route (a Bash write,
// or the native Write/Edit/NotebookEdit tool); a read/grep is legit diagnostics.
const SCHEDULE_STORE_RX = /scheduled_tasks\.json/i
// Write-intent shell tokens (redirect / tee / in-place edit / dd / copy-move).
const WRITE_INTENT_RX = /(>>?|\btee\b|\bsed\b[\s\S]*\s-i|\bdd\b|\bcp\b|\bmv\b)/i
// Dashboard schedule API, curl spelling only. A WRITE method (POST/PUT/PATCH/
// DELETE) creates/edits a self-paced cron; a GET is legit diagnostics. This pair
// never saw any other HTTP client -- see scheduleSurfaceDeny,
// which covers the API and its on-disk store for every client.
const SCHEDULE_API_RX = /\/api\/schedules\b/i
const HTTP_WRITE_RX = /(-X\s*(POST|PUT|PATCH|DELETE)|--request\s+(POST|PUT|PATCH|DELETE)|(^|\s)(--data\b|--data-\w+\b|-d\b))/i

// THE EGRESS ALLOWLIST IS A GATE ON THE SUB-AGENT ITSELF (EGRESSSELFEDIT824).
// store/egress-allowlist.json decides which hosts egress-gate.mjs lets through, and it
// was a plain writable file in the sub-agent's own tree: on 2026-08-24 a nested
// sub-agent added a domain to reach it and removed it afterwards. Its legitimate
// writers are the MAIN agent (on the owner's go) and the owner by hand -- neither runs
// this gate (it is wired for sub-agents only), so neither is affected.
//
// Native file tools: denied on the file name AND on the resolved real path, so a
// relative path or a symlink created earlier does not walk past the name check.
// Bash: FAIL-CLOSED. A segment that mentions the file may only be a plain READ
// (cat/grep/jq/...), and an output redirect in it may not point at the file. An
// interpreter (python/node/...), cp/mv/tee/sed/ln/... or anything else that names the
// file is denied, because whether it writes cannot be read off the command string.
//
// The same rule, same message, for store/extra-hooks.json and the local-hooks/ scripts it
// may name: the scaffold wires those into EVERY sub-agent's settings, so a sub-agent that
// could write either would run its code in the other agents' sessions.
//
// WHAT "MENTIONS" MEANS (EXTRAHOOKSGATE1020, review #2001). The Bash check is a text
// check, so it holds only for a command that SPELLS a protected name. "Spells" covers
// (protectedMention):
//   - the plain name, and the name after the shell's quote, backslash and $IFS removal,
//     after \xHH / \uHHHH / octal / %HH decoding and after literal string concatenation
//     in any language (lo''cal-hooks, ext""ra-hooks.json, 'extra-'+'hooks.json'), the
//     same spellings the schedule surface reads (scheduleSurfaceVariants);
//   - a variable assigned a literal in the same command ($D-hooks after D=local);
//   - a glob or brace word, or a word with an expansion this check cannot resolve (read
//     as `*`), that can match a protected name with at least three of its own literal
//     characters (*-hooks, ext*-hooks.json, $X-hooks), or that can match it at all
//     right under the real project root (local-hooks) or the real store dir (the json
//     files) -- the parent resolved through symlinks, relative to the hook's cwd and to
//     any literal cd earlier in the command (with the cwd AT the root or the store dir,
//     a word that starts with an unresolved expansion is read relative to it too);
//   - a program that names the files it creates itself (cp/mv/ln/install/rsync/tar/
//     unzip/cpio/patch, DIR_WRITERS) given the project root or the store dir itself as
//     an argument: the name it creates there is not in the command.
// Every one of these comparisons, and every path comparison in the file-tool branch,
// reads every nameForms() form of the text and denies if any matches: the raw text, and
// the folds a case-insensitive volume reads as the same name (see nameForms).
//
// WHAT IT DOES NOT COVER, and cannot from a command's text: a name the command never
// spells -- built at run time (chr(), base64, a `$(...)` that prints it, os.path.join of
// computed pieces), held in a script file the agent wrote in an earlier call or with the
// native Write tool and then runs, or written by a program not on that list (an
// interpreter, git apply / checkout, a build tool) into a directory under the root it
// picks itself. A sub-agent that WANTS to write one of these files can, because every
// agent runs as the same OS user: the files are in the same trust domain as every
// agent's own settings.json. This gate stops the casual and the spelled-out route. What
// it misses is made visible after the fact: the dashboard keeps a hash baseline of the
// egress allowlist and reports every change (src/egress-allowlist-baseline.ts), and it
// logs the sha256 of store/extra-hooks.json and of every script it names whenever it
// syncs the extras (logExtraHooksDigest in agent-scaffold.ts).
const ALLOWLIST_BASENAME = 'egress-allowlist.json'
const PROTECTED_BASENAMES = new Set([ALLOWLIST_BASENAME, 'extra-hooks.json'])
// The STORE objects, not the concept: the file and its history directory, or a glob that
// starts on the name (egress-allow*, egress-allowlist.*). A plain /egress[-_]?allow/ also
// matched this gate's own source and test names (egress-allowlist-baseline.ts), so no
// sub-agent could run, stage or diff them -- review on #1678.
// local-hooks as a whole path segment or word: not part of a longer name
// (my-local-hooks, local-hooks.md), but after any separator a language puts between
// pieces (`,` `(` `[` `+`), as in os.path.join(root, 'local-hooks', 'a.py').
const ALLOWLIST_MENTION_RX = /egress[-_]?allowlist(?:\.json|\.history)|egress[-_]?allow[\w.]*[*?[]|extra[-_]?hooks\.json|(?<![\w.-])local-hooks(?![\w.-])/i

// The fold every comparison of a protected name ALSO goes through (nameForms): the
// raw-text mention check, the glob match, the file-tool basename and path checks, and
// pathKey(). A case-insensitive volume (macOS APFS default) matches more than ASCII
// case: it reads U+017F LATIN SMALL LETTER LONG S as `s` and U+212A KELVIN SIGN as `k`
// (measured on APFS in U+0080..U+FFFF, review #2001 round 4: the only two code points
// there it treats as an ASCII letter; the astral planes were not measured).
// toLowerCase() maps the Kelvin sign but not the long s, which is already lower case,
// and a non-unicode /i regex matches neither, so extra-hook<U+017F>.json passed and
// landed as extra-hooks.json. NFKC maps both, and the lower-casing then folds ASCII case.
export function foldName(s) {
  return String(s ?? '').normalize('NFKC').toLowerCase()
}

// Every form a protected-name decision reads, and it denies if ANY of them matches. The
// fold only ADDS denials, it never replaces the raw reading, because a fold also takes
// spellings away: NFKC composes a combining mark into the letter before it
// (extra-hooks.json + U+0301 ends in U+0144, which `${V%?}` or [:-1] strips again at run
// time), and lower-casing shifts a bracket range's endpoints ([Z-z] covers `k`, [z-z]
// does not). In this order, fixed, so two keys compare form by form (sameKey):
//   0. the text as given;
//   1. lower-cased (the case-insensitive reading the round-3 fix compared);
//   2. foldName(), for the letters a case-insensitive volume reads as ASCII;
//   3. NFKD with the combining marks removed, lower-cased: a mark next to a name
//      (composed or not) does not hide it.
// On a case-sensitive volume the extra denials are look-alike names a sub-agent has no
// business writing either.
const COMBINING_MARK_RX = /\p{M}/gu
export function nameForms(s) {
  const raw = String(s ?? '')
  return [raw, raw.toLowerCase(), foldName(raw), raw.normalize('NFKD').replace(COMBINING_MARK_RX, '').toLowerCase()]
}
function mentionsProtectedName(text) {
  return nameForms(text).some((f) => ALLOWLIST_MENTION_RX.test(f))
}
const ALLOWLIST_READERS = new Set([
  'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'jq', 'wc', 'ls', 'stat',
  'file', 'shasum', 'sha256sum', 'md5', 'md5sum', 'diff', 'cmp', 'echo', 'printf',
])
// Output redirects: `>`, `>>`, `>|`, `&>`, `&>>`, `N>`. The target is the next word.
const OUTPUT_REDIRECT_RX = /(?:&>>?|\d*>>?\|?)\s*([^\s;&|<>]+)/g

// `ctx` (optional): what protectedMention needs beyond the segment's own text, see
// protectedContext. Without it only the spelling variants are read.
// The mention is measured from EVERY cwd the command has passed, the caller's included (ctx.cwds, Samu 57529/57656):
// the segments follow each cd unconditionally, also one after || or && that may not run (`false && cd /tmp; cp a $f`
// passed from the root), so a cd followed wrongly can only make it stricter.
export function allowlistBashSegmentAllowed(seg, ctx) {
  const cwds = ctx?.cwds?.length ? ctx.cwds : [ctx?.cwd ?? null]
  return readOnlyMentionAllowed(seg, (text) => cwds.some((cwd) => protectedMention(text, ctx ? { ...ctx, cwd } : ctx)), ctx?.rgConfigNamed)
}

// MORE STORE FILES ARE GATES ON THE SUB-AGENT ITSELF (kanban c556a35a), and get the same
// treatment as the allowlist above:
//   egress-vendor-hosts-<agent>.json -- per-agent additions to the global list (AGENTEGRESS1111)
//   egress-vendor-hosts.json       -- the hosts bash-egress-parser lets curl/wget reach
//   config-overrides.json          -- dashboard settings; BASH_SANDBOX_AGENTS is one of them
//   bash-sandbox-write-paths.json  -- where a sandboxed agent may write (#2149)
//   email-standing-recipients.json -- an address on it (once activated) takes letters with
//                                     no per-letter approval (email-approval-gate.py)
//   agent-send-exceptions.json     -- the named-script draft/send grants themselves, which a
//                                     sub-agent must not write for itself (card f2ccb0bb)
//   .approval-bot-token, .approval-bot-key -- the owner's approval bot and the key its button data is
//                                     signed with (src/approval-bot.ts, #2160)
// Their writers are the owner, the main agent and, for config-overrides.json, the dashboard
// process; none of them runs this gate. Unlike the allowlist, these have no hash baseline yet,
// so what this gate cannot see (a path built at runtime) is not reported after the fact.
const DEFAULT_STORE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'store')
export const AGENT_VENDOR_HOSTS_RX = /^egress[-_]?vendor[-_]?hosts[-_][\w.-]+\.json$/i
export const PROTECTED_STORE_FILES = new Set([
  'egress-vendor-hosts.json',
  'config-overrides.json',
  'bash-sandbox-write-paths.json',
  'email-standing-recipients.json',
  'agent-send-exceptions.json',
  '.approval-bot-token',
  '.approval-bot-key',
])
// The file, or a glob that starts on its name. The prefixes are long enough that this gate's
// and the features' own sources (bash-sandbox.ts, config-registry.ts) stay out of it; the
// approval-bot files need their leading dot, so a source or doc named approval-bot-key-*.md or a
// glob over src/approval-bot* stays out too. The send-exception family (card f2ccb0bb) needs the
// plural "exceptions" in its exact name, so the gates' own sources and tests
// (email-send-gate.mjs, email-approval-gate.py, email-send-gate-script-exception.test.ts,
// agent-scaffold-send-exception.test.ts) and the shared corpus fixture
// (agent-send-exception-cases.json, singular) stay out of it; its glob prefix drops only that
// word, so a glob over the store file (store/agent-send*) is caught -- a glob over the fixture
// (agent-send-exception-*) is then caught too, the same trade the email-standing prefix makes.
const PROTECTED_MENTION_RX =
  /(?:egress[-_]?vendor[-_]?hosts(?:[-_][\w.-]*)?|config[-_]?overrides|bash[-_]?sandbox[-_]?write[-_]?paths|email[-_]?standing[-_]?recipients|agent[-_]?send[-_]?exceptions)\.json|\.approval[-_]?bot[-_]?(?:token|key)\b|(?:egress[-_]?vendor|config[-_]?overrid|bash[-_]?sandbox[-_]?write|email[-_]?standing|\.approval[-_]?bot|agent[-_]?send)[\w.-]*[*?[]/i

// One rule for every protected store object: a segment that mentions it may only be a plain
// READ, and no output redirect in it may point at it (or at a target built at runtime).
// `mentions(text)` says whether a text names the protected object.
// `rgConfigNamed`: the WHOLE command names RIPGREP_CONFIG_PATH (an export or an assignment in another segment
// reaches rg too, Dani 71589), so rg is no read anywhere in it.
function readOnlyMentionAllowed(seg, mentions, rgConfigNamed = false) {
  const s = String(seg ?? '').trim()
  if (!mentions(s)) return true
  const words = s.split(/\s+/)
  let i = 0
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++ // leading VAR=x
  const cmd = (words[i] ?? '').replace(/^.*\//, '')
  // `git grep` reads too (EGRESSFP1106 (c)), in the narrow form gitGrepReadOnly accepts; a leading VAR=x in front of
  // git (GIT_PAGER, GIT_CONFIG_PARAMETERS, ...) can make it run a program, so then it is not a read.
  const gitRead = cmd === 'git' && i === 0 && gitGrepReadOnly(words.slice(i + 1))
  if (!ALLOWLIST_READERS.has(cmd) && !gitRead) return false
  // rg runs a program with --pre (EGRESSFP1106, Samu 71567), and a RIPGREP_CONFIG_PATH prefix can bring --pre in from
  // a file: then it is not a read.
  if (cmd === 'rg' && (rgConfigNamed || !rgReadOnly(words.slice(i + 1), i > 0))) return false
  // A command substitution inside the read runs a command of its own: each piece after a `$(` or a backtick (to its
  // `)`, the naive segments may have cut it) is measured with this same rule (Dani 57649: `echo $(cp /tmp/a
  // <allowlist>)` passed as a read).
  if (/\$\(|`/.test(s)) {
    for (const piece of s.split(/\$\(|`/).slice(1)) {
      const inner = piece.split(')')[0].replace(/^["'\s]+|["'\s]+$/g, '')
      if (inner && !readOnlyMentionAllowed(inner, mentions, rgConfigNamed)) return false
    }
  }
  for (const m of s.matchAll(OUTPUT_REDIRECT_RX)) {
    const target = m[1]
    if (/^&?\d+$/.test(target) || target === '/dev/null') continue // 2>&1, >/dev/null
    if (mentions(target) || /[$`]/.test(target)) return false
  }
  return true
}

export function protectedStoreBashSegmentAllowed(seg, ctx) {
  return readOnlyMentionAllowed(seg, (text) => PROTECTED_MENTION_RX.test(text), ctx?.rgConfigNamed)
}

// EGRESSFP1106 (c): `git grep` only reads, except where git runs a program of its choosing:
//   - -O / --open-files-in-pager[=<pager>] opens the matches in a pager it RUNS (also inside a short-option
//     cluster, -nO..., and as an abbreviation, --open..., which git's option parser accepts);
//   - -c <name>=<value> / --config-env set any config (core.pager, alias.*, ...) for this run;
//   - -p / --paginate and any other global option this list does not know: refused, not interpreted.
// The accepted global options are -C <dir>, --no-pager, -P, --no-optional-locks, --git-dir=, --work-tree=.
// `words` are the words after `git`, split on whitespace like readOnlyMentionAllowed's (a quoted pattern may span
// several words: they are read as more arguments, so a stray -O spelling in a pattern refuses, never admits).
export function gitGrepReadOnly(words) {
  let k = 0
  for (; k < words.length; k++) {
    const w = words[k]
    if (w === '-C') { k++; continue }
    if (w === '--no-pager' || w === '-P' || w === '--no-optional-locks') continue
    if (/^--(?:git-dir|work-tree)=/.test(w)) continue
    break // anything else ends the accepted global options, and only `grep` may stand here (so -c, -p: refused)
  }
  if (words[k] !== 'grep') return false
  for (const w of words.slice(k + 1)) {
    if (/^-[^-]/.test(w) && w.includes('O')) return false
    const long = w.startsWith('--') ? w.slice(2).split('=')[0] : null
    if (long !== null && /^o/.test(long) && 'open-files-in-pager'.startsWith(long)) return false
    // --textconv runs the textconv program the config names, with the file as its argument (Dani 71554, git 2.50.1).
    // Its abbreviations count from --textc (--text alone is -a, a read).
    if (long !== null && long.length >= 5 && /^textc/.test(long) && 'textconv'.startsWith(long)) return false
  }
  return true
}

// rg is a reader, except --pre <program> / --pre=<program> (rg runs it on every file), and any environment prefix
// (RIPGREP_CONFIG_PATH names a config file that may hold --pre). --pre-glob only narrows --pre; --pretty is a read.
const RG_CONFIG_ENV_RX = /RIPGREP_CONFIG_PATH/
// a bare HOME word: not $HOME / ${HOME} (a read), not part of a longer name (HOMEBREW_X, MY_HOME)
const HOME_TOUCH_RX = /(?<![$\w{])HOME(?!\w)/
export function rgReadOnly(words, envPrefix = false) {
  if (envPrefix) return false
  return !words.some((w) => w === '--pre' || w.startsWith('--pre='))
}

// EGRESSFP1106 (a): the segments the protected-store and allowlist rules judge. A separator inside a quoted string
// is no separator: `grep -n "a\|b" f` is one grep, but the naive split made `b" f` a command of its own, which is no
// reader, so a plain grep from the project root was denied. The cut is made on maskInertLiterals' mask (same
// length as the joined source) and every segment keeps its ORIGINAL text, so a quoted name is still read as a
// mention. Fail-closed to the naive split, which only ever cuts MORE:
//   - unresolved quoting (an unterminated quote, a "$(...)" or backtick in double quotes) -> naive;
//   - any heredoc -> naive: a heredoc body is one masked region, and `bash <<EOF` with an `echo` first and a
//     `cp ... <allowlist>` on the next body line would otherwise read as one echo.
export function protectedSegments(command) {
  return protectedSplit(command).segs
}

// protectedSegments plus what the definite-assignment rule needs: the separator after each segment ('' after the
// last) and the mask. `quoteAware` false = the naive fallback, where no separator is known.
export function protectedSplit(command) {
  const src = String(command ?? '').replace(/\\\r?\n/g, ' ')
  const heredocs = []
  const masked = maskInertLiterals(src, heredocs)
  if (masked == null || masked.length !== src.length || heredocs.length) {
    return { segs: splitSegments(command), seps: null, masked: null, quoteAware: false }
  }
  const segs = []
  const seps = []
  let start = 0
  for (const m of masked.matchAll(SEGMENT_SEP_RX)) {
    segs.push(src.slice(start, m.index).trim())
    seps.push(m[0] === '\n' ? ';' : m[0])
    start = m.index + m[0].length
  }
  segs.push(src.slice(start).trim())
  seps.push('')
  return { segs, seps, masked, quoteAware: true }
}

// EGRESSFP1106 (b): a variable that is DEFINITELY a literal when a segment runs is read only as that literal there,
// not also as "any text". Without this, `L=/abs/dir; ... cd <root> && docker run -v $L/out:/out ...` read `$L/out`
// as `*/out`, and from the project root `*` can be local-hooks. Rule (Samu 71460), all of it, else the unresolved
// reading STAYS:
//   - the command has no subshell, group, substitution or compound command: no unquoted ( ) { } or backtick (a
//     `${NAME}` is fine), and no segment starts with if/then/elif/else/fi/for/while/until/do/done/case/esac/
//     select/function/coproc;
//   - no segment can set a variable another way: source, `.`, eval, read, mapfile, readarray, getopts, unset,
//     export, local, declare, typeset, readonly, let, `printf -v`;
//   - the name is assigned exactly ONCE in the whole command (NAME= or NAME+=, quoted text excluded), in a segment
//     that is only literal NAME=value words, and the use comes after it;
//   - the name is not one the shell itself sets or rewrites (SHELL_MANAGED_NAMES: every special name of zsh and bash; any BASH*/ZSH*/COMP_*/READLINE_*/LC_*: Dani 71554);
//   - every separator from that assignment to the use is && or ; (or a newline);
//   - from the last ; before the assignment up to it there is no || (`a || F=x && use $F` can run use without F);
//   - the separator right before the assignment is not a pipe or & (that would run it in a subshell).
// Returns, per segment, a Map name -> literal value.
const COMPOUND_WORDS = new Set(['if', 'then', 'elif', 'else', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'select', 'function', 'coproc', '{', '}', '(', ')', '((', '[[' ])
// Names the SHELL itself sets or rewrites: an assignment to one is no definite literal. `PWD=/tmp/q; cd .; cp -R x/.
// $PWD` copies into the real cwd (cd resets PWD; measured in bash and zsh, Dani 71554), `cd /` resets OLDPWD, and $_,
// RANDOM, SECONDS, LINENO ... change on their own. zsh's lower-case twins (dirstack, cdpath, ...) are listed too; any
// BASH* / ZSH* / COMP_* / READLINE_* / LC_* name is excluded by prefix.
//
// The list is NOT grown name by name: every name either shell treats as special stays unresolved. Some zsh special
// parameters accept an assignment, keep running and hold ANOTHER value (KEYBOARD_HACK keeps one character, HISTCHARS /
// histchars three, USERNAME its old value), so the gate would read `$NAME<install>` as a place the shell never writes to.
// zsh: the special parameters of zsh 5.9 (112 names), generated with
//   for k in ${(ko)parameters}; do [[ ${parameters[$k]} == *special* ]] && print -r -- $k; done
// A test compares this list with the running zsh's own list (skipped where there is no zsh), so a newer zsh that adds
// a special parameter turns it red on a machine that has one.
export const ZSH_SPECIAL_NAMES = Object.freeze([
  '!', '#', '$', '*', '-', '0', '?', '@', 'ARGC', 'CDPATH', 'COLUMNS', 'EGID', 'EUID', 'FIGNORE', 'FPATH', 'FUNCNEST', 'GID',
  'HISTCHARS', 'HISTCMD', 'HISTSIZE', 'HOME', 'IFS', 'KEYBOARD_HACK', 'LINENO', 'LINES', 'MAILPATH', 'MANPATH', 'MODULE_PATH',
  'NULLCMD', 'OPTARG', 'OPTIND', 'PATH', 'PPID', 'PROMPT', 'PROMPT2', 'PROMPT3', 'PROMPT4', 'PS1', 'PS2', 'PS3', 'PS4',
  'PSVAR', 'RANDOM', 'READNULLCMD', 'SAVEHIST', 'SECONDS', 'SHLVL', 'SPROMPT', 'TERM', 'TRY_BLOCK_ERROR',
  'TRY_BLOCK_INTERRUPT', 'TTYIDLE', 'UID', 'USERNAME', 'WATCH', 'WORDCHARS', 'ZSH_EVAL_CONTEXT', 'ZSH_SUBSHELL', '_',
  'aliases', 'argv', 'builtins', 'cdpath', 'commands', 'dirstack', 'dis_aliases', 'dis_builtins', 'dis_functions',
  'dis_functions_source', 'dis_galiases', 'dis_patchars', 'dis_reswords', 'dis_saliases', 'fignore', 'fpath', 'funcfiletrace',
  'funcsourcetrace', 'funcstack', 'functions', 'functions_source', 'functrace', 'galiases', 'histchars', 'history',
  'historywords', 'jobdirs', 'jobstates', 'jobtexts', 'keymaps', 'mailpath', 'manpath', 'module_path', 'modules', 'nameddirs',
  'options', 'parameters', 'patchars', 'path', 'pipestatus', 'prompt', 'psvar', 'reswords', 'saliases', 'status', 'termcap',
  'terminfo', 'userdirs', 'usergroups', 'watch', 'widgets', 'zsh_eval_context', 'zsh_scheduled_events',
])
// bash: the variables the shell sets, rewrites or reads for its own behaviour (the "Shell Variables" chapter of the bash
// manual). BASH* / COMP_* / READLINE_* / LC_* names are excluded by prefix below.
export const BASH_SPECIAL_NAMES = Object.freeze([
  'CDPATH', 'CHILD_MAX', 'COLUMNS', 'COMPREPLY', 'COPROC', 'DIRSTACK', 'EMACS', 'ENV', 'EPOCHREALTIME', 'EPOCHSECONDS', 'EUID',
  'EXECIGNORE', 'FCEDIT', 'FIGNORE', 'FUNCNAME', 'FUNCNEST', 'GLOBIGNORE', 'GLOBSORT', 'GROUPS', 'HISTCMD', 'HISTCONTROL',
  'HISTFILE', 'HISTFILESIZE', 'HISTIGNORE', 'HISTSIZE', 'HISTTIMEFORMAT', 'HOME', 'HOSTFILE', 'HOSTNAME', 'HOSTTYPE', 'IFS',
  'IGNOREEOF', 'INPUTRC', 'INSIDE_EMACS', 'LANG', 'LINENO', 'LINES', 'MACHTYPE', 'MAIL', 'MAILCHECK', 'MAILPATH', 'MAPFILE',
  'OLDPWD', 'OPTARG', 'OPTERR', 'OPTIND', 'OSTYPE', 'PATH', 'PIPESTATUS', 'POSIXLY_CORRECT', 'PPID', 'PROMPT_COMMAND',
  'PROMPT_DIRTRIM', 'PS0', 'PS1', 'PS2', 'PS3', 'PS4', 'PWD', 'RANDOM', 'REPLY', 'SECONDS', 'SHELL', 'SHELLOPTS', 'SHLVL',
  'SRANDOM', 'TERM', 'TIMEFORMAT', 'TMOUT', 'TMPDIR', 'UID', '_', 'auto_resume', 'histchars',
])
const SHELL_MANAGED_NAMES = new Set([...ZSH_SPECIAL_NAMES, ...BASH_SPECIAL_NAMES, 'PWD', 'OLDPWD', 'DIRSTACK', 'dirstack', 'CDPATH',
  'cdpath', 'IFS', 'RANDOM', 'SRANDOM', 'SECONDS', 'LINENO', 'EPOCHSECONDS', 'EPOCHREALTIME', 'HISTCMD', 'PPID', 'UID', 'EUID',
  'GROUPS', 'SHLVL', 'OPTIND', 'OPTARG', 'REPLY', 'PIPESTATUS', 'pipestatus', 'FUNCNAME', 'COLUMNS', 'LINES', 'HOME', 'PATH', 'path',
  'argv', 'status', 'psvar', 'TMOUT', 'HOSTNAME', 'MACHTYPE', 'OSTYPE', 'HOSTTYPE', 'COPROC', 'MAPFILE', '_'])
const SHELL_MANAGED_PREFIX_RX = /^(?:BASH|ZSH|COMP_|READLINE_|LC_)/
const VAR_SETTERS = new Set(['source', '.', 'eval', 'read', 'mapfile', 'readarray', 'getopts', 'unset', 'export', 'local', 'declare', 'typeset', 'readonly', 'let'])
export function definiteAssignments(split) {
  const none = split.segs.map(() => new Map())
  if (!split.quoteAware) return none
  const shape = split.masked.replace(/\$\{[A-Za-z_]\w*\}/g, '')
  if (/[(){}`]/.test(shape)) return none
  const firstWords = split.segs.map((s) => {
    const w = s.split(/\s+/)
    let i = 0
    while (i < w.length && /^[A-Za-z_]\w*\+?=/.test(w[i])) i++
    return { cmd: w[i] ?? '', rest: w.slice(i + 1) }
  })
  for (const { cmd, rest } of firstWords) {
    if (COMPOUND_WORDS.has(cmd) || VAR_SETTERS.has(cmd)) return none
    if (cmd === 'printf' && rest.includes('-v')) return none
  }
  // assignments of each name anywhere in the unquoted text
  const counts = new Map()
  for (const m of split.masked.matchAll(/(?:^|[\s;&|])([A-Za-z_]\w*)\+?=/g)) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1)
  // literal-only assignment segments
  const defs = [] // { at, name, value }
  split.segs.forEach((s, at) => {
    const words = shellWords(s)
    if (!words || !words.length) return
    const pairs = []
    for (const w of words) {
      const m = ASSIGN_RX.exec(w.value)
      if (!m || w.dollar) return
      const v = w.value.slice(m[0].length)
      if (/[$`\u0000]/.test(v)) return
      pairs.push([m[1], v])
    }
    for (const [name, value] of pairs) if (counts.get(name) === 1 && !SHELL_MANAGED_NAMES.has(name) && !SHELL_MANAGED_PREFIX_RX.test(name)) defs.push({ at, name, value })
  })
  const out = split.segs.map(() => new Map())
  for (const d of defs) {
    const before = d.at > 0 ? split.seps[d.at - 1] : ';'
    if (!['&&', ';'].includes(before)) continue
    // no || from the last ; before the assignment
    let k = d.at - 1
    let orBefore = false
    while (k >= 0 && split.seps[k] !== ';') { if (split.seps[k] === '||') orBefore = true; k-- }
    if (orBefore) continue
    // A CONDITIONAL assignment (an && before it in its own ;-list: `false && F=x`) resolves only inside that && chain.
    // Past a ; the use runs whether or not the assignment did, with F empty: `false && F=x; cp a ${F}local-hooks/b`
    // writes into the protected dir (Samu 71530). An unconditional one (first in its list) holds for the rest.
    const conditional = before === '&&'
    for (let u = d.at + 1; u < split.segs.length; u++) {
      if (!['&&', ';'].includes(split.seps[u - 1])) break
      if (conditional && split.seps[u - 1] === ';') break
      out[u].set(d.name, d.value)
    }
  }
  return out
}

// VARDEFDB1121: the command with every DEFINITE literal variable use (definiteAssignments) put in as its
// value, for a gate that does not follow variables itself (db-write-gate: `W=/abs/wt; git -C $W ...`, `S=/abs; cd $S/x`).
// Only a LIVE use is replaced (not one in single quotes or $'...'; a double-quoted one is live), only `$NAME` /
// `${NAME}` (no `${NAME:-x}`), not one followed by `[` or `:` (zsh subscript / modifier: `$W[1]`, `$W:h`), and only an
// ABSOLUTE value of plain path characters (`/...`: a relative one goes through CDPATH in a cd): no space, quote, glob,
// `$`, backslash or `~`, so the value reads the same quoted or not; and nothing at all when the command names IFS.
// Everything else keeps its unresolved reading. Unchanged when the quoting cannot be followed or nothing is definite.
const DEFINITE_SAFE_VALUE_RX = /^\/[A-Za-z0-9_./@%+=,-]*$/
// VARDEFDB1121: definiteAssignments proves a name is ASSIGNED once, not that nothing
// else SETS it. A setter can hide behind a precommand word (`builtin read W`, `\builtin source f`, `time source f`, zsh
// `repeat 1 source f`), run code later (`trap 'W=...' ERR`) or name the variable without `NAME=` (`W[0]=x`, `printf
// -vW`, `print -v W`, `set -A W`, `builtin unset W`). Two fail-closed rules, the self-pace decision itself unchanged:
//   (A) no replacement at all when a segment's first word (quotes and backslashes dropped) is a precommand or
//       indirect-execution word below, a VAR_SETTERS word, or not a plain command name (`$B`, `>out`, `2>x`);
//   (B) a name is not replaced when it occurs anywhere else than its one `NAME=` assignment and its `$NAME` /
//       `${NAME}` uses: quoted, as an argument, subscripted, `+=`, in a `${NAME<op>...}` expansion, or glued to an
//       option (`-vW`).
const INDIRECT_FIRST_WORDS = new Set(['builtin', 'command', 'exec', 'noglob', 'nocorrect', '-', 'repeat', 'time', '!',
  'trap', 'alias', 'enable', 'autoload', 'fc', 'emulate', 'zmodload'])
const PLAIN_COMMAND_RX = /^(?:[A-Za-z0-9_./][A-Za-z0-9_./:+@%,-]*|\[)$/
// a redirection in front of the command word (after the NAME=value prefix words): `2>/dev/null x`, `</tmp/p read W`
// (every prefix word ends in \s+, so a run of `a=a=a=...` has ONE way to split: no backtracking blowup)
const LEADING_REDIRECT_RX = /^\s*(?:[A-Za-z_]\w*\+?=(?:'[^']*'|"[^"]*"|\\.|[^\s'"\\])*\s+)*\d*[<>]/
function firstWordBlocks(seg) {
  if (LEADING_REDIRECT_RX.test(String(seg))) return true // the quote-aware reader drops redirections: keep this reading
  // the quote-aware reader, not a split on blanks: `X='a b' source f` is ONE prefix word, then `source`
  const w = shellWords(seg)
  if (w === null) return true // the quoting cannot be followed: fail closed
  let i = 0
  while (i < w.length && /^[A-Za-z_]\w*\+?=/.test(w[i].value)) i++
  if (i >= w.length) return false
  const bare = w[i].value
  if (bare === '') return true
  return INDIRECT_FIRST_WORDS.has(bare) || VAR_SETTERS.has(bare) || !PLAIN_COMMAND_RX.test(bare)
}
// VARDEFDB1121: a NAME can be BUILT from pieces the raw-text rule (B) cannot see:
// `W''T`, `"W"T`, `W\T`, `${n}T`, `$a$b`. So no name is replaced in a command where an identifier character or an
// expansion touches another identifier character or expansion ACROSS a quoting boundary inside one word. A clean word
// (`$W`, `"$W"`, `${W}/x`, `--format='%H'`, `NAME='a b'`) has no such joint; fail-closed otherwise (no replacement).
function hasGluedPieces(src) {
  const ID = /[A-Za-z0-9_]/
  let lastId = false
  let lastPiece = -1
  let piece = 0
  let q = null
  const emit = (isId) => {
    if (isId && lastId && lastPiece !== piece) return true
    lastId = isId
    lastPiece = piece
    return false
  }
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (q === "'") {
      if (c === "'") { q = null; piece++; continue }
      if (emit(ID.test(c))) return true
      continue
    }
    if (c === '\\') {
      piece++
      const n = src[i + 1] ?? ''
      i++
      const bad = emit(ID.test(n) || n === '$')
      piece++
      if (bad) return true
      continue
    }
    if (c === '"') { q = q === '"' ? null : '"'; piece++; continue }
    if (c === "'" && q === null) { q = "'"; piece++; continue }
    if (c === '$') {
      let j = i + 1
      if (src[j] === '{') { const e = src.indexOf('}', j); j = e < 0 ? src.length : e + 1 } else if (ID.test(src[j] ?? '')) { while (j < src.length && ID.test(src[j])) j++ } else j = Math.min(j + 1, src.length)
      piece++
      const bad = emit(true)
      piece++
      i = j - 1
      if (bad) return true
      continue
    }
    if (q === null && /[\s;&|<>()]/.test(c)) { lastId = false; continue }
    if (emit(ID.test(c))) return true
  }
  return false
}
function nameSetIndirectly(src, name) {
  let assigns = 0
  for (const m of src.matchAll(new RegExp(`(?<![A-Za-z0-9_])(-[A-Za-z]*)?${name}(?![A-Za-z0-9_])`, 'g'))) {
    if (m[1]) return true // glued to an option: -vW
    const before = src.slice(0, m.index)
    // a use is exactly `$NAME` or `${NAME}`; any other `${NAME<op>` (zsh `${W::=x}`, `${W:=x}`) may assign
    if (before.endsWith('${')) { if (src[m.index + name.length] === '}') continue; return true }
    if (before.endsWith('$')) continue // a use
    if (src[m.index + name.length] === '=' && /(?:^|[\s;&|])$/.test(before)) { assigns++; continue }
    return true
  }
  return assigns !== 1
}
export function substituteDefiniteCommand(command) {
  const src = String(command ?? '').replace(/\\\r?\n/g, ' ')
  // a command that names IFS may split the value: no replacement at all
  if (/(?<![\w$])IFS(?!\w)/.test(src)) return String(command ?? '')
  // a line continuation joins names (`"$W\<newline>X"` is $WX) and $'...' has its own escapes (`$'\'$W'`): no
  // replacement in such a command at all
  if (/\\\r?\n/.test(String(command ?? '')) || src.includes("$'")) return String(command ?? '')
  const split = protectedSplit(src)
  if (!split.quoteAware) return String(command ?? '')
  if (split.segs.some(firstWordBlocks)) return String(command ?? '') // rule (A)
  if (hasGluedPieces(src)) return String(command ?? '') // a name built from pieces, class level
  const definite = definiteAssignments(split).map((m) => new Map([...m].filter(([n]) => !nameSetIndirectly(src, n))))
  if (!definite.some((m) => m.size)) return String(command ?? '')
  // The replacement is only for the SIMPLE form, by an ALLOWLIST (a blocklist of glob characters misses zsh
  // extendedglob `W#T`, `^X`). Outside quotes only these characters may occur: [A-Za-z0-9_./@%+=,:-], blanks (space,
  // tab, newline), the separators ; & |, a standalone `[` `[[` `]` `]]` word (a test), and a `$` that is a plain
  // `$NAME` / `${NAME}` use of a name replaced here. Inside double quotes only that `$` use is allowed, and no
  // backtick. No redirection `<` `>`: zsh runs an assignment that has only redirections as a prefix of NULLCMD, so in
  // `W=/x &>/dev/null </dev/null; git -C "$W"` W is unset there. Anything else (`#`, `^`, `~`, `!`, `?`, `*`, a
  // backslash, `(`, `$n:u`, `$(..)`, `${W:-x}`, `$1`, another name's use) could build or set the target name, which
  // the text rules cannot see: no replacement at all, the denying behaviour of the unpatched gate.
  const replaced = new Set(definite.flatMap((m) => [...m].filter(([, v]) => DEFINITE_SAFE_VALUE_RX.test(v)).map(([n]) => n)))
  if (!replaced.size) return String(command ?? '')
  const UNCHANGED = String(command ?? '')
  for (let i = 0, q = null; i < src.length; i++) {
    const c = src[i]
    if (q === "'") { if (c === "'") q = null; continue }
    if (c === '"') { q = q === '"' ? null : '"'; continue }
    if (c === "'" && q === null) { q = "'"; continue }
    if (c === '$') {
      const u = /^\$\{([A-Za-z_]\w*)\}|^\$([A-Za-z_]\w*)(?![\w[:])/.exec(src.slice(i))
      if (!u || !replaced.has(u[1] ?? u[2])) return UNCHANGED
      i += u[0].length - 1
      continue
    }
    if (q === '"') {
      if (c === '`') return UNCHANGED
      if (c === '\\') i++ // an escaped character inside double quotes cannot start a name or an expansion of its own here
      continue
    }
    if (/[A-Za-z0-9_./@%+=,: \t\n;&|-]/.test(c)) continue
    if (c === '[' || c === ']') {
      const w = /^(?:\[\[?|\]\]?)(?=[ \t\n;&|]|$)/.exec(src.slice(i))
      if (w && /(?:^|[ \t\n;&|])$/.test(src.slice(0, i))) { i += w[0].length - 1; continue }
    }
    return UNCHANGED
  }
  const bounds = []
  let start = 0
  for (const m of split.masked.matchAll(SEGMENT_SEP_RX)) { bounds.push([start, m.index]); start = m.index + m[0].length }
  bounds.push([start, src.length])
  if (bounds.length !== definite.length) return String(command ?? '')
  let out = ''
  let at = 0
  bounds.forEach(([a, b], k) => {
    const defs = definite[k]
    if (!defs.size) return
    // the quoting is followed here: a single-quoted (or $'...') `$W` is text, a double-quoted one expands
    let q = null
    for (let i = a; i < b; i++) {
      const c = src[i]
      if (q === "'") { if (c === "'") q = null; continue }
      if (c === '\\') { i++; continue }
      if (c === '"') { q = q === '"' ? null : '"'; continue }
      if (c === "'" && q === null) { q = "'"; continue }
      if (c !== '$') continue
      const m = /^\$\{([A-Za-z_]\w*)\}|^\$([A-Za-z_]\w*)(?![\w[:])/.exec(src.slice(i, b))
      if (!m) continue
      const v = defs.get(m[1] ?? m[2])
      if (v == null || !DEFINITE_SAFE_VALUE_RX.test(v)) continue
      out += src.slice(at, i) + v
      at = i + m[0].length
      i = at - 1
    }
  })
  return at === 0 ? String(command ?? '') : out + src.slice(at)
}

function substituteDefinite(text, definite) {
  if (!definite?.size) return text
  return text.replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)(?!\w)/g, (m, a, b) => definite.has(a ?? b) ? definite.get(a ?? b) : m)
}

// Does a native file-tool call target one of the protected store files? By name anywhere
// (fail-closed, as for the allowlist), or by real path, so a symlink under another name does
// not walk past it. `storeDir` is this install's store; tests pass a tmp one.
export function fileToolTargetsProtectedStoreFile(toolInput, storeDir = DEFAULT_STORE_DIR, cwd = process.cwd()) {
  const raw = String(toolInput?.file_path ?? toolInput?.notebook_path ?? '')
  if (!raw) return false
  if (PROTECTED_STORE_FILES.has(basename(raw).toLowerCase()) || AGENT_VENDOR_HOSTS_RX.test(basename(raw))) return true
  const real = realOrSelf(resolve(cwd, expandHome(raw)))
  // AGENTEGRESS1111: a renamed symlink must not bypass the per-agent list protection.
  if (dirname(real) === realOrSelf(storeDir) && AGENT_VENDOR_HOSTS_RX.test(basename(real))) return true
  return [...PROTECTED_STORE_FILES].some((f) => real === realOrSelf(join(storeDir, f)))
}

// The protected names a glob, brace or unresolved word is matched against.
const PROTECTED_GLOB_TARGETS = ['egress-allowlist.json', 'egress-allowlist.history', 'extra-hooks.json', 'local-hooks']
const PROTECTED_FILE_SUFFIX_RX = /\.(?:json|history)$/i
// An expansion this check does not resolve: it stands for any text (`*`).
const UNRESOLVED_EXPANSION_RX = /\$\{[^}]*\}|\$\([^()]*\)|`[^`]*`|\$[A-Za-z_]\w*|\$[0-9@*#?$!-]/g
const UNRESOLVED = '\u0003'
const MAX_ASSIGNMENT_VARIANTS = 8

// The context of one Bash command for protectedMention: the variables it assigns a
// literal to (NAME -> every literal value it gets), the real project root and store dir
// (from the allowlist path, so tests can pass a temp root), and the working directory
// the hook reports (payload cwd), which literal cd segments then move.
export function protectedContext(segs, allowlistPath = DEFAULT_ALLOWLIST_PATH, cwd = null) {
  const assigns = new Map()
  for (const seg of segs) {
    const words = shellWords(seg)
    if (!words || !words.length) continue
    const rest = DECLARE_WORDS.has(words[0].value) ? words.slice(1).filter((w) => !/^-\w+$/.test(w.value)) : words
    for (const w of rest) {
      const m = ASSIGN_RX.exec(w.value)
      if (!m) break // only the leading NAME=value words of a segment assign
      const v = w.value.slice(m[0].length)
      if (w.dollar || /[$`\u0000]/.test(v)) continue // not a literal: stays an unresolved expansion
      const list = assigns.get(m[1]) ?? []
      if (!list.includes(v)) list.push(v)
      assigns.set(m[1], list)
    }
  }
  const store = dirname(allowlistPath)
  // root/store are compared as pathKey()s (real, on-disk case, every nameForms() form):
  // see realDeep and sameKey.
  const start = cwd ? resolve(String(cwd)) : null
  return { assigns, root: pathKey(resolve(store, '..')), store: pathKey(store), cwd: start, cwds: [start] }
}

// The working directory after one segment: a literal `cd DIR` / `pushd DIR` moves it,
// any other cd (no argument is $HOME, `cd -`, an expansion) makes it unknown.
export function cwdAfterSegment(seg, ctx) {
  if (!ctx) return
  const words = shellWords(String(seg ?? '').trim())
  if (!words || !words.length) return
  const name = words[0].value
  if (name !== 'cd' && name !== 'pushd' && name !== 'popd') return
  const arg = words.slice(1).find((w) => !/^-[LPe@]+$/.test(w.value))
  // WRITEGATERELPATH1115: a bare `cd`, and `cd` or `pushd` to `~`, `$HOME` or `${HOME}`, go to the home, unless the command
  // gives HOME a value of its own (then the home is not known here). A bare `pushd` swaps the stack: unknown, below.
  const homeArg = !!arg && (arg.value === '~' || /^\$(?:HOME|\{HOME\})$/.test(arg.value))
  if ((name === 'cd' && !arg) || ((name === 'cd' || name === 'pushd') && homeArg)) {
    ctx.cwd = ctx.homeTouched ? null : homedir()
    return
  }
  // a substitution the parser replaced with its NUL-fenced marker (run-time output) is no known directory either
  if (name === 'popd' || !arg || arg.dollar || /[$`*?[\u0000]/.test(arg.value) || arg.value === '-') { ctx.cwd = null; return }
  // a ~ under a HOME the command set itself is not the real home (EGRESSHOME1106); ~+ / ~- / ~N are the cwd, the
  // previous cwd and the dir stack (Dani 71720), never the home: unknown here
  if ((ctx.homeTouched && arg.value.startsWith('~')) || DIR_TILDE_WORD_RX.test(arg.value)) { ctx.cwd = null; return }
  const target = expandHome(arg.value)
  ctx.cwd = target.startsWith('/') ? resolve(target) : (ctx.cwd ? resolve(ctx.cwd, target) : null)
}

// ~+, ~-, ~N, ~+N, ~-N at a word start, followed by / or the word's end (bash and zsh tilde expansion, Dani 71720)
const DIR_TILDE_RX = /(^|[\s=:'"])~(?:[+-]?\d+|[+-])(?=\/|$|[\s;&|'"])/g
const DIR_TILDE_WORD_RX = /^~(?:[+-]?\d+|[+-])(?:\/|$)/

function substituteAssignments(text, assigns) {
  const used = [...(assigns?.keys() ?? [])].filter((n) => new RegExp(`\\$\\{?${n}(?!\\w)`).test(text))
  if (!used.length) return [text]
  const most = Math.min(MAX_ASSIGNMENT_VARIANTS, Math.max(...used.map((n) => assigns.get(n).length)))
  // the text as written stays in: a name that is ALSO assigned a non-literal keeps its
  // unresolved reading (`*`)
  const out = [text]
  for (let k = 0; k < most; k++) {
    out.push(text.replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (m, a, b) => {
      const list = assigns.get(a ?? b)
      return list ? list[Math.min(k, list.length - 1)] : m
    }))
  }
  return out
}

// Does this text spell a protected name? See "WHAT MENTIONS MEANS" above.
export function protectedMention(text, ctx) {
  // $'...' and $"..." are quotes too; $HOME is the one variable the hook can resolve -- unless the command gives HOME
  // a value of its own (EGRESSHOME1106, Dani 71590): then $HOME, ${HOME} and a leading ~ stay unresolved (any text),
  // since `HOME=.; cp -R x/. $HOME` (or `~`) writes into the cwd, not the real home.
  // A word-start ~+ (= $PWD), ~- (= $OLDPWD), ~N / ~+N / ~-N (the dir stack) is always unresolved: it is the cwd or a
  // directory the gate does not track, so `cp -R x/. ~+` from the root writes into the root (Dani 71720).
  const unquoted = String(text ?? '').replace(/\$(?=['"])/g, '').replace(DIR_TILDE_RX, '$1$PWD')
  const raw = ctx?.homeTouched
    ? unquoted.replace(/(^|[\s=:'"])~(?=\/|$|[\s;&|'"])/g, '$1$HOME')
    : unquoted.replace(/\$\{HOME\}|\$HOME(?!\w)/g, homedir())
  // a variable that is definitely a literal here (definiteAssignments, EGRESSFP1106 (b)) has no unresolved reading
  const src = substituteDefinite(raw, ctx?.definite)
  for (const t of substituteAssignments(src, ctx?.assigns)) {
    if (scheduleSurfaceVariants(t).some(mentionsProtectedName)) return true
    // implicit or `+` concatenation glued, every other quote kept as a word break:
    // ['root', 'local-hoo' 'ks'] -> root , local-hooks (scheduleSurfaceVariants'
    // joined form also glues across the comma, and loses the boundary before the name)
    const glued = decodeEscapes(t).replace(/(['"`])\s*(?:\+\s*)?(['"`])/g, '').replace(/[\\'"`]/g, ' ')
    if (mentionsProtectedName(glued)) return true
    if (protectedPatternWord(t, ctx)) return true
  }
  return false
}

// Programs that create files under a DIRECTORY argument with names of their own (the
// source's name, an archive's or a patch's content). Pointed at the project root or the
// store dir itself, the name they create is not in the command, so the command is read
// as a mention.
const DIR_WRITERS = new Set(['cp', 'mv', 'ln', 'install', 'rsync', 'tar', 'bsdtar', 'gtar', 'unzip', 'cpio', 'patch', 'ditto', '7z', '7za'])

// A curl header argument, `-H "Name: value"`, is a header, never a path, so what its
// value expands to cannot name a protected file. The fleet's documented dashboard call,
// `-H "Authorization: Bearer $(cat store/.dashboard-token)"`, was denied from the project
// root: the substitution stood for any text, and there `*` could be local-hooks. The
// argument POSITION decides, not the file's content (reading the content at gate time
// races a command that rewrites the file before its own substitution runs, review on
// #2495). Only a double-quoted value that opens with a fixed header name, and whose
// expansions are plain variables or a `$(cat PATH)` / `$(< PATH)` read: a substitution
// that runs anything else keeps the whole argument unresolved.
const CURL_HEADER_ARG_RX = /(^|\s)(?:-H|--header)(?:\s+|=)"[A-Za-z][\w-]*:(?:[^"`$\\]|\$\(\s*(?:cat\s+|<\s*)[\w./@+-]+\s*\)|\$\{[A-Za-z_]\w*\}|\$[A-Za-z_]\w*)*"(?=\s|$)/g
function inertCurlHeaders(src) {
  const first = src.trim().split(/\s+/).find((w) => !/^[A-Za-z_]\w*=/.test(w)) ?? ''
  return first.replace(/^.*\//, '') === 'curl' ? src.replace(CURL_HEADER_ARG_RX, '$1-H HEADER') : src
}

// A glob, brace or unresolved word that can expand onto a protected name.
function protectedPatternWord(text, ctx) {
  const src = inertCurlHeaders(String(text).replace(/\\\r?\n/g, '').replace(/\$\{IFS\}|\$IFS\b/g, ''))
  // An unresolved expansion is read as any text. One that STARTS a word may be an
  // absolute path, so that word has no known parent directory.
  const words = src.replace(UNRESOLVED_EXPANSION_RX, UNRESOLVED).replace(/[\\'"]/g, '').split(/[\s;&|<>()]+/).filter(Boolean)
  const cwdReal = ctx?.cwd ? pathKey(ctx.cwd) : null
  const cwdProtected = !!cwdReal && (sameKey(cwdReal, ctx.root) || sameKey(cwdReal, ctx.store))
  // The writer need not be the first word (#3001: it was read as the first non-assignment word). A reserved word (`for ..; do tar .. -C store`,
  // `if ..; then cp x store`, `{ cp x store; }`, `case k in k) cp x store;;`), a wrapper (env, nice, time, timeout, sudo,
  // command, exec, nohup ..) or a runner (xargs, find -exec) puts it later, and the first-word reading let every one of
  // them write a name of its own into the store dir or the root. Read the other way round: a dir writer named ANYWHERE in
  // the segment, with the store dir or the root as an argument, makes the segment a mention. No list of prefixes to keep up
  // to date: an unknown wrapper or runner is on the denying side. A mention is not yet a denial: a segment that a reader
  // leads (`grep -rn install .`) is still a plain read in readOnlyMentionAllowed, unless it redirects onto a target built at
  // runtime, which is the price of this reading.
  if (ctx && words.some((w) => DIR_WRITERS.has(w.replace(/^.*\//, '')))) {
    for (const w of words) {
      const v = w.replace(/^--?[\w-]+=/, '').replace(/^-[A-Za-z](?=[/~.])/, '')
      if (!v || v.startsWith('-') || v.includes(UNRESOLVED) || /[*?[{]/.test(v)) continue
      const abs = v.startsWith('/') || v === '~' || v.startsWith('~/') ? expandHome(v === '~' ? '~/' : v) : (ctx.cwd ? join(ctx.cwd, v) : null)
      if (!abs) continue
      const real = pathKey(resolve(abs))
      if (sameKey(real, ctx.root) || sameKey(real, ctx.store)) return true
    }
  }
  for (const raw of words) {
    // A word that STARTS with an unresolved expansion may be absolute: no known parent,
    // unless the cwd itself is the root or the store dir (then a relative reading counts).
    const unknownStart = raw.startsWith(UNRESOLVED) && !cwdProtected
    const word = raw.replaceAll(UNRESOLVED, '*')
    if (!/[*?[{]/.test(word)) continue
    const exps = /[{}]/.test(word) ? expandBraces(word, BRACE_EXPANSION_CAP) : [word]
    if (!exps) return true // too many expansions to prove harmless: fail closed
    for (const e of exps) {
      if (mentionsProtectedName(` ${e}`)) return true
      if (!/[*?[]/.test(e)) continue
      const home = e === '~' || e.startsWith('~/')
      const abs = unknownStart ? null
        : e.startsWith('/') || home ? expandHome(home && e === '~' ? '~/' : e) : (ctx?.cwd ? join(ctx.cwd, e) : null)
      const segs = normalizePathSegments(abs ?? e)
      for (let i = 0; i < segs.length; i++) {
        if (!/[*?[]/.test(segs[i])) continue
        const above = segs.slice(0, i)
        const parent = abs && i > 0 && !above.some((x) => /[*?[]/.test(x)) ? pathKey(above.join('/') || '/') : null
        // every form of the pattern: the raw one keeps its bracket ranges as written
        for (const seg of nameForms(segs[i])) {
          const literal = seg.replace(/\[[^\]]*\]|[*?]/g, '')
          for (const target of PROTECTED_GLOB_TARGETS) {
            if (!globMatchesName(seg, target)) continue
            const isFile = PROTECTED_FILE_SUFFIX_RX.test(target)
            if (parent && ctx && sameKey(parent, isFile ? ctx.store : ctx.root)) return true
            const stem = (isFile ? literal.replace(PROTECTED_FILE_SUFFIX_RX, '') : literal).replace(/^[.]+|[.]+$/g, '')
            if (stem.length >= 3) return true
          }
        }
      }
    }
  }
  return false
}

export function expandHome(p) {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
}
// The plain JS real path, or the path itself when it does not resolve. Kept for
// fileToolTargetsProtectedStoreFile (c556a35a); the allowlist and extra-hooks checks
// use pathKey below.
function realOrSelf(p) {
  try { return realpathSync(p) } catch { return p }
}

// The real path of `p` even when it does not exist yet (a Write creates it): the deepest
// EXISTING ancestor resolved with realpathSync.native, the rest appended as given. The
// native call returns the on-disk case, so on a case-insensitive volume (macOS APFS
// default) LOCAL-HOOKS/a.py comes back as local-hooks/a.py; the JS realpathSync keeps the
// case it was given, and a missing file has no real path at all (review #2001). A
// dangling symlink is followed to where a write through it would land.
function realDeep(p) {
  const tail = []
  let cur = p
  for (let hops = 0; ; ) {
    try {
      const real = realpathSync.native(cur)
      return tail.length ? join(real, ...tail.reverse()) : real
    } catch {
      try {
        if (hops < 40 && lstatSync(cur).isSymbolicLink()) {
          hops++
          cur = resolve(dirname(cur), readlinkSync(cur))
          continue
        }
      } catch { /* missing: walk up */ }
      const up = dirname(cur)
      if (up === cur) return p
      tail.push(basename(cur))
      cur = up
    }
  }
}
// The key every protected-path comparison uses, in the file-tool AND the Bash branch:
// the nameForms() of the real path. Two keys are the same path if any form matches its
// counterpart (sameKey); a path is under a directory the same way (underKey).
export function pathKey(p) {
  return nameForms(realDeep(p))
}
export function sameKey(a, b) {
  return a.some((f, i) => f === b[i])
}
export function underKey(a, dir) {
  return a.some((f, i) => f === dir[i] || f.startsWith(dir[i] + '/'))
}

// Does a native file-tool call target the allowlist, store/extra-hooks.json or a script
// under local-hooks/? `allowlistPath` is the real file this install's egress-gate reads;
// tests pass a tmp one. EVERY comparison here reads every nameForms() form: the filesystem may
// be case-insensitive (review #2001), and on a case-sensitive one the extra denial is a
// look-alike name a sub-agent has no business writing either.
export function fileToolTargetsAllowlist(toolInput, allowlistPath = DEFAULT_ALLOWLIST_PATH, cwd = process.cwd()) {
  const raw = String(toolInput?.file_path ?? toolInput?.notebook_path ?? '')
  if (!raw) return false
  const forms = nameForms(raw)
  if (forms.some((f) => PROTECTED_BASENAMES.has(basename(f)))) return true
  if (forms.some((f) => /(^|\/)local-hooks(\/|$)/i.test(f))) return true
  const real = pathKey(resolve(cwd, expandHome(raw)))
  if (real.some((f) => PROTECTED_BASENAMES.has(basename(f)))) return true
  if (underKey(real, pathKey(join(dirname(allowlistPath), '..', 'local-hooks')))) return true
  return sameKey(real, pathKey(allowlistPath))
}

// Split a compound command into individual simple commands, so a token in one
// segment cannot trip a check anchored in another (e.g. `cat store && cp a b`).
// Line-continuations (backslash-newline) are collapsed FIRST so a single command
// continued across lines stays ONE segment (this is what keeps the
// tmux\<newline>send-keys vector closed); only real separators split.
//
// KNOWN LIMITATIONS (accepted, defense-in-depth -- the runtime tool-deny is the
// primary guard, this Bash hook is a second layer; a sub-agent is not adversarial
// to its own gate, it just must not casually self-pace):
//   - Not quote-aware: a separator INSIDE quotes (e.g. a commit message
//     `git commit -m "fix; crontab -r"`) splits and could false-deny. Rare
//     enough (the quoted ; must be immediately followed by a blocked binary at a
//     segment start) that a full shell-tokenizer is not warranted here.
//   - A $(...) or backtick substitution that assigns a scheduler result
//     (`X=$(crontab -)`, `X=`crontab -``) is caught by SCHEDULER_RX's boundary
//     anchor, which now includes both `(` and the backtick.
//   - Code piped into a shell (`echo ... | sh`) is not decided.
//   - Code run by another interpreter (`python3 -c`, `node -e`) is not decided.
export function splitSegments(command) {
  return String(command ?? '')
    .replace(/\\\r?\n/g, ' ')
    .split(/&&|\|\||[;&|]|\r?\n/)
    // trim so a leading-separator segment (" at now") anchors at ^ correctly
    .map((s) => s.trim())
}

// Split like splitSegments, but ONLY on separators the shell would actually
// treat as separators -- never on one that sits inside a quoted string or a
// heredoc body. Returns null when the quoting cannot be resolved with
// confidence, and every caller must then fall back to the naive splitter.
//
// WHY THIS EXISTS (measured 2026-08-05, five denials in one morning -- three
// mine, two taric's): splitSegments is not quote-aware, so PROSE can manufacture
// a command position that never existed. All five denials had the same cause: a
// grep pattern quoted inside an inter-agent message,
//   Minta: stop.sh <bar> launchctl <bar> com.janna.dashboard
// The `<bar>` split it, the middle piece trimmed down to the bare word
// `launchctl`, and SCHEDULER_RX's end-of-segment branch reads a bare `launchctl`
// as a real (interactive) invocation -- correctly, for a real command line.
// Nothing was scheduled; five messages simply never went out. From outside, a
// hard-gate denial is indistinguishable from an agent that stayed silent.
//
// The route decided it: the SAME text passes as `curl -d '<json>'` (the payload
// is blanked by stripDataPayloads) and is denied when sent from a python
// heredoc, which has no -d argument to blank. Choosing how to send a message
// had quietly become a security decision. stripDataPayloads' own comment names
// this false-positive class as its target -- it is implemented for exactly one
// route, so the gap is unfinished work, not an oversight.
//
// SCOPE, and this is the part that matters: the result feeds ONLY the anchored
// scheduler check. The unanchored patterns (tmux+send-keys, nohup+claude,
// claude+/loop) keep scanning naive segments, quoted regions included, because
// they do NOT depend on a command position that prose can fake -- and because
// measurement showed the naive scan is what catches a real
// `subprocess.run(['tmux','send-keys',...])` hidden in a heredoc body. Handing
// them quote-aware segments would have removed the detection of the very
// incident vector this gate was built for, under the banner of a structural fix.
//
// FAIL-CLOSED in three places, because "could not parse" must mean "scan more",
// never "scan less":
//   - unterminated quote or heredoc -> null (caller uses the naive split)
//   - a double-quoted region containing $(...) or a backtick -> null; the shell
//     runs what is inside, so a `;` in there IS a real separator
//   - a heredoc with an UNQUOTED tag whose body contains $(...) or a backtick
//     -> null, same reason (an unquoted tag expands the body)
// NOTE ON THE SHAPE OF THIS FIX. The first attempt made the SEGMENTER
// quote-aware and left the regexes alone. It failed one corpus case:
//   echo 'grep: foo <bar> crontab <bar> bar'
// stayed denied, because SCHEDULER_RX carries its OWN boundary anchor
// (SCHED_BOUNDARY includes the bar), so it re-finds a command position INSIDE a
// segment. Keeping the quoted text in the segment at all was the mistake. The
// `launchctl` cases passed only by luck -- LAUNCHCTL_SUBCOMMAND's lookahead
// happened to reject the following bar. So the primitive is not "split more
// carefully", it is "the inert text must not be there": mask it out, then let
// the existing splitter and regexes run unchanged on what remains.
// `heredocs` (optional): when an array is passed, every heredoc the scan resolved
// is pushed onto it as { opStart, bodyStart, bodyEnd, end, quotedTag } in the coordinates
// of the continuation-joined source (which has the same length as the returned
// mask). shellSegments uses it to hand a heredoc body back to the command that
// owns it; the scan itself is unchanged.
// Index of the `)` closing a `$(` whose body starts at `from`, or -1. Quotes
// and nested substitutions inside the body are skipped as bash reads them, so
// `"$(grep -o '"x": "[^"]*"' f)"` closes where bash closes it.
function substEnd(src, from) {
  let depth = 1
  for (let k = from; k < src.length; k++) {
    const c = src[k]
    if (c === '\\') { k++; continue }
    if (c === "'") { const e = src.indexOf("'", k + 1); if (e === -1) return -1; k = e; continue }
    if (c === '"') { const e = dquoteEnd(src, k + 1); if (e === -1) return -1; k = e; continue }
    if (c === '(') depth++
    else if (c === ')' && --depth === 0) return k
  }
  return -1
}
// Index of the `"` closing a double-quoted string whose body starts at `from`.
function dquoteEnd(src, from) {
  for (let k = from; k < src.length; k++) {
    const c = src[k]
    if (c === '\\') { k++; continue }
    if (c === '"') return k
    if (c === '$' && src[k + 1] === '(') { const e = substEnd(src, k + 2); if (e === -1) return -1; k = e; continue }
    if (c === '`') { const e = src.indexOf('`', k + 1); if (e === -1) return -1; k = e; continue }
  }
  return -1
}

export function maskInertLiterals(command, heredocs, lenient = false, comments = null) {
  const src = String(command ?? '').replace(/\\\r?\n/g, ' ')
  let cur = ''
  let i = 0

  // Inert regions collapse to spaces: the text is gone, and with it every
  // separator inside it -- which is precisely what prose was faking.
  const blank = (s) => ' '.repeat(s.length)

  while (i < src.length) {
    const c = src[i]

    // backslash escape outside quotes: consumes the next character
    if (c === '\\' && i + 1 < src.length) { cur += src.slice(i, i + 2); i += 2; continue }

    // heredoc: <<TAG / <<-TAG / <<'TAG' / <<"TAG"
    const here = /^<<-?\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z_]\w*))/.exec(src.slice(i))
    if (here) {
      const tag = here[1] ?? here[2] ?? here[3]
      const quotedTag = here[1] != null || here[2] != null
      const opStart = i
      cur += here[0]
      i += here[0].length
      // the body starts after the rest of THIS line
      const nl = src.indexOf('\n', i)
      if (nl === -1) return null // heredoc announced but no body -> cannot resolve
      cur += src.slice(i, nl + 1)
      i = nl + 1
      // find the terminator line (leading tabs allowed for <<-)
      const endRx = new RegExp(`^[ \\t]*${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*$`, 'm')
      const rel = endRx.exec(src.slice(i))
      if (!rel) return null // unterminated heredoc
      const body = src.slice(i, i + rel.index)
      if (!quotedTag && !lenient && /\$\(|`/.test(body)) return null // unquoted tag expands the body
      cur += blank(body) + rel[0]
      if (Array.isArray(heredocs)) heredocs.push({ opStart, bodyStart: i, bodyEnd: i + rel.index, end: i + rel.index + rel[0].length, quotedTag })
      i += rel.index + rel[0].length
      continue
    }

    if (c === "'") { // literal until the next ' -- a backslash is NOT special here
      const end = src.indexOf("'", i + 1)
      if (end === -1) return null
      cur += blank(src.slice(i, end + 1)); i = end + 1; continue
    }

    if (c === '$' && src[i + 1] === "'") { // ANSI-C: \' does escape
      let j = i + 2
      while (j < src.length && src[j] !== "'") { j += src[j] === '\\' ? 2 : 1 }
      if (j >= src.length) return null
      cur += blank(src.slice(i, j + 1)); i = j + 1; continue
    }

    if (c === '"') {
      let j = i + 1
      if (lenient) { j = dquoteEnd(src, i + 1); if (j === -1) return null } // nested $( ... ) understood
      else while (j < src.length && src[j] !== '"') { j += src[j] === '\\' ? 2 : 1 }
      if (j >= src.length) return null
      const inner = src.slice(i + 1, j)
      if (!lenient && /\$\(|`/.test(inner)) return null // may run a command -> not inert
      cur += blank(src.slice(i, j + 1)); i = j + 1; continue
    }

    // GATECOMMENTQUOTE1104: an unquoted # at a word start comments out the rest of the line. Its text is inert, and a
    // quote character in it must not pair with one on a later line: it did, so a later line read as quoted text and a
    // command there was never judged. A word start is the line start or after whitespace, ; & or | (not after `(`:
    // zsh's `*(#qD)` is a glob qualifier). A comment holding a command substitution or a backtick: not resolved here
    // (null, the caller reads more, not less). `comments` (optional) receives each comment's { start, end }.
    // Dani's review of #2524: after `(` or `)` a # comments out the line in bash and zsh too (a subshell, `$(`), but
    // zsh's EXTENDED_GLOB reads `(#i)...` and `(...)#` as glob syntax: not resolved here (null, the whole command is
    // read). Only a `(` that follows a glob character in the same word stays a qualifier (`*(#qD)`).
    if (c === '#' && i > 0 && (src[i - 1] === ')' || (src[i - 1] === '(' && !/[*?\]]/.test(src[i - 2] ?? '')))) return null
    if (c === '#' && (i === 0 || /[\s;&|]/.test(src[i - 1]))) {
      const nl = src.indexOf('\n', i)
      const end = nl < 0 ? src.length : nl
      const body = src.slice(i, end)
      if (/\$\(|`/.test(body)) return null
      if (Array.isArray(comments)) comments.push({ start: i, end })
      cur += blank(body); i = end; continue
    }

    cur += c; i++
  }
  return cur
}

// Blank out curl/HTTP DATA-PAYLOAD arguments before self-pace matching. A -d /
// --data body is data sent over the wire, NEVER a shell invocation, so a trigger
// token that only appears INSIDE the payload must not false-deny. The classic
// false-positive: an /api/messages inter-agent dispatch (a legit peer message in
// a green, operator-authorised review-loop) whose JSON body happens to mention
// "/api/schedules", "tmux send-keys", "scheduled_tasks.json" or "/loop" -- pure
// text, not an invocation. Only PROVABLY-LITERAL payloads are stripped:
// single-quoted '...', ANSI-C $'...', and double-quoted "..." WITHOUT
// $(...)/backtick. A payload that can run a command substitution (double-quoted
// with $(...) / backticks) is left intact so a real command-substitution payload
// is not blanked. Such a payload is then still denied by SCHEDULER_RX, whose
// boundary anchor recognises both `$(` and the backtick as a command boundary,
// so a scheduler binary inside either substitution form is caught. The data FLAG
// itself is kept, so HTTP-write detection (-d /
// --data) is unchanged; the URL and method args live OUTSIDE the payload, so a
// real WRITE to /api/schedules is still denied.
//
// Quote classes match BASH parsing, not C. Inside a plain '...' a backslash is
// LITERAL and the FIRST following ' always closes the string, so the class is
// '[^']*'. A C-style '(?:[^'\\]|\\.)*' would treat \' as an escaped quote and
// scan PAST bash's real closing quote -- e.g. `curl -d 'x\' ; crontab -r` would
// blank the out-of-band `; crontab -r` and let a real self-pace command slip.
// ANSI-C $'...' DOES process \', so that branch keeps the \\. escape form; "..."
// keeps it too (backslash is special inside bash double quotes).
// Human prose in a command-argument position is DATA, not commands. The heredoc
// fix closed one wrapper; this closes the rest of the family: a PR body, a PR
// comment, a release note. The failure mode is identical -- a sentence like
// "runs at the same time" reads as the `at` scheduler at a segment start, and
// the better the prose, the likelier it contains words like at / cron /
// schedule. Same literal-only rule as the other strippers: a double-quoted
// value with $( or ` may substitute, so it is left alone.
const PROSE_FLAGS = String.raw`--body|--message|--notes|--title|--subject|-b|-m|-t`

export function stripProseArguments(seg) {
  const s = String(seg ?? '')
  // Scoped to the tools these prose flags were written for: gh, git, glab (a PR
  // body, a PR comment, a release note). A short flag means different things to
  // different binaries (`tar -t`, `cut -b`, `sort -t`), so blanking it on an
  // unrelated tool would hide real data from the gate (PR #770 review, Szotasz).
  // Same coarse command-word guard as stripGitCommitMessages just below.
  if (!/\b(?:gh|git|glab)\b/i.test(s)) return s
  return s.replace(
    new RegExp(String.raw`((?:^|\s)(?:${PROSE_FLAGS})(?:\s+|=))('[^']*'|\$'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")`, 'gi'),
    (full, flag, arg) => {
      const dq = arg.startsWith('"')
      if (dq && (arg.includes('$(') || arg.includes('`'))) return full
      return flag + (dq ? '""' : "''")
    },
  )
}

export function stripDataPayloads(seg) {
  return String(seg ?? '').replace(
    /((?:^|\s)(?:-d|--data(?:-(?:raw|binary|ascii|urlencode))?)(?:\s+|=))('[^']*'|\$'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/gi,
    (full, flag, arg) => {
      const dq = arg.startsWith('"')
      if (dq && (arg.includes('$(') || arg.includes('`'))) return full // may substitute -> keep
      return flag + (dq ? '""' : "''") // literal payload -> blank the content
    },
  )
}

// Blank out git commit/tag/stash -m/--message LITERAL text before self-pace
// matching. A commit message is prose, NEVER a shell invocation, so a trigger
// token that only appears INSIDE the message must not false-deny (2026-07-13,
// DrCode: a long `git commit -m "...batch...; at..."` blocked twice, the short
// one passed -- the message text was split as shell segments). Same principle
// and same literal-only quote handling as stripDataPayloads: single-quoted,
// ANSI-C $'...', and double-quoted WITHOUT $(...)/backtick are blanked; a
// double-quoted message that CAN command-substitute (`git commit -m "$(crontab
// -r)"`) is left intact so SCHEDULER_RX still catches the real substitution.
// Scoped to git commit/tag/stash so a `-m` on an unrelated binary is untouched.
// Heredoc bodies are DATA, not commands. A worker writing a real commit message
// through `git commit -F - <<EOF … EOF` had the turn denied because one prose
// line happened to start with "at " -- which SCHEDULER_RX reads as the `at`
// scheduler at a segment start. A heredoc body is data, so blank it before any
// pattern runs. Handles <<- for tab-indented bodies.
//
// EXCEPT when the body can still run something. A QUOTED marker (<<'EOF' or
// <<"EOF") is literal: the shell performs no expansion inside it, so blanking is
// safe. An UNQUOTED marker (<<EOF) is not -- the shell expands $(...) and
// backticks in that body at exec time, so blanking one would hide a live
// command substitution from SCHEDULER_RX and the gate would stop seeing
// something that really runs:
//
//     git commit -m "$(cat <<EOF
//     fix
//     $(at now)
//     EOF
//     )"
//
// This is the same rule the other strippers already apply: stripDataPayloads,
// stripGitCommitMessages and stripProseArguments all leave a double-quoted
// value alone when it contains `$(` or a backtick. An unquoted heredoc is the
// same category; it was simply missing the guard. Reported on PR #770.
// Whether the command word owning a heredoc redirect EXECUTES the body. The
// shell-literal guard above is not enough: a quoted marker (<<'EOF') is literal
// to the SHELL, so blanking looks safe, but `bash <<'EOF'`, `sh`, `ssh box`,
// `python - <<'EOF'` feed the body to an interpreter that runs it -- blanking
// would hide a live scheduler command from the gate (PR #770 review, Szotasz).
// `git commit -F - <<'EOF'` feeds the body to git as DATA, so that stays safe to
// blank. So: keep the body visible when its redirect owner is an interpreter or
// remote/container executor.
const HEREDOC_INTERPRETER_RX = /^(?:bash|sh|zsh|dash|ksh|ash|python[0-9.]*|node|nodejs|ruby|perl|php|ssh)$/

function heredocOwnerRunsBody(before) {
  // `before` is the command text up to the << redirect; the owner is the first
  // word of the last command segment.
  const seg = before.split(/\n|;|\|\|?|&&?|\(|\{/).pop() ?? ''
  const tokens = seg.trim().split(/\s+/).filter(Boolean)
  // Pass-through prefixes that do not change what runs the body.
  while (tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]) ||
    ['sudo', 'env', 'nice', 'time', 'exec', 'command', 'nohup', 'stdbuf'].includes(tokens[0]))) {
    tokens.shift()
  }
  if (!tokens.length) return false
  const word = tokens[0].split('/').pop()
  if (HEREDOC_INTERPRETER_RX.test(word)) return true
  // docker/podman/kubectl exec run the body through a shell in the target.
  if (['docker', 'podman', 'kubectl'].includes(word) && tokens.slice(1).includes('exec')) return true
  return false
}

// The same body reaches an interpreter when the heredoc's OUTPUT is piped into
// one on the operator line: `cat <<'EOF' | bash` runs it like `bash <<'EOF'`.
// `lineRest` is the text after the marker up to the end of that line.
function heredocPipedIntoRunner(lineRest) {
  const pipeline = lineRest.replace(/\|&/g, '|').split(/;|&&|\|\||&/)[0]
  return pipeline.split('|').slice(1).some((stage) => heredocOwnerRunsBody(stage))
}

export function stripHeredocBodies(command) {
  const cmd = String(command ?? '')
  if (!/<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*/.test(cmd)) return cmd
  return cmd.replace(
    /(<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2)([\s\S]*?)(^\s*\3\s*$)/gm,
    (full, open, quote, _marker, body, close, offset, string) => {
      const literal = quote === "'" || quote === '"'
      if (!literal && (body.includes('$(') || body.includes('`'))) return full
      // A quoted body the shell will not expand is still executed when an
      // interpreter/remote-executor owns the redirect -- keep it visible then.
      if (heredocOwnerRunsBody(string.slice(0, offset))) return full
      if (heredocPipedIntoRunner(body.split('\n', 1)[0])) return full
      return `${open}\n${close}`
    },
  )
}

export function stripGitCommitMessages(command) {
  const cmd = String(command ?? '')
  if (!/\bgit\b[\s\S]*\b(commit|tag|stash)\b/i.test(cmd)) return cmd
  return cmd.replace(
    /((?:^|\s)(?:-m|--message)(?:\s+|=))('[^']*'|\$'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/gi,
    (full, flag, arg) => {
      const dq = arg.startsWith('"')
      if (dq && (arg.includes('$(') || arg.includes('`'))) return full // may substitute -> keep
      return flag + (dq ? '""' : "''") // literal message -> blank the content
    },
  )
}

// Normalise two shell-level obfuscations that bash resolves at EXEC time, so an
// invocation whose SHAPE is a real self-pace cannot dodge the slash-command match
// with quoting the shell undoes anyway. Measured end-to-end through the gate hook
// (upstream review, 2026-07-27): `claude \/loop` and `claude$IFS/loop` BOTH run
// `claude /loop` in bash but slipped the `(?:^|[\s'"])\/loop` match -- the char
// before `/loop` was `\` and `S` (end of `$IFS`), neither in the [\s'"] class.
// The fix is NOT to widen that class (that would let more prose through); it is to
// resolve what the shell resolves before matching: `$IFS`/`${IFS}` word-splits to
// a space, and a backslash escape `\X` collapses to `X`. Side effect: also closes
// `claude /lo\op`. Applied ONLY to the self-pace bash patterns below; the
// scheduler/store/API checks keep the raw segment (upstream measured them clean,
// and this PR is scoped to these two loop regressions). This cannot introduce a
// false positive: collapsing escapes / dropping `$IFS` never synthesises the
// literal `tmux`+send-keys, `nohup`+claude, or `claude`+`/loop` tokens out of
// prose -- it only removes an evasion.
export function normalizeShellEvasion(seg) {
  return String(seg ?? '')
    .replace(/\$\{IFS\}|\$IFS\b/g, ' ') // $IFS / ${IFS} -> the space it expands to
    .replace(/\\(.)/g, '$1') // \X -> X (bash unescape of a backslash-escaped char)
}

// ---------------------------------------------------------------------------
// Dashboard schedule surface: the /api/schedules API and the on-disk store it
// writes (~/.claude/scheduled-tasks/).
//
// Measured on a live install: a sub-agent created four schedules with a python
// urllib POST, four times HTTP 200. The per-segment check below this block only
// knew the CURL spelling of a write (-X POST / -d / --data), so every other
// HTTP client -- python urllib/requests, node fetch, wget --post-data, httpie,
// nc -- was a write the gate could not see. Adding those spellings one by one
// is a losing blacklist (miss one client and it is a hole), so this block
// inverts the question:
//
//   1. Does the command REFERENCE the schedule surface at all, in any spelling?
//      (path /api/schedules through any host/port, the scheduled-tasks
//      directory, the schedule-registry-cli tool by name, or an SQL write on
//      a scheduled_task* table; the database file has its own narrower rule,
//      see DASHBOARD_DB_REF_RX; also after the shell's own quote and backslash removal, after
//      \xHH / \uHHHH / octal / %HH decoding, after string concatenation glued to
//      a slash, after brace expansion, and through any glob or bracket segment
//      that could expand onto the store or the route -- see globRefs.)
//   2. If it does, the command is judged by FLAT, fail-closed invariants -- no
//      shell-state modelling (an earlier cwd/shadow-tracking draft had bypasses:
//      cd -/OLDPWD/failed-cd, a function shadowing an allowed name):
//      - ANY cd/pushd/popd whose argument references the store denies the whole
//        command (a sub-agent has no reason to enter the store);
//      - ANY function/alias/shadow definition (name(), function, alias, enable,
//        builtin, command, exec) denies;
//      - a variable that carries a reference may not reach a program's
//        environment (export, declare -x, set -a), and the builtins that
//        assign a variable without a NAME=value word (printf -v, read,
//        mapfile, a nameref) deny;
//      - a command is trusted (below) only by a bare name or an exact system
//        binary path, so `/tmp/cat` and `./curl` do not pass.
//      Then every segment that carries the reference must be one of a few forms
//      that are PROVABLY unable to write it:
//        a. a plain curl GET: `curl -q [-s -S -f -L -i -k -v ...] [-H v] [-m n]
//           URL` -- -q FIRST (no curlrc), no -w/-X/-d/--data*/--json/-F/-T/-K/
//           -o/-D/--url, exactly one URL, a literal http(s):// scheme, no
//           unquoted $ expansion (word splitting can inject -X POST), and
//           header values that cannot carry a line break (curl sends one
//           verbatim, so a smuggled second request could ride along). The one
//           file-content a header may carry is the fleet token file, injected as
//           a NUL nonce that shell source cannot express -- a literal
//           `${DASHBOARD_TOKEN}` (or any surviving $) in a header denies;
//        b. a read-only file command (ls, cat, grep, head, tail, wc, stat, ...;
//           find without -exec/-delete/-fprint) whose output, if piped, only
//           reaches plain text filters -- `cat <<EOF | python3` stays denied;
//        c. a carrier whose reference sits ONLY in literal message data: a curl
//           -d/--data value (or a quoted heredoc fed to --data-binary @-), a git
//           commit/tag/stash -m message (or -F - heredoc), a gh/glab prose
//           argument (--body/--title/--notes/... or a --body-file - heredoc,
//           any subcommand but `api`: the same scope stripProseArguments
//           blanks), the content argument of scripts/agent-msg.sh. The value
//           is identified by PARSING the command's own option grammar, not by
//           a regex over the text, so `curl -H -d 'http://.../api/schedules'`
//           (where the "payload" is the URL) is not mistaken for data.
//      Anything else -- any interpreter, any other client, a redirect, cp/mv/
//      tee, an unknown curl option, quoting that cannot be resolved -- is
//      denied. A segment that does NOT reference the surface is judged exactly
//      as it would be on its own, so a pipe consumer like `| python3 -c ...`
//      after a plain curl GET stays allowed.
//
// What this does NOT close, stated so nobody mistakes it for more:
//   - a script FILE the agent wrote in an EARLIER call (the Write tool, or a
//     Bash call that never mentions the surface) and then runs -- allowed on
//     purpose, since the Write tool can write any file. In the SAME command a
//     heredoc that carries a reference may not be redirected to a file
//     (`cat <<'EOF' > /tmp/x.py ... EOF; python3 /tmp/x.py` is denied);
//   - a list of store paths written to a file in one segment and consumed in
//     another (`ls -d <store>/*/SKILL.md > /tmp/l; while read f; do echo x >>
//     "$f"; done < /tmp/l`): the write segment's path comes from `read`, not
//     from the command text;
//   - a reference assembled at run time (chr(), base64, `$(echo sch)edules`, a
//     variable split across segments, a symlink to the store), or a URL/config
//     taken from the environment;
//   - a curlrc: ~/.curlrc can turn ANY curl, even one with no reference, into a
//     write; only form (a) is protected, by requiring -q;
//   - a cd into the store whose effect PERSISTS to a LATER Bash call, IF Claude
//     Code keeps the cwd across calls (unverified): a per-command gate cannot
//     see the earlier cd. Rule 1 still denies that cd in the command where it
//     appears.
// None of these are provable from a single command's text. They belong to the
// server side (a per-agent dashboard token the schedule routes can refuse) and
// the runner side (a registry the runner checks before it fires a task), both
// separate changes. The gate stays what its header says: a hard stop for the
// casual self-pace, not a sandbox.
// ---------------------------------------------------------------------------

// The route, as the dashboard router resolves it. Up to three intermediate path
// segments are tolerated because the router's URL parser resolves dot segments
// (`/api/./schedules`, `/api/x/../schedules`) onto the same route; a lookalike
// that is not a real route is denied as well, which costs nothing.
// Intermediate segments are NON-empty ({1,64}): with {0,64} a run of slashes
// could be split between the \/+ groups in O(n^4) ways, and a hook that times
// out is a hook that did not block.
const SCHEDULE_API_REF_RX = /api\/+(?:[^\s/]{1,64}\/+){0,3}schedules/i
// The store the schedule runner reads. Matched by NAME, not by the
// ~/.claude/ prefix, on purpose: the same directory is reachable through
// links (the isolated config dirs .claude-config / .channels-config link
// their scheduled-tasks entry to ~/.claude/scheduled-tasks), and the repo's
// scheduled-tasks/ and seed-scheduled-tasks/ are copied INTO it by the dashboard
// start and update.sh. The lookahead keeps files that merely share the prefix
// (scheduled-tasks-io.ts, docs/scheduled-tasks.md) out of it.
const SCHEDULE_DIR_REF_RX = /scheduled-tasks(?![\w-]|\.\w)/i
const SCHEDULE_DIR_NAME = 'scheduled-tasks'
// Directories the store is reachable under (the home config dir and the two
// symlinked config dirs, see SCHEDULE_DIR_REF_RX).
const STORE_PARENTS = ['.claude', '.claude-config', '.channels-config']
// Names a glob or bracket segment is checked against: if it can expand to one
// of them, it is read as that name.
// The registry operator tool (and the module behind it), matched by NAME in
// any path, extension and runner form: it opens the database directly, so a
// task registered through it never passes the dashboard's routes. Only its
// read-only subcommands are accepted (isRegistryCliRead). The lookahead keeps
// test files that share the prefix (schedule-registry-shell-paths.test.ts)
// out of it. The tool may not exist on a given install; the rule does not
// depend on it.
const SCHEDULE_CLI_REF_RX = /schedule-registry(?:-cli)?(?:\.[cm]?[jt]s)?(?![\w.-])/i
const SCHEDULE_CLI_NAMES = ['schedule-registry-cli.js', 'schedule-registry-cli.ts', 'schedule-registry.js', 'schedule-registry.ts']
// An SQL write on a schedule table (scheduled_tasks, scheduled_task_registry,
// ...), whatever program runs it: the sqlite3 CLI, python, node, a heredoc.
const SCHEDULE_SQL_WRITE_RX = /\b(?:insert(?:\s+or\s+\w+)?\s+into|replace\s+into|delete\s+from|update(?:\s+or\s+\w+)?|drop\s+(?:table|trigger|view)(?:\s+if\s+exists)?|alter\s+table|create\s+(?:temp\w*\s+)?(?:table|view)(?:\s+if\s+not\s+exists)?)\s+(?:\w+\.)?scheduled_task|\bcreate\s+(?:temp\w*\s+)?trigger\b[\s\S]{0,300}?\bon\s+(?:\w+\.)?scheduled_task/i
// The dashboard's SECURITY tables (APPROVALDBGATE1030): approvals and their
// audit trail, the login sessions and users, the device keys, the SSH vault.
// Used by scripts/hooks/db-write-gate.mjs through scheduleSurfaceDeny's
// `surface: 'security'` mode, for every agent including the main one.
// approval_slack_posts (APPROVALSLACK1030 (2)): the posted Slack request the server checks the owner's reaction
// against; an agent that could write it could point a request at a message it controls.
// agent_create_specs (AGENTCREATEPR2-1119): the spec an agent_create approval is bound to; an agent that could write
// it could swap the agent the owner approved for another one, or mark a spec consumed so it never runs.
// support_consents and support_password_state (SUPPORTKULCS1109, D5): the owner's consent to support access, with
// how and why it ended, and the support password bucket. An agent that could write them could forge or erase the
// trail of an enabling, or lift the lock that stands in front of enabling.
// approver_scopes (DELEGAPPROVER1123): what a delegated human approver may decide; an agent that could write it could
// widen an approver's reach to its own requests.
// custom_commands (CHANINBOUNDFORGE1125): the owner's custom slash commands. A prompt command's body is queued as the
// channel coordinator (custom-commands.ts sendPrompt), so an agent that could rewrite a body would speak in the owner's
// voice the next time the owner runs that command. The dashboard's owner-gated CRUD is the only writer.
export const SECURITY_TABLES = ['approvals', 'approval_events', 'approval_slack_posts', 'approval_teams_cards', 'approval_gromzo_posts', 'agent_create_specs', 'auth_sessions', 'colleague_sessions', 'dashboard_users', 'device_keys', 'vault_ssh_keys', 'support_consents', 'support_password_state', 'approver_scopes', 'custom_commands']
// An SQL write on one of them. The table name is read wherever the statement
// names its target: after a schema prefix (`main.approvals`, an ATTACHed
// `x.approvals`), in [brackets], with SQL comments or line breaks between the
// words (`UPDATE/**/approvals`), inside a CTE (`WITH .. UPDATE approvals`), as
// the target of an UPSERT, and in a trigger's body or ON clause (a trigger on
// another table that writes this one, or a trigger on this one). Quoted names
// ("approvals", `approvals`) are matched on the unquoted variant.
const SQL_GAP = String.raw`(?:\s|/\*(?:[^*]|\*(?!/))*\*/|--[^\n]*\n)`
// A schema-table name (sqlite_master and its aliases), also the target of a
// write: with PRAGMA writable_schema a statement can rename a security table
// in the schema, write it under the new name and rename it back, never spelling
// it (Dani 56276, measured on a throwaway database). So writable_schema in any
// form and any write on a schema table are denied as well.
export const SCHEMA_TABLES = ['sqlite_master', 'sqlite_schema', 'sqlite_temp_master', 'sqlite_temp_schema']
const sqlIdent = (names) => String.raw`(?:\[?\w+\]?${SQL_GAP}*\.${SQL_GAP}*)?\[?(?:${names.join('|')})\]?(?![\w$])`
const SQL_IDENT = sqlIdent([...SECURITY_TABLES, ...SCHEMA_TABLES])
const SQL_WRITE_HEADS = [
  String.raw`insert(?:${SQL_GAP}+or${SQL_GAP}+\w+)?${SQL_GAP}+into`,
  String.raw`replace${SQL_GAP}+into`,
  String.raw`delete${SQL_GAP}+from`,
  String.raw`update(?:${SQL_GAP}+or${SQL_GAP}+\w+)?`,
  String.raw`drop${SQL_GAP}+(?:table|trigger|view|index)(?:${SQL_GAP}+if${SQL_GAP}+exists)?`,
  String.raw`alter${SQL_GAP}+table`,
  String.raw`create${SQL_GAP}+(?:temp\w*${SQL_GAP}+)?(?:table|view)(?:${SQL_GAP}+if${SQL_GAP}+not${SQL_GAP}+exists)?`,
]
export const SECURITY_SQL_WRITE_RX = new RegExp(
  String.raw`\b(?:${SQL_WRITE_HEADS.join('|')})${SQL_GAP}+${SQL_IDENT}` +
  String.raw`|\bcreate${SQL_GAP}+(?:(?:temp\w*|unique)${SQL_GAP}+)?(?:trigger|index)\b[\s\S]{0,300}?\bon${SQL_GAP}+${SQL_IDENT}` +
  String.raw`|\bpragma${SQL_GAP}+(?:\[?\w+\]?${SQL_GAP}*\.${SQL_GAP}*)?\[?writable_schema\b`,
  'i',
)

// CHANINBOUNDFORGE1125: agent_messages stays writable (agents mark their queue rows done, and the skills do), but not
// in the ways that forge who is speaking. The message router frames a row as the owner speaking (channel-inbound) or
// as a system directive by its from_agent column ALONE (message-router.ts classifyAgentMessage; the directive check
// reads the row's from_agent), and it honours stop_authorized / urgent / priority / affects_current_work as stored.
// /api/messages refuses those senders and those flags to the shared token; a direct SQL write skipped all of that.
// So, on agent_messages:
//   - INSERT / REPLACE: only `INTO agent_messages (<columns>) VALUES (<literals>)[, (...)]`, no flag column, and
//     every row's from_agent a plain quoted literal naming a sender the API would also take from the shared token:
//     the main agent or an existing agents/<id>/ directory, never a reserved sender. Anything the gate cannot read
//     (no column list, INSERT .. SELECT, a parameter, a shell or f-string expansion, concatenation, an UPSERT)
//     is denied.
//   - UPDATE: never from_agent or a flag column; content or to_agent only with a WHERE pinned to one plain,
//     allowed from_agent literal (your own pending row, the interagent-queue-lag skill's recipe), no OR, no subquery.
//     A status / result / timestamp update stays free.
//   - no DROP / ALTER / CREATE TABLE|VIEW, no trigger or index on it, no trigger that writes it.
// THE LIMIT, as for the security tables: a text-based brake, not an OS boundary; a program that builds the statement
// at run time passes. The real lock is a server-side mark on the row (HMACINBOUND1125, decided separately).
// Reserved senders: the message layer's reserved ids (sanitize.ts MESSAGE_LAYER_RESERVED_AGENT_IDS), the voice
// channel's default id and the one this install's .env names (VOICE_CHANNEL_ID). A NEW owner-voice sender (the
// planned companion id, FIGURAKULCS1125) is reserved there too, and agent-messages-forge.test.ts fails until it
// is listed here as well.
export const AGENT_MESSAGES_RESERVED_SENDERS = ['system', 'heartbeat', 'telegram-coordinator', 'channel-coordinator', 'hanna']
const AGENT_MESSAGES_FLAG_COLUMNS = new Set(['stop_authorized', 'urgent', 'priority', 'affects_current_work'])
const AM_IDENT = sqlIdent(['agent_messages'])
const AM_ROW_WRITE_RX = new RegExp(
  String.raw`\b(?:insert(?:${SQL_GAP}+or${SQL_GAP}+\w+)?${SQL_GAP}+into|replace${SQL_GAP}+into|update(?:${SQL_GAP}+or${SQL_GAP}+\w+)?)${SQL_GAP}+${AM_IDENT}`,
  'gi',
)
const AM_SCHEMA_WRITE_RX = new RegExp(
  String.raw`\b(?:drop${SQL_GAP}+(?:table|view)(?:${SQL_GAP}+if${SQL_GAP}+exists)?|alter${SQL_GAP}+table|create${SQL_GAP}+(?:temp\w*${SQL_GAP}+)?(?:table|view)(?:${SQL_GAP}+if${SQL_GAP}+not${SQL_GAP}+exists)?)${SQL_GAP}+${AM_IDENT}` +
  String.raw`|\bcreate${SQL_GAP}+(?:(?:temp\w*|unique)${SQL_GAP}+)?(?:trigger|index)\b[\s\S]{0,300}?\bon${SQL_GAP}+${AM_IDENT}` +
  String.raw`|\bcreate${SQL_GAP}+(?:temp\w*${SQL_GAP}+)?trigger\b[\s\S]*?\b(?:insert|replace|update)\b[\s\S]{0,60}?${AM_IDENT}`,
  'i',
)

/** The statement that starts at `i`: up to a `;` or a `"` outside a single-quoted SQL literal, or the end. */
function sqlStatementAt(text, i) {
  let inLit = false
  for (let j = i; j < text.length; j++) {
    const c = text[j]
    if (inLit) {
      if (c === "'") {
        if (text[j + 1] === "'") { j++; continue }
        inLit = false
      }
      continue
    }
    if (c === "'") inLit = true
    else if (c === ';' || c === '"') return text.slice(i, j)
  }
  return inLit ? null : text.slice(i)
}

/** Split on top-level commas (outside quotes and parentheses); null when the quotes or parentheses do not balance. */
function splitTopLevel(s) {
  const out = []
  let depth = 0
  let inLit = false
  let last = 0
  for (let j = 0; j < s.length; j++) {
    const c = s[j]
    if (inLit) {
      if (c === "'") { if (s[j + 1] === "'") { j++; continue } inLit = false }
      continue
    }
    if (c === "'") inLit = true
    else if (c === '(') depth++
    else if (c === ')') { if (--depth < 0) return null }
    else if (c === ',' && depth === 0) { out.push(s.slice(last, j)); last = j + 1 }
  }
  if (inLit || depth !== 0) return null
  out.push(s.slice(last))
  return out
}

const sqlColumnName = (c) => c.trim().replace(/^["`[]|["`\]]$/g, '').toLowerCase()

/** The senders this install allows by SQL: the main agent and existing agent directories, never a reserved id. */
function agentMessagesSenderOk(id, root) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return false
  const env = root ? readEnvFileValues(join(root, '.env')) : {}
  const reserved = new Set(AGENT_MESSAGES_RESERVED_SENDERS)
  if (env.VOICE_CHANNEL_ID) reserved.add(env.VOICE_CHANNEL_ID.trim().toLowerCase())
  if (reserved.has(id.toLowerCase())) return false
  if (id === (env.MAIN_AGENT_ID?.trim() || 'marveen')) return true
  if (!root) return false
  try { return lstatSync(join(root, 'agents', id)).isDirectory() } catch { return false }
}

function readEnvFileValues(path) {
  const out = {}
  let raw = ''
  try { raw = readFileSync(path, 'utf8') } catch { return out }
  for (const line of raw.split('\n')) {
    const m = /^\s*(MAIN_AGENT_ID|VOICE_CHANNEL_ID)\s*=\s*(.*)$/.exec(line)
    if (m) out[m[1]] = m[2].replace(/^["']|["']\s*$/g, '').trim()
  }
  return out
}

const PLAIN_SENDER_LITERAL_RX = /^'([A-Za-z0-9_-]{1,64})'$/

/** INSERT / REPLACE INTO agent_messages: true when it could forge the sender or a flag (or cannot be read). */
function agentMessagesInsertForges(stmt, root) {
  const head = new RegExp(String.raw`^(?:insert(?:${SQL_GAP}+or${SQL_GAP}+\w+)?${SQL_GAP}+into|replace${SQL_GAP}+into)${SQL_GAP}+${AM_IDENT}${SQL_GAP}*\(([^()]*)\)${SQL_GAP}*values${SQL_GAP}*`, 'i').exec(stmt)
  if (!head) return true // no column list, INSERT .. SELECT, DEFAULT VALUES, or unreadable
  const cols = head[1].split(',').map(sqlColumnName)
  if (cols.some((c) => AGENT_MESSAGES_FLAG_COLUMNS.has(c))) return true
  const fromAt = cols.indexOf('from_agent')
  if (fromAt < 0) return true
  let rest = stmt.slice(head[0].length)
  let rows = 0
  while (rest.length) {
    if (rest[0] !== '(') return true
    let depth = 0
    let inLit = false
    let end = -1
    for (let j = 0; j < rest.length; j++) {
      const c = rest[j]
      if (inLit) { if (c === "'") { if (rest[j + 1] === "'") { j++; continue } inLit = false } continue }
      if (c === "'") inLit = true
      else if (c === '(') depth++
      else if (c === ')' && --depth === 0) { end = j; break }
    }
    if (end < 0) return true
    const vals = splitTopLevel(rest.slice(1, end))
    if (!vals || vals.length !== cols.length) return true
    const sender = PLAIN_SENDER_LITERAL_RX.exec(vals[fromAt].trim())
    if (!sender || !agentMessagesSenderOk(sender[1], root)) return true
    rows++
    rest = rest.slice(end + 1).replace(new RegExp(`^${SQL_GAP}*`), '')
    if (rest.startsWith(',')) { rest = rest.slice(1).replace(new RegExp(`^${SQL_GAP}*`), ''); continue }
    break
  }
  // nothing may follow the rows: an UPSERT (ON CONFLICT .. DO UPDATE SET from_agent ..) or anything unread
  return rows === 0 || rest.trim() !== ''
}

/** UPDATE agent_messages: true when it could forge the sender, a flag, or rewrite another sender's row. */
function agentMessagesUpdateForges(stmt, root) {
  const head = new RegExp(String.raw`^update(?:${SQL_GAP}+or${SQL_GAP}+\w+)?${SQL_GAP}+${AM_IDENT}${SQL_GAP}+set${SQL_GAP}+`, 'i').exec(stmt)
  if (!head) return true
  const body = stmt.slice(head[0].length)
  if (body.trimStart().startsWith('(')) return true // SET (a, b) = (...): row-value assignment, not read
  // the first top-level WHERE (outside literals) ends the SET list
  let whereAt = -1
  let inLit = false
  for (let j = 0; j < body.length; j++) {
    const c = body[j]
    if (inLit) { if (c === "'") { if (body[j + 1] === "'") { j++; continue } inLit = false } continue }
    if (c === "'") { inLit = true; continue }
    if (/\s/.test(c) && /^\swhere\b/i.test(body.slice(j))) { whereAt = j; break }
  }
  const setPart = whereAt < 0 ? body : body.slice(0, whereAt)
  const wherePart = whereAt < 0 ? '' : body.slice(whereAt).replace(/^\s*where\b/i, '')
  if (/\bfrom\b/i.test(setPart.replace(/'(?:[^']|'')*'/g, "''"))) return true // UPDATE .. FROM
  const assigns = splitTopLevel(setPart)
  if (!assigns) return true
  const cols = []
  for (const a of assigns) {
    const m = /^\s*(\[?["`]?\w+["`]?\]?)\s*=/.exec(a)
    if (!m) return true
    cols.push(sqlColumnName(m[1]))
  }
  if (cols.some((c) => c === 'from_agent' || AGENT_MESSAGES_FLAG_COLUMNS.has(c))) return true
  if (cols.some((c) => c === 'content' || c === 'to_agent')) {
    const bare = wherePart.replace(/'(?:[^']|'')*'/g, "''")
    if (/\bor\b|\bselect\b|\bnot\b/i.test(bare)) return true
    const pins = [...wherePart.matchAll(/(?<![<>!=\w])\[?["`]?from_agent["`]?\]?\s*==?\s*('[^']*')/gi)]
    if (pins.length !== 1) return true
    const sender = PLAIN_SENDER_LITERAL_RX.exec(pins[0][1])
    if (!sender || !agentMessagesSenderOk(sender[1], root)) return true
  }
  return false
}

/**
 * CHANINBOUNDFORGE1125: does this text write agent_messages in a way that could forge the sender or a delivery flag?
 * Read on the escape-decoded text WITH its quotes (the SQL literals are the evidence); a statement the gate cannot
 * read is a forge (fail closed).
 */
export function agentMessagesForgeWrite(text, opts = {}) {
  const joined = String(text ?? '').replace(/\\\r?\n/g, '')
  const decoded = decodeEscapes(decodeEscapes(joined))
  // cheap pre-test, so the hook pays nothing for the many texts that never name the table: the decoded text, and the
  // same with shell quoting removed (a name split by quotes, "agent_""messages", closes up there)
  const closed = decoded.replace(/\$\{IFS\}|\$IFS\b/g, '').replace(/[\\'"`]/g, '')
  if (!/agent_messages/i.test(decoded) && !/agent_messages/i.test(closed)) return false
  const vs = scheduleSurfaceVariants(text)
  for (const v of [decoded, ...vs]) if (AM_SCHEMA_WRITE_RX.test(v)) return true
  const root = opts.projectRoot ?? null
  for (const m of decoded.matchAll(AM_ROW_WRITE_RX)) {
    const stmt = sqlStatementAt(decoded, m.index)
    if (stmt === null) return true
    const forges = /^update/i.test(m[0]) ? agentMessagesUpdateForges(stmt, root) : agentMessagesInsertForges(stmt, root)
    if (forges) return true
  }
  // a write the decoded text hides (quotes or escapes split the keywords) but an unquoted variant shows: unreadable
  const shown = (s) => (s.match(AM_ROW_WRITE_RX) ?? []).length
  const seen = shown(decoded)
  return vs.some((v) => shown(v) > seen)
}

// The dashboard database file (and its WAL/SHM/journal). Reads by any program
// stay allowed (a worker reads the board with sqlite3 SELECT); a FILE-level
// write -- a redirect onto it, cp/mv/tee/dd/rm/ln/... naming it, or a sqlite3
// dot-command that replaces or runs files -- is denied (dbSegmentWrites).
const DASHBOARD_DB_REF_RX = /claudeclaw\.db(?:-wal|-shm|-journal)?(?![\w.-])/i
const GLOB_TARGETS = [SCHEDULE_DIR_NAME, 'schedules', 'api', ...STORE_PARENTS, ...SCHEDULE_CLI_NAMES, 'claudeclaw.db']
const FILE_GLOB_TARGETS = new Set([...SCHEDULE_CLI_NAMES, 'claudeclaw.db'])
// Brace expansion is enumerated up to this many words; beyond it, a word that
// could still spell a reference is treated as one (fail closed).
const BRACE_EXPANSION_CAP = 1024

function codePoint(n) {
  try { return String.fromCodePoint(n) } catch { return '' }
}

// Escapes that a shell (printf/echo -e/$'...') or the interpreter the command
// runs (python, node, perl) resolves before the text becomes a URL or a path.
function decodeEscapes(s) {
  return s
    .replace(/\\x([0-9a-f]{2})/gi, (_, h) => codePoint(parseInt(h, 16)))
    .replace(/\\u\{([0-9a-f]{1,6})\}/gi, (_, h) => codePoint(parseInt(h, 16)))
    .replace(/\\u([0-9a-f]{4})/gi, (_, h) => codePoint(parseInt(h, 16)))
    .replace(/\\([0-7]{3})/g, (_, o) => codePoint(parseInt(o, 8)))
    .replace(/%([0-9a-f]{2})/gi, (_, h) => codePoint(parseInt(h, 16)))
}

// Spellings of the same text that the matchers run against. Each one can only
// ADD matches (it removes or decodes characters), so it can never let a
// reference through that the raw text would have caught.
export function scheduleSurfaceVariants(text) {
  const joined = String(text ?? '').replace(/\\\r?\n/g, '')
  const decoded = decodeEscapes(decodeEscapes(joined)) // twice: %5cx73 -> \x73 -> s
  // quotes, backslashes and $IFS are shell syntax: gone before the program runs
  const unquoted = decoded.replace(/\$\{IFS\}|\$IFS\b/g, '').replace(/[\\'"`]/g, '')
  // string concatenation in any language ('/api/' + 'schedules', "/api/"."x",
  // implicit "a" "b", ','.join): separators glued to a slash disappear...
  // (the lookbehind starts a match only at the beginning of a separator run, so
  // a long run with no slash is scanned once, not once per character)
  const glued = unquoted.replace(/(?<![\s+,.])[\s+,.]*\/[\s+,.]*/g, '/')
  // ...and a literal split mid-word ('sch' + 'edules', "sch"."edules") closes up
  const joinedLiterals = decoded.replace(/(['"`])\s*(?:[+.,]\s*)?(['"`])/g, '')
    .replace(/\$\{IFS\}|\$IFS\b/g, '').replace(/[\\'"`]/g, '')
  return [joined, unquoted, glued, joinedLiterals]
}

// A bracket class whose range runs backwards (`[x-1]`, as in the Python index `row[x-1000]`) is a SyntaxError for a JS
// RegExp, which the catch in globMatchesName read as "unreadable glob: matches everything": a read-only measuring script
// (python heredoc, `lum[y-1000]`) was denied as an egress-allowlist write (kodolo2, 2026-11-19). bash and dash expand a
// reversed range to nothing (measured), so it names no file. The retry reads such a range as the SWAPPED one (`1-x`),
// a superset of every plausible reading (nothing, the two endpoints, the span between them), so it still matches
// whatever any shell could. A NEGATED class (`[!x-1]`) is left as it was: swapping would shrink the set it excludes, so
// it stays unreadable and fail-closed.
function globToRegexSource(glob, swapReversed) {
  let rx = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') rx += '.*'
    else if (c === '?') rx += '.'
    else if (c === '[') {
      const j = glob.indexOf(']', i + 1)
      if (j === -1) { rx += '\\['; continue }
      let body = glob.slice(i + 1, j)
      if (swapReversed && !body.startsWith('!') && !body.includes('\\')) body = body.replace(/(.)-(.)/gs, (m, a, b) => (a > b ? `${b}-${a}` : m))
      rx += '[' + body.replace(/^!/, '^').replace(/\\/g, '\\\\') + ']'
      i = j
    } else rx += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return rx
}
export function globMatchesName(glob, name) {
  try { return new RegExp(`^${globToRegexSource(glob, false)}$`, 'i').test(name) } catch { /* retry below */ }
  try { return new RegExp(`^${globToRegexSource(glob, true)}$`, 'i').test(name) } catch { return true } // unreadable glob: fail closed
}

// Bash brace expansion of one word: `api/sch{e,}dules` -> [api/schedules,
// api/schdules]; `{a..c}` sequences too. Returns null past `cap` words. `${`
// is a parameter expansion, not a brace group, and is left alone.
function findBraceGroup(w) {
  for (let i = 0; i < w.length; i++) {
    if (w[i] !== '{' || w[i - 1] === '$') continue
    let depth = 0
    let last = i + 1
    const parts = []
    for (let j = i; j < w.length; j++) {
      if (w[j] === '{') depth++
      else if (w[j] === ',' && depth === 1) { parts.push(w.slice(last, j)); last = j + 1 }
      else if (w[j] === '}' && --depth === 0) {
        parts.push(w.slice(last, j))
        if (parts.length > 1) return { start: i, end: j, alts: parts }
        const seq = /^(-?\d+|[a-zA-Z])\.\.(-?\d+|[a-zA-Z])$/.exec(parts[0])
        if (!seq) break
        const num = /^-?\d+$/.test(seq[1]) && /^-?\d+$/.test(seq[2])
        const [a, b] = num ? [Number(seq[1]), Number(seq[2])] : [seq[1].charCodeAt(0), seq[2].charCodeAt(0)]
        if (!num && /^-?\d+$/.test(seq[1]) !== /^-?\d+$/.test(seq[2])) break
        if (Math.abs(b - a) > BRACE_EXPANSION_CAP) return { start: i, end: j, alts: null }
        const alts = []
        for (let k = a; a <= b ? k <= b : k >= b; k += a <= b ? 1 : -1) alts.push(num ? String(k) : String.fromCharCode(k))
        return { start: i, end: j, alts }
      }
    }
  }
  return null
}
export function expandBraces(word, cap) {
  const out = []
  const todo = [word]
  while (todo.length) {
    const w = todo.pop()
    const g = findBraceGroup(w)
    if (!g) { out.push(w); continue }
    if (!g.alts) return null
    for (const alt of g.alts) todo.push(w.slice(0, g.start) + alt + w.slice(g.end + 1))
    if (todo.length + out.length > cap) return null
  }
  return out
}

// Is `needle` a subsequence of `hay`? Every brace expansion of a word is a
// subsequence of that word with `{`, `}` and `,` removed, so a word that fails
// this for every target cannot expand to a reference -- no enumeration needed.
function isSubsequence(needle, hay) {
  let i = 0
  for (let j = 0; j < hay.length && i < needle.length; j++) if (hay[j] === needle[i]) i++
  return i === needle.length
}

// Shell words of `text` with a per-character quoted flag: [[{ c, q }]]. Heredoc
// bodies are dropped (they are data for the program that reads them, never
// expanded as words). A command substitution inside double quotes, $(...) or
// `...`, is a fresh unquoted context in bash, so its text is scanned again as
// words of its own. Returns null when the quoting cannot be resolved.
export function quotedWords(text, depth = 0) {
  if (depth > 8) return null
  const src = String(text ?? '').replace(/\\\r?\n/g, ' ')
  const heredocs = []
  if (maskInertLiterals(src, heredocs, true) == null) return null
  let s = src
  for (const h of heredocs) s = s.slice(0, h.bodyStart) + ' '.repeat(h.end - h.bodyStart) + s.slice(h.end)
  const words = []
  let cur = []
  const flush = () => { if (cur.length) words.push(cur); cur = [] }
  const inner = (from, close) => (close === '`' ? s.indexOf('`', from) : substEnd(s, from))
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === "'") {
      const e = s.indexOf("'", i + 1)
      if (e === -1) return null
      for (const ch of s.slice(i + 1, e)) cur.push({ c: ch, q: true })
      i = e; continue
    }
    if (c === '"') {
      let j = i + 1
      for (; j < s.length && s[j] !== '"'; j++) {
        if (s[j] === '\\' && j + 1 < s.length) { j++; cur.push({ c: s[j], q: true }); continue }
        const sub = s[j] === '`' ? '`' : (s[j] === '$' && s[j + 1] === '(' ? ')' : '')
        if (sub) {
          const from = j + (sub === '`' ? 1 : 2)
          const e = inner(from, sub)
          if (e === -1) return null
          const nested = quotedWords(s.slice(from, e), depth + 1)
          if (nested == null) return null
          words.push(...nested)
          cur.push({ c: '\u0002', q: true }) // the substituted output: unknown, literal
          j = e; continue
        }
        cur.push({ c: s[j], q: true })
      }
      if (j >= s.length) return null
      i = j; continue
    }
    if (c === '\\' && i + 1 < s.length) { cur.push({ c: s[i + 1], q: true }); i++; continue }
    if (/\s/.test(c) || ';&|<>()`'.includes(c)) { flush(); continue }
    cur.push({ c, q: false })
  }
  flush()
  return words
}

// Words the shell (brace expansion, pathname globbing) or curl (URL globbing:
// {a,b} and [a-z], even inside quotes) turns into OTHER words. Each is expanded
// and every glob or bracket segment is read as the target name it can match, so
// `api/sch{e,}dules`, `api/sch[e]dules`, `~/.c*/sch*`, `.channels-config/sched*`
// and `cd sched*` all count. Only UNQUOTED metacharacters count -- bash expands
// nothing inside quotes, and a python regex like '[a-z]*' is not a path --
// except in a URL word, where curl globs quoted text too. A pure `*` segment
// only counts under a store parent (`~/.claude/*`, or after a cd into one:
// opts.parentCtx), otherwise every `ls src/*` would. A bracket segment counts
// on ANY match: rare in paths, and it fails closed.
const NEUTRAL = '\u0002' // stands in for a quoted metacharacter: literal, matches no target
function globRefs(text, opts) {
  const out = { api: false, dir: false, cli: false, db: false }
  const words = quotedWords(text)
  const list = words
    ? words.map((w) => {
      // a real URL (scheme://host...): curl globs {a,b} and [x-y] in it even
      // when quoted. A grep pattern like 'https\?://[^ ]*' is not one.
      const url = /^[a-z][a-z0-9+.-]*:\/\/[a-z0-9.\-[\]:$]+(?:\/|$)/i.test(w.map((x) => x.c).join(''))
      return w.map((x) => (x.q && '*?[]{},'.includes(x.c) && !(url && '[]{},'.includes(x.c)) ? NEUTRAL : x.c)).join('')
    })
    : scheduleSurfaceVariants(text)[1].split(/[\s;&|<>()]+/) // unresolvable quoting: read every metachar (fail closed)
  for (const raw of list) {
    const word = raw.replace(/[\\'"`]/g, '')
    if (!/[*?[\]{}]/.test(word)) continue
    const flat = word.replace(/[{},]/g, '').toLowerCase()
    // a glob character can stand for any letters, so then always enumerate
    const mayBrace = /[*?[]/.test(word) || ['schedules', 'scheduled-tasks', 'schedule-registry', 'claudeclaw.db'].some((t) => isSubsequence(t, flat))
    const exps = /[{}]/.test(word) ? (mayBrace ? expandBraces(word, BRACE_EXPANSION_CAP) : [word.replace(/[{}]/g, '')]) : [word]
    if (!exps) return { api: true, dir: true, cli: true, db: true } // too many expansions to prove harmless
    for (const e of exps) {
      if (SCHEDULE_API_REF_RX.test(e)) out.api = true
      if (SCHEDULE_DIR_REF_RX.test(e)) out.dir = true
      const segs = normalizePathSegments(e)
      const mapped = segs.map((seg, i) => {
        if (!/[*?[]/.test(seg)) return seg
        const bracket = /\[[^\]]*\]/.test(seg)
        const literal = seg.replace(/\[[^\]]*\]|[*?]/g, '').length
        // the parent segment must name a store parent with some literal text
        // (`.claude`, `.c*`): a bare `*/*` is not evidence of anything
        const prev = segs[i - 1] ?? ''
        const parent = i > 0
          ? prev.replace(/\[[^\]]*\]|[*?]/g, '').length >= 2 && STORE_PARENTS.some((p) => globMatchesName(prev, p))
          : !!opts?.parentCtx
        // a file name target needs literal text beyond its extension: `*.ts`
        // or `*.db` alone is every such file, not evidence of this one
        const stem = seg.replace(/\.[cm]?[jt]s$|\.db$/i, '').replace(/\[[^\]]*\]|[*?]/g, '').length
        for (const name of GLOB_TARGETS) {
          if (!globMatchesName(seg, name)) continue
          if (FILE_GLOB_TARGETS.has(name) && !bracket && stem < 3) continue
          if (bracket || literal >= 3 || (name === SCHEDULE_DIR_NAME && parent)) return name
        }
        return seg
      }).join('/')
      if (SCHEDULE_API_REF_RX.test(mapped)) out.api = true
      if (SCHEDULE_DIR_REF_RX.test(mapped)) out.dir = true
      if (SCHEDULE_CLI_REF_RX.test(e) || SCHEDULE_CLI_REF_RX.test(mapped)) out.cli = true
      if (DASHBOARD_DB_REF_RX.test(e) || DASHBOARD_DB_REF_RX.test(mapped)) out.db = true
    }
  }
  return out
}

// Lexical path normalisation before a word is read segment by segment: `//`
// and `/./` collapse and `x/..` resolves, exactly as the kernel would walk
// them, so `~/.claude//sc*` and `~/.claude/./sc*` still show `.claude` as the
// parent of `sc*`. (A `..` after a symlink can differ from the lexical result;
// that is inside the stated symlink limit.)
export function normalizePathSegments(word) {
  const out = []
  for (const seg of String(word).split('/')) {
    if (seg === '.' || (seg === '' && out.length)) continue
    if (seg === '..' && out.length && out[out.length - 1] !== '..' && out[out.length - 1] !== '') { out.pop(); continue }
    out.push(seg)
  }
  return out
}

// Does this text reference the schedule surface? { api, dir, cli, sql, db }
// (route, store, registry tool, schedule-table SQL write, database file).
// opts.parentCtx: the command cd's into a store parent, so a bare glob word
// (`s*`) may be resolved relative to it.
export function scheduleSurfaceRefs(text, opts) {
  const vs = scheduleSurfaceVariants(text)
  // The security surface (db-write-gate): an SQL write on a security table is
  // the strong reference, the database file keeps its own narrower rule; the
  // schedule route, store and registry tool are not this mode's business.
  if (opts?.surface === 'security') {
    return {
      api: false,
      dir: false,
      cli: false,
      sql: vs.some((v) => SECURITY_SQL_WRITE_RX.test(v)) || agentMessagesForgeWrite(text, opts),
      db: vs.some((v) => DASHBOARD_DB_REF_RX.test(v)) || globRefs(text, opts).db,
    }
  }
  const r = {
    api: vs.some((v) => SCHEDULE_API_REF_RX.test(v)),
    dir: vs.some((v) => SCHEDULE_DIR_REF_RX.test(v)),
    cli: vs.some((v) => SCHEDULE_CLI_REF_RX.test(v)),
    sql: vs.some((v) => SCHEDULE_SQL_WRITE_RX.test(v)),
    db: vs.some((v) => DASHBOARD_DB_REF_RX.test(v)),
  }
  if (!r.api || !r.dir || !r.cli || !r.db) {
    const g = globRefs(text, opts)
    r.api ||= g.api
    r.dir ||= g.dir
    r.cli ||= g.cli
    r.db ||= g.db
  }
  return r
}
// Everything except the database file, which has its own, narrower rule.
const strongRef = (r) => r.api || r.dir || r.cli || r.sql

// Does the command cd/pushd into a store PARENT (~/.claude, a config dir)?
// Then a relative glob anywhere in it may land on the store.
function cdsIntoStoreParent(command) {
  const unquoted = scheduleSurfaceVariants(command)[1]
  for (const m of unquoted.matchAll(/(?:^|[\s;&|(])(?:cd|pushd)\s+(\S+)/g)) {
    const last = normalizePathSegments(m[1]).filter(Boolean).pop() ?? ''
    if (STORE_PARENTS.some((p) => globMatchesName(last, p))) return true
  }
  return false
}

// `"$(cat <<'EOF' ... EOF)"` -- the canonical multi-line commit message -- is a
// LITERAL string: a quoted tag expands nothing and cat prints the body verbatim.
// Rewrite it to the single-quoted literal it evaluates to, so the parser below
// can see it as a plain word. If the body contains a line equal to the tag, the
// shell would have ended the heredoc THERE and run the rest; that case is left
// untouched, and maskInertLiterals then fails closed on it.
const LITERAL_HEREDOC_SUBST_RX = /"\$\(\s*cat\s+<<-?\s*(['"])([A-Za-z_]\w*)\1[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*\2[ \t]*\r?\n\s*\)"/g
function resolveLiteralHeredocSubst(cmd) {
  return cmd.replace(LITERAL_HEREDOC_SUBST_RX, (full, _q, tag, body) => {
    if (new RegExp(`^[ \\t]*${tag}[ \\t]*$`, 'm').test(body)) return full
    return `'${body.replace(/'/g, '')}'`
  })
}

// `$(cat PATH)` / `$(< PATH)` only reads a file -- the dashboard token header
// `-H "Authorization: Bearer $(cat store/.dashboard-token)"` is the fleet's own
// documented form. It becomes a marker: harmless inside double quotes, and
// rejected unquoted by the word parser (an unquoted substitution word-splits,
// so `curl -H $(cat args) URL` could smuggle -X POST in). Only when the path
// itself does not reference the surface. The TOKEN path gets a distinct marker
// because its file content is the ONLY thing form (a) accepts inside a header
// (isPlainCurlGet). That marker MUST NOT be expressible in shell source: an
// earlier draft used the literal `${DASHBOARD_TOKEN}`, which an agent can
// itself write as a real expansion -- `DASHBOARD_TOKEN=$'...\r\n...'; curl -H
// "X: ${DASHBOARD_TOKEN}"` -- reopening CR/LF smuggling. So it is a per-run
// nonce fenced by NUL, which cannot occur in a shell command's argv.
const CAT_SUBST_RX = /\$\(\s*(?:cat\s+|<\s*)((?:[\w./~@+-]|\$\w+|\$\{\w+\})+)\s*\)/g
const TOKEN_NONCE = `\u0000SPTOK${randomBytes(9).toString('hex')}\u0000`
const NONCONTENT_MARKER = '\u0000SPVAL\u0000' // any other $(...) whose output is opaque
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// The token files a header may read, as LITERAL absolute paths (the form the
// scaffold writes into every sub-agent's CLAUDE.md: tokenPath is
// join(PROJECT_ROOT, 'store', '.dashboard-token')):
//   - <root>/store/.dashboard-token, the shared dashboard token;
//   - <root>/agents/<self>/.dashboard-token, a per-agent token file, for the
//     calling agent only (opts.selfAgent, see selfAgentFromProjectDir). On an
//     install without per-agent tokens that file does not exist, so it is
//     refused by the content check below.
// No relative path (a sub-agent runs in agents/<name>/ and could create its
// own store/.dashboard-token there), no ~ or $HOME (an expansion the command
// can redefine). And the file's CONTENT must look like a token, read when the
// gate decides: a token file with a CR/LF in it would put a second, pipelined
// request (a POST) inside the "GET". Missing or unreadable = refused.
const TOKEN_CONTENT_RX = /^[A-Za-z0-9._~+/=-]+\n?$/
export function tokenFileContentOk(path) {
  try { return TOKEN_CONTENT_RX.test(readFileSync(path, 'utf-8')) } catch { return false }
}
export function acceptedTokenFile(path, opts = {}) {
  const root = opts.projectRoot ?? PROJECT_ROOT
  const allowed = [join(root, 'store', '.dashboard-token')]
  if (opts.selfAgent && /^[A-Za-z0-9_-]+$/.test(opts.selfAgent)) allowed.push(join(root, 'agents', opts.selfAgent, '.dashboard-token'))
  return allowed.includes(path) && tokenFileContentOk(path)
}
// The calling agent: the hook's CLAUDE_PROJECT_DIR (the directory the agent's
// session was launched in, set by Claude Code for every hook process; a Bash
// `cd` does not change it) when it is exactly <root>/agents/<name>. Anything
// else -- unset, the repo root, a deeper or outside path -- is no agent, so
// only the shared token file is accepted.
export function selfAgentFromProjectDir(dir, root = PROJECT_ROOT) {
  if (!dir) return undefined
  const rel = relative(join(root, 'agents'), resolve(String(dir)))
  if (!rel || rel.startsWith('..') || rel.includes(sep) || !/^[A-Za-z0-9_-]+$/.test(rel)) return undefined
  return rel
}
function resolveCatSubst(cmd, opts) {
  return cmd.replace(CAT_SUBST_RX, (full, path) => {
    if (strongRef(scheduleSurfaceRefs(path, opts)) || opts?.keepSubst?.(path)) return full
    return acceptedTokenFile(path, opts) ? TOKEN_NONCE : NONCONTENT_MARKER
  })
}

// Any other flat `$(CMD)` -- no quotes, no nesting, no expansion inside, and no
// reference in CMD -- becomes NONCONTENT_MARKER (NUL-fenced, see above). CMD
// itself would be allowed on its own (it references nothing), and its OUTPUT is
// run-time data, which this gate cannot see in any spelling. Without this, one
// `"$(date -Iseconds)"` anywhere in a command made the whole quoting
// unresolvable and denied an unrelated read of the store (replay of real
// sub-agent tool calls). readWord treats an unquoted marker as an expansion (unknown word
// count), and headerValueIsInert rejects it in a header, so the curl checks
// still refuse it there and as a URL's start. There is no "inside the store"
// case to guard any more: a cd/pushd/popd into the store denies the whole
// command (scheduleSurfaceDeny, rule 1).
const FLAT_SUBST_RX = /\$\(([^()'"`$\\]*)\)/g
function resolveFlatSubst(cmd, opts) {
  return cmd.replace(FLAT_SUBST_RX, (full, inner) => {
    // opts.keepSubst: a caller's own reference (db-write-gate: a protected install
    // path) keeps the substitution as written, so the word stays unparsable there
    return strongRef(scheduleSurfaceRefs(inner, opts)) || opts?.keepSubst?.(inner) ? full : NONCONTENT_MARKER
  })
}

// Split a command into the segments the SHELL would see: separators inside
// quotes or heredoc bodies do not split (maskInertLiterals decides that), and
// a heredoc body is handed back to the segment whose `<<` owns it. Returns null
// when the quoting cannot be resolved -- the caller then denies.
// A `|` right after a `>` is the `>|` (noclobber-override) redirection, not a pipe (ENVRELAXGATE1104, measured: the
// db-write-gate read `echo x >| <protected>` as `echo x >` piped into running the protected path, and let it through).
const SEGMENT_SEP_RX = /\|\||&&|\|&|;;|[;\n]|(?<!>)\||(?<![<>])&(?!>)/g
export function shellSegments(command, opts) {
  const src = resolveFlatSubst(resolveCatSubst(resolveLiteralHeredocSubst(String(command ?? '')), opts), opts)
    .replace(/\\\r?\n/g, ' ')
  const heredocs = []
  const comments = []
  const masked = maskInertLiterals(src, heredocs, false, comments)
  if (masked == null || masked.length !== src.length) return null
  // GATECOMMENTQUOTE1104: a comment is no part of its segment's words (same length, so the ranges still line up)
  let plain = src
  for (const k of comments) plain = plain.slice(0, k.start) + ' '.repeat(k.end - k.start) + plain.slice(k.end)
  const ranges = []
  let start = 0
  for (const m of masked.matchAll(SEGMENT_SEP_RX)) {
    ranges.push({ start, end: m.index, sep: m[0] })
    start = m.index + m[0].length
  }
  ranges.push({ start, end: src.length, sep: '' })
  const segs = []
  for (const r of ranges) {
    // a range that lies inside a heredoc body/terminator belongs to its owner
    if (heredocs.some((h) => r.start >= h.bodyStart && r.end <= h.end)) continue
    const own = plain.slice(r.start, r.end)
    // an empty range (`a |<newline>b`) is skipped WITHOUT touching the previous
    // separator: the pipe before it still connects to the next real command
    if (!own.trim()) continue
    const bodies = heredocs
      .filter((h) => h.opStart >= r.start && h.opStart < r.end)
      .map((h) => src.slice(h.bodyStart, h.bodyEnd))
    segs.push({ own: own.trim(), bodies, text: [own.trim(), ...bodies].join('\n'), sep: r.sep })
  }
  return segs
}

// Plain-word parser for one segment. Returns [{ value, dollar, star, ansi }] or
// null when the segment is not a plain word list: a command or process
// substitution, grouping, brace expansion, a here-string. Redirections are
// parsed, not rejected: an output target lands on `words.redirects` (the caller
// decides whether it may be written), an fd dup (2>&1) and an input redirect
// are dropped.
const HEREDOC_OP_RX = /<<-?\s*(?:'[^']*'|"[^"]*"|[A-Za-z_]\w*)/g
const REDIRECT_OP_RX = /^(?:\d|&)?(?:>>|>\||>|<(?![<(]))/

function readWord(s, i) {
  let value = ''
  let dollar = false // an UNQUOTED expansion: word splitting can turn it into several words
  let star = false // an unquoted * or [ glob
  let ansi = false // a $'...' part: its \r \n escapes become real control characters
  while (i < s.length && !/\s/.test(s[i])) {
    const c = s[i]
    if (c === "'") {
      const e = s.indexOf("'", i + 1)
      if (e === -1) return null
      value += s.slice(i + 1, e); i = e + 1; continue
    }
    if (c === '$' && s[i + 1] === "'") {
      let j = i + 2
      while (j < s.length && s[j] !== "'") j += s[j] === '\\' ? 2 : 1
      if (j >= s.length) return null
      value += s.slice(i + 2, j); ansi = true; i = j + 1; continue
    }
    if (c === '"') {
      let j = i + 1
      while (j < s.length && s[j] !== '"') {
        if (s[j] === '`' || (s[j] === '$' && s[j + 1] === '(')) return null
        // inside "..." bash drops the backslash only before $ ` " \ and newline
        if (s[j] === '\\' && j + 1 < s.length) {
          value += '$`"\\\n'.includes(s[j + 1]) ? s[j + 1] : s.slice(j, j + 2)
          j += 2; continue
        }
        value += s[j]; j++
      }
      if (j >= s.length) return null
      i = j + 1; continue
    }
    if (c === '\\') {
      if (i + 1 >= s.length) return null
      value += s[i + 1]; i += 2; continue
    }
    if (c === '$' && s[i + 1] === '{') { // ${NAME...}: an expansion, unless it nests a command
      const e = s.indexOf('}', i + 2)
      if (e === -1 || /[`{]|\$\(/.test(s.slice(i + 2, e))) return null
      value += s.slice(i, e + 1); dollar = true; i = e + 1; continue
    }
    if ('`(){}<>;&|'.includes(c)) return null
    if (c === '$' || c === '\u0000') dollar = true // $ or a NUL substitution marker
    if (c === '*' || c === '[') star = true
    value += c; i++
  }
  return { word: { value, dollar, star, ansi }, i }
}

export function shellWords(text) {
  const s = String(text).replace(HEREDOC_OP_RX, ' ')
  const words = []
  words.redirects = []
  let i = 0
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++
    if (i >= s.length) break
    const op = REDIRECT_OP_RX.exec(s.slice(i))
    if (op) {
      i += op[0].length
      if (s[i] === '&' && /\d/.test(s[i + 1] ?? '')) { i += 2; continue } // 2>&1: fd dup, no file
      while (i < s.length && /\s/.test(s[i])) i++
      const t = readWord(s, i)
      if (!t || !t.word.value) return null
      if (op[0].includes('>')) words.redirects.push(t.word) // output: a file gets written
      i = t.i
      continue
    }
    const r = readWord(s, i)
    if (!r) return null
    words.push(r.word)
    i = r.i
  }
  return words
}

// System directories a tool's real binary lives in. A command word is trusted
// (forms a/b/c) only as a BARE name (`curl`) or as an EXACT absolute path in one
// of these (`/usr/bin/curl`). `./curl`, `/tmp/cat`, `$X/curl`, a relative path:
// not trusted -> commandName returns '' -> neither form matches -> deny.
const SYSTEM_BIN_DIRS = ['/usr/bin/', '/bin/', '/usr/local/bin/', '/usr/sbin/', '/sbin/', '/opt/homebrew/bin/']
export function commandName(words) {
  const w = words[0]
  if (!w || w.dollar || w.value.includes('$')) return ''
  const v = w.value
  if (!v.includes('/')) return v // bare name
  const base = v.slice(v.lastIndexOf('/') + 1)
  return SYSTEM_BIN_DIRS.some((d) => v === d + base) ? base : ''
}

// curl's option grammar, as far as this gate needs it. An option not listed
// here makes parseCurl return null: unknown means not provable.
const CURL_NOARG = new Set([
  '-s', '--silent', '-S', '--show-error', '-f', '--fail', '--fail-with-body', '-L', '--location',
  '-i', '--include', '-I', '--head', '-k', '--insecure', '-v', '--verbose', '-g', '--globoff',
  '-G', '--get', '--compressed', '--no-progress-meter', '-N', '--no-buffer', '-4', '-6',
])
const CURL_SHORT_NOARG = 'sSfLiIkvgGN46'
const CURL_ARG_OPTS = new Map([
  ['-H', 'header'], ['--header', 'header'],
  // 'safe' = checked against the installed curl 8.5.0 man page (2026-09-28):
  // no file written, no config read, no change to the request. -w/--write-out
  // is NOT safe: its %output{file} / %output{>>file} (curl >= 8.3.0) writes a
  // file of the caller's choosing.
  ['-m', 'safe'], ['--max-time', 'safe'], ['--connect-timeout', 'safe'],
  ['-w', 'file'], ['--write-out', 'file'],
  ['-A', 'header'], ['--user-agent', 'header'], ['-e', 'header'], ['--referer', 'header'],
  ['--retry', 'safe'], ['--retry-delay', 'safe'], ['--retry-max-time', 'safe'],
  ['-X', 'method'], ['--request', 'method'],
  ['-d', 'data'], ['--data', 'data'], ['--data-raw', 'data'], ['--data-binary', 'data'],
  ['--data-ascii', 'data'], ['--data-urlencode', 'data'], ['--json', 'data'],
  ['-F', 'body'], ['--form', 'body'], ['-T', 'body'], ['--upload-file', 'body'],
  ['-K', 'config'], ['--config', 'config'],
  ['-o', 'file'], ['--output', 'file'], ['-D', 'file'], ['--dump-header', 'file'], ['-c', 'file'], ['--cookie-jar', 'file'],
  ['-u', 'auth'], ['--user', 'auth'], ['-b', 'auth'], ['--cookie', 'auth'],
  ['--url', 'url'],
  ['-x', 'route'], ['--proxy', 'route'], ['--resolve', 'route'], ['--connect-to', 'route'], ['--unix-socket', 'route'],
])

function parseCurl(words) {
  const out = { urls: [], kinds: new Set(), dataIdx: new Set(), stdinData: false, sent: [], noCurlrc: false }
  const record = (kind, idx, value) => {
    out.kinds.add(kind)
    if (kind === 'header') out.sent.push({ value, ansi: words[idx].ansi })
    if (kind === 'data') {
      out.dataIdx.add(idx)
      if (value === '@-') out.stdinData = true
    }
    if (kind === 'url') out.urls.push(words[idx])
  }
  for (let i = 1; i < words.length; i++) {
    const w = words[i]
    const v = w.value
    if (w.dollar) return null // unquoted expansion: its word count is unknown
    // -q / --disable skips the curlrc, but ONLY as the very first argument
    if (i === 1 && (v === '-q' || v === '--disable')) { out.noCurlrc = true; continue }
    if (v === '--') return null
    if (v.startsWith('--')) {
      const eq = v.indexOf('=')
      const name = eq >= 0 ? v.slice(0, eq) : v
      if (eq < 0 && CURL_NOARG.has(name)) continue
      const kind = CURL_ARG_OPTS.get(name)
      if (!kind) return null
      if (eq >= 0) { record(kind, i, v.slice(eq + 1)); continue }
      if (i + 1 >= words.length) return null
      i++; record(kind, i, words[i].value); continue
    }
    if (v.startsWith('-') && v.length > 1) {
      if (v.includes('$')) return null
      for (let j = 1; j < v.length; j++) {
        if (CURL_SHORT_NOARG.includes(v[j])) continue
        const kind = CURL_ARG_OPTS.get('-' + v[j])
        if (!kind) return null
        const rest = v.slice(j + 1)
        if (rest) record(kind, i, rest)
        else { if (i + 1 >= words.length) return null; i++; record(kind, i, words[i].value) }
        break
      }
      continue
    }
    out.urls.push(w)
  }
  return out
}

// Form (a): a plain curl GET. The scheme must be literal: a URL that STARTS with
// an expansion (`"$D/api/schedules"`) can carry gopher:// or dict://, which let
// curl write raw bytes -- a POST -- to the port.
//
// Header values (-H, -A, -e) must not be able to carry a line break. Measured
// 2026-09-28 against a raw socket: curl 8.5.0 sends `-H $'X: a\r\n\r\nPOST
// /api/schedules HTTP/1.1...'` VERBATIM, i.e. a second, pipelined POST rides
// inside the "GET". (A CR/LF in the URL is refused by curl itself, exit 3,
// measured the same way.) So a header value may contain no control character,
// no $'...' part, and no expansion other than the dashboard token file; and
// not the `@file` form, which reads header lines from a file this gate cannot
// see. (Residual, not closed: the token FILE's own content is trusted.) The
// token nonce (the resolved `$(cat store/.dashboard-token)`) is stripped FIRST;
// then any control char -- a NUL from a non-token substitution, or a real
// CR/LF -- and any surviving `$` (a literal `${DASHBOARD_TOKEN}` the agent
// wrote, or any other expansion) make the value non-inert.
function headerValueIsInert(h) {
  if (h.ansi || h.value.startsWith('@')) return false
  const stripped = h.value.split(TOKEN_NONCE).join('')
  if (/[\x00-\x1f\x7f]/.test(stripped)) return false
  return !stripped.includes('$')
}
//
// curl reads ~/.curlrc (or $CURL_HOME/.curlrc, $XDG_CONFIG_HOME/curlrc) before
// its command line, and a curlrc can say `request = POST` / `data = ...` /
// `output = ...`. Form (a) therefore requires -q as the FIRST argument (the
// only position where curl honours it) instead of guessing at run time whether
// a curlrc exists: that guess could not see one written earlier in the same
// command. The scheme must be a literal http(s)://: without one, curl guesses
// the protocol from the host name (ftp., dict., ...).
function isPlainCurlGet(words) {
  const p = parseCurl(words)
  if (!p || !p.noCurlrc) return false
  for (const k of p.kinds) if (k !== 'header' && k !== 'safe') return false
  if (!p.sent.every(headerValueIsInert)) return false
  if (p.urls.length !== 1) return false
  const u = p.urls[0]
  if (u.star) return false
  return /^https?:\/\//i.test(u.value)
}

// Form (b): commands that can neither write a file (other than through a
// redirect, which the caller checks) nor open a socket, and -- for their output
// -- the only consumers allowed on a pipe. No tee, awk, xargs, tree (-o), file
// (-C); sed and sort only in a shape whose options cannot write or exec.
const READ_ONLY_FS = new Set([
  'ls', 'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'wc', 'stat', 'du', 'readlink', 'realpath',
  'basename', 'dirname', 'test', '[', 'diff', 'cmp', 'md5sum', 'sha1sum', 'sha256sum', 'find', 'echo', 'printf',
  'date', 'pwd', 'true', 'false', 'sed', 'sort', 'cut', 'tr', 'nl', 'uniq', 'column',
])
const TEXT_FILTERS = new Set(['grep', 'egrep', 'fgrep', 'head', 'tail', 'wc', 'cut', 'tr', 'nl', 'cat', 'uniq', 'column', 'sort', 'sed'])
const FIND_ACTION_RX = /^-(?:exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/
// sed: only -n/-E/-r and print/delete scripts -- a line range (`1,60p`, `$d`), a /regex/ address (`/^X=/p`), or a
// substitution printing its result (`s/^WEB_PORT=//p`, the seed skills' port read, ENVRELAXGATE1104) with only the
// g/p/I/i/number flags -- no `w file`, no `e command`, no second command, no -i.
const SED_ADDR = String.raw`(?:\d+|\$|/(?:[^/\\\n]|\\.)*/)`
const SED_PART = String.raw`(?:[^/\\\n]|\\.)*`
const SED_SCRIPT_RX = new RegExp(String.raw`^(?:(?:${SED_ADDR}(?:,${SED_ADDR})?)?(?:[pd]|s/${SED_PART}/${SED_PART}/[gpIi0-9]*);?)+$`)
function sedIsPrintOnly(words) {
  let script = 0
  for (const w of words.slice(1)) {
    if (/^-[nEr]+$/.test(w.value) || w.value === '--quiet') continue
    if (w.value.startsWith('-')) return false
    if (!script++) { if (!SED_SCRIPT_RX.test(w.value)) return false }
  }
  return script > 0
}
// sort: -o writes a file, --compress-program runs one
function sortIsReadOnly(words) {
  return words.slice(1).every((w) => !w.value.startsWith('-') || /^-[bdfghinMRrsuVz]+$/.test(w.value) || /^-[kt]/.test(w.value))
}

export function isReadOnlyFsCommand(words, name) {
  if (!READ_ONLY_FS.has(name)) return false
  // uniq's SECOND operand is an output file
  if (name === 'uniq') return words.slice(1).filter((w) => !w.value.startsWith('-')).length <= 1
  if (name === 'find') return !words.some((w) => w.dollar || w.star || FIND_ACTION_RX.test(w.value))
  if (name === 'rg') return !words.some((w) => w.value.startsWith('--pre'))
  if (name === 'sed') return sedIsPrintOnly(words)
  if (name === 'sort') return sortIsReadOnly(words)
  return true
}

const AGENT_MSG_RX = /(?:^|\/)scripts\/agent-msg\.sh$/
const KANBAN_TOOL_RX = /(?:^|\/)scripts\/kartya-es-ertesites\.py$/
function isPipeSink(words, name) {
  if (TEXT_FILTERS.has(name)) return isReadOnlyFsCommand(words, name)
  // the inter-agent helper: its stdin becomes message content, nothing else
  const script = (name === 'bash' || name === 'sh') ? words[1] : words[0]
  return !!script && AGENT_MSG_RX.test(script.value) && words.every((w) => !w.dollar)
}

// Does a later segment of the same command run or feed a file segment [k] wrote? Then the file is a script, whatever
// wrote it: an interpreter, sqlite3 or a shell given it (as an argument or on stdin), `source` / `.`, chmod, the file as
// the command word, or a reader of it piped into one of them. A file only sent on (curl -d @file, the kanban tool's
// --comment-file) is not run. [targets]: the written words as the command spells them. A run in a LATER Bash call is the
// stated limit, as for a file written with the Write tool.
// An interpreter runs the file when it is its script (the first word that is not an option), its stdin, or named in
// its -c/-e code; a script that only takes the file as data (the kanban tool's --comment-file) does not.
const FILE_INTERPRETERS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'node', 'nodejs', 'deno', 'bun', 'ruby',
  'perl', 'php', 'osascript', 'tsx'])
// The rest run or hand on whatever file they name. chmod is NOT here (47eeb016): it changes metadata, it does not run
// the file; `chmod <protected>` itself is denied through the DIR_CHANGER rule. `env` runs a target only through the
// command it starts (envRunsTarget below), never through an assignment value alone.
const FILE_RUNNERS = new Set(['sqlite3', 'sqlite', 'source', '.', 'env', 'xargs', 'exec', 'eval', 'npx'])
const isInterpreter = (name) => FILE_INTERPRETERS.has(name) || /^python[0-9.]*$/.test(name)
const isFileRunner = (name) => FILE_RUNNERS.has(name) || isInterpreter(name)
const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const SHELL_NAME_RX = /^(?:(?:ba|z|da|k)?sh|ash)$/
/** GATEPATHNORM1118 F5: the script word of a shell run, given the words after the program: options start with - or +,
 *  an option cluster ending in o or O (-o, +o, -eo, -O, +O) takes the next word as its argument, -- ends the options.
 *  null for another program, or when no script word is left (the shell reads stdin, or -c gives the code). */
export function shellScriptWord(name, args) {
  if (!SHELL_NAME_RX.test(name)) return null
  for (let i = 0; i < args.length; i++) {
    const v = args[i]
    if (v === '--') return args[i + 1] ?? null
    if (v === '-' || !/^[-+]/.test(v)) return v === '-' ? null : v
    if (/^[-+][A-Za-z]*c[A-Za-z]*$/.test(v)) return null
    if (/^[-+][A-Za-z]*[oO]$/.test(v)) i++
    // F6: bash's long options that take the next word (--rcfile RC, --init-file RC); --name=value holds its own
    else if (v === '--rcfile' || v === '--init-file') i++
  }
  return null
}

/** F6: the rc files a shell run names (--rcfile RC, --init-file RC, --rcfile=RC): an interactive shell runs them. */
export function shellRcFiles(name, args) {
  if (!SHELL_NAME_RX.test(name)) return []
  const out = []
  for (let i = 0; i < args.length; i++) {
    const v = args[i]
    if (v === '--') break
    if (v === '--rcfile' || v === '--init-file') { if (args[i + 1] !== undefined) out.push(args[i + 1]); i++; continue }
    const m = /^--(?:rcfile|init-file)=(.+)$/.exec(v)
    if (m) out.push(m[1])
    else if (!/^[-+]/.test(v)) break
  }
  return out
}

// 47eeb016 round 12: an empty quoted string ('' "" $'' $"") adds nothing to a shell word, so `< ''<f>` and
// `< <f-head>''<f-tail>` read <f>. The text is matched both as written and with those dropped (fail-closed union).
// A regex cannot follow every quoting; real tokenising is card fdc1ce07.
const dropEmptyQuotes = (s) => s.replace(/\$?(?:''|"")/g, '')
const stdinFromTarget = (own, targets) =>
  [own, dropEmptyQuotes(own)].some((text) => targets.some((t) => new RegExp(`(?:^|[^<])<\\s*['"]?${escapeRx(t)}`).test(text)))
// 47eeb016: `env [-opts] [NAME=VALUE ...] CMD`: true only when the target is the command word.
const ENV_LONG_OPTS = ['split-string', 'unset', 'chdir', 'argv0', 'file']
// One env option word at words[i] (starts with '-', not bare '--'): how many words it consumes, and the -S/--split-string
// value when it has one (GNU re-parses that text as a command line).
function envOption(words, i) {
  const v = words[i].value
  const next = words[i + 1]?.value
  if (v.startsWith('--')) {
    const eq = v.indexOf('=')
    const name = eq < 0 ? v.slice(2) : v.slice(2, eq)
    const opt = name ? ENV_LONG_OPTS.find((l) => l.startsWith(name)) : undefined
    if (!opt) return { n: 1 }
    const val = eq < 0 ? next : v.slice(eq + 1)
    return { n: eq < 0 ? 2 : 1, split: opt === 'split-string' ? (val ?? '') : undefined }
  }
  for (let c = 1; c < v.length; c++) {
    if (!'uCafS'.includes(v[c])) continue
    const rest = v.slice(c + 1)
    const val = rest || next
    return { n: rest ? 1 : 2, split: v[c] === 'S' ? (val ?? '') : undefined }
  }
  return { n: 1 }
}
const SHELL_INTERPRETERS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash', 'fish'])
// A command wrapper started by env runs whatever command follows it (47eeb016 round 9): it gets the same
// conservative reading as an interpreter -- a BASH_ENV/ENV assignment that held a target, or ANY later word
// that contains a target, makes it a run.
const ENV_COMMAND_WRAPPERS = new Set(['nice', 'timeout', 'gtimeout', 'nohup', 'stdbuf', 'setsid', 'time', 'sudo',
  'command', 'builtin', 'chrt', 'ionice', 'taskset', 'doas', 'parallel'])
// An interpreter started by env runs a target when a shell startup file (BASH_ENV/ENV) holds it, its stdin reads it,
// or ANY later word contains it (the base gate's conservative reading: no per-interpreter option table).
function envRunsTarget(words, targets, own, depth = 0, inheritedStartupFile = false, inheritedTargetAssign = false) {
  if (depth > 8) return true
  let ws = words
  let i = 1
  let splices = 0
  let ended = false // after a bare `--` no word is an option
  let startupFile = inheritedStartupFile // BASH_ENV / ENV assignment whose value holds a target (also from an outer env)
  let targetAssign = inheritedTargetAssign // ANY assignment whose value holds a target (NODE_OPTIONS, PERL5OPT ...; also from an outer env)
  while (i < ws.length) {
    const v = ws[i].value
    if (!ended && v.startsWith('-') && v !== '--') {
      const o = envOption(ws, i)
      if (o.split !== undefined) {
        if (targets.some((t) => o.split.includes(t))) return true
        if (++splices > 8) return true
        const toks = shellWords(o.split)
        if (!toks) return true
        ws = [...toks, ...ws.slice(i + o.n)]
        i = 0
        ended = false
        continue
      }
      i += o.n
      continue
    }
    if (v === '--' && !ended) { ended = true; i++; continue }
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(v)
    if (m) {
      if ((m[1] === 'BASH_ENV' || m[1] === 'ENV') && targets.some((t) => v.includes(t))) startupFile = true
      if (targets.some((t) => v.includes(t))) targetAssign = true
      i++
      continue
    }
    break
  }
  const rest = ws.slice(i)
  if (!rest.length) return false
  const cmd = rest[0].value
  if (targets.some((t) => cmd === t || cmd.includes(t))) return true
  const name = baseName(cmd)
  if (name === 'env') return envRunsTarget(rest, targets, own, depth + 1, startupFile, targetAssign)
  if (FILE_RUNNERS.has(name)) return true
  if (ENV_COMMAND_WRAPPERS.has(name)) {
    // What the wrapper starts (47eeb016 round 11): a later word -- or the first word of an env -S value -- that is
    // an interpreter, env, a runner or another wrapper can load a startup file / an assignment or read stdin.
    const starts = rest.slice(1).some((w) => {
      const b = baseName(w.value.trim().split(/\s+/)[0])
      return isInterpreter(b) || b === 'env' || FILE_RUNNERS.has(b) || ENV_COMMAND_WRAPPERS.has(b)
    })
    if (starts && (startupFile || targetAssign)) return true
    if (starts && own !== undefined && stdinFromTarget(own, targets)) return true
    return rest.slice(1).some((w) => targets.some((t) => w.value.includes(t)))
  }
  if (isInterpreter(name)) {
    if (startupFile && SHELL_INTERPRETERS.has(name)) return true
    if (targetAssign) return true
    if (own !== undefined && stdinFromTarget(own, targets)) return true
    return rest.slice(1).some((w) => targets.some((t) => w.value.includes(t)))
  }
  return false
}
// PR #2883 review B1 (47eeb016 round 13): chmod is not a run, but a later command can run the written file without
// spelling its path as the command word -- `cd <dir> && ./<base>`, `find <dir> ... -exec {} \;`, a command wrapper
// (`timeout 5 <f>`, `nohup ./<base>`). runsByName looks at the RUN POSITIONS only (the command word after the
// leading assignments, a wrapper's later words, find's -exec family), so a file named as data (`cat <base>`, an
// assignment value, a find with no action) stays allowed.
// 47eeb016 R2 B1/B2: the run positions are now read by an executable-position analysis, not a broad scan of every
// word -- the round-13 wrapper branch denied `timeout 5 cat ./<base>` (cat's argument is data), and the find branch
// denied `find -name <base> -exec echo \;` (-name's argument is data). The missed-run holes of the same round --
// `bash ./<base>` after `cd`, `env X=1 timeout 5 ./<base>` -- run at positions the broad scan never modelled.
// 47eeb016 R4: the wrapper branch no longer applies env's conservative any-word reading -- the wrapped command gets
// the same executable-position analysis as a bare one, so its plain operands are data (upstream #2891's wrapped
// reader/upload pins).
const targetBase = (t) => t.slice(t.lastIndexOf('/') + 1)
const targetDir = (t) => (t.lastIndexOf('/') > 0 ? t.slice(0, t.lastIndexOf('/')) : '')
const FIND_RUN_ACTIONS = new Set(['-exec', '-execdir', '-ok', '-okdir'])
// 47eeb016 R2 B1: per command wrapper, the SHORT and LONG options that consume a SEPARATE value word. An option not
// listed takes no argument; an unknown option consumes nothing extra. Some wrappers also take ONE leading operand
// between their options and the executable (timeout's duration, chrt's priority, taskset's mask) -- see below.
const WRAPPER_VALUE_OPTIONS = new Map([
  ['timeout', new Set(['-s', '-k', '--signal', '--kill-after'])],
  ['gtimeout', new Set(['-s', '-k', '--signal', '--kill-after'])],
  ['nice', new Set(['-n', '--adjustment'])],
  ['nohup', new Set()],
  ['builtin', new Set()],
  ['command', new Set()], // -p / -v / -V take no argument
  ['stdbuf', new Set(['-o', '-e', '-i'])], // the value may also be attached: -o0
  ['setsid', new Set()], // -c / -f / -w take no argument
  ['time', new Set(['-f', '-o', '--format', '--output'])], // -p / -a / -v take no argument
  ['sudo', new Set(['-u', '-g', '-p', '-r', '-t', '-C', '-D', '-a', '-R', '--user', '--group', '--prompt', '--role', '--type', '--chdir'])],
  ['chrt', new Set()], // the policy flags -b -f -i -o -r -R -m -a take no argument
  ['taskset', new Set(['-c', '--cpulist'])], // -a takes no argument
  ['ionice', new Set(['-c', '-n', '--class', '--classdata'])], // -t takes no argument
  ['doas', new Set(['-C', '-a', '-u'])], // -n / -s / -S take no argument
  ['parallel', new Set(['-j', '--jobs', '-a', '--arg-file', '--results', '-S', '--sshlogin', '--ssh', '--tmpdir', '--workdir', '--tagstring', '--timeout', '--retries'])],
])
// The one leading operand a wrapper skips, only when the word matches its required shape.
const TIMEOUT_OPERAND_RX = /^[0-9][0-9.]*[smhdSMHD]?$|^[0-9]+m[0-9]+s$/ // 5, 0.5, 5m, 90m30s
const NUMERIC_OPERAND_RX = /^[0-9]+$/ // chrt's priority
const MASK_OPERAND_RX = /^0x[0-9a-fA-F]+$|^[0-9]+$/ // taskset's affinity mask
// 47eeb016 R2 B1: walk a wrapper's option zone and its one leading operand; the index of the word it EXECUTES,
// or -1 when the words ran out -- or in a -p pid mode (chrt/taskset/ionice then have no executable at all).
function wrapperExecIndex(name, ws) {
  const valueOpts = WRAPPER_VALUE_OPTIONS.get(name) ?? new Set()
  let i = 1
  let ended = false // after a bare `--` no word is an option
  while (i < ws.length) {
    const v = ws[i].value
    if (v === '--' && !ended) { ended = true; i++; continue }
    if (!ended && v.startsWith('-') && v.length > 1) {
      if (v.includes('=')) { i++; continue } // --signal=KILL: the value is attached
      if (!v.startsWith('--') && v.length > 2 && valueOpts.has('-' + v[1])) { i++; continue } // -sKILL, -n5, -o0
      if (valueOpts.has(v)) { i += 2; continue } // -s KILL, --signal KILL: the next word is the value
      i++; continue // a no-arg or unknown option consumes nothing extra
    }
    break // the first word that is not an option ends the option zone
  }
  // chrt/taskset/ionice -p act on a running pid: nothing is executed
  if ((name === 'chrt' || name === 'taskset' || name === 'ionice') && ws.slice(1, i).some((w) => w.value === '-p')) return -1
  if (i < ws.length) {
    const v = ws[i].value
    if ((name === 'timeout' || name === 'gtimeout') && TIMEOUT_OPERAND_RX.test(v)) i++
    else if (name === 'chrt' && NUMERIC_OPERAND_RX.test(v)) i++
    else if (name === 'taskset' && MASK_OPERAND_RX.test(v)) i++
  }
  return i < ws.length ? i : -1
}
// 47eeb016 R2 B1o: env's executable word. env's options (envOption) and then its NAME=value assignments are
// VALUES, not runs -- only the word they precede is the command env starts.
function envExecIndex(ws) {
  let i = 1
  let ended = false
  while (i < ws.length) {
    const v = ws[i].value
    if (v === '--' && !ended) { ended = true; i++; continue }
    if (!ended && v.startsWith('-') && v.length > 1) { i += envOption(ws, i).n; continue }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(v)) { i++; continue }
    break
  }
  return i < ws.length ? i : -1
}
// 47eeb016 R3: an interpreter's VALUE options, in three kinds. Which options exist per interpreter follows the
// knowledge the code already has (FILE_INTERPRETERS / SHELL_INTERPRETERS / the python regex of isInterpreter);
// an interpreter with no table here (deno, perl, php, osascript, tsx) keeps the old reading: every unknown
// option consumes nothing, so its value word lands on the script position and is checked there.
// CODE: the value IS the program (`node -e/-p/--eval/--print`, `python -c`, `ruby -e`, `bun -e`, `fish -c`;
// the attached form `-c./x` too): the value word is a run, but the option no longer ENDS the walk -- node keeps
// reading options after a code value (`node -e 0 -r ./x.js` loads and runs x.js too), so the walk goes on and
// only the script POSITION is consumed: the first word after a CODE value that is no option is that program's
// argv, data, and never a run.
// DATA: the value only configures the interpreter (python's -W): exactly ONE word is skipped while searching
// for the script operand and is NOT a run. Attached (`-Werror`): the remainder of the option word is the value,
// no extra word is consumed.
// LOAD: the value is loaded AND run (`node -r/--require`, `ruby -r`, python's `-m`: the module runs, attached
// too): one word (or the attached remainder) is skipped and checked as a run.
// python -m MOD: db-write-gate's writtenFileSpellings adds MOD as a spelling of a written MOD.py, so the LOAD value
// is checked against it (develop #2934 (d)).
// sh: the table of the SHELL family (bash, sh, zsh, dash, ksh, ash), which the real bash reads its own way:
// -c is a FLAG that never takes a value (a `c` anywhere in a cluster is the flag: `-ce`, `-co`), and a short
// cluster is read CHARACTER BY CHARACTER -- every o/O in it takes the NEXT word as its option name, and an
// attached remainder is never one (`bash -oerrexit` names the option of the word AFTER it, so only later words
// can be the script). The family has no CODE kind: the first word that is no option (and no o/O value) is the
// run position -- the command string with -c, the script operand without -- and the walk stops right there.
const SH_VALUE_OPTIONS = { sh: true, short: { c: 'flag', o: 'data', O: 'data' } }
const NODE_VALUE_OPTIONS = { short: { e: 'code', p: 'code', r: 'load' }, long: { eval: 'code', print: 'code', require: 'load' } }
const PY_VALUE_OPTIONS = { short: { c: 'code', m: 'load', W: 'data' } }
const INTERPRETER_VALUE_OPTIONS = new Map([
  ['bash', SH_VALUE_OPTIONS], ['sh', SH_VALUE_OPTIONS], ['zsh', SH_VALUE_OPTIONS], ['dash', SH_VALUE_OPTIONS],
  ['ksh', SH_VALUE_OPTIONS], ['ash', SH_VALUE_OPTIONS],
  ['fish', { short: { c: 'code' } }],
  ['node', NODE_VALUE_OPTIONS], ['nodejs', NODE_VALUE_OPTIONS],
  ['ruby', { short: { e: 'code', r: 'load' } }],
  ['bun', { short: { e: 'code' } }],
])
const interpreterValueOptions = (name) =>
  INTERPRETER_VALUE_OPTIONS.get(name) ?? (/^python[0-9.]*$/.test(name) ? PY_VALUE_OPTIONS : undefined)
// 47eeb016 R3b: the run positions among an interpreter's words (ws[0] is the interpreter command word): the
// script operand -- the first word that is no option, found with the option walk above -- plus every CODE and
// LOAD value met before it. The shell family (a table with sh) walks its clusters character by character and
// stops at the first operand, be it the -c command string or the script; every other table ends the run
// positions at a CODE value even though the walk itself goes on -- the CODE value took the script position, so
// the next word that is no option is that program's argv, and so are all words after the script operand.
// Attached CODE/LOAD values are returned as the path part of the remainder (`-c./a.sh` -> `./a.sh`); DATA
// values are consumed and returned nowhere.
function interpreterRunWords(name, ws) {
  const opts = interpreterValueOptions(name)
  const runs = []
  let codeSeen = false // a CODE value consumed the script position: the next operand is argv, not a run
  let i = 1
  while (i < ws.length) {
    const v = ws[i].value
    if (!v.startsWith('-')) {
      if (codeSeen) return runs // argv of the code program: data
      runs.push(ws[i]); return runs // the script operand
    }
    if (v.startsWith('--')) {
      const eq = v.indexOf('=')
      const kind = opts?.long?.[eq < 0 ? v.slice(2) : v.slice(2, eq)]
      if (!kind) { i++; continue } // an unknown long option takes no value: the next word can still be the script
      if (eq >= 0) { // --require=./x: the value is attached
        if (kind !== 'data') runs.push({ value: v.slice(eq + 1) })
        i++
      } else {
        if (i + 1 >= ws.length) return runs // the value word is missing: no script operand either
        if (kind !== 'data') runs.push(ws[i + 1])
        i += 2
      }
      if (kind === 'code') codeSeen = true // the walk goes on (node reads options past a code value)
      continue
    }
    if (opts?.sh) { // the shell family: -c is a flag, and every o/O of the cluster takes the NEXT word
      let next = i + 1 // the words after the cluster, one consumed per o/O, in order; c and unknown chars none
      for (let c = 1; c < v.length; c++) if (opts.short[v[c]] === 'data' && next < ws.length) next++
      i = next
      continue
    }
    let kind // the first option char of the cluster the interpreter knows: the chars before it are no-argument
    let rest = ''
    for (let c = 1; c < v.length; c++) {
      if (!opts?.short?.[v[c]]) continue
      kind = opts.short[v[c]]
      rest = v.slice(c + 1)
      break
    }
    if (!kind) { i++; continue } // an unknown short option takes no value
    if (kind === 'data') { i += rest ? 1 : 2; continue } // -Werror: the remainder is the value; -W error: one word
    if (rest) { runs.push({ value: rest }); i++ } // -c./a.sh, -r./dep.js: the attached value
    else {
      if (i + 1 >= ws.length) return runs
      runs.push(ws[i + 1])
      i += 2
    }
    if (kind === 'code') codeSeen = true // the walk goes on: a later option is still read, not argv
  }
  return runs
}
// 47eeb016 R2 B2: find's -exec family, by POSITION. The run positions are the found file itself (the command word
// `{}`), an interpreter command word that receives the found file as an operand (`-exec sh {} \;`), or a command
// word that IS the written file; `-name <base>` and an action's data operands stayed denied in round 13 because
// every word was matched. namesTarget is the SAME word-match the round-13 branch used.
// 47eeb016 R3: an interpreter's words inside the action are read with the same option walk as everywhere else
// (its script operand is the run position, every other clause word is data: `-exec sh /dev/null {} +` only
// passes the found file as $1), and a command word that is env or a wrapper gets the full recursive analysis
// with `{}` standing for the found file (`-exec timeout 5 {} \;`, `-exec env X=1 timeout 5 {} +`).
function findRunsTarget(ws, targets, relRun) {
  const namesTarget = (w) => targets.some((t) => w.value.includes(t)
    || (targetBase(t) !== '' && w.value === targetBase(t))
    || (targetDir(t) !== '' && w.value === targetDir(t)))
  for (let j = 1; j < ws.length; j++) {
    if (!FIND_RUN_ACTIONS.has(ws[j].value)) continue
    const cw = ws[j + 1]
    if (cw === undefined) { if (ws.some(namesTarget)) return true; continue } // action word last: malformed, fail closed
    if (cw.value === '{}') { if (ws.some(namesTarget)) return true; continue } // find executes the found file itself
    let end = ws.length // this -exec clause ends at the next `;` / `+` word after j
    for (let k = j + 2; k < ws.length; k++) if (ws[k].value === ';' || ws[k].value === '+') { end = k; break }
    // the wrapper's / env's operand that replaces `{}` is the found file: it IS a run position
    const relRunFound = (v) => (v === '{}' ? ws.some(namesTarget) : relRun(v))
    const head = baseName(cw.value)
    if (head === 'env' || ENV_COMMAND_WRAPPERS.has(head)) {
      if (execWordsRun(ws.slice(j + 1, end), targets, undefined, relRunFound, 1)) return true
    }
    if (isInterpreter(head) && interpreterRunWords(head, ws.slice(j + 1, end)).some((w) => relRunFound(w.value))) return true
    if (relRun(cw.value)) return true // the -exec command word itself is the written file
  }
  return false
}
// 47eeb016 R2 B1: the executable-position analysis, shared by runsByName and its env / wrapper recursion. ws[0]
// is a command word; the run positions are the command word itself, the command env or a wrapper STARTS, an
// interpreter's / a file runner's operand. Everything else -- a plain command's arguments, an option's or an
// assignment's value, a find action's data operand -- is DATA. Without a parseable executable the round-13 broad
// relRun scan stays (fail closed), as it does past the depth bound.
const RUN_ANALYSIS_MAX_DEPTH = 6
function execWordsRun(ws, targets, own, relRun, depth) {
  const broad = () => ws.slice(1).some((w) => relRun(w.value))
  if (depth > RUN_ANALYSIS_MAX_DEPTH) return broad()
  const name = commandName(ws) || baseName(ws[0].value)
  if (name === 'env') {
    if (envRunsTarget(ws, targets, own)) return true
    const ei = envExecIndex(ws)
    if (ei < 0) return broad()
    if (relRun(ws[ei].value)) return true
    return execWordsRun(ws.slice(ei), targets, own, relRun, depth + 1)
  }
  if (ENV_COMMAND_WRAPPERS.has(name)) {
    const ei = wrapperExecIndex(name, ws)
    if (ei < 0) return broad()
    if (relRun(ws[ei].value)) return true
    if (name === 'parallel') {
      // ::: / :::: end the command template: from the first one on, every word is data, never a run position
      const sep = ws.slice(ei).findIndex((w) => w.value === ':::' || w.value === '::::')
      const template = ws.slice(ei, sep < 0 ? ws.length : ei + sep)
      if (!template.length) return broad()
      if (relRun(template[0].value)) return true
      return execWordsRun(template, targets, own, relRun, depth + 1)
    }
    return execWordsRun(ws.slice(ei), targets, own, relRun, depth + 1)
  }
  // An interpreter's SCRIPT operand (the first word that is no option, found with the R3 option walk: an option
  // with a value consumes it, a CODE option consumes the script position itself) is a run position -- `cd <dir>
  // && bash ./<base>` (round 13's missed run), `bash -O extglob ./<base>` (R3: the -O value was taken for the
  // script) deny --, but a DATA option's value or a later argument is DATA: the kanban tool's --comment-file, a
  // prefixed script's argument (R2 gate-suite regression: db-write-gate.test.ts 3 red on 58ebb9ad, green on
  // 9311a515; the named branch's script rule, mirrored here). A file runner's ANY operand stays a run position:
  // source/xargs/eval read a file and do what it says.
  if (isInterpreter(name)) return interpreterRunWords(name, ws).some((w) => relRun(w.value))
  if (FILE_RUNNERS.has(name)) return ws.slice(1).some((w) => relRun(w.value))
  if (name === 'find' && ws.some((w) => FIND_RUN_ACTIONS.has(w.value))) return findRunsTarget(ws, targets, relRun)
  return false // a plain command: its arguments are data
}
function runsByName(words, targets, own, exact = false) {
  let i = 0
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i].value)) i++
  if (i >= words.length) return false
  const ws = words.slice(i)
  // exact: the caller passed every spelling of the file already resolved per directory (db-write-gate's
  // writtenFileSpellings), so only those words are the file; otherwise a path with the file's last part is
  // taken for it (fail closed: the directory it runs in is not followed here)
  const relRun = exact
    ? (v) => targets.includes(v)
    : (v) => v.includes('/') && targets.some((t) => targetBase(t) !== '' && baseName(v) === targetBase(t))
  if (relRun(ws[0].value)) return true
  return execWordsRun(ws, targets, own, relRun, 0)
}

// 47eeb016 R2 (G6/G7): the two shapes shellWords refuses inside a find -exec clause are find's own syntax, not
// shell structure -- the bare `{}` operand, and the `\` left at the end when the segment splitter consumed the `;`
// of a `\;`. Re-split those for the near-branch fallback in laterRuns: `{}` becomes a plain token mapped back
// after the split, the trailing `\` goes only when the separator really was the `;` it escaped. The re-split is
// REFUSED (the caller keeps its deny) when anything else unsplittable or unresolved remains, and when a word from
// an -exec action word on carries a `$`, a glob or a redirection character: an unresolved variable or an expanded
// word could be the very command find executes, so only provably inert clauses reach the positional analysis.
function findClauseWords(own, sep) {
  let t = own
  if (sep === ';' && /\\\s*$/.test(t)) t = t.replace(/\\\s*$/, '')
  t = t.replace(/(^|\s)\{\}(?=\s|$)/g, '$147eeb016FOUND')
  if (t.includes('\\') || /[{}]/.test(t)) return null
  const ws = shellWords(t)
  if (!ws || !ws.length) return null
  let inClause = false
  for (const w of ws) {
    if (FIND_RUN_ACTIONS.has(w.value)) inClause = true
    if (inClause && /[$*?<>()'"`]/.test(w.value)) return null
  }
  return ws.map((w) => (w.value.includes('47eeb016FOUND')
    ? { ...w, value: w.value.replaceAll('47eeb016FOUND', '{}') }
    : w))
}

export function laterRuns(segs, k, targets, opts = {}) {
  if (!targets.length) return false
  const exact = opts.exactNames === true
  for (let j = k + 1; j < segs.length; j++) {
    const s = segs[j]
    const text = [s.own, ...s.bodies].join('\n')
    if (!targets.some((t) => text.includes(t) || dropEmptyQuotes(text).includes(t))) {
      // Not named as spelled: it can still run through a relative path or find's -exec family (runsByName).
      const near = targets.some((t) => (targetBase(t) !== '' && text.includes(targetBase(t)))
        || (targetDir(t) !== '' && text.includes(targetDir(t))))
      const w = near ? shellWords(s.own) : null
      // A segment shellWords cannot split (find's `-exec {} \;` leaves a bare `{}`, a brace group) that names the
      // file's base or directory is denied, as the named branch below denies an unsplittable one (fail closed) --
      // EXCEPT the find-clause shapes findClauseWords can re-split cleanly (47eeb016 R2: `find <dir> -name <base>
      // -exec echo \;` and `-exec cat {} +` only read the file); those get the same positional analysis as a
      // splittable segment, and every shape the re-split refuses keeps the deny.
      if (near && !w) {
        const fw = findClauseWords(s.own, s.sep)
        if (!fw || runsByName(fw, targets, s.own, exact)) return true
        continue
      }
      if (w && w.length && runsByName(w, targets, s.own, exact)) return true
      continue
    }
    const words = shellWords(s.own)
    if (!words || !words.length) return true
    const first = words[0].value
    if (targets.includes(first)) return true
    const name = commandName(words) || first.slice(first.lastIndexOf('/') + 1)
    if (runsByName(words, targets, s.own, exact)) return true
    if (isInterpreter(name)) {
      const stdin = stdinFromTarget(s.own, targets)
      const code = words.some((w, i) => /^-[A-Za-z]*[ceE]$/.test(w.value) && targets.some((t) => (words[i + 1]?.value ?? '').includes(t)))
      const script = words.slice(1).find((w) => !w.value.startsWith('-'))
      // GATEPATHNORM1118 F5: a shell option that takes an argument (-o NAME, +o NAME, -O NAME, +O NAME) is not the script
      // word. Read in addition to the word above, never instead of it, so no run read before is lost.
      const optScript = shellScriptWord(name, words.slice(1).map((w) => w.value))
      // F6: an rc file the shell is told to read runs too (an interactive shell runs it; judged fail-closed)
      const rc = shellRcFiles(name, words.slice(1).map((w) => w.value)).some((v) => targets.includes(v))
      // R3 (rebased onto GATEPATHNORM1118 F5/F6: read in addition, never instead): the same option walk as the executable-position analysis -- `bash -O extglob <f>` names <f> as its
      // script operand, an option's DATA value (`bash -o <f>`) does not name a run at all.
      const runWords = interpreterRunWords(name, words)
      if (stdin || code || rc || (script && targets.includes(script.value)) || (optScript !== null && targets.includes(optScript)) || runWords.some((w) => targets.includes(w.value))) return true
      continue
    }
    if (name === 'env') { if (envRunsTarget(words, targets, s.own)) return true }
    else if (FILE_RUNNERS.has(name)) return true
    if ((s.sep === '|' || s.sep === '|&') && segs[j + 1]) {
      const nw = shellWords(segs[j + 1].own)
      if (!nw || isFileRunner(commandName(nw))) return true
    }
  }
  return false
}

function pipesOnlyIntoSinks(segs, k, redirectsOk) {
  for (let j = k; j < segs.length - 1 && (segs[j].sep === '|' || segs[j].sep === '|&'); j++) {
    const next = segs[j + 1]
    const words = shellWords(next.own)
    if (!words || !isPipeSink(words, commandName(words)) || next.bodies.length || !redirectsOk(words)) return false
  }
  return true
}

// gh/glab prose flags (the set stripProseArguments blanks), and the flags that
// read the same prose from a file (`-` = stdin, i.e. a heredoc on the segment).
const GH_PROSE_FLAGS = new Set(['--body', '--message', '--notes', '--title', '--subject', '-b', '-m', '-t'])
const GH_PROSE_FILE_FLAGS = new Set(['--body-file', '--notes-file', '-F'])

// Form (c): the segment's text with its LITERAL message data removed. The data
// words are found by the carrier's own grammar; anything not recognised keeps
// the full text, so the reference stays and the segment is denied.
export function dataResidue(seg, words, name, opts) {
  const keep = (drop) => words.filter((_, i) => !drop.has(i)).map((w) => w.value).join(' ')
  // The kanban write tool (security surface only): its --title is card text, and
  // the tool writes kanban_cards / kanban_comments, never a security table. Run
  // as `python3 <path>/scripts/kartya-es-ertesites.py ...`, no interpreter option
  // before the script, no expansion in any word.
  if (opts?.surface === 'security' && /^python[0-9.]*$/.test(name) && KANBAN_TOOL_RX.test(words[1]?.value ?? '')
    && !words.some((w) => w.dollar)) {
    const drop = new Set()
    for (let j = 2; j < words.length; j++) {
      const v = words[j].value
      if (v === '--title') { drop.add(j + 1); j++; continue }
      if (v.startsWith('--title=')) drop.add(j)
    }
    return [keep(drop), ...seg.bodies].join('\n')
  }
  if (name === 'curl') {
    const p = parseCurl(words)
    if (!p || p.kinds.has('config')) return seg.text
    return [keep(p.dataIdx), ...(p.stdinData ? [] : seg.bodies)].join('\n')
  }
  if (name === 'git') {
    let i = 1
    while (i < words.length && words[i].value.startsWith('-')) {
      if (['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(words[i].value)) i++
      i++
    }
    if (!['commit', 'tag', 'stash'].includes(words[i]?.value)) return seg.text
    const drop = new Set()
    let stdinMsg = false
    for (let j = i + 1; j < words.length; j++) {
      const v = words[j].value
      if (v === '--message' || /^-[a-zA-Z]*m$/.test(v)) { drop.add(j + 1); j++; continue }
      if (/^-m./.test(v) || v.startsWith('--message=')) { drop.add(j); continue }
      if ((v === '-F' || v === '--file') && words[j + 1]?.value === '-') { stdinMsg = true; j++; continue }
      if (v === '-F-' || v === '--file=-') stdinMsg = true
    }
    return [keep(drop), ...(stdinMsg ? [] : seg.bodies)].join('\n')
  }
  if (name === 'gh' || name === 'glab') {
    // `gh api` sends a request of the caller's choosing: never message data
    if (words.slice(1).some((w) => w.value === 'api')) return seg.text
    const drop = new Set()
    let stdinMsg = false
    for (let j = 1; j < words.length; j++) {
      const v = words[j].value
      const eq = v.indexOf('=')
      const flag = v.startsWith('--') && eq > 0 ? v.slice(0, eq) : v
      if (GH_PROSE_FLAGS.has(flag)) {
        if (flag !== v) drop.add(j) // --body=TEXT
        else { drop.add(j + 1); j++ }
        continue
      }
      if (GH_PROSE_FILE_FLAGS.has(flag)) {
        const val = flag !== v ? v.slice(eq + 1) : words[j + 1]?.value
        if (val === '-') stdinMsg = true
        if (flag === v) j++
      }
    }
    return [keep(drop), ...(stdinMsg ? [] : seg.bodies)].join('\n')
  }
  const helperAt = (name === 'bash' || name === 'sh') ? 1 : 0
  if (words[helperAt] && AGENT_MSG_RX.test(words[helperAt].value) && !words.some((w) => w.dollar)) {
    // <from> <to> <content | -> ; stdin content comes from a heredoc or a pipe
    const contentIdx = helperAt + 3
    const drop = new Set([contentIdx])
    const stdinMsg = words[contentIdx]?.value === '-'
    return [keep(drop), ...(stdinMsg ? [] : seg.bodies)].join('\n')
  }
  return seg.text
}

// The registry tool's read-only use: `node|tsx <path>/schedule-registry-cli.(js|ts)
// status|verify ...` or `npx [--no-install|-y] tsx <path> status|verify ...`.
// No runner option before the script (`node --import X`, `-e`), no expansion
// in any word. register / unregister / no subcommand / anything else: denied.
const SCHEDULE_CLI_SCRIPT_RX = /(?:^|\/)schedule-registry-cli\.(?:[cm]?js|[cm]?ts)$/
const SCHEDULE_CLI_READ_SUBCOMMANDS = new Set(['status', 'verify'])
function isRegistryCliRead(words, name) {
  let i = 1
  if (name === 'npx') {
    while (['--no-install', '--yes', '-y'].includes(words[i]?.value)) i++
    if (words[i]?.value !== 'tsx') return false
    i++
  } else if (name !== 'node' && name !== 'tsx') return false
  const script = words[i]
  if (!script || script.dollar || script.star || !SCHEDULE_CLI_SCRIPT_RX.test(script.value)) return false
  if (!SCHEDULE_CLI_READ_SUBCOMMANDS.has(words[i + 1]?.value)) return false
  return words.every((w) => !w.dollar && !w.star)
}
// A developer sub-agent may stage, diff or log the tool's SOURCE: git index and
// history commands that never execute it, without -c (an alias or a pager is a
// command) and without an external diff driver.
const GIT_SOURCE_SUBCOMMANDS = new Set(['add', 'diff', 'log', 'show', 'status', 'blame', 'ls-files', 'grep', 'restore'])
function isGitSourceCommand(words, name) {
  if (name !== 'git') return false
  if (words.some((w) => w.dollar || /^(?:-c|--exec-path(?:=.*)?|--ext-diff|--textconv|-p|--paginate)$/.test(w.value))) return false
  return GIT_SOURCE_SUBCOMMANDS.has(words[1]?.value)
}

// The database file: a FILE-level write. Reads by any program pass; an SQL
// write on a schedule table is caught separately (SCHEDULE_SQL_WRITE_RX), and
// an SQL write through a script file is a stated limit.
const DB_FILE_WRITERS = new Set(['cp', 'mv', 'tee', 'dd', 'rm', 'ln', 'truncate', 'install', 'rsync', 'shred', 'unlink', 'touch', 'scp', 'tar', 'unzip', 'patch'])
const SQLITE_FILE_DOT_RX = /(?:^|[\s'"])\.(?:read|restore|import|load|shell|system|clone|backup|save)\b|(?:^|\s)-init\b/
function dbSegmentWrites(words, name, text) {
  if (DB_FILE_WRITERS.has(name)) return true
  if (name === 'sed' && words.some((w) => /^-[a-zA-Z]*i/.test(w.value) || w.value.startsWith('--in-place'))) return true
  if ((name === 'perl' || name === 'ruby') && words.some((w) => /^-[a-zA-Z]*i/.test(w.value))) return true
  if (/^sqlite3?$/.test(name) && SQLITE_FILE_DOT_RX.test(text)) return true
  return name === '' // an untrusted command path (./x, $X/x) naming the database
}

// Shell grammar around a command that this check steps over: a loop/branch
// keyword in front of it, or a keyword standing alone.
const CONTROL_PREFIX_RX = /^(?:(?:do|then|else|elif|if|while|until|!|\{)\s+)+/
const CONTROL_ALONE_RX = /^(?:done|fi|esac|\}|else|then|do)$/
const ASSIGN_RX = /^([A-Za-z_]\w*)=/
const DECLARE_WORDS = new Set(['export', 'local', 'declare', 'readonly', 'typeset'])

// The names an assignment-only segment (`D=~/.claude/scheduled-tasks/x`,
// `export U=...`) assigns, or null when the segment does anything else.
function assignedNames(words) {
  const rest = DECLARE_WORDS.has(words[0]?.value) ? words.slice(1).filter((w) => !/^-\w+$/.test(w.value)) : words
  if (!rest.length || !rest.every((w) => ASSIGN_RX.test(w.value))) return null
  return rest.map((w) => ASSIGN_RX.exec(w.value)[1])
}

// Words that name/shadow a command: a definition (`function`), a builtin that
// runs or redefines one (`alias`, `enable`, `builtin`, `command`, `exec`). When
// the command touches the surface, ANY of these in command position denies --
// they exist to make an allowed name (`ls`, `curl`) do something else.
const SHADOW_WORDS = new Set(['alias', 'enable', 'builtin', 'command', 'exec', 'function'])
// A function definition in command position: `name()` / `name ()` / `function name`.
const FUNCTION_DEF_RX = /^(?:function\s+[\w-]+|[\w-]+\s*\(\s*\))/

// The same invariants, applied to the WHOLE command with quoted text and
// heredoc bodies blanked, at every command position -- after `(`, `{`, `;`,
// `&`, `|`, a backtick or a newline, past `!`/keywords/env assignments -- so a
// definition opening a subshell or group (`(ls(){ cp ...; }; ls <store>)`) is
// seen too. A `name()` anywhere in unquoted shell text is a definition (or a
// syntax error), so that one needs no position at all.
const CMD_POS = String.raw`(?:^|[;&|(){}\n\x60])\s*(?:(?:!|do|then|else|elif|if|while|until|time)\s+|[A-Za-z_]\w*=\S*\s+)*(?:\S*/)?`
const ANY_FUNCTION_DEF_RX = /[\w.:-]+\s*\(\s*\)/
const SHADOW_ANYWHERE_RX = new RegExp(`${CMD_POS}(?:alias|enable|builtin|command|exec|function)(?=\\s|$)`)
// Builtins that assign a variable the taint tracking cannot see (their NAME is
// not a `NAME=value` word): printf -v, read, mapfile/readarray, getopts, and a
// nameref (declare/local/typeset -n). Once the command references the surface,
// any of them denies -- flat, instead of modelling each one's assignment.
const VAR_WRITER_RX = new RegExp(`${CMD_POS}(?:printf\\s+(?:-[^\\s]*\\s+)*-v\\b|read\\b|mapfile\\b|readarray\\b|getopts\\b|(?:declare|local|typeset)\\s+(?:-\\w+\\s+)*-\\w*n)`)
function wholeCommandShadows(command) {
  const src = String(command ?? '').replace(/\\\r?\n/g, ' ')
  const masked = maskInertLiterals(src, [], true)
  if (masked == null) return true // unresolvable: fail closed
  return ANY_FUNCTION_DEF_RX.test(masked) || SHADOW_ANYWHERE_RX.test(masked) || VAR_WRITER_RX.test(masked)
}

// The definition/shadow half of wholeCommandShadows, without the variable writers.
function wholeCommandDefines(command) {
  const masked = maskInertLiterals(String(command ?? '').replace(/\\\r?\n/g, ' '), [], true)
  return masked == null || ANY_FUNCTION_DEF_RX.test(masked) || SHADOW_ANYWHERE_RX.test(masked)
}

// Builtins that put a shell variable into the ENVIRONMENT of later commands:
// export, declare/typeset/local -x, and set -a / set -o allexport. A program
// reads its environment without spelling `$NAME` on the command line
// (`os.environ['U']`, `process.env.U`), so the taint tracking below cannot see
// that use. Once a variable carries a reference, any of these denies (flat).
const ENV_EXPORT_RX = new RegExp(`${CMD_POS}(?:export(?=\\s|$)|(?:declare|local|typeset)\\s+(?:-\\w+\\s+)*-\\w*x|set\\s+(?:-\\w*a|-o\\s+allexport))`)
function wholeCommandExports(command) {
  const masked = maskInertLiterals(String(command ?? '').replace(/\\\r?\n/g, ' '), [], true)
  return masked == null || ENV_EXPORT_RX.test(masked)
}

// The decision for one Bash command. true = deny.
//
// Once the command references the API or the store surface (raw or decoded),
// the check is FLAT and fail-closed -- it does NOT model shell state:
//   1. ANY cd/pushd/popd whose argument references the store denies the whole
//      command. A sub-agent has no reason to enter the schedule store, and this
//      removes the working-directory state machine (and its cd -/OLDPWD/failed-cd
//      bypasses) entirely. (A cd whose effect PERSISTS to a LATER Bash call, if
//      Claude Code keeps the cwd across calls, is outside a per-command gate;
//      rule 1 still denies the cd itself when it appears.)
//   2. ANY function/alias/shadow definition anywhere denies -- it can make an
//      allowed name write.
//   3. Forms (a)/(b)/(c) trust a command only by a bare name or an exact system
//      binary path (commandName), so `/tmp/cat` and `./curl` do not pass.
// The only cross-segment state left is a tainted VARIABLE (`F=<store path>;
// cat >> $F`): a value carrying a reference taints its name, and a later use of
// it counts as a reference. That only ADDS denials.
export function scheduleSurfaceDeny(command, gateOpts = {}) {
  const opts = { parentCtx: cdsIntoStoreParent(command), projectRoot: gateOpts.projectRoot, selfAgent: gateOpts.selfAgent, surface: gateOpts.surface }
  const whole = scheduleSurfaceRefs(command, opts)
  const wholeStrong = strongRef(whole)
  if (!wholeStrong && !whole.db) return false
  const segs = shellSegments(command, opts)
  if (!segs) return true // unresolvable quoting around a reference: fail closed

  const tainted = new Set()
  const dbTainted = new Set()
  const usesVar = (set, text) => [...set].some((v) => new RegExp(`\\$\\{?${v}(?!\\w)`).test(text))
  // Once a schedule reference is present, a token-file mention other than an
  // accepted `$(cat <token file>)` (already replaced by the nonce) is one too:
  // `echo ... > <root>/store/.dashboard-token; curl -q ... $(cat <it>)` would
  // otherwise rewrite the file between the gate's content check and curl.
  const tokenMention = (text) => wholeStrong && scheduleSurfaceVariants(text).some((v) => /dashboard[-_.]?token/i.test(v))
  const refsIn = (text) => strongRef(scheduleSurfaceRefs(text, opts)) || usesVar(tainted, text) || tokenMention(text)
  const dbRefsIn = (text) => scheduleSurfaceRefs(text, opts).db || usesVar(dbTainted, text)
  // A redirect target may not reference the store or the database (a tainted
  // var or the path).
  const redirectsOk = (words) => words.redirects.every((t) => t.value === '/dev/null' || (!refsIn(t.value) && !dbRefsIn(t.value)))

  // Flat invariant 2 (and the variable writers), over the whole command at every
  // command position -- a subshell/group opener is not a segment start. A
  // command that names only the database file gets the definition/shadow part:
  // a reader that pipes into `while read` must keep working.
  if (wholeStrong ? wholeCommandShadows(command) : wholeCommandDefines(command)) return true

  // Flat invariants 1 & 2, scanned across EVERY segment (a shadow/def or a cd
  // segment need carry no reference of its own).
  for (const seg of segs) {
    const own = seg.own.slice((CONTROL_PREFIX_RX.exec(seg.own)?.[0] ?? '').length).trimStart()
    if (FUNCTION_DEF_RX.test(own)) return true // rule 2: `name() {`
    const first = /^([\w./-]+)/.exec(own)?.[1] ?? ''
    const base = first.slice(first.lastIndexOf('/') + 1)
    if (SHADOW_WORDS.has(base)) return true // rule 2: alias/enable/builtin/command/exec/function
    if ((base === 'cd' || base === 'pushd' || base === 'popd') && refsIn(seg.text)) return true // rule 1
  }

  let carried = false
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k]
    const own = seg.own.slice((CONTROL_PREFIX_RX.exec(seg.own)?.[0] ?? '').length)
    if (CONTROL_ALONE_RX.test(own.trim()) && !seg.bodies.length) continue
    const view = { ...seg, own, text: [own, ...seg.bodies].join('\n') }
    const strong = refsIn(view.text)
    const db = !strong && dbRefsIn(view.text)
    if (!strong && !db) continue // no reference in this segment -> not this segment's problem
    carried = true
    const words = shellWords(own)
    if (!words) return true
    // Only redirections / a bare heredoc, no command word: not a known form, and
    // a bare `> file` truncates. (Guards words[0] too: a throw here exits 1,
    // which PreToolUse does not block.)
    if (!words.length) return true
    if (!redirectsOk(words)) return true
    const names = assignedNames(words)
    if (names) { names.forEach((n) => (strong ? tainted : dbTainted).add(n)); continue } // an assignment writes nothing
    if (words[0].value === 'for' && /^[A-Za-z_]\w*$/.test(words[1]?.value ?? '')) { (strong ? tainted : dbTainted).add(words[1].value); continue }
    const name = commandName(words) // '' for an untrusted path -> matches no form -> deny
    if (db) {
      if (dbSegmentWrites(words, name, view.text)) return true
      continue
    }
    // A reference that sits in a heredoc body, with the command's output going
    // to a file: `cat <<'X' > /tmp/s.sh ... X; bash /tmp/s.sh`. The file is a
    // script the next segment can run, so no redirect but /dev/null is
    // accepted there -- whatever the consumer (message carriers included).
    // The security surface (db-write-gate) asks the narrower question, for the main agent writes its message and
    // comment files this way: the file is a script only when the same command then runs or feeds it (laterRuns).
    const fileTargets = words.redirects.map((t) => t.value).filter((v) => v !== '/dev/null')
    const scriptFile = opts.surface !== 'security' || laterRuns(segs, k, fileTargets)
    if (seg.bodies.length && refsIn(seg.bodies.join('\n')) && fileTargets.length && scriptFile) return true
    const residue = dataResidue(view, words, name, opts)
    // The security surface reads the same of any output: SQL text written to a
    // file (`printf 'UPDATE approvals ..' > s.sql; sqlite3 db < s.sql`) is a
    // statement file the next segment runs, whichever command wrote it.
    if (opts.surface === 'security' && fileTargets.length && scriptFile && refsIn(residue)) return true
    if (!refsIn(residue)) continue // (c) only message data mentions it
    if (name === 'curl' && isPlainCurlGet(words)) continue // (a)
    if (isReadOnlyFsCommand(words, name) && pipesOnlyIntoSinks(segs, k, redirectsOk)) continue // (b)
    // the registry tool's read-only subcommands, and git on its source
    const r = scheduleSurfaceRefs(view.text, opts)
    const cliOnly = r.cli && !r.api && !r.dir && !r.sql && !usesVar(tainted, view.text) && !tokenMention(view.text)
    if (cliOnly && (isRegistryCliRead(words, name) || isGitSourceCommand(words, name)) && pipesOnlyIntoSinks(segs, k, redirectsOk)) continue
    return true
  }
  // A variable that carries a reference must not reach a program's environment.
  if (tainted.size && wholeCommandExports(command)) return true
  // The whole command references the surface but no single segment does: the
  // reference only exists across a boundary this parser drew. Fail closed.
  return !carried
}

// Native file tools: a path through a *scheduled-tasks directory (same scope
// as SCHEDULE_DIR_REF_RX, see there).
const SCHEDULE_DIR_PATH_RX = /scheduled-tasks([/\\]|$)/i

// The base denies every path through a task dir. The one exception is a REPO COPY (isRepoCopyPath below):
// a task dir of the STORE is the store. The runner's store and the linked config
// dirs sit below a store parent (~/.claude, ~/.claude-config, <agent>/.claude-config,
// ~/.channels-config); this install's own scheduled-tasks/ and seed-scheduled-tasks/ are
// copied into the store at start. A fleet's config repo keeps a DIFFERENT copy of task
// prompts (<repo>/common/scheduled-tasks/...), edited in a git worktree and deployed only
// through review: a native Edit/Write of such a copy is not a self-schedule. The path is
// judged in its canonical form: `..` resolved and the deepest existing ancestor resolved
// through symlinks (realDeep, a dangling link is followed), so a copy-looking path that
// links onto the store is the store. Three spellings are judged and any one denies: the kernel's
// view, the same after the lexical `..` folding, and the lexical spelling itself (a store behind a
// symlinked ~/.claude is still named .claude). The decision is made when the hook runs: a symlink
// swapped in later is not seen. The Bash branch is unchanged (git can run a pager or a helper).
const STORE_PARENT_SEGMENTS = new Set(['.claude', '.claude-config', '.channels-config'])
function isStoreTaskPath(canonical, root = PROJECT_ROOT) {
  const segs = canonical.split(/[\\/]+/).map((s) => s.toLowerCase())
  // a store parent segment followed by a task dir segment, wherever the pair sits in the path
  const firstParent = segs.findIndex((s) => STORE_PARENT_SEGMENTS.has(s))
  const lastTaskDir = segs.map((s) => s.endsWith('scheduled-tasks')).lastIndexOf(true)
  if (firstParent >= 0 && lastTaskDir > firstParent) return true
  // the store parents of this home, resolved when the hook runs: a task dir under the TARGET of a symlinked
  // ~/.claude (dotfiles/cc/<task dir>) is the store although no segment of that path says so
  const lower = canonical.toLowerCase()
  for (const name of STORE_PARENT_SEGMENTS) {
    const real = realDeep(join(homedir(), name)).toLowerCase()
    if (lower.startsWith(real + sep) && SCHEDULE_DIR_PATH_RX.test(lower.slice(real.length))) return true
  }
  // ...and the same for the store parents of every agent of this install (<install>/agents/<name>/.claude-config
  // linked to a target of another name): the target path is the store as well. An agents/ dir that cannot be
  // listed for any reason but "missing" denies, like the HOME loop never lets a task dir under a store pass.
  let agentNames
  try { agentNames = readdirSync(join(root, 'agents')) } catch (e) {
    if (!e || e.code !== 'ENOENT') return true
    agentNames = []
  }
  for (const agent of agentNames) {
    for (const name of STORE_PARENT_SEGMENTS) {
      const real = realDeep(join(root, 'agents', agent, name)).toLowerCase()
      if (lower.startsWith(real + sep) && SCHEDULE_DIR_PATH_RX.test(lower.slice(real.length))) return true
    }
  }
  // the install root's own task dirs, without regard to letter case (the name rule above is case-insensitive)
  for (const d of ['scheduled-tasks', 'seed-scheduled-tasks']) {
    const dir = realDeep(join(root, d)).toLowerCase()
    if (lower === dir || lower.startsWith(dir + sep)) return true
  }
  return false
}
// The ONLY allowing branch (the base denied EVERY task dir path, so a path
// the store rules do not name must not pass by default): a repo copy. R is the nearest ancestor of the
// canonical path that holds a `.git` (a directory, or a FILE for a git worktree; the file system is
// looked at, no git process runs in a hook), and the path below R is exactly common/scheduled-tasks/...
// (letter case ignored) with no store parent segment (.claude, .claude-config, .channels-config) in it.
// HOME itself may be R. Anything else denies.
function isRepoCopyPath(canonical) {
  let cur = canonical
  for (;;) {
    const up = dirname(cur)
    if (up === cur) return false
    cur = up
    try { lstatSync(join(cur, '.git')); break } catch { /* no .git here: walk up */ }
  }
  const segs = relative(cur, canonical).split(/[\\/]+/).map((x) => x.toLowerCase())
  if (segs.length < 3 || segs[0] !== 'common' || segs[1] !== 'scheduled-tasks') return false
  return !segs.some((x) => STORE_PARENT_SEGMENTS.has(x))
}
function scheduleDirPathDenied(fp, cwd, root = PROJECT_ROOT) {
  if (!SCHEDULE_DIR_PATH_RX.test(fp)) return false
  // an absolute spelling that keeps every `..` as written (a symlink before a `..` is followed by the kernel,
  // not folded away), a leading ~/ expanded and a relative path taken from the hook's cwd
  const abs = fp.startsWith('~/') ? homedir() + sep + fp.slice(2) : isAbsolute(fp) ? fp : (cwd || process.cwd()) + sep + fp
  // three spellings, any one denies: the kernel's view (symlinks followed), the same after the lexical
  // `..` folding, and the lexical spelling itself (the store behind a symlinked ~/.claude is still named .claude)
  const forms = [realDeep(abs), realDeep(resolve(abs)), resolve(abs)]
  if (forms.some((c) => isStoreTaskPath(c, root))) return true
  // not the store: a task dir path still denies unless it is a repo copy in EVERY spelling (the store rules above
  // deny on any one, so the one allowing branch must hold on all of them: a `..` that folds onto an unnamed
  // store is no copy even when the kernel's view is one)
  return !forms.every((c) => isRepoCopyPath(c))
}

// A scheduler command word the shell builds from quotes or a backslash ('crontab' -r, cr''ontab, c\rontab)
// reads as the same command, but the OS-scheduler rule matches the MASKED text (quoted = data) and a
// quoted or escaped name passed. The command word of each code segment is judged in its dequoted form
// too; a plain $VAR / "$VAR" / ${VAR} command word is resolved when the SAME command assigned it a
// literal in an earlier assignment-only segment (X=crontab; $X -r). Arguments, quoted messages and
// heredoc bodies are not command words and stay data. PARTIAL by design: a name glued from several
// variables or copied through another variable is not resolved (accepted limit).
// Only a name that matches BECAUSE of the dequoting or the resolution is judged here: when the plain spelling
// of the segment already matches the rule, the rule above decided it (its read-listing exemption included).
// So a dequoted name has no read exemption: crontab -l written as cr""ontab -l is denied as well.
// A resolved name is carried into the shell code a segment hands to another shell (eval, sh -c, $(...)),
// through opts.vars: every literal value this command ever gave a name (an assignment behind && / || / if may or may
// not have run, so each literal stays a candidate), plus the NAME=literal prefixes a child inherits.
const LITERAL_VALUE = '[^$`(){}<>;&|*[\\\\\\s]*'
const LITERAL_ASSIGNMENT_RX = new RegExp(`^([A-Za-z_][A-Za-z0-9_]*)=(${LITERAL_VALUE})$`)
const ANSI_ASSIGNMENT_RX = /^([A-Za-z_][A-Za-z0-9_]*)=\$'([A-Za-z0-9_./-]*)'$/
const ANY_ASSIGNMENT_RX = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/
const VARIABLE_WORD_RX = /^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})$/
const DEFAULT_WORD_RX = new RegExp(`^\\$\\{([A-Za-z_][A-Za-z0-9_]*)(:?)[-=](${LITERAL_VALUE})\\}$`)
const MAX_WORD_COMBINATIONS = 256
const DECLARATION_BUILTINS = new Set(['export', 'declare', 'readonly', 'local', 'typeset'])
const literalAssignment = (w) => {
  const m = w.ansi ? ANSI_ASSIGNMENT_RX.exec(w.value) : LITERAL_ASSIGNMENT_RX.exec(w.value)
  return m ? [m[1], m[2]] : null
}
// `text` with the code of every backtick or $( ) substitution blanked: that code is decided on its own (the bodies
// of the caller), so a scheduler name inside it must not stand for the command word of the segment.
function blankSubstitutions(text) {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') { out += text.slice(i, i + 2); i++; continue }
    if (text[i] === '`') {
      const e = text.indexOf('`', i + 1)
      const end = e === -1 ? text.length - 1 : e
      out += ' '.repeat(end - i + 1)
      i = end
      continue
    }
    if (text[i] === '$' && text[i + 1] === '(') {
      let depth = 0
      let j = i + 1
      for (; j < text.length; j++) {
        if (text[j] === '(') depth++
        else if (text[j] === ')' && --depth === 0) break
      }
      const end = j >= text.length ? text.length - 1 : j
      out += ' '.repeat(end - i + 1)
      i = end
      continue
    }
    out += text[i]
  }
  return out
}
// The command without its heredocs: each operator (with the file descriptor in front of it, 0<<EOF) and each body with
// its terminator are cut out, using the ranges the mask resolved. The mask copies the rest of an operator line as
// written, so a `;` inside a quoted redirect target (`cmd <<EOF 2>"a;b"`) cut the segment into two halves that do not
// parse, and the dequoted check skipped both; without the operator the quoting is plain again and the segment splits
// the way the shell reads it. Quoting the mask cannot resolve (null) leaves the command as it is. The mask resolves
// one heredoc per line, so the cut repeats until nothing is left to cut (a second operator on the same line).
function withoutHeredocs(command) {
  let cur = String(command ?? '')
  for (let round = 0; round < 4; round++) {
    const next = cutHeredocsOnce(cur)
    if (next === cur) break
    cur = next
  }
  return cur
}
function cutHeredocsOnce(command) {
  const src = String(command ?? '').replace(/\\\r?\n/g, ' ')
  const heredocs = []
  if (maskInertLiterals(src, heredocs) == null || heredocs.length === 0) return command
  const cuts = []
  for (const h of heredocs) {
    const op = /^<<-?\s*(?:'[^']*'|"[^"]*"|[A-Za-z_]\w*)/.exec(src.slice(h.opStart))
    if (!op) return command
    const fd = /(?:^|[\s;&|(])(\d+|\{[A-Za-z_]\w*\})$/.exec(src.slice(0, h.opStart))
    cuts.push([fd ? h.opStart - fd[1].length : h.opStart, h.opStart + op[0].length, ' '])
    cuts.push([h.bodyStart, h.end, ''])
  }
  cuts.sort((x, y) => x[0] - y[0])
  let out = ''
  let at = 0
  for (const [from, to, fill] of cuts) {
    if (from < at) return command // overlapping ranges: not understood
    out += src.slice(at, from) + fill
    at = to
  }
  return out + src.slice(at)
}
// One code segment the way the OS-scheduler rule reads it: a heredoc operator dropped (the segment of the command as
// written still carries it, without its body), quoted = data and substitution code blanked (that code is decided on
// its own). A segment that reaches this point parsed into plain words, so its quoting resolves; if it does not
// anyway, '' gives no exemption and the dequoted word is judged.
function schedulerRuleView(own) {
  const masked = maskInertLiterals(own.replace(/<<-?\s*(?:'[^']*'|"[^"]*"|[A-Za-z_]\w*)/g, ' '))
  return masked == null ? '' : blankSubstitutions(masked)
}
// Both readings of the command are judged, the text as written and the text without its heredocs, and either one
// denies: the cut only ever ADDS what the first reading could not parse. The mask can read a `<<` that is no
// operator (in a comment, in $((1<<2)), in a here-string) as one, so the cut may also remove real code; the first
// reading still sees that code.
function dequotedSchedulerDeny(command, inherited) {
  const plainView = scanDequoted(command, inherited)
  const cut = withoutHeredocs(command)
  if (cut === command) return plainView
  const cutView = scanDequoted(cut, inherited)
  const vars = new Map()
  for (const [name, set] of [...plainView.vars, ...cutView.vars]) {
    if (!vars.has(name)) vars.set(name, new Set())
    for (const value of set) vars.get(name).add(value)
  }
  return { deny: plainView.deny || cutView.deny, vars }
}
function scanDequoted(command, inherited) {
  const addTo = (map, name, value) => {
    if (!map.has(name)) map.set(name, new Set())
    map.get(name).add(value)
  }
  const vars = new Map() // name -> the set of literal values it was ever given
  for (const [name, v] of inherited ?? []) for (const value of typeof v === 'string' ? [v] : v) addTo(vars, name, value)
  const childEnv = new Map() // NAME=literal prefixes of a command: its child shell inherits them
  let deny = false
  for (const seg of codeSegments(command)) {
    const words = splitCodeWords(seg.own)
    if (words == null) continue
    let args = argWords(words)
    // for NAME in literal
    if (args.length === 4 && args[0].value === 'for' && args[2].value === 'in' && !args[3].ansi && new RegExp(`^${LITERAL_VALUE}$`).test(args[3].value)) {
      addTo(vars, args[1].value, args[3].value)
      continue
    }
    // export / declare / readonly / local / typeset [-options] NAME=literal: assignments that outlive the segment
    const declaration = args.length > 0 && DECLARATION_BUILTINS.has(args[0].value)
    if (declaration) {
      let k = 1
      while (args[k] && /^[-+]/.test(args[k].value)) k++
      args = args.slice(k)
    }
    if ((declaration || args.length > 0) && args.every((w) => ANY_ASSIGNMENT_RX.test(w.value))) {
      // an assignment-only segment: the shell keeps these values for the later segments
      for (const w of args) {
        const lit = literalAssignment(w)
        if (lit) addTo(vars, lit[0], lit[1])
      }
      continue
    }
    // every value a word can take: a name holds each literal it was ever given
    // null = an empty expansion: the shell drops it, the next word moves up
    const noEmpty = (v) => (v === '' ? null : v)
    const candidates = args.map((w) => {
      if (w.ansi) return [w.value]
      const ref = VARIABLE_WORD_RX.exec(w.value)
      const name = ref ? ref[1] ?? ref[2] : null
      if (name != null && vars.has(name)) return [...vars.get(name)].map(noEmpty)
      const dflt = DEFAULT_WORD_RX.exec(w.value) // ${NAME:-literal}, ${NAME-literal}, ${NAME:=literal}, ${NAME=literal}
      if (dflt) {
        const [, dname, colon, lit] = dflt
        if (!vars.has(dname)) return [noEmpty(lit)]
        // the :- and := forms also take the literal when the name is set but EMPTY; - and = only when it is unset
        return [...new Set([...vars.get(dname)].map((v) => (v === '' ? noEmpty(colon ? lit : '') : v)))]
      }
      return [w.value]
    })
    // only the words the scheduler rule reads (wrapper and assignment prefixes, the command word and what follows it)
    // are listed in every reading; a later argument keeps its first reading, so a long argument list of
    // many-valued names is not read as a scheduler. A word that can BE a prefix in some reading (empty, a wrapper,
    // an assignment) is not the command word.
    const prefixLike = (v) => v == null || CMD_WRAPPERS.has(v) || RESERVED_LEAD.has(v) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(v)
    const cmdAt = candidates.findIndex((options) => !options.some(prefixLike))
    if (cmdAt >= 0) for (let k = cmdAt + 6; k < candidates.length; k++) candidates[k] = [candidates[k][0]]
    // NAME=literal prefixes in front of the command word reach the child shell's environment
    for (let k = 0; k < args.length && ANY_ASSIGNMENT_RX.test(args[k].value); k++) {
      const lit = literalAssignment(args[k])
      if (lit) addTo(childEnv, lit[0], lit[1])
    }
    let combinations = [[]]
    for (const options of candidates) {
      combinations = combinations.flatMap((prefix) => options.map((v) => [...prefix, v]))
      // too many readings to list: read as a scheduler (fail-closed)
      if (combinations.length > MAX_WORD_COMBINATIONS) {
        deny = true
        combinations = []
        break
      }
    }
    // the plain-spelling test sees the text the way the rule above does (quoted = data), not the raw segment:
    // a quoted decoy such as 2>"/tmp/a;crontab" must not switch the dequoted check off
    const plain = schedulerRuleView(seg.own.trim())
    for (const reading of combinations) {
      const values = reading.filter((v) => v != null)
      // a reserved word in front of the command (then, do, {, !) is not the command word
      let lead = 0
      while (values.length - lead > 1 && RESERVED_LEAD.has(values[lead])) lead++
      // one flat word per argument: a separator or a space INSIDE a quoted argument cannot start a new command
      const joined = values.slice(lead).map((v) => v.replace(/[\s;&|(`]/g, '_')).join(' ')
      if (SCHEDULER_RX.test(joined) && !SCHEDULER_RX.test(plain)) deny = true
    }
  }
  const out = new Map()
  for (const [name, set] of [...vars, ...childEnv]) for (const value of set) addTo(out, name, value)
  return { deny, vars: out }
}

// Pure decision: does this tool call set up self-pace / self-injection?
// Any exception inside the decision is a DENY: a gate that throws must never
// be read as "nothing to block" (see also the hook entry below).
export function gateDecision(toolName, toolInput, opts = {}) {
  try {
    return decide(toolName, toolInput, opts)
  } catch (err) {
    return { deny: true, error: String(err?.stack ?? err) }
  }
}

// Small word splitter for the shell-code and tmux checks (shellWords/readWord
// stay as they are, other checks depend on them). Returns [{ value, ansi }] or
// null on an unterminated quote. $(...), backticks and ${...} stay plain text in
// the word: they are tracked only so a space inside one does not split the word.
// Unquoted ( and ) end a word and are dropped. Unquoted < and > end a word and
// start a redirection operator, emitted as its own word with redirect: true; the
// word after it is its target (target: true). A word with an unquoted bash brace
// expansion (`{a,b}`, `{1..3}`) gets brace: true.
function splitCodeWords(text) {
  const words = []
  let cur = null
  let i = 0
  let expectTarget = false
  let braceOpen = false
  let braceSep = false
  const add = (s, ansi) => {
    if (cur == null) {
      cur = { value: '', ansi: false }
      braceOpen = false
      braceSep = false
      if (expectTarget) {
        cur.target = true
        expectTarget = false
      }
    }
    cur.value += s
    if (ansi) cur.ansi = true
  }
  let depth = 0
  let tick = false
  while (i < text.length) {
    const c = text[i]
    if (depth === 0 && !tick && (c === ' ' || c === '\t')) {
      if (cur) words.push(cur)
      cur = null
      i++
    } else if (c === '#' && cur == null && depth === 0 && !tick) {
      // an unquoted # at a word start comments out the rest of the line, so an
      // apostrophe there (`# don't`) is not an unterminated quote
      const nl = text.indexOf('\n', i)
      i = nl < 0 ? text.length : nl
    } else if (c === "'") {
      const end = text.indexOf("'", i + 1)
      if (end < 0) return null
      add(text.slice(i + 1, end))
      i = end + 1
    } else if (c === '"') {
      let j = i + 1
      let s = ''
      for (;;) {
        if (j >= text.length) return null
        if (text[j] === '"') break
        if (text[j] === '\\' && '"\\$`'.includes(text[j + 1] ?? '')) j++
        s += text[j]
        j++
      }
      add(s)
      i = j + 1
    } else if (c === '$' && text[i + 1] === "'") {
      let j = i + 2
      for (;;) {
        if (j >= text.length) return null
        if (text[j] === '\\') j++
        else if (text[j] === "'") break
        j++
      }
      add(text.slice(i, j + 1), true)
      i = j + 1
    } else if (c === '\\') {
      if (i + 1 < text.length) add(text[i + 1])
      i += 2
    } else if (depth === 0 && !tick && (c === '(' || c === ')')) {
      if (cur) words.push(cur)
      cur = null
      i++
    } else if (depth === 0 && !tick && (c === '<' || c === '>')) {
      let prefix = ''
      if (cur && (cur.value === '' || /^\d+$/.test(cur.value) || cur.value === '&')) {
        prefix = cur.value
        cur = null
      } else if (cur) {
        words.push(cur)
        cur = null
      }
      let j = i
      while (j < text.length && '<>&|-'.includes(text[j])) j++
      words.push({ value: prefix + text.slice(i, j), ansi: false, redirect: true })
      expectTarget = true
      i = j
    } else {
      if (c === '`') tick = !tick
      else if (c === '$' && (text[i + 1] === '(' || text[i + 1] === '{')) {
        depth++
        add(c + text[i + 1])
        i += 2
        continue
      } else if (depth > 0 && (c === ')' || c === '}')) depth--
      add(c)
      if (depth === 0 && !tick) {
        if (c === '{') {
          braceOpen = true
          braceSep = false
        } else if (braceOpen && (c === ',' || (c === '.' && text[i + 1] === '.'))) braceSep = true
        else if (c === '}' && braceOpen && braceSep) cur.brace = true
      }
      i++
    }
  }
  if (cur) words.push(cur)
  return words
}

const SHELL_NAMES = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh', 'ash', 'fish', 'csh', 'tcsh', 'mksh', 'rbash', 'yash', 'posh'])
const baseName = (v) => v.slice(v.lastIndexOf('/') + 1)

// The words without redirection operators and their targets: the command's
// own arguments.
const argWords = (words) => words.filter((w) => !w.redirect && !w.target)

// tmux global options: flags (combinable) and options taking a value (attached
// or as the next word). Returns { next, codes } where next is the index of the
// tmux command word and codes the words given to -c.
function tmuxGlobalOptions(words, from) {
  const codes = []
  let i = from
  while (i < words.length) {
    const v = words[i].value
    if (!/^-[2CDlNuvVcfLST]/.test(v)) break
    let consumedNext = false
    for (let j = 1; j < v.length; j++) {
      if ('2CDlNuvV'.includes(v[j])) continue
      if (!'cfLST'.includes(v[j])) break
      const attached = v.slice(j + 1)
      let val = null
      if (attached) val = { value: attached, ansi: words[i].ansi }
      else if (words[i + 1]) {
        val = words[i + 1]
        consumedNext = true
      }
      if (v[j] === 'c' && val) codes.push(val)
      break
    }
    i += consumedNext ? 2 : 1
  }
  return { next: i, codes }
}

// How many following words a shell option word takes as its values: one per o/O letter in a
// short-option bundle (bash -oc pipefail 'code'), one for --rcfile/--init-file, else none.
function optionValueCount(v) {
  if (/^[-+][A-Za-z]+$/.test(v)) return (v.match(/[oO]/g) ?? []).length
  if (v === '--rcfile' || v === '--init-file') return 1
  return 0
}

// What one shell word in `words` (at index i) runs: { codes } the words given
// as code strings (-c; for fish also -C, --command, --init-command), and
// { stdin } when no code string is given, so the word may read its code from
// stdin (whatever its operand is).
// strictStdin (Refs #2974, #2975, the db-write-gate's shell-code reading): a non-fish shell reads its code from stdin
// only with no script operand, or with -s; `bash script.sh <<'E' ... E` hands the body to the script as data. The
// default (false) keeps the wider reading for the other callers.
function shellWordRuns(words, i, strictStdin = false) {
  const fish = baseName(words[i].value) === 'fish'
  const codes = []
  let cGiven = false
  let sGiven = false
  let mainGiven = false
  let operand = false
  for (let j = i + 1; j < words.length; j++) {
    const v = words[j].value
    if (!/^[-+]/.test(v) || v === '--') {
      // fish: a -c/-C/--command/--init-command anywhere still runs code
      if (!fish) { operand = v !== '--' || j + 1 < words.length; break }
      operand = true
      continue
    }
    if (fish && /^-[^-]/.test(v) && /[cC]/.test(v.slice(1))) {
      const k = v.slice(1).search(/[cC]/) + 1
      const rest = v.slice(k + 1)
      if (v[k] === 'c' && !operand) mainGiven = true
      if (rest === '') {
        if (words[j + 1]) codes.push(words[j + 1])
        j++
      } else {
        codes.push({ value: rest, ansi: words[j].ansi })
      }
      continue
    }
    if (fish && (v === '--command' || v === '--init-command')) {
      if (v === '--command' && !operand) mainGiven = true
      if (words[j + 1]) codes.push(words[j + 1])
      j++
      continue
    }
    if (fish && (v.startsWith('--command=') || v.startsWith('--init-command='))) {
      if (v.startsWith('--command=') && !operand) mainGiven = true
      codes.push({ value: v.slice(v.indexOf('=') + 1), ansi: words[j].ansi })
      continue
    }
    if (/^-[A-Za-z]+$/.test(v) && v.includes('c')) cGiven = true
    if (/^-[A-Za-z]+$/.test(v) && v.includes('s')) sGiven = true
    j += optionValueCount(v)
  }
  if (!fish && cGiven) {
    // the code string is the first non-option word after the options
    let j = i + 1
    for (; j < words.length; j++) {
      const v = words[j].value
      if (!/^[-+]/.test(v)) break
      if (v === '--') { j++; break }
      j += optionValueCount(v)
    }
    if (words[j]) codes.push(words[j])
  }
  return { codes, stdin: fish ? !mainGiven : !cGiven && (!strictStdin || !operand || sGiven) }
}

// shellSegments cuts at an escaped `\;` (tmux's own command separator); glue
// such pieces back together so `tmux a \; send-keys` stays one segment.
function codeSegments(command) {
  const segs = shellSegments(command)
  if (segs == null) {
    const whole = String(command ?? '')
    const out = [{ own: whole, bodies: [] }]
    for (const piece of splitSegments(whole)) {
      const own = piece.trim()
      if (own) out.push({ own, bodies: [], naive: true })
    }
    return out
  }
  const out = []
  for (const seg of segs) {
    const prev = out[out.length - 1]
    if (prev && prev.sep === ';' && /(?:^|[^\\])(?:\\\\)*\\$/.test(prev.own)) {
      out[out.length - 1] = { ...seg, own: prev.own + '; ' + seg.own, bodies: [...prev.bodies, ...seg.bodies] }
    } else out.push(seg)
  }
  return out
}

// Every piece of shell code the command hands to another shell as
// { value, ansi }, plus `bad` when a segment holding a shell word, eval or tmux
// could not be split (unterminated quote) or hides such a word behind $'..' or a
// brace expansion.
const HIDDEN_NAMES = new Set([...SHELL_NAMES, 'eval', 'trap', 'tmux', 'systemctl'])
const CMD_WRAPPERS = new Set(['env', 'sudo', 'command', 'builtin', 'exec', 'nohup', 'nice', 'time', 'stdbuf', 'setsid', 'xargs'])
const RESERVED_LEAD = new Set(['!', '{', 'if', 'then', 'elif', 'else', 'do', 'while', 'until'])
// Index of the command word in a segment: the first word that is not a VAR=val
// assignment, a wrapper or a reserved leading word; -1 if there is none.
function commandWordIndex(args) {
  return args.findIndex((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w.value) && !CMD_WRAPPERS.has(w.value) && !RESERVED_LEAD.has(w.value))
}
const EVAL_QUOTING_COMMANDS = new Set(['echo', 'printf', 'grep', 'egrep', 'fgrep', 'rg', 'sed', 'awk', 'cat', 'jq', 'test', '[', 'man', 'which', 'type'])

// A command NAME that comes out of a substitution is invisible to this gate. The shell runs
// the OUTPUT of `$(echo crontab -r)` as the command, while the text only shows `echo`; a flat $(...)
// is even turned into an opaque marker before the segments are parsed, and the marker in command
// position denied nothing. Fail-closed: a word in COMMAND POSITION (the command itself, or what a
// wrapper such as env, exec, timeout, nice or xargs runs) that contains a substitution -- $(...),
// backticks or <(...), bare or inside "..." -- denies. So does a <(...) that `source`, `.` or a
// shell reads as code, without modelling the shell's own option grammar. An assignment (also an
// array literal), an argument, a quoted argument, data and a plain $VAR command word stay allowed
// ($VAR as a command name is common in real commands and was never resolved here).
// The scan is its own on purpose: shellSegments also cuts inside "...$(a | b)...", so its pieces
// look like commands (measured on real commands: 108 of 123 false denials).
// A heredoc body is data unless its TAG is unquoted: then it expands like "...", and the
// substitutions in it are scanned as such. eval, `sh -c` and a heredoc a shell reads are decided
// again by decide() as code of their own (scanShellCode); a resolved substitution reaches that
// recursion as a NUL marker, which counts as a substitution here.
const DYN_WRAPPERS = new Set([...CMD_WRAPPERS, 'timeout', 'gtimeout'])
const DYN_RESERVED = new Set([...RESERVED_LEAD, 'coproc'])
const DYN_CODE_READERS = new Set(['source', '.', ...SHELL_NAMES])
// shells whose option grammar the scanner models (the bash one); any other shell has options of its own, with values
const DYN_MODELLED_SHELLS = new Set(['bash', 'rbash', 'sh', 'dash'])
const DYN_ASSIGNMENT_RX = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/
const DYN_ARRAY_OPEN_RX = /^[A-Za-z_][A-Za-z0-9_]*\+?=$/
const ANSI_C_ESCAPES = { a: '\x07', b: '\b', e: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' }
// wrapper options whose NEXT word is their value (an attached value, -uroot or --user=root, takes none)
const DYN_WRAPPER_VALUE_OPTS = {
  sudo: ['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-T', '-U', '--user', '--group', '--host', '--prompt', '--close-from', '--chdir', '--role', '--type', '--command-timeout', '--other-user'],
  env: ['-u', '-C', '-S', '--unset', '--chdir', '--split-string'],
  nice: ['-n', '--adjustment'],
  timeout: ['-s', '-k', '--signal', '--kill-after'],
  gtimeout: ['-s', '-k', '--signal', '--kill-after'],
  stdbuf: ['-i', '-o', '-e', '--input', '--output', '--error'],
  xargs: ['-I', '-n', '-P', '-L', '-s', '-d', '-E', '-a', '--max-args', '--max-procs', '--max-lines', '--max-chars', '--delimiter', '--eof', '--arg-file', '--replace'],
  time: ['-f', '-o', '--format', '--output'],
}
// env's short options in one word (-iS, -vu, -C/tmp): split = the bundle holds an S, whose rest of the word (or, when it ends the
// bundle, the next word) env runs as a command line; attached = a value follows the letter inside the word. null: no S / u / C.
function envBundle(plain) {
  if (!/^-[^-]/.test(plain)) return null
  for (let k = 1; k < plain.length; k++) {
    const ch = plain[k]
    if (ch === 'S' || ch === 'u' || ch === 'C') return { split: ch === 'S', attached: k < plain.length - 1 }
  }
  return null
}
// opts.heredoc: the text is an UNQUOTED heredoc body: it expands like "...", except that a " is an ordinary
// character there and a backslash escapes only $ ` \ and a newline. opts.any: (heredoc only) the body is the
// script of a shell, so ANY substitution in it denies. opts.bodies: the CALLER's list; the code of each
// outermost $(...), `...`, <(...) and >(...) is pushed to it, for decide() to decide again as a command of its own.
export function substitutionInCommandPosition(command, { heredoc: asHeredocBody = false, any = false, bodies = null } = {}) {
  const s = String(command ?? '')
  let found = false
  let nest = 0 // code frames of a substitution we are inside of
  let closed = false // set by scanCode: did the frame end on its closer
  const newWord = () => ({ raw: '', plain: '', subst: false, bare: false, proc: false })

  // $((, $(, ${ or a backtick at i: scan the whole construct, return the index after it (-1: none).
  // keepRaw: the opener is also recorded in the raw spelling of the word (code context only).
  function expansionAt(i, w, keepRaw, bare = keepRaw) {
    const c = s[i]
    const n = s[i + 1]
    if (c === '$' && n === '(' && s[i + 2] === '(') {
      if (keepRaw) w.raw += '$(('
      return scanBalanced(i + 3, w, 'arith')
    }
    if (c === '$' && n === '(') {
      if (keepRaw) w.raw += '$('
      w.subst = true
      if (bare) w.bare = true // unquoted: the output is split into words
      return enterCode(i + 2, ')')
    }
    if (c === '$' && n === '{') {
      if (keepRaw) w.raw += '${'
      return scanBalanced(i + 2, w, 'param', bare)
    }
    if (c === '$' && n === '[') {
      if (keepRaw) w.raw += '$['
      return scanBalanced(i + 2, w, 'bracket')
    }
    if (c === '`') {
      if (keepRaw) w.raw += c
      w.subst = true
      if (bare) w.bare = true
      return scanBacktick(i + 1)
    }
    return -1
  }

  // the code frame of a substitution ($(...), <(...), >(...)); the outermost ones hand their text to the caller
  function enterCode(from, close) {
    const outermost = nest === 0
    nest++
    const end = scanCode(from, close)
    nest--
    if (outermost && bodies) bodies.push(s.slice(from, closed ? end - 1 : end))
    return end
  }

  // `...`: the shell finds the closing backtick first (a comment ends there, too), then undoes \$ \` \\ in the
  // text and runs THAT as code; so the inside is cut out, unescaped and scanned as a command line of its own
  function scanBacktick(i) {
    let e = i
    while (e < s.length && s[e] !== '`') e += s[e] === '\\' ? 2 : 1
    e = Math.min(e, s.length)
    const text = s.slice(i, e).replace(/\\([$`\\])/g, '$1')
    if (nest === 0 && bodies) bodies.push(text)
    if (substitutionInCommandPosition(text)) found = true
    return Math.min(e + 1, s.length)
  }

  // $'...': ANSI-C quoting, a \' inside does not end it
  function ansiCEnd(i) {
    while (i < s.length && s[i] !== "'") i += s[i] === '\\' ? 2 : 1
    return Math.min(i + 1, s.length)
  }

  // the inside of "...", from after the opening quote; returns the index after the closing one
  function scanDq(i, w, heredoc = false, anySubst = false) {
    while (i < s.length && !found) {
      const c = s[i]
      if (c === '\0') { w.subst = true; i++; continue }
      if (c === '"' && !heredoc) return i + 1
      if (c === '\\' && heredoc) {
        const n = s[i + 1]
        // the heredoc unescapes \$ and \` : a shell that reads the body as its script then gets a live $( or `
        if (anySubst && (n === '`' || (n === '$' && s[i + 2] === '('))) { found = true; return i }
        if (n === '\n') i += 2
        else if (n !== undefined && '$`\\'.includes(n)) { w.plain += n; i += 2 }
        else { w.plain += c; i++ }
        continue
      }
      if (c === '\\') { if (s[i + 1] !== '\n') w.plain += s[i + 1] ?? ''; i += 2; continue }
      const j = expansionAt(i, w, false)
      if (j >= 0) { i = j; continue }
      w.plain += c
      i++
    }
    return i
  }

  // ${...}, $((...)) and an array literal x=(...): no command position of their own, but a
  // substitution inside opens one. Returns the index after the closer.
  function scanBalanced(i, w, kind, bare = false) {
    const square = kind === 'bracket' || kind === 'subscript'
    const open = kind === 'param' ? '{' : square ? '[' : '('
    const close = kind === 'param' ? '}' : square ? ']' : ')'
    const quotes = kind !== 'arith' && kind !== 'bracket'
    let depth = 0
    while (i < s.length && !found) {
      const c = s[i]
      if (c === '\0') { w.subst = true; if (bare) w.bare = true; i++; continue } // a resolved $(...): unquoted, it splits
      if (quotes && c === '$' && s[i + 1] === "'") { i = ansiCEnd(i + 2); continue }
      if (quotes && c === "'") {
        const e = s.indexOf("'", i + 1)
        if (e < 0) return s.length
        i = e + 1
        continue
      }
      if (quotes && c === '"') { i = scanDq(i + 1, w); continue }
      if (c === '\\') { i += 2; continue }
      const j = expansionAt(i, w, false, bare)
      if (j >= 0) { i = j; continue }
      if (kind === 'array' && (c === '<' || c === '>') && s[i + 1] === '(') {
        w.subst = true
        i = enterCode(i + 2, ')')
        continue
      }
      if (c === open) { depth++; i++; continue }
      if (c !== close) { i++; continue }
      if (depth > 0) { depth--; i++; continue }
      return i + (kind === 'arith' && s[i + 1] === ')' ? 2 : 1)
    }
    return i
  }

  // The delimiter word of a heredoc, from after the `<<`: the whole shell word with its quoting removed;
  // any quoting (a part of it is enough: <<E"O"F, <<\\EOF) makes the body data. null: no word follows.
  function heredocTag(i) {
    const dash = s[i] === '-'
    if (dash) i++
    while (s[i] === ' ' || s[i] === '\t') i++
    let tag = ''
    let quoted = false
    let any = false
    while (i < s.length && !/[\s;&|()<>]/.test(s[i])) {
      any = true
      const c = s[i]
      if (c === '$' && s[i + 1] === "'") {
        // $'...' ANSI-C quoting: the escapes are decoded (a \' does not end it)
        let j = i + 2
        while (j < s.length && s[j] !== "'") {
          const m = s[j] === '\\' ? /^\\(?:([abefnrtv\\'"?])|x([0-9A-Fa-f]{1,2})|([0-7]{1,3}))/.exec(s.slice(j, j + 5)) : null
          if (m) {
            tag += m[1] ? (ANSI_C_ESCAPES[m[1]] ?? m[1]) : String.fromCharCode(parseInt(m[2] ?? m[3], m[2] ? 16 : 8))
            j += m[0].length
          } else {
            tag += s[j++]
          }
        }
        i = Math.min(j + 1, s.length)
        quoted = true
      } else if (c === '$' && s[i + 1] === '"') {
        // $"..." locale quoting: the $ is dropped with the quotes
        quoted = true
        i++
      } else if (c === "'") {
        const e = s.indexOf("'", i + 1)
        tag += s.slice(i + 1, e < 0 ? s.length : e)
        i = e < 0 ? s.length : e + 1
        quoted = true
      } else if (c === '"') {
        // inside "...": a backslash before $ ` " \ or a newline is removed (a newline with it), any other stays
        let e = i + 1
        while (e < s.length && s[e] !== '"') {
          if (s[e] === '\\' && s[e + 1] !== undefined && '$`"\\\n'.includes(s[e + 1])) {
            if (s[e + 1] !== '\n') tag += s[e + 1]
            e += 2
          } else {
            tag += s[e++]
          }
        }
        i = Math.min(e + 1, s.length)
        quoted = true
      } else if (c === '\\') {
        tag += s[i + 1] ?? ''
        i += 2
        quoted = true
      } else {
        tag += c
        i++
      }
    }
    return any ? { dash, tag, quoted, end: i } : null
  }

  // Shell code: the top level, $(...), `...` and <(...). From i, until its closer (or the end).
  function scanCode(i, close) {
    const f = { atCmd: true, wrapped: null, wraps: 0, assigned: false, redirected: false, timeKw: false, valueNext: false, operandNext: false, afterFunction: false, dbl: false, afterFor: false, eval: false, shell: null, hereString: false, hereSubst: false, cmdHeredocs: [], target: false, paren: 0, word: null, reader: false, heredocs: [] }
    let ended = false
    const word = () => (f.word ??= newWord())

    // a word is complete: decide what it was
    const finish = () => {
      const w = f.word
      f.word = null
      if (!w) return
      if (f.dbl && w.plain === ']]') f.dbl = false
      // source / . / a shell may read ANY <(...) of its command as code (operand, stdin, an option value
      // the shell's own option grammar decides): fail-closed, without modelling that grammar
      if (f.reader && w.proc) { found = true; return }
      if (f.target) {
        f.target = false
        // the target of a here-string: if the command turns out to be a shell without -c, it is the script
        if (f.hereString && w.subst) f.hereSubst = true
        f.hereString = false
        return
      }
      if (!f.atCmd) { argumentWord(w); return }
      if (f.timeKw && w.raw !== '[[') f.timeKw = w.raw === '-p' && f.timeKw === true ? 'p' : false // the keyword time takes ONE -p; any other word, a second -p too, makes it a command
      if (f.valueNext) {
        // the value of a wrapper option (also one spelled NAME=value: exec -a A=B, xargs -I A=B): unquoted, it is split
        // into words; env -S / --split-string runs it as a command line
        f.valueNext = false
        if (w.bare || (w.subst && f.wrapped === 'env')) found = true
        return
      }
      if (DYN_ASSIGNMENT_RX.test(w.raw)) {
        // env / sudo take NAME=value for the child's environment: an unquoted substitution there is split into words
        if (f.wrapped && w.bare) found = true
        if (!f.wrapped) f.assigned = true // a NAME=value before it: a following [[ is no keyword any more
        return
      }
      // the duration of timeout / gtimeout is an operand, whatever it is spelled as; unquoted, it is split into words
      if (f.operandNext && !w.plain.startsWith('-')) { f.operandNext = false; if (w.bare) found = true; return }
      if (w.subst) {
        // an option of a wrapper with the value glued on (xargs -P$(nproc), env -C"$(pwd)"): quoted, it runs nothing;
        // unquoted, it is split into words; env -S / --split-string runs its value as a command line
        if (f.wrapped && w.plain.startsWith('-') && !(f.wrapped === 'env' && (/^--split-string/.test(w.plain) || envBundle(w.plain)?.split))) {
          if (w.bare) found = true
          return
        }
        found = true
        return
      }
      if (f.afterFunction) { f.afterFunction = false; return } // the NAME of function NAME { ...; }
      if (w.plain === 'function') { f.afterFunction = true; return }
      if (DYN_RESERVED.has(w.plain)) return
      const base = baseName(w.plain)
      if (DYN_WRAPPERS.has(base)) { f.wrapped = base; f.wraps++; f.timeKw = f.wraps === 1 && w.raw === 'time'; f.operandNext = base === 'timeout' || base === 'gtimeout'; return }
      // `command -v` / `-V` only looks the name up, nothing runs
      if (f.wrapped === 'command' && /^-[a-zA-Z]*[vV]/.test(w.plain)) { f.atCmd = false; f.wrapped = null; return }
      if (f.wrapped && (DYN_WRAPPER_VALUE_OPTS[f.wrapped] ?? []).includes(w.plain)) { f.valueNext = true; return }
      if (f.wrapped === 'env' && envBundle(w.plain)?.attached === false) { f.valueNext = true; return } // env -iS CMDLINE, -vu NAME
      if (f.wrapped === 'exec' && /^-[cl]*a$/.test(w.plain)) { f.valueNext = true; return } // exec -la NAME
      if (f.wrapped && (w.plain.startsWith('-') || /^\d+(?:\.\d+)?[smhd]?$/.test(w.plain))) return
      const wraps = f.wraps
      f.atCmd = false
      f.wrapped = null
      f.reader = DYN_CODE_READERS.has(base)
      // inside [[ ... ]] the && || ( ) join operands, they start no command. [[ is a keyword only as the bare first word
      // of a command: quoted ("[[", \[[), behind a NAME=value, a redirection or a wrapper (env, command, timeout ...;
      // only the bare keyword time, with -p at most, keeps it a keyword) it is an ordinary command name, and a following
      // || or && ends it
      f.dbl = base === '[[' && w.raw === '[[' && !f.assigned && !f.redirected && (wraps === 0 || (wraps === 1 && f.timeKw))
      f.afterFor = base === 'for' // `for ((` opens an arithmetic loop head
      f.eval = base === 'eval' || base === 'trap' // eval parses ALL its words again; so does the action word of trap, when the signal fires
      f.shell = SHELL_NAMES.has(base) ? { c: false, opts: true, optValue: 0, code: false, skip: 0, modelled: DYN_MODELLED_SHELLS.has(base) } : null
    }
    // a word after the command word. eval parses its words again after the outer shell expanded them, so a
    // substitution anywhere in them is code. A shell's -c code string is parsed again, too: a substitution in the
    // words from the -c bundle up to and including the code word (the first one that is no option) denies; the
    // positional arguments after it are not parsed again.
    const argumentWord = (w) => {
      if (f.eval && w.subst) found = true
      const sh = f.shell
      if (!sh) return
      const t = w.plain
      // the option range of a shell (its options, their values, the -c bundle word, the first operand) holds a word that
      // can bring the -c and the code itself (`bash "$(cat f)" 'x'` with f = -c), quoted or not; a shell whose options
      // the scanner does not model has no range end: any of its words denies
      if (w.subst && (!sh.modelled || sh.opts)) found = true
      if (sh.optValue > 0) { sh.optValue--; return }
      if (sh.opts) {
        if (!/^[-+]/.test(t) || t === '--') { sh.opts = false; return } // the script operand, or the end of the options
        if (/^-[A-Za-z]*c[A-Za-z]*$/.test(t)) { sh.c = true; sh.opts = false; sh.code = true; sh.skip = (t.match(/[oO]/g) ?? []).length; return } // each o / O in the bundle takes the next word
        // each o / O of an option bundle (-xo pipefail, -oo a b) takes the next word as its value, and so does --rcfile / --init-file
        sh.optValue = /^[-+][A-Za-z]+$/.test(t) ? (t.match(/[oO]/g) ?? []).length : /^--(?:rcfile|init-file)$/.test(t) ? 1 : 0
        return
      }
      if (sh.code) {
        if (sh.skip > 0) { sh.skip--; if (w.subst) found = true; return } // the value of an o / O of the -c bundle, not the code word: unquoted, its output can shift the code word
        if (w.subst) found = true
        if (!/^[-+]/.test(t)) sh.code = false
      }
    }
    // the end of a simple command: a shell without -c reads its stdin as the script, so a substitution in a
    // here-string or in an unquoted heredoc handed to it is code (the redirection may come before the command word)
    const settle = () => {
      if (!f.shell || f.shell.c) return
      if (f.hereSubst) found = true
      for (const h of f.cmdHeredocs) h.shellScript = true
    }
    // a separator starts a new simple command
    const separate = () => {
      finish()
      settle()
      f.atCmd = true
      f.wrapped = null
      f.wraps = 0
      f.assigned = false
      f.redirected = false
      f.timeKw = false
      f.valueNext = false
      f.operandNext = false
      f.afterFunction = false
      f.dbl = false
      f.afterFor = false
      f.eval = false
      f.shell = null
      f.hereString = false
      f.hereSubst = false
      f.cmdHeredocs = []
      f.target = false
      f.reader = false
    }
    const bodyRunsSubst = (body, h) => substitutionInCommandPosition(body, { heredoc: true, any: h.shellScript, bodies })
    // the heredoc bodies announced on the line that just ended: skip each, from `at` to its TAG line
    // (or to the end when there is none); an unquoted one is scanned as "..." (it expands)
    const skipBodies = (at) => {
      let p = at
      for (const h of f.heredocs) {
        let body = ''
        for (;;) {
          if (p >= s.length) {
            if (!h.quoted && bodyRunsSubst(body, h)) found = true
            return s.length
          }
          // an unquoted body joins a \ + newline BEFORE the TAG line is matched (bash reads it so)
          let line = ''
          for (;;) {
            const e = s.indexOf('\n', p)
            const part = s.slice(p, e < 0 ? s.length : e)
            p = e < 0 ? s.length : e + 1
            const joins = !h.quoted && e >= 0 && /(?:^|[^\\])(?:\\\\)*\\$/.test(part)
            line += joins ? part.slice(0, -1) : part
            if (!joins) break
          }
          if ((h.dash ? line.replace(/^\t+/, '') : line) === h.tag) break
          body += line + '\n'
        }
        if (!h.quoted && bodyRunsSubst(body, h)) { found = true; return s.length }
      }
      f.heredocs = []
      return p
    }

    while (i < s.length && !found) {
      const c = s[i]
      const n = s[i + 1]
      if (c === '\0') { const w = word(); w.subst = true; w.bare = true; i++; continue } // a resolved $(...) outside quotes: it splits
      if (close === ')' && c === ')' && f.paren === 0) { i++; ended = true; break }
      if (c === '\\' && n === '\n') { i += 2; continue } // a line continuation joins, it is no character
      if (c === ' ' || c === '\t') { finish(); i++; continue }
      if (c === '\n') { separate(); i = f.heredocs.length ? skipBodies(i + 1) : i + 1; continue }
      if (c === '#' && !f.word) { const e = s.indexOf('\n', i); i = e < 0 ? s.length : e; continue }
      if (c === "'") {
        const e = s.indexOf("'", i + 1)
        if (e < 0) { i = s.length; continue }
        const w = word()
        w.raw += s.slice(i, e + 1)
        w.plain += s.slice(i + 1, e)
        i = e + 1
        continue
      }
      if (c === '"') { const w = word(); w.raw += c; i = scanDq(i + 1, w); continue }
      if (c === '\\') { const w = word(); w.raw += c + (n ?? ''); w.plain += n ?? ''; i += 2; continue }
      if (c === '$' && n === "'") {
        const e = ansiCEnd(i + 2)
        const w = word()
        w.raw += s.slice(i, e)
        w.plain += s.slice(i, e)
        i = e
        continue
      }
      if (c === '$' || c === '`') {
        const j = expansionAt(i, word(), true)
        if (j >= 0) { i = j; continue }
      }
      if ((c === '<' || c === '>') && n === '(') {
        // a process substitution; one that opens a word is what source / . / a shell would read
        const w = word()
        if (!w.raw) w.proc = true
        w.raw += c + '('
        w.subst = true
        w.bare = true
        i = enterCode(i + 2, ')')
        continue
      }
      if (c === '(' && f.word && DYN_ARRAY_OPEN_RX.test(f.word.raw)) {
        f.word.raw += c
        i = scanBalanced(i + 1, f.word, 'array')
        continue
      }
      if (c === '<' && n === '<' && s[i + 2] !== '<') {
        // a heredoc: remember its TAG, its body starts on the next line
        const h = heredocTag(i + 2)
        if (h) {
          if (f.atCmd) f.redirected = true
          if (f.word && /^\d+$/.test(f.word.raw)) f.word = null
          else finish()
          f.heredocs.push(h)
          f.cmdHeredocs.push(h)
          i = h.end
          continue
        }
      }
      if (c === '<' || c === '>' || (c === '&' && n === '>')) {
        // a redirection: an fd number before it is part of the operator, the next word is its target
        if (f.atCmd) f.redirected = true
        if (f.word && /^\d+$/.test(f.word.raw)) f.word = null
        else finish()
        const opStart = i
        while (i < s.length && '<>&|'.includes(s[i])) i++
        f.hereString = s.slice(opStart, i) === '<<<'
        // 2>&1, <&0, >&-: an fd dup or close names no file, so the next word is not a target
        const dup = s[i - 1] === '&' && /[\d-]/.test(s[i] ?? '')
        while (dup && i < s.length && /[\d-]/.test(s[i])) i++
        f.target = !dup
        continue
      }
      if (f.dbl && (c === '&' || c === '|')) {
        finish() // a glued `]]&&` ends the conditional here: then it is a separator, handled below
        if (f.dbl) {
          while (i < s.length && '&|'.includes(s[i])) i++
          continue
        }
      }
      if (c === ';' || c === '&' || c === '|') {
        separate()
        while (i < s.length && ';&|'.includes(s[i])) i++
        continue
      }
      if (f.dbl && c === '(') { finish(); f.paren++; i++; continue }
      if (f.dbl && c === ')' && f.paren > 0) { finish(); f.paren--; i++; continue }
      if (c === '(' && n === '(' && f.atCmd && f.word && /^(?:for|while|until|if|elif)$/.test(f.word.plain)) finish()
      if (c === '(' && n === '(' && (f.atCmd || f.afterFor) && !f.word) {
        // (( ... )) is an arithmetic command (also the head of `for ((`), not two subshells: no command
        // position of its own, and a << inside is a shift, no heredoc
        const loopHead = f.afterFor
        separate()
        i = scanBalanced(i + 2, newWord(), 'arith')
        f.atCmd = loopHead
        continue
      }
      if (c === '[' && f.atCmd && !f.wrapped && !f.target && f.word && /^[A-Za-z_][A-Za-z0-9_]*$/.test(f.word.raw)) {
        // name[index]=value at the start of a command: the index is arithmetic, a << in it is a shift
        f.word.raw += '[]'
        i = scanBalanced(i + 1, f.word, 'subscript')
        continue
      }
      if (c === '(') { separate(); f.paren++; i++; continue }
      if (c === ')') { separate(); if (f.paren > 0) f.paren--; i++; continue }
      const w = word()
      w.raw += c
      w.plain += c
      i++
    }
    finish()
    settle()
    closed = ended
    return i
  }

  if (asHeredocBody) {
    const w = newWord()
    scanDq(0, w, true, any)
    if (any && w.subst) found = true
  } else scanCode(0, null)
  return found
}

function scanShellCode(command, strictStdin = false) {
  const segs = codeSegments(command)
  const codes = []
  const seen = new Set()
  const push = (c) => {
    const key = `${c.ansi ? 1 : 0}:${c.value}`
    if (seen.has(key)) return
    seen.add(key)
    codes.push(c)
  }
  let bad = false
  for (const [k, seg] of segs.entries()) {
    const words = splitCodeWords(seg.own)
    const names = /\b(?:sh|bash|dash|zsh|ksh|ash|fish|csh|tcsh|mksh|rbash|yash|eval|trap|tmux|systemctl)\b/
    if (words == null) {
      // a naive piece can cut a quoted string in two; the whole command is scanned too
      if (!seg.naive && names.test(seg.own)) bad = true
      continue
    }
    const args = argWords(words)
    const cmdIndex = commandWordIndex(args)
    const cmdWord = cmdIndex >= 0 ? args[cmdIndex] : undefined
    if (cmdWord && (cmdWord.ansi || cmdWord.brace)) bad = true
    if (args.some((w) => HIDDEN_NAMES.has(baseName(w.value))) && words.some((w) => w.ansi || w.brace)) bad = true
    let stdinBodies = null
    const stdinCodes = () => {
      if (stdinBodies == null) {
        // a heredoc of the command piped into this one reaches its stdin too (`cat <<'EOF' | bash`)
        const piped = k > 0 && /^\|&?$/.test(segs[k - 1].sep ?? '') ? segs[k - 1].bodies ?? [] : []
        stdinBodies = [...(seg.bodies ?? []), ...piped].map((b) => ({ value: b, ansi: false }))
        for (let j = 0; j < words.length; j++) {
          if (words[j].redirect && /^\d*<<<$/.test(words[j].value) && words[j + 1]?.target) stdinBodies.push(words[j + 1])
        }
      }
      return stdinBodies
    }
    for (let i = 0; i < args.length; i++) {
      const v = args[i].value
      if (v === 'eval' && !(cmdWord && EVAL_QUOTING_COMMANDS.has(cmdWord.value))) {
        const rest = args.slice(i + 1)
        if (rest[0]?.value === '--') rest.shift() // eval skips one leading `--`, the code starts after it
        if (rest.length) push({ value: rest.map((w) => w.value).join(' '), ansi: rest.some((w) => w.ansi) })
      }
      if (v === 'trap') {
        let t = i + 1
        // option words end at `--`; a lone `-` is the action word
        while (t < args.length && args[t].value.length > 1 && args[t].value.startsWith('-')) {
          if (args[t++].value === '--') break
        }
        if (args[t]) push(args[t])
      }
      if (i === cmdIndex && (v === '.' || v === 'source') && args[i + 1]) {
        for (const c of stdinCodes()) push(c)
      }
      const base = baseName(v)
      if (base === 'tmux') for (const c of tmuxGlobalOptions(args, i + 1).codes) push(c)
      if (!SHELL_NAMES.has(base)) continue
      const runs = shellWordRuns(args, i, strictStdin)
      for (const c of runs.codes) push(c)
      if (!runs.stdin) continue
      for (const c of stdinCodes()) push(c)
    }
  }
  return { codes, bad }
}

export function shellCodeStrings(command, opts = {}) {
  return scanShellCode(command, opts.strictStdin === true).codes.map((c) => c.value)
}

// tmux takes an exact command name or alias first, otherwise a prefix that only
// one command name starts with. Measured with tmux 3.6 `list-commands`, the
// words that reach a pane-injecting command are:
//   send-keys:    send send-k send-ke send-key send-keys
//   run-shell:    ru run run- run-s run-sh run-she run-shel run-shell
//   paste-buffer: pa pas past paste paste- pasteb paste-b paste-bu paste-buf paste-buff paste-buffe paste-buffer
//   set-buffer:   setb set-b set-bu set-buf set-buff set-buffe set-buffer
const TMUX_PANE_INJECT_WORDS = new Set([
  'send', 'send-k', 'send-ke', 'send-key', 'send-keys',
  'ru', 'run', 'run-', 'run-s', 'run-sh', 'run-she', 'run-shel', 'run-shell',
  'pa', 'pas', 'past', 'paste', 'paste-', 'pasteb', 'paste-b', 'paste-bu', 'paste-buf', 'paste-buff', 'paste-buffe', 'paste-buffer',
  'setb', 'set-b', 'set-bu', 'set-buf', 'set-buff', 'set-buffe', 'set-buffer',
])

// A .timer or .path unit runs its service later or on a file change, so
// starting, enabling or linking one is a self-timed future run, the same thing
// SCHEDULER_RX denies for systemd-run.
const SYSTEMCTL_ARM_VERBS = new Set([
  'start', 'restart', 'try-restart', 'reload-or-restart', 'try-reload-or-restart',
  'condrestart', 'force-reload', 'enable', 'reenable', 'preset', 'link', 'edit',
  'add-wants', 'add-requires', 'isolate',
])

const SYSTEMCTL_VERBS = new Set([
  'start', 'stop', 'reload', 'restart', 'try-restart', 'reload-or-restart', 'try-reload-or-restart',
  'condrestart', 'condreload', 'condstop', 'force-reload', 'isolate', 'kill', 'clean', 'freeze', 'thaw',
  'set-property', 'bind', 'mount-image', 'service-log-level', 'service-log-target', 'reset-failed', 'whoami',
  'list-units', 'list-automounts', 'list-paths', 'list-sockets', 'list-timers', 'is-active', 'is-failed',
  'status', 'show', 'cat', 'help', 'list-dependencies', 'enable', 'disable', 'reenable', 'preset',
  'preset-all', 'is-enabled', 'mask', 'unmask', 'link', 'revert', 'add-wants', 'add-requires', 'edit',
  'get-default', 'set-default', 'list-unit-files', 'list-machines', 'list-jobs', 'cancel',
  'show-environment', 'set-environment', 'unset-environment', 'import-environment', 'daemon-reload',
  'daemon-reexec', 'log-level', 'log-target', 'service-watchdogs', 'default', 'rescue', 'emergency',
  'halt', 'poweroff', 'reboot', 'kexec', 'soft-reboot', 'exit', 'switch-root', 'suspend', 'hibernate',
  'hybrid-sleep', 'suspend-then-hibernate', 'sleep',
])

// words: output of splitCodeWords. The verb of `systemctl` is the first later
// word that is a systemctl verb (what precedes it is options and their
// values). True when that verb is an arm verb and a later word is a .timer or
// .path unit, or a glob or brace (* ? [ {) that may expand to one: bash
// expands `x.{timer,service}` and systemctl matches `x.*` against loaded
// units. A non-arm verb arms nothing, even if `start x.timer` follows it as
// unit names.
const SYSTEMCTL_VALUE_OPTIONS = new Set([
  '-o', '--output', '-t', '--type', '-p', '--property', '-P', '-M', '--machine', '-H', '--host', '-s', '--signal',
  '-n', '--lines', '--root', '--image', '--image-policy', '--state', '--what', '--job-mode', '--kill-whom',
  '--kill-value', '--timestamp', '--message', '--drop-in', '--when', '--boot-loader-entry', '--boot-loader-menu',
  '--reboot-argument', '--check-inhibitors', '--preset-mode',
])

export function systemctlArmsTimer(words) {
  words = argWords(words)
  for (let i = 0; i < words.length; i++) {
    if (baseName(words[i].value) !== 'systemctl') continue
    let v = -1
    for (let k = i + 1; k < words.length; k++) {
      if (SYSTEMCTL_VERBS.has(words[k].value)) { v = k; break }
      if (SYSTEMCTL_VALUE_OPTIONS.has(words[k].value)) k++
    }
    if (v < 0 || !SYSTEMCTL_ARM_VERBS.has(words[v].value)) continue
    if (words.slice(v + 1).some((w) => w.value.endsWith('.timer') || w.value.endsWith('.path') || w.value.endsWith('.target') || w.brace || /[*?[]/.test(w.value))) return true
  }
  return false
}

// words: output of splitCodeWords. Follows `tmux [global options] cmd ... \; cmd`.
export function tmuxInjectsPane(words) {
  words = argWords(words)
  for (let i = 0; i < words.length; i++) {
    if (baseName(words[i].value) !== 'tmux') continue
    let k = tmuxGlobalOptions(words, i + 1).next
    if (words[k] && TMUX_PANE_INJECT_WORDS.has(words[k].value)) return true
    for (; k < words.length; k++) {
      const v = words[k].value
      if ((v === ';' || v.endsWith(';')) && words[k + 1] && TMUX_PANE_INJECT_WORDS.has(words[k + 1].value)) return true
    }
  }
  return false
}

// --- MCP tools (MCPWRITEGATE1104) -------------------------------------------------------------------------------
// An MCP tool reaches local paths through its own arguments (hooks/mcp-file-targets.mjs names them, by the TOOL's
// name, never the server's). Each path is judged by this gate's own native Write branch, so a protected name added
// there is covered here without a second list. A mover's path, and a directory a file lands in under a name the call
// does not fix, is also denied when it IS, or is above, a directory this gate guards: the store, local-hooks/, a
// scheduled-tasks directory, a Claude config directory (where the self-schedule store lives). A relative path is
// measured against the payload cwd AND the project dir (an MCP server resolves it against its own start cwd).
// This gate runs for sub-agents only; the 'other' class (read, send) is judged as a file (D1, Samu 68033).
function mcpDirDeny(raw, base, opts) {
  const w = String(raw)
  const abs = resolve(base, w === '~' || w.startsWith('~/') ? expandHome(w === '~' ? '~/' : w) : w)
  const key = pathKey(abs)
  const allowlistPath = opts.allowlistPath ?? DEFAULT_ALLOWLIST_PATH
  const localHooks = join(dirname(allowlistPath), '..', 'local-hooks')
  const guarded = [opts.storeDir ?? DEFAULT_STORE_DIR, dirname(allowlistPath), localHooks, join(homedir(), '.claude')]
  for (const g of guarded) {
    const gk = pathKey(g)
    if (sameKey(key, gk) || underKey(gk, key)) return true
  }
  if (underKey(key, pathKey(localHooks))) return true
  return nameForms(abs).some((f) => SCHEDULE_DIR_PATH_RX.test(f) || STORE_PARENTS.includes(basename(f)))
}

function mcpDecide(name, toolInput, opts) {
  const m = mcpFileTargets(name, toolInput)
  if (!m) return { deny: false }
  if (m.cls !== 'other' && (m.missingPath || m.truncated)) return { deny: true, reason: 'mcp-path' }
  const cwd = opts.cwd ? resolve(String(opts.cwd)) : process.cwd()
  const bases = [...new Set([cwd, opts.projectDir ? resolve(String(opts.projectDir)) : null].filter(Boolean))]
  for (const t of m.targets) {
    for (const base of bases) {
      const v = decide('Write', { file_path: t.path }, { ...opts, cwd: base })
      if (v.deny) return { deny: true, reason: v.reason ? `mcp-${v.reason}` : 'mcp-schedule' }
      // a mover's paths come marked dir (mcp-file-targets.mjs)
      if (m.cls !== 'other' && t.dir && mcpDirDeny(t.path, base, opts)) return { deny: true, reason: 'mcp-dir' }
    }
  }
  // A base INSIDE a directory this gate guards (Dani 68255): there every bare name is a path into it, so the bare
  // leaves the classifier left out go through the native Write branch too. Outside one this costs nothing.
  if (m.bare?.length) {
    for (const base of bases) {
      if (!mcpBaseInsideGuarded(base, opts)) continue
      for (const b of m.bare) {
        const v = decide('Write', { file_path: b }, { ...opts, cwd: base })
        if (v.deny) return { deny: true, reason: v.reason ? `mcp-${v.reason}` : 'mcp-schedule' }
      }
    }
  }
  return { deny: false }
}

function mcpBaseInsideGuarded(base, opts) {
  const key = pathKey(base)
  const allowlistPath = opts.allowlistPath ?? DEFAULT_ALLOWLIST_PATH
  const guarded = [opts.storeDir ?? DEFAULT_STORE_DIR, dirname(allowlistPath), join(dirname(allowlistPath), '..', 'local-hooks')]
  if (guarded.some((g) => underKey(key, pathKey(g)))) return true
  return nameForms(base).some((f) => SCHEDULE_DIR_PATH_RX.test(f) || f.split('/').some((s) => STORE_PARENTS.includes(s)))
}

function decide(toolName, toolInput, opts = {}) {
  const name = String(toolName ?? '')
  if (SELF_PACE_TOOLS.has(name)) return { deny: true }
  if (/^mcp__/i.test(name)) return mcpDecide(name, toolInput, opts)
  // Native file tools writing the self-schedule store would bypass any Bash regex.
  if (name === 'Write' || name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit') {
    const fp = String(toolInput?.file_path ?? toolInput?.notebook_path ?? '')
    if (SCHEDULE_STORE_RX.test(fp)) return { deny: true }
    if (fileToolTargetsAllowlist(toolInput, opts.allowlistPath, opts.cwd)) return { deny: true, reason: 'egress-allowlist' }
    if (fileToolTargetsProtectedStoreFile(toolInput, opts.storeDir, opts.cwd)) return { deny: true, reason: 'protected-store-file' }
    // ...and the dashboard's schedule store, which the runner turns into turns
    if (scheduleDirPathDenied(fp, opts.cwd, opts.projectRoot ?? PROJECT_ROOT)) return { deny: true }
  }
  if (name === 'Bash') {
    // The schedule surface is judged on the RAW command, before the payload and
    // commit-message blanking below: that blanking is regex-based and trusts a
    // `-d` wherever it appears (`python3 -c CODE -d URL` would blank the URL),
    // so this check does its own grammar-aware data removal instead.
    if (scheduleSurfaceDeny(String(toolInput?.command ?? ''), opts)) return { deny: true }
    // Strip -d/--data payloads on the WHOLE command BEFORE splitting. A payload is
    // data, not an invocation; and since splitSegments is NOT quote-aware, a shell
    // separator (; && | &) INSIDE a dispatch body would otherwise orphan a fragment
    // that false-matches. Stripping first blanks the body (incl. any separators in
    // it), so the URL/method args still match but the body text never does. A
    // separator OUTSIDE the payload still splits, so `curl -d '' x ; crontab -r`
    // is still caught.
    const safeCommand = stripProseArguments(stripDataPayloads(stripGitCommitMessages(stripHeredocBodies(String(toolInput?.command ?? '')))))
    // Per-segment so an unrelated token elsewhere in a compound command cannot
    // turn a legit read (store inspection, schedule-API GET) into a false deny.
    const naiveSegs = splitSegments(safeCommand)
    for (const seg of naiveSegs) {
      // Match the self-pace bash patterns against the shell-normalised segment so a
      // `\/loop` / `$IFS/loop` evasion (which bash resolves to `/loop` at exec) is
      // still caught; the scheduler/store/API checks below use the RAW seg (scoped).
      //
      // These stay on the NAIVE segments ON PURPOSE. They are unanchored, so a
      // quoted region is not a hiding place for them -- and the naive scan is
      // what catches a real `subprocess.run(['tmux','send-keys',...])` inside a
      // heredoc body (measured 2026-08-05). Quote-aware segments here would have
      // dropped the detection of this gate's own founding incident vector.
      if (SELF_PACE_BASH_PATTERNS.some((re) => re.test(normalizeShellEvasion(seg)))) return { deny: true }
      // self-schedule store: block WRITE only (a read/grep is legit diagnostics)
      if (SCHEDULE_STORE_RX.test(seg) && WRITE_INTENT_RX.test(seg)) return { deny: true }
      // dashboard schedule API: block WRITE methods only (GET list/pending is legit)
      if (SCHEDULE_API_RX.test(seg) && HTTP_WRITE_RX.test(seg)) return { deny: true }
    }
    // The protected store files and the allowlist judge the segments the shell runs (protectedSegments,
    // EGRESSFP1106 (a)): a `|` or `;` inside a quoted grep pattern does not make a command of its own.
    // Unresolved quoting or a heredoc falls back to the naive split.
    const protSplit = protectedSplit(safeCommand)
    const protSegs = protSplit.segs
    const protectedCtx = protectedContext(protSegs, opts.allowlistPath, opts.cwd)
    const definite = definiteAssignments(protSplit)
    // the name spelled anywhere, also split by quotes or a backslash (RIPGREP_CONFIG_PAT""H= is the same variable)
    protectedCtx.rgConfigNamed = RG_CONFIG_ENV_RX.test(safeCommand.replace(/\$(?=['"])|["'\\]/g, ''))
    // HOME as a bare word anywhere (HOME=, export/unset/read HOME, for HOME in ...), also split by quotes: the command
    // may change it, so neither $HOME nor ~ is the real home in it (EGRESSHOME1106)
    protectedCtx.homeTouched = HOME_TOUCH_RX.test(safeCommand.replace(/\$(?=['"])|["'\\]/g, ''))
    for (const [idx, seg] of protSegs.entries()) {
      protectedCtx.definite = definite[idx]
      // The other store files that gate the sub-agent (c556a35a) first: they are matched by
      // name only, so a segment that names one of them gets that file's message even when
      // the allowlist check below would also deny it on an unresolved word (`> $TARGET`).
      if (!protectedStoreBashSegmentAllowed(seg, protectedCtx)) return { deny: true, reason: 'protected-store-file' }
      // the egress allowlist and the extra hooks: a plain read only (EGRESSSELFEDIT824)
      if (!allowlistBashSegmentAllowed(seg, protectedCtx)) return { deny: true, reason: 'egress-allowlist' }
      cwdAfterSegment(seg, protectedCtx)
      if (!protectedCtx.cwds.includes(protectedCtx.cwd)) protectedCtx.cwds.push(protectedCtx.cwd)
    }
    // The scheduler check is the ANCHORED one -- it fires on what sits at a
    // segment START -- so it is the one a fake segment boundary can mislead, and
    // the only one that gets quote-aware segments. Null (unresolvable quoting)
    // falls back to the naive split, i.e. to scanning strictly more.
    const masked = maskInertLiterals(safeCommand)
    // The transient-unit exemption lifts ONLY the scheduler-binary deny, and only for a
    // command that is one single transient-unit invocation; every check above still ran.
    const transientUnitOk = transientUserUnitAllowed(String(toolInput?.command ?? ''))
    for (const seg of (masked == null ? naiveSegs : splitSegments(masked))) {
      // scheduler binaries: deny the exec/submit forms, allow pure read-listing
      if (SCHEDULER_RX.test(seg) && !SCHEDULER_READ_RX.test(seg) && !transientUnitOk) return { deny: true }
    }
    // ...and the same rule on the dequoted command word of each code segment
    const dequoted = dequotedSchedulerDeny(String(toolInput?.command ?? ''), opts.vars)
    if (!transientUnitOk && dequoted.deny) return { deny: true }
    // Shell code handed to another shell (sh -c, eval, here-strings, heredocs,
    // tmux -c) is decided recursively; quoted, it was blanked above. The RAW
    // command is used: safeCommand blanks heredoc bodies and data payloads.
    const rawCommand = String(toolInput?.command ?? '')
    const depth = opts.depth ?? 0
    const bodies = []
    if (substitutionInCommandPosition(rawCommand, { bodies })) return { deny: true, reason: 'dynamic-command' }
    // the code of each outermost substitution is a command of its own (scanShellCode does not look inside one)
    for (const body of bodies) {
      if (depth >= 4) return { deny: true, reason: 'shell-code-depth' }
      const inner = decide('Bash', { command: body }, { ...opts, depth: depth + 1, vars: dequoted.vars })
      if (inner.deny) return { deny: true, reason: inner.reason ?? 'shell-code' }
    }
    const scan = scanShellCode(rawCommand)
    for (const code of scan.codes) {
      if (code.ansi) return { deny: true, reason: 'shell-code' }
      if (depth >= 4) return { deny: true, reason: 'shell-code-depth' }
      const inner = decide('Bash', { command: code.value }, { ...opts, depth: depth + 1, vars: dequoted.vars })
      if (inner.deny) return { deny: true, reason: inner.reason ?? 'shell-code' }
    }
    if (scan.bad) return { deny: true, reason: 'shell-code' }
    // tmux command shortcuts and `tmux a \; send-keys` chains
    for (const seg of codeSegments(rawCommand)) {
      const words = splitCodeWords(seg.own)
      if (words != null && (tmuxInjectsPane(words) || systemctlArmsTimer(words))) return { deny: true }
    }
  }
  return { deny: false }
}

const GATE_MSG =
  'Self-pace TILTOTT (governance hard-gate). Sub-agentkent NEM utemezhetsz sajat ' +
  'jovobeli turn-t: se ScheduleWakeup/Cron*/RemoteTrigger, se tmux send-keys, se ' +
  'scheduled_tasks.json iras, se /api/schedules iras (semmilyen klienssel: curl, python, node, ' +
  'wget, httpie...; olvasasra csak a `curl -q -s -H "Authorization: Bearer $(cat <TOKEN>)" ' +
  'http://...` GET megy at: -q ELSO argumentumkent, <TOKEN> pedig SZO SZERINT a repo-gyoker abszolut ' +
  '<repo>/store/.dashboard-token, vagy a sajat <repo>/agents/<nev>/.dashboard-token utja -- relativ ut, ~ vagy ' +
  '$HOME nem), se ~/.claude/scheduled-tasks/ iras (olvasni ls/cat/grep/sed -n lehet, ' +
  'de NE cd-vel a store-ba -- abszolut uttal hivatkozz ra), se schedule-registry-cli register/unregister ' +
  '(csak status es verify), se utemezes-tabla SQL-iras vagy a claudeclaw.db fajl felulirasa, ' +
  'se /loop self-pace. ' +
  'Kivetel: hosszu tesztfutashoz EGYETLEN azonnali, idozito nelkuli `systemd-run --user --collect -p RuntimeMaxSec=<1..7200> [--unit=NEV] <parancs>` megengedett, onallo parancskent (--on-*/--timer-property, -E/--setenv/Environment=, claude, utemezo, tmux, sleep es /api/ nelkul). ' +
  'Ha csak egy dokumentumot irsz, ami az utemezo API-t vagy a store-t emliti ' +
  '(jegyzet, review-tervezet): a nativ Write tool-lal ird, a store-on kivuli utra -- az atmegy; ' +
  'egy fajlba iranyitott heredoc (cat <<EOF > fajl) nem. Utemezest a fo agenstol kerj inter-agent uzenetben. ' +
  'Input-vezerelt ' +
  'vagy: csak az operator (channel) vagy egy peer (inter-agent) uzenete inditson. Ha varakozol, ' +
  'maradj idle a prompt-on -- a beerkezo uzenet majd ujrainditja a turn-t. SOHA ne valaszolj ' +
  'magadnak es SOHA ne dontsd el az operator helyett egy hozza intezett kerdest.'

const DYNAMIC_COMMAND_GATE_MSG =
  'Self-pace kapu: a parancs NEVE helyettesitesbol jon ($(...), backtick vagy <(...)), igy a kapu nem latja, ' +
  'mi fut: a $(echo X) az X-et futtatja. Fail-closed: TILTVA. Ird ki a parancsot szo szerint; a ' +
  'helyettesites argumentumkent vagy idezve tovabbra is szabad.'

const ALLOWLIST_GATE_MSG =
  'Egress-engedelylista TILTOTT (governance hard-gate). Sub-agentkent NEM irhatod a ' +
  'store/egress-allowlist.json-t: ez a kapu RAD vonatkozik. Ha egy domain kell, kerd a fo ' +
  'agenst (inter-agent uzenet: domain + miert); o a gazda jovahagyasaval veszi fel. ' +
  'Ugyanigy NEM irhatod a store/extra-hooks.json-t es a local-hooks/ alatti szkripteket (minden ' +
  'sub-agens hookjai): ha kell egy, kerd a fo agenst. ' +
  'Olvasni szabad: cat / grep / jq a fajlra (ertelmezo -- python, node -- nem).'

const MCP_GATE_MSG =
  'MCP-eszkoz ut-argumentuma TILTOTT (MCPWRITEGATE1104, sub-agensre): a hivas egy utja az utemezo store-t, a ' +
  'scheduled-tasks/ vagy egy Claude config-konyvtarat, az egress-allowlistet, a local-hooks/-t vagy egy vedett store-fajlt ' +
  'eri el (irva, mozgatva, vagy ismeretlen nevu fajlt teve bele), vagy egy ismert fajl-iro MCP-eszkoz ut nelkul a szerver ' +
  'alapertelmezett helyere irna. Adj meg kifejezett, a munkakonyvtaradon beluli celutat es egyszeru fajlnevet; ha vedett ' +
  'fajl kell, kerd a fo agenst.'

const PROTECTED_STORE_GATE_MSG =
  'Vedett store-fajl TILTOTT (governance hard-gate). Sub-agentkent NEM irhatod a ' +
  'store/egress-vendor-hosts.json, store/egress-vendor-hosts-<agent>.json, store/config-overrides.json, store/bash-sandbox-write-paths.json, ' +
  'store/email-standing-recipients.json, store/agent-send-exceptions.json, store/.approval-bot-token es store/.approval-bot-key ' +
  'fajlt: mindegyik RAD vonatkozo kapu beallitasa. ' +
  'Ha valtoztatas kell, kerd a fo agenst (inter-agent uzenet: mit es miert); o a gazda ' +
  'jovahagyasaval irja. Olvasni szabad: cat / grep / jq a fajlra (ertelmezo -- python, node -- nem).'

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

// The hook entry. PreToolUse reads exit 2 as "block", exit 0 as "allow" (unless
// a deny is printed) -- and exit 1, or a hook killed by the harness timeout, as
// a NON-blocking error: the tool call runs as if the gate had not been there.
// So nothing on this path may end in a crash or a hang:
//   - the decision runs in a worker thread with a deadline; a decision that
//     throws, never answers, or outlives the deadline (a pathological regex
//     backtrack blocks a thread, it cannot be interrupted from inside) is a
//     DENY, printed by the main thread, which stays responsive;
//   - uncaughtException / unhandledRejection on the main thread deny as well.
// Measured cost of the worker: about +100 ms per call (whole hook process,
// median of 20 runs: 200 ms vs 100 ms without it, node 22, Linux).
//
// Stated exception: stdin that is not JSON still ALLOWS (unchanged). It comes
// from the harness, not from the agent, and a gate that blocks every tool on a
// harness glitch takes the whole fleet down (hook-exit-code-invariant pins it).
const DECISION_DEADLINE_MS = Math.min(30000, Math.max(100, Number(process.env.SELF_PACE_GATE_DEADLINE_MS) || 5000))

const FAIL_CLOSED_MSG = (why) => 'Self-pace kapu: belso hiba vagy idotullepes a vizsgalat kozben ' +
  `(${String(why).slice(0, 200)}). Fail-closed: a hivas nem vizsgalhato, ezert TILTVA. ` + GATE_MSG

function decideInWorker(toolName, toolInput, opts = {}) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), {
      workerData: { selfPaceGateWorker: true, toolName, toolInput, opts },
    })
    const timer = setTimeout(() => {
      w.terminate()
      reject(new Error(`decision exceeded ${DECISION_DEADLINE_MS} ms`))
    }, DECISION_DEADLINE_MS)
    w.once('message', (m) => {
      clearTimeout(timer)
      w.terminate()
      if (m?.ok === true && typeof m.deny === 'boolean') resolve(m)
      else reject(new Error(m?.error ?? 'malformed verdict from the decision worker'))
    })
    w.once('error', (e) => { clearTimeout(timer); reject(e) })
    w.once('exit', (code) => { clearTimeout(timer); reject(new Error(`decision worker exited ${code} without a verdict`)) })
  })
}

if (!isMainThread && workerData?.selfPaceGateWorker) {
  try {
    const verdict = gateDecision(workerData.toolName, workerData.toolInput, workerData.opts ?? {})
    parentPort.postMessage({ ok: true, deny: verdict.deny === true, reason: verdict.reason, error: verdict.error })
  } catch (err) {
    parentPort.postMessage({ ok: false, error: String(err?.stack ?? err) })
  }
} else if (isMainThread && isInvokedDirectly()) {
  process.on('uncaughtException', (err) => deny(FAIL_CLOSED_MSG(err?.message ?? err)))
  process.on('unhandledRejection', (err) => deny(FAIL_CLOSED_MSG(err?.message ?? err)))
  let payload
  try {
    payload = JSON.parse(readFileSync(0, 'utf-8'))
  } catch {
    allow() // malformed/empty input must never break the agent's tool calls
  }
  try {
    const selfAgent = selfAgentFromProjectDir(process.env.CLAUDE_PROJECT_DIR)
    // MCP fast path: a call that names no local path (and is not a known writer missing one) needs no worker
    const mcp = mcpFileTargets(payload?.tool_name, payload?.tool_input)
    if (mcp && mcp.targets.length === 0 && !mcp.missingPath && !mcp.truncated && !mcp.bare.length) allow()
    const verdict = await decideInWorker(payload?.tool_name, payload?.tool_input, { cwd: payload?.cwd, selfAgent, projectDir: process.env.CLAUDE_PROJECT_DIR || null })
    if (verdict.error) deny(FAIL_CLOSED_MSG(verdict.error.split('\n')[0]))
    if (verdict.deny) {
      deny(verdict.reason === 'egress-allowlist' ? ALLOWLIST_GATE_MSG
        : verdict.reason === 'dynamic-command' ? DYNAMIC_COMMAND_GATE_MSG
        : verdict.reason === 'protected-store-file' ? PROTECTED_STORE_GATE_MSG
        : String(verdict.reason ?? '').startsWith('mcp-') ? MCP_GATE_MSG : GATE_MSG)
    }
    allow()
  } catch (err) {
    deny(FAIL_CLOSED_MSG(err?.message ?? err))
  }
}
