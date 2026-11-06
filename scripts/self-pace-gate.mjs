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
const SCHED_PREFIX = String.raw`(?:(?:[A-Za-z_]\w*=\S*|sudo|env|command|exec|nice|builtin|time)\s+)*(?:\S*/)?`
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
//   egress-vendor-hosts.json       -- the hosts bash-egress-parser lets curl/wget reach
//   config-overrides.json          -- dashboard settings; BASH_SANDBOX_AGENTS is one of them
//   bash-sandbox-write-paths.json  -- where a sandboxed agent may write (#2149)
//   email-standing-recipients.json -- an address on it (once activated) takes letters with
//                                     no per-letter approval (email-approval-gate.py)
//   .approval-bot-token, .approval-bot-key -- the owner's approval bot and the key its button data is
//                                     signed with (src/approval-bot.ts, #2160)
// Their writers are the owner, the main agent and, for config-overrides.json, the dashboard
// process; none of them runs this gate. Unlike the allowlist, these have no hash baseline yet,
// so what this gate cannot see (a path built at runtime) is not reported after the fact.
const DEFAULT_STORE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'store')
export const PROTECTED_STORE_FILES = new Set([
  'egress-vendor-hosts.json',
  'config-overrides.json',
  'bash-sandbox-write-paths.json',
  'email-standing-recipients.json',
  '.approval-bot-token',
  '.approval-bot-key',
])
// The file, or a glob that starts on its name. The prefixes are long enough that this gate's
// and the features' own sources (bash-sandbox.ts, config-registry.ts) stay out of it; the
// approval-bot files need their leading dot, so a source or doc named approval-bot-key-*.md or a
// glob over src/approval-bot* stays out too.
const PROTECTED_MENTION_RX =
  /(?:egress[-_]?vendor[-_]?hosts|config[-_]?overrides|bash[-_]?sandbox[-_]?write[-_]?paths|email[-_]?standing[-_]?recipients)\.json|\.approval[-_]?bot[-_]?(?:token|key)\b|(?:egress[-_]?vendor|config[-_]?overrid|bash[-_]?sandbox[-_]?write|email[-_]?standing|\.approval[-_]?bot)[\w.-]*[*?[]/i

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
function protectedSplit(command) {
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
//   - the name is not one the shell itself sets or rewrites (SHELL_MANAGED_NAMES, any BASH*/ZSH*: Dani 71554);
//   - every separator from that assignment to the use is && or ; (or a newline);
//   - from the last ; before the assignment up to it there is no || (`a || F=x && use $F` can run use without F);
//   - the separator right before the assignment is not a pipe or & (that would run it in a subshell).
// Returns, per segment, a Map name -> literal value.
const COMPOUND_WORDS = new Set(['if', 'then', 'elif', 'else', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'select', 'function', 'coproc', '{', '}', '(', ')', '((', '[[' ])
// Names the SHELL itself sets or rewrites: an assignment to one is no definite literal. `PWD=/tmp/q; cd .; cp -R x/.
// $PWD` copies into the real cwd (cd resets PWD; measured in bash and zsh, Dani 71554), `cd /` resets OLDPWD, and $_,
// RANDOM, SECONDS, LINENO ... change on their own. zsh's lower-case twins (dirstack, cdpath, ...) are listed too; any
// BASH* / ZSH* name is excluded by prefix.
const SHELL_MANAGED_NAMES = new Set(['PWD', 'OLDPWD', 'DIRSTACK', 'dirstack', 'CDPATH', 'cdpath', 'IFS', 'RANDOM', 'SRANDOM',
  'SECONDS', 'LINENO', 'EPOCHSECONDS', 'EPOCHREALTIME', 'HISTCMD', 'PPID', 'UID', 'EUID', 'GROUPS', 'SHLVL', 'OPTIND', 'OPTARG',
  'REPLY', 'PIPESTATUS', 'pipestatus', 'FUNCNAME', 'COLUMNS', 'LINES', 'HOME', 'PATH', 'path', 'argv', 'status', 'psvar',
  'TMOUT', 'HOSTNAME', 'MACHTYPE', 'OSTYPE', 'HOSTTYPE', 'COPROC', 'MAPFILE', '_'])
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
    for (const [name, value] of pairs) if (counts.get(name) === 1 && !SHELL_MANAGED_NAMES.has(name) && !/^(?:BASH|ZSH)_?/.test(name)) defs.push({ at, name, value })
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
  if (PROTECTED_STORE_FILES.has(basename(raw).toLowerCase())) return true
  const real = realOrSelf(resolve(cwd, expandHome(raw)))
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
  if (name === 'popd' || !arg || arg.dollar || /[$`*?[]/.test(arg.value) || arg.value === '-') { ctx.cwd = null; return }
  const target = expandHome(arg.value)
  ctx.cwd = target.startsWith('/') ? resolve(target) : (ctx.cwd ? resolve(ctx.cwd, target) : null)
}

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
  // $'...' and $"..." are quotes too; $HOME is the one variable the hook can resolve
  const raw = String(text ?? '').replace(/\$(?=['"])/g, '').replace(/\$\{HOME\}|\$HOME(?!\w)/g, homedir())
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
  const cmd = (words.find((w) => !/^[A-Za-z_]\w*=/.test(w)) ?? '').replace(/^.*\//, '')
  if (ctx && DIR_WRITERS.has(cmd)) {
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
export const SECURITY_TABLES = ['approvals', 'approval_events', 'approval_slack_posts', 'auth_sessions', 'dashboard_users', 'device_keys', 'vault_ssh_keys']
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

export function globMatchesName(glob, name) {
  let rx = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') rx += '.*'
    else if (c === '?') rx += '.'
    else if (c === '[') {
      const j = glob.indexOf(']', i + 1)
      if (j === -1) { rx += '\\['; continue }
      rx += '[' + glob.slice(i + 1, j).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']'
      i = j
    } else rx += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  try { return new RegExp(`^${rx}$`, 'i').test(name) } catch { return true } // unreadable glob: fail closed
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
  return scheduleSurfaceRefsAll(text, opts)
}
function scheduleSurfaceRefsAll(text, opts) {
  const vs = scheduleSurfaceVariants(text)
  // The security surface (db-write-gate): an SQL write on a security table is
  // the strong reference, the database file keeps its own narrower rule; the
  // schedule route, store and registry tool are not this mode's business.
  if (opts?.surface === 'security') {
    return {
      api: false,
      dir: false,
      cli: false,
      sql: vs.some((v) => SECURITY_SQL_WRITE_RX.test(v)),
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
// no leading `-` (v8): a token that reached a curl word could otherwise be read as an option
const TOKEN_CONTENT_RX = /^[A-Za-z0-9._~+/=][A-Za-z0-9._~+/=-]*\n?$/
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
// The fleet's own bus recipe (the closing PUT / the message POST) builds its JSON body with a FIXED python snippet inside the
// data value, `--data-binary "$(python3 -c 'import json,sys; print(json.dumps({"status":"done","result":sys.argv[1]}))'
// '<text>')"`. The quoted substitution is not a plain word (readWord refuses a `$(` inside "..."), so a result text that
// merely NAMES the schedule API denied the whole message (measured with and without the flag). It is
// rewritten to the single-quoted literal it evaluates to ONLY when (a) the python code is exactly a json.dumps of a dict
// literal whose values are string/true/false/null constants or sys.argv[N] -- no other expression can run, (b) every
// argument is a single-quoted word (no expansion) separated by blanks (space/tab) ONLY -- a newline inside the substitution is a
// command separator, so the words after it run as their own command -- that carries no `$` and no backtick (the single-quoted result is inert only for
// a consumer that treats it as DATA; an `eval` re-reads the json.dumps output as shell and would run a `$(...)` in it),
// and (c) it is the VALUE of a data option (-d / --data / --data-raw /
// --data-binary), never a URL or a header. Anything else is left alone and judged as before.
const JSON_DUMP_CODE_RX = /^import json,\s*sys;\s*print\(json\.dumps\(\{(?:\s*"[A-Za-z_]\w*"\s*:\s*(?:"[^"\\$`]*"|true|false|null|sys\.argv\[[1-9]\])\s*,?)+\s*\}(?:\s*,\s*ensure_ascii\s*=\s*(?:True|False))?\)\)$/
const JSON_DUMP_SUBST_RX = /((?:^|[ \t])(?:-d|--data(?:-raw|-binary)?)(?:[ \t]+|=))"\$\([ \t]*(?:\/usr\/bin\/)?python3[ \t]+(?:-I[ \t]+)?-c[ \t]+'([^']*)'((?:[ \t]+'[^'$`]*')*)[ \t]*\)"/g
// The rewrite must NOT run inside a heredoc body: a body handed to an interpreter (`python3 - <<EOF`, node, bash) is code
// that RUNS, and a recipe-shaped substitution in it would be rewritten to a data word and blanked, hiding a real
// `tmux send-keys` next to it from the naive layer. A recipe is a command-line form, never body text.
// Where a body starts and ends is the shell's business (line continuation, quoted or escaped delimiters, `<<-` tabs, a
// delimiter that only looks closed), and every rule this gate re-implements for it is a way to be wrong; so the rewrite is
// FAIL-CLOSED instead: it stops at the first `<<` that is not a here-string (`<<<`), wherever that sits (inside quotes too,
// and also when a backslash-newline splits the operator: the shell removes that pair before it reads `<<`),
// and nothing after it is rewritten. The price: a recipe AFTER a heredoc is judged unresolved (denied when its text names the
// schedule surface); a recipe BEFORE one, and one after a here-string, still resolve.
// An ESCAPED `<` is a literal word, not an operator: `\<<<'PY'` is a literal `<` followed by a real `<<'PY'` heredoc, so the
// lookbehind only excludes an UNESCAPED `<` (a real here-string's first or second `<`). `\\<<<` (an escaped backslash, then
// a real here-string) is cut as well: it over-cuts, which is the fail-closed side.
const HEREDOC_CUT_RX = /(?<!(?<!\\)<)<(?:\\\r?\n)*<(?!<)/
// True when the character at `k` starts a shell word: nothing in front of it, or a blank / separator / `(`. A backslash-newline
// pair in front is REMOVED by the shell (`x\<newline>#y` is the one word `x#y`, whose # is no comment), so it is skipped
// before the look-back; an escaped backslash in front of a newline (`\\<newline>`) is no continuation.
// The shell's blanks are the SPACE and the TAB (and the newline, which ends the command): a CR, a VT, a FF or a Unicode space in front
// of a `#` is a word character, so that `#` opens no comment. The JS `\s` class counts them all as white space, which is why it is not
// used for a word boundary here or in hasUnspelledCommandWord.
function wordStartAt(src, k) {
  let j = k - 1
  while (j >= 1 && src[j] === '\n') {
    let b = j - 1
    if (src[b] === '\r') b--
    let n = 0
    for (let m = b; m >= 0 && src[m] === '\\'; m--) n++
    if (n % 2 === 0) break
    j = b - 1
  }
  return j < 0 || /[ \t\n;|&(]/.test(src[j])
}
// True when `upTo` sits at the shell's TOP LEVEL of `src`: nothing opened in front of it is still open (a quote, a `$(`, a `(`, a
// backtick). The rewrite below turns "$(...)" into one inert word, which is only true when the opening `"` really OPENS a word: in
// `bash -c 'shift 3; "$@"' "x -d "$(...)""` the `"` in front of `$(` CLOSES the earlier word, the substitution is unquoted, its output
// is split into words and RUNS -- while the rewritten text hid it from both layers. Anything the scan cannot close
// (an unterminated quote, a `$(` or a quote that spans `upTo`) is "not at the top level": the text is then judged as written.
// Returns the start index of the shell segment `upTo` sits in (the recipe's owner is that segment's first word), or -1 when it is not top level.
// True when the character in front of src[k] is the operator character `ch`: a backslash-newline pair in between is removed by the
// shell before it reads an operator (`>\<newline>&` is `>&`), and an ESCAPED character is a literal (`\>&` is a literal `>` and a
// real `&`; an odd run of backslashes escapes, an even one does not).
function prevIsOp(src, k, ch) {
  let j = k - 1
  while (j >= 1 && src[j] === '\n') {
    let n = 0
    for (let m = j - 1; m >= 0 && src[m] === '\\'; m--) n++
    if (n % 2 === 0) break
    j -= 2
  }
  if (j < 0 || src[j] !== ch) return false
  let n = 0
  for (let m = j - 1; m >= 0 && src[m] === '\\'; m--) n++
  return n % 2 === 0
}
function topLevelScan(src, upTo) {
  let segStart = 0
  for (let k = 0; k < upTo; k++) {
    const c = src[k]
    if (c === '\\') { k++; continue }
    // a `#` at the start of a word begins a comment up to the end of the line: a quote inside it opens nothing
    if (c === '#' && wordStartAt(src, k)) { const e = src.indexOf('\n', k); if (e === -1 || e >= upTo) return -1; segStart = e + 1; k = e; continue }
    if (c === "'") { const e = src.indexOf("'", k + 1); if (e === -1 || e >= upTo) return -1; k = e; continue }
    if (c === '"') { const e = dquoteEnd(src, k + 1); if (e === -1 || e >= upTo) return -1; k = e; continue }
    if (c === '$' && src[k + 1] === "'") {
      let j = k + 2
      while (j < src.length && src[j] !== "'") j += src[j] === '\\' ? 2 : 1
      if (j >= src.length || j >= upTo) return -1
      k = j; continue
    }
    if (c === '$' && src[k + 1] === '(') { const e = substEnd(src, k + 2); if (e === -1 || e >= upTo) return -1; k = e; continue }
    if (c === '(') { const e = substEnd(src, k + 1); if (e === -1 || e >= upTo) return -1; k = e; continue }
    if (c === '`') { const e = src.indexOf('`', k + 1); if (e === -1 || e >= upTo) return -1; k = e; continue }
    // a command separator at the top level starts a new segment (the same set SEGMENT_SEP_RX splits on, but `2>&1`, `&>` and `>|` are redirections, not separators)
    // `>|` is the clobbering redirection, not a pipe: the file name behind it owns nothing
    if (c === '\n' || c === ';' || (c === '|' && !prevIsOp(src, k, '>')) || (c === '&' && !prevIsOp(src, k, '<') && !prevIsOp(src, k, '>') && src[k + 1] !== '>')) segStart = k + 1
  }
  return segStart
}
// The recipe is a curl command line, so the rewrite needs a curl OWNER: the option's command is the first word of its own
// shell segment, `curl` or `/usr/bin/curl`. Any other owner (`python3 -c 'exec(...)' -d "$(...)"`, a wrapper such as `env` /
// `command`, a group `{ curl ...; }`, an env prefix) may execute the value of its -d, and the rewritten word is blanked from the
// naive layer, so what it carries would be invisible. Anything not recognised is left alone and judged
// as before: fail closed, the price is a denied text that names the surface.
const CURL_OWNER_RX = /^(?:\/usr\/bin\/)?curl(?=[ \t\r\n]|$)/
// The recipe also relies on `python3` (and `curl`) being the real programs. A command that defines a function, an alias, a hash
// entry, a PATH, or pulls in code (source, `.`, eval) outside the recipe itself may have replaced them, so the "fixed json.dumps
// snippet" is then whatever that definition does with its arguments. PYTHON* (PYTHONPATH, PYTHONHOME, ...) is the same for the
// module lookup: `import json` would load another file. The text outside the recipe matches is checked; the recipes' own
// single-quoted arguments are inert and are not (a result text may say "function", "PATH" or "()"), and that holds for EVERY
// valid recipe in the command, not only the one being rewritten.
// `trap` is on the list because its body is shell code that runs in THIS shell, inside a quoted word the scan below does not parse: a
// body such as `p=PA;t=TH;export "$p$t=/tmp/x"` builds the name PATH out of two pieces no regex here can see, and `python3` then
// resolves to whatever sits in /tmp/x. An ambiguous command is not rewritten (fail closed): the original text goes through the
// ordinary checks, and the recipe's own `$( )` body is decided as a command of its own.
// KNOWN LIMIT, stated like the script-file one in the header of this section: `python3 -c` puts the working directory first on
// sys.path, so a `json.py` an EARLIER call wrote into the current directory would run in place of the stdlib module. That is the
// same "script file written earlier" the gate allows on purpose (the Write tool can write any file); it is not visible in the
// command text. `python3 -I -c` closes it for the recipes that use it and is accepted as the interpreter; the bare `python3 -c` stays
// accepted too (a gate change must not force a fleet-wide recipe rewrite; moving the shared recipes to -I is a separate step).
const COMMAND_SHADOW_RX = /\b(?:function|alias|unalias|hash|enable|builtin|shopt|typeset|declare|readonly|source|eval|trap|PATH|BASH_ENV|ENV|PYTHON\w*)\b|\(\s*\)|(?:^|[;&|\n(]\s*)\.[ \t]/
// ... but that regex reads the RAW text (it also runs on a copy without quotes and backslashes, which closes a split variable NAME
// such as `PA""TH=` or `PY\THONPATH` used as an argument), so a command word split by quotes or an escape (`ha""sh`, `h\ash`, `h\<newline>ash`) or built by an
// expansion (`$x`, `$(echo hash)`) is not seen. The command word of every top-level segment of the text outside the recipes must
// therefore be a plain literal word (letters, digits, `_./+-`); behind an env assignment or a control keyword (`!`, `if`, `then`,
// `do`, `{` ...) the next word counts. A wrapper (`command`, `env`, `time`, `case` ...) and the dot command are not resolved. A redirection first in the segment, a quote, an escape or an expansion in that word
// means its name is unknown: the rewrite is not applied (fail closed). A group `( ... )` is the
// command by itself. The scan reads quotes, `$(...)`, backticks and comments the way topLevelScan does.
const COMMAND_WORD_PLAIN_RX = /^[A-Za-z0-9_.\/+-]+$/
const COMMAND_WORD_SKIP_RX = /^(?:[A-Za-z_]\w*=[\s\S]*|!|if|then|else|elif|do|while|until|\{|\})$/
// harmless as a command word: the test builtins and `:` (they define nothing and run nothing)
const COMMAND_WORD_HARMLESS = new Set(['[', '[[', ':'])
// a command word whose REAL command follows it (or that the scan cannot follow): not resolved, fail closed
const COMMAND_WORD_WRAPPERS = new Set(['command', 'builtin', 'exec', 'env', 'nohup', 'nice', 'time', 'xargs', 'sudo', 'doas', 'timeout', 'case', 'select', 'coproc', 'watch', 'stdbuf'])
// The ARGUMENTS of a builtin that takes a variable NAME as one (`export PATH=...`, `read PATH`, `printf -v PATH`, `mapfile PATH`,
// `getopts o PATH`) are read as well: a name built by an ANSI-C quote (`$'PA\x54H'`), an empty expansion (`PA${x}TH`, `PA$(:)TH`) or a
// brace expansion (`PA{,}TH`) passes both keyword regexes, which only undo quotes and backslashes. The name
// part of such an argument (up to the first `=`) must be a plain IDENTIFIER, or the rewrite is not applied (fail closed); the
// value is free. Anything else is a shape the parser cannot identify for sure, and it is denied, not enumerated: a digit, a dash, an
// empty part (`export =$y$z` is no assignment, so its unquoted value splits into new NAME arguments), a glob, a quote, an expansion
// (none of them is an identifier). A redirection and its target are no argument of the builtin (a closing one, `>&-`, has no target).
// The value of a `read` / `mapfile` option and the option string of `getopts` are no name, but they are words: one that may SPLIT
// into several (an unquoted expansion, a glob) puts a later piece in a name position, so it must be a plain literal, a single-quoted
// word, or a double-quoted word whose only expansions are plain scalars (`"$x"`, `"${x}"`): `"$@"`, `"${a[@]}"` and `"${!P@}"` split
// even inside double quotes, and an empty `"$@"` is no word at all. A `mapfile -C` callback is code and denies. `for v do BODY; done` has no `;` in front of its `do`:
// there the `do` opens command position again.
const NAME_ARG_BUILTINS = new Set(['export', 'read', 'mapfile', 'readarray', 'getopts'])
const NAME_PART_RX = /^[A-Za-z_][A-Za-z0-9_]*\+?$/
// the only options of `export` (`-f` function names, `-n` unexport, `-p` listing) and the end-of-options word; they take no value
const EXPORT_OPTION_RX = /^(?:--|-[fnp]+)$/
// a word that cannot split into several: a plain literal, a single-quoted word, or a double-quoted one with no inner double quote, no escape,
// no command substitution or backtick, and only plain scalar expansions (`$x`, `${x}`: the `@`, `*`, `!` and `[` forms are left out
// because `"$@"`, `"${a[@]}"` and `"${!P@}"` split, or vanish, inside double quotes). The anchors rule out a mixed word such as `"a"$x"b"`.
const INERT_VALUE_RX = /^(?:[A-Za-z0-9_.%\/+:@,=-]+|'[^']*'|"(?:[^"\\$`]|\$[A-Za-z_][A-Za-z0-9_]*|\$\{[A-Za-z_][A-Za-z0-9_]*\})*")$/
// `>&-` and `<&-` close a descriptor and take NO target: only the forms that wait for a target set redirNext
const REDIRECTION_ONLY_RX = /^[0-9]*(?:&>>?|<<<|<<-?|<>|<&|>&|>>|>\||<|>)$/
const REDIRECTION_START_RX = /^[0-9]*(?:&>|[<>])/
// A literal name that sticks to its option (`-vPATH`, `-aPATH`) has no word boundary in front of it, so the keyword regex never sees
// it: such a name must not END like a protected one.
const ATTACHED_PROTECTED_RX = /(?:PATH|ENV|PYTHON\w*)$/
// The options of `read` / `mapfile` that take a VALUE (the next word, or the rest of the option word): the value is no variable name
// (`read -d '' X`, `read -p "Name: " x`). `read -a` is the exception: its value IS the array name.
const OPTION_VALUE_LETTERS = new Map([['read', 'dinNptu'], ['mapfile', 'dnOsuc'], ['readarray', 'dnOsuc']])
// Whether a word can be an OPTION is decided by the shell AFTER quote removal and expansion, so the raw text is no judge: `"-v"`,
// `-"v"`, `$d`, `{-v,x}`, `\-v`, `$'-v'` and `""-v` are all `-v` to printf. 'plain': the word cannot start with a dash
// (it starts with a literal that is no dash, or with a quote followed by such a character); 'dash': a literal option word; 'unknown':
// anything the scan cannot tell (an expansion, an escape, a brace, a glob, a quote followed by a dash or an expansion).
const OPTIONLESS_START_RX = /^[A-Za-z0-9_.%\/+:@,]/
const QUOTED_PLAIN_RX = /^['"][^-$`\\'"]/
const leadWordKind = (w) => {
  if (OPTIONLESS_START_RX.test(w) || QUOTED_PLAIN_RX.test(w)) return 'plain'
  if (w === '--' || /^-[A-Za-z0-9]*$/.test(w)) return 'dash'
  return 'unknown'
}
// The option string of `getopts` (its first operand) must be fully literal, or quoted without an expansion: an unquoted expansion or a
// glob in a word that merely STARTS with a letter splits into several words and moves the variable name one place on.
const GETOPTS_STRING_RX = /^(?:[A-Za-z0-9_:]+|'[^'-][^']*'|"[^-$`\\"][^$`\\"]*")$/
// (measured, bash 5.2.15) a `%n` conversion in printf's FORMAT stores the byte count in the variable its argument
// NAMES (`printf '%s%n' x "${p}TH"` sets PATH=1), a name no check above sees. A format that holds a %n (after `%%` is taken out), or
// that the scan cannot read (an expansion, a mixed or unquoted escaped word), is not rewritten. A backslash escape cannot make a %n:
// printf reads the conversion from the raw format, and an unquoted `\n` is excluded with the rest of the unquoted escapes.
const PRINTF_FORMAT_READABLE_RX = /^(?:[A-Za-z0-9_.%\/+:@,=-]+|'[^']*'|"(?:[^"\\$`]|\\.)*")$/
// fail closed on the spec between `%` and the `n`: any run of non-letters (flags such as `'`, width, precision, `*`)
const PRINTF_N_RX = /%[^%a-zA-Z]*[hlLqjzt]*n/
const printfFormatAssigns = (w) => !PRINTF_FORMAT_READABLE_RX.test(w) || PRINTF_N_RX.test(w.replace(/%%/g, ''))
// the same class: arithmetic evaluation assigns to a name, and the name may be built at run time or sit in the VALUE
// of a variable the arithmetic reads (bash evaluates that value as an expression too). Measured on bash 5.2.15: `let`, `((...))`,
// `$((...))`, `$[...]`, a `[[ ... -eq ... ]]` operand, an array subscript and a `${x:offset}` each set PATH=1. Text outside the recipes
// that may evaluate arithmetic is not rewritten, `for ((...))` included (fail closed). `[[ -f x ]]` and the defaults `${x:-y}`,
// `${x:=y}`, `${x:?y}`, `${x:+y}` evaluate nothing and stay open.
// v3: a NAME held in a variable reaches the same subscript arithmetic without any `name[` in the text: the indirect
// expansion `${!n}`, `test -v` / `[ -v ]` / `[[ -v ]]`, `unset` and `wait -p` take a name such as `a[PATH=1]` (or PATH itself, for
// wait -p) from a variable. Those forms are not rewritten either.
const ARITH_EVAL_RX = /\blet\b|\bunset\b|\(\(|\$\[|\$\{!|\[\[(?:(?!\]\])[\s\S])*?\s-(?:eq|ne|lt|le|gt|ge|v)\b|(?:\btest|(?:^|[\s;&|(!])\[)\s(?:[^\n;&|]*\s)?-v\b|\bwait\b[^\n;&|]*\s-[A-Za-z]*p|\w\[|\$\{[^}]*(?::(?![-=?+])|\[)/
// a STRUCTURAL allowlist instead of the open-ended deny lists. Three review rounds found a new way, each
// time, to write a variable by a name the text never spells (printf %n, arithmetic, ${!n}, `test $'-v'`, ${x@P}, PS4 with
// set -x, jobs -x ...): every one of them needs an expansion, a quote trick, an assignment or a builtin. So the text around a
// rewritten recipe, and the whole create command, is accepted only when the shell can do nothing there but run a few
// known commands with literal words. Anything else is not rewritten (fail closed: the command is judged as written).
//   - command words: only the given set (exact, unquoted), behind the structure keywords `!` `if` `then` `else` `elif` `fi`
//     `{` `}`; no assignment word, no other builtin, no function, no wrapper;
//   - words: plain characters (letters, digits, `_@%+=:,./-`), single-quoted parts, and double-quoted parts with no `$`,
//     backtick or backslash -- except the token read `$(cat <literal path>)` inside double quotes, which runs `cat` only;
//   - printf: the format (behind an optional `--`) is a literal word that does not start with `-` and holds no %n conversion;
//   - blanks are the space and the tab, separators `;` `|` `&` `&&` `||` and the newline, a `#` at a word start opens a
//     comment;
//   - nothing may write a file (a file written in front of the recipe can replace
//     the python3 it runs): an output redirection goes to /dev/null only, a descriptor copy (`N>&M`, `>&-`) to a number or `-`
//     only; curl takes only the non-writing options below, and `-K -` / `--config -` only when its stdin is the pipe from
//     EXACTLY the recipe's header printf right in front of it (`printf 'header = "Authorization: Bearer %s"\n'
//     "$(cat <accepted token file>)"`, the stdinAuthHeaderOnly shape: one header line, no output, URL or data line; the file is
//     acceptedTokenFile's, so opts carries the same projectRoot and selfAgent), never a file or an
//     inherited descriptor (`0<&3`); and at most ONE curl without `-q` / `--disable` first
//     (an earlier curl reading a ~/.curlrc with an `output` line would write a file before the recipe runs; that ~/.curlrc
//     itself is a file an EARLIER call wrote, the documented residual); curl's words are judged as curl
//     gets them, after the shell's quote removal (`'-o'`, `"-K"` are options too);
//   - v7 (F1): the token read `"$(cat <path>)"` stands only as the header printf's second word or as a curl -H / --header
//     value, and only from an accepted token file (acceptedTokenFile); in any other word it denies;
//   - every other character ($, backtick, backslash, `( ) [ ] * ? ~`, `! { }` inside a word, any other white space) denies;
//   - `cd <literal path> && ...` is plain too (the fleet writes the recipe so): `cd` with exactly one plain,
//     unquoted path that does not start with `-`, no redirection, and `&&` right behind it. (A `json.py` an EARLIER call wrote
//     into that directory is the documented residual of the recipe rewrite, see KNOWN LIMIT there.)
//   - v5: a line continuation (backslash-newline outside quotes) is removed as the shell removes it, and a newline right after
//     `|`, `&&` or `||` continues the same pipeline or list (the multi-line recipe the fleet writes); any other backslash denies
//     (an escaped `\-o` would reach curl as `-o`).
// Returns the number of commands, or -1 when the text is not plain (the create path wants exactly one command).
const PLAIN_REWRITE_COMMANDS = new Set(['curl', '/usr/bin/curl', 'printf', 'echo', 'true', 'false', 'ls', 'cat', 'cd'])
const PLAIN_CREATE_COMMANDS = new Set(['curl', '/usr/bin/curl'])
const PLAIN_KEYWORDS = new Set(['!', 'if', 'then', 'else', 'elif', 'fi', '{', '}'])
const PLAIN_CHAR_RX = /[A-Za-z0-9_@%+=:,./-]/
const TOKEN_CAT_RX = /\$\(cat ([A-Za-z0-9_./-]+)\)/g
const PLAIN_REDIRECT_RX = /^(?:[0-9]?(?:>>|>\||>&|<&|>|<)|&>>?)/
const PLAIN_CD_PATH_RX = /^[A-Za-z0-9_@%+=:,./][A-Za-z0-9_@%+=:,./-]*$/
const PLAIN_AUTH_PRINTF_FORMAT = `'header = "Authorization: Bearer %s"\\n'`
const PLAIN_AUTH_PRINTF_TOKEN_RX = /^"\$\(cat ([A-Za-z0-9_./-]+)\)"$/
const PLAIN_FORMAT_RX = /^(?:'[^']*'|"[^"$`\\]*"|[A-Za-z0-9_@%+=:,./-]+)$/
const PLAIN_CURL_SHORT = 'sSfLiIkvgGNq46'
const PLAIN_CURL_SHORT_ARG = 'XHdmK'
const PLAIN_CURL_LONG_NOARG = new Set(['--silent', '--show-error', '--fail', '--fail-with-body', '--location', '--include',
  '--insecure', '--verbose', '--globoff', '--get', '--compressed', '--no-progress-meter', '--no-buffer', '--disable'])
const PLAIN_CURL_LONG_ARG = new Set(['--request', '--header', '--data', '--data-raw', '--data-binary', '--json', '--max-time',
  '--connect-timeout', '--retry', '--retry-delay', '--retry-max-time', '--config', '--url'])
const unquoted = (a) => a.replace(/'[^']*'|"[^"]*"/g, '')
// the word as the program gets it, after the shell's quote removal (a quoted '-o' is curl's -o)
const dequote = (a) => a.replace(/'([^']*)'|"([^"]*)"/g, (_m, s, d) => s ?? d)
// curl's option words: only the known, non-writing ones. Returns -1 for anything else, 1 when it reads a config from stdin
// (`-K -` / `--config -`, the only config value let through), 0 otherwise. headerAt gets the index of every word that is the
// value of a -H / --header, as curl pairs options and values (v8: not the word in front, `-X -H x` is -X's value)
function plainCurlArgs(args, headerAt = new Set()) {
  let config = 0
  for (let j = 0; j < args.length; j++) {
    const a = args[j]
    if (!a.startsWith('-') || a === '-') continue
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      const name = eq === -1 ? a : a.slice(0, eq)
      if (PLAIN_CURL_LONG_NOARG.has(name) && eq === -1) continue
      if (!PLAIN_CURL_LONG_ARG.has(name)) return -1
      const value = eq === -1 ? args[++j] : a.slice(eq + 1)
      if (value === undefined) return -1
      if (name === '--header' && eq === -1) headerAt.add(j)
      if (name === '--config') { if (value !== '-') return -1; config = 1 }
      continue
    }
    for (let q = 1; q < a.length; q++) {
      if (PLAIN_CURL_SHORT.includes(a[q])) continue
      if (!PLAIN_CURL_SHORT_ARG.includes(a[q])) return -1
      const value = q + 1 < a.length ? a.slice(q + 1) : args[++j]
      if (value === undefined) return -1
      if (a[q] === 'H' && q + 1 === a.length) headerAt.add(j)
      if (a[q] === 'K') { if (value !== '-') return -1; config = 1 }
      break
    }
  }
  return config
}
function plainShellText(text, commands, opts) {
  const segs = [{ words: [], sep: '' }]
  let w = null
  const end = () => { if (w !== null) { segs[segs.length - 1].words.push(w); w = null } }
  for (let k = 0; k < text.length; k++) {
    const c = text[k]
    if (c === '\\' && text[k + 1] === '\n') { k++; continue } // a line continuation: the shell joins the two lines
    if (c === ' ' || c === '\t') { end(); continue }
    if (c === '&' && (text[k - 1] === '>' || text[k - 1] === '<' || text[k + 1] === '>')) { w = (w ?? '') + c; continue }
    if (c === '|' && text[k - 1] === '>') { w = (w ?? '') + c; continue } // `>|` is a redirection, not a pipe
    if (c === '\n' || c === ';' || c === '|' || c === '&') {
      end()
      // a newline right after `|`, `&&`, `||` or `|&` continues that pipeline or list: no new command starts there
      const cur = segs[segs.length - 1]
      if (c === '\n' && cur.words.length === 0 && ['|', '&&', '||', '|&'].includes(cur.sep)) continue
      // `||`, `&&` and `|&` are one separator each: only a single `|` makes the next command read this one's output
      const two = (c === '|' || c === '&') && (text[k + 1] === '|' || text[k + 1] === '&')
      segs.push({ words: [], sep: two ? c + text[++k] : c })
      continue
    }
    if (c === '#' && w === null) { const e = text.indexOf('\n', k); if (e === -1) break; k = e - 1; continue }
    if (c === "'") {
      const e = text.indexOf("'", k + 1)
      if (e === -1) return -1
      w = (w ?? '') + text.slice(k, e + 1); k = e; continue
    }
    if (c === '"') {
      const e = text.indexOf('"', k + 1)
      if (e === -1 || /[$`\\]/.test(text.slice(k + 1, e).replace(TOKEN_CAT_RX, ''))) return -1
      w = (w ?? '') + text.slice(k, e + 1); k = e; continue
    }
    if (PLAIN_CHAR_RX.test(c) || c === '>' || c === '<' || PLAIN_KEYWORDS.has(c)) { w = (w ?? '') + c; continue }
    return -1
  }
  end()
  let n = 0
  let rcCurls = 0 // curl commands that may read a ~/.curlrc (no -q / --disable as the first argument)
  let prevAuth = false // the segment right in front is exactly the recipe's header printf
  for (let si = 0; si < segs.length; si++) {
    const seg = segs[si]
    const authPiped = seg.sep === '|' && prevAuth
    prevAuth = false
    let i = 0
    while (i < seg.words.length && PLAIN_KEYWORDS.has(seg.words[i])) i++
    if (i === seg.words.length) continue
    const cmd = seg.words[i]
    if (!commands.has(cmd)) return -1
    n++
    const args = []
    let input = false
    const words = seg.words.slice(i + 1)
    for (let j = 0; j < words.length; j++) {
      const a = words[j]
      if (/[!{}]/.test(unquoted(a))) return -1
      const op = PLAIN_REDIRECT_RX.exec(a)
      if (!op) {
        if (/[<>]/.test(unquoted(a))) return -1
        args.push(a)
        continue
      }
      const target = a.length > op[0].length ? a.slice(op[0].length) : words[++j]
      if (target === undefined || /[<>!{}]/.test(unquoted(target)) || target.includes('$(')) return -1
      if (op[0].includes('<')) input = true // any input redirection, a descriptor copy (`0<&3`) too
      if (/[<>]&$/.test(op[0])) { if (!/^(?:[0-9]+|-)$/.test(target)) return -1; continue } // a descriptor copy or close
      if (op[0].includes('>')) { if (target !== '/dev/null') return -1; continue } // an output: no file gets written
      // `<` from a literal file (input is set above)
    }
    // the token read `"$(cat <path>)"` only where the recipe puts it -- the header printf's second word
    // and the value of a curl -H / --header -- and only from an accepted token file: anywhere else its run-time content could
    // be a curl option or a URL
    const isCurl = cmd === 'curl' || cmd === '/usr/bin/curl'
    const headerAt = new Set() // v8: the real -H / --header values, from curl's own option and value pairing
    if (isCurl && plainCurlArgs(args.map(dequote), headerAt) < 0) return -1
    for (let k = 0; k < args.length; k++) {
      if (!args[k].includes('$(')) continue
      const at = cmd === 'printf' ? k === 1 && args.length === 2 && args[0] === PLAIN_AUTH_PRINTF_FORMAT
        : isCurl && headerAt.has(k)
      if (!at || ![...args[k].matchAll(TOKEN_CAT_RX)].every((m) => acceptedTokenFile(m[1], opts))) return -1
    }
    // `cd <literal path> &&`: one plain path argument, no redirection, and the `&&` right behind it
    if (cmd === 'cd' && (args.length !== 1 || args.length !== words.length || !PLAIN_CD_PATH_RX.test(args[0]) || segs[si + 1]?.sep !== '&&')) return -1
    // the header printf of the bus recipe, word for word and nothing else in its segment (no redirection either), and the file
    // it reads is an accepted token file (a relative path, `cat -` or a multi-line file could put an `output` or
    // `url` line into the config, the same check stdinAuthHeaderOnly makes through resolveCatSubst)
    const tokenCat = cmd === 'printf' && words.length === 2 && words[0] === PLAIN_AUTH_PRINTF_FORMAT && PLAIN_AUTH_PRINTF_TOKEN_RX.exec(words[1])
    prevAuth = !!tokenCat && acceptedTokenFile(tokenCat[1], opts)
    if (cmd === 'printf') {
      const f = args[0] === '--' ? args[1] : args[0] // the format comes first: an option (-v) in front of it is no plain form
      if (f === undefined || !PLAIN_FORMAT_RX.test(f)) return -1
      const v = /^['"]/.test(f) ? f.slice(1, -1) : f
      if (v.startsWith('-') || PRINTF_N_RX.test(v.replace(/%%/g, ''))) return -1
    }
    if (cmd === 'curl' || cmd === '/usr/bin/curl') {
      const cargs = args.map(dequote) // curl's own view of its words
      const config = plainCurlArgs(cargs)
      if (config < 0) return -1
      // a config read from stdin only from the printf piped right into it, never from a file
      if (config === 1 && (!authPiped || input)) return -1
      // the -q rule reads the word as written: a quoted '-q' counts as a curl that may read a ~/.curlrc (stricter)
      if (args[0] !== '-q' && args[0] !== '--disable' && ++rcCurls > 1) return -1
    }
  }
  return n
}
const nameIsLiteral = (w, attached = false) => {
  const i = w.indexOf('=')
  const part = i === -1 ? w : w.slice(0, i)
  return NAME_PART_RX.test(part) && !(attached && ATTACHED_PROTECTED_RX.test(part))
}
function hasUnspelledCommandWord(src) {
  let seen = false
  let ws = -1
  let cmd = ''
  let nameNext = false
  let redirNext = false
  let valueNext = false
  let getoptsPos = 0
  let printfFmt = false
  // an option word of read / mapfile / readarray: true when it hides an unknown option or a built array name
  const optionWord = (w) => {
    if (!/^-[A-Za-z0-9]+$/.test(w)) return true
    const letters = OPTION_VALUE_LETTERS.get(cmd)
    for (let i = 1; i < w.length; i++) {
      const rest = w.slice(i + 1)
      // `mapfile -C` names a CALLBACK the shell evaluates: its value is code, not data
      if (cmd !== 'read' && w[i] === 'C') return true
      if (cmd === 'read' && w[i] === 'a') return rest ? !nameIsLiteral(rest, true) : false // the next word is a name: read as any argument
      if (letters.includes(w[i])) { if (!rest) valueNext = true; return false }
    }
    return false
  }
  // an argument of the command word `cmd`: true when the rewrite must not be applied
  const argUnspelled = (w) => {
    if (redirNext) { redirNext = false; return false }
    if (REDIRECTION_ONLY_RX.test(w)) { redirNext = true; return false }
    if (REDIRECTION_START_RX.test(w)) return false
    if (cmd === 'for' && w === 'do') { seen = false; return false }
    if (valueNext) { valueNext = false; return !INERT_VALUE_RX.test(w) }
    if (nameNext) { nameNext = false; return !nameIsLiteral(w) }
    // an option-looking word (`getopts -- x NAME`) would shift the position of the name: unknown, fail closed
    if (cmd === 'getopts') {
      getoptsPos++
      // the option string: a word that is or may be an option (`getopts -- x NAME`, `"--"`, `$d`) shifts the position of the name
      if (getoptsPos === 1) return !GETOPTS_STRING_RX.test(w)
      return getoptsPos === 2 && !nameIsLiteral(w)
    }
    if (cmd === 'printf') {
      if (printfFmt === 'args') return false // after the format word nothing is an option
      if (printfFmt === 'fmt') { printfFmt = 'args'; return printfFormatAssigns(w) } // the word after `--`
      const kind = leadWordKind(w)
      if (kind === 'plain') { printfFmt = 'args'; return printfFormatAssigns(w) }
      if (w === '--') { printfFmt = 'fmt'; return false }
      if (w === '-v') { nameNext = true; return false }
      if (w.startsWith('-v')) return !nameIsLiteral(w.slice(2), true)
      return kind === 'unknown'
    }
    if (!NAME_ARG_BUILTINS.has(cmd)) return false
    if (w[0] === '-' && OPTION_VALUE_LETTERS.has(cmd)) return optionWord(w)
    if (cmd === 'export' && EXPORT_OPTION_RX.test(w)) return false
    return !nameIsLiteral(w)
  }
  const endWord = (e) => {
    const w = src.slice(ws, e)
    ws = -1
    if (seen) return argUnspelled(w)
    if (COMMAND_WORD_SKIP_RX.test(w)) return false
    seen = true
    cmd = w
    nameNext = false
    redirNext = false
    valueNext = false
    getoptsPos = 0
    printfFmt = false
    if (COMMAND_WORD_HARMLESS.has(w)) return false
    if (!COMMAND_WORD_PLAIN_RX.test(w)) return true
    // the dot command sources a file (the keyword regex only sees it after a separator), a wrapper hides the real command
    return w === '.' || COMMAND_WORD_WRAPPERS.has(w.slice(w.lastIndexOf('/') + 1))
  }
  for (let k = 0; k < src.length; k++) {
    const c = src[k]
    if (c === '\\') {
      if (src[k + 1] === '\n') { k++; continue }
      if (ws === -1) ws = k
      k++; continue
    }
    if (c === '#' && ws === -1) { const e = src.indexOf('\n', k); if (e === -1) break; k = e - 1; continue }
    if (c === "'") { const e = src.indexOf("'", k + 1); if (e === -1) return true; if (ws === -1) ws = k; k = e; continue }
    if (c === '"') { const e = dquoteEnd(src, k + 1); if (e === -1) return true; if (ws === -1) ws = k; k = e; continue }
    if (c === '$' && src[k + 1] === "'") {
      let j = k + 2
      while (j < src.length && src[j] !== "'") j += src[j] === '\\' ? 2 : 1
      if (j >= src.length) return true
      if (ws === -1) ws = k
      k = j; continue
    }
    if (c === '$' && src[k + 1] === '(') { const e = substEnd(src, k + 2); if (e === -1) return true; if (ws === -1) ws = k; k = e; continue }
    if (c === '`') { const e = src.indexOf('`', k + 1); if (e === -1) return true; if (ws === -1) ws = k; k = e; continue }
    if (c === '(') {
      if (ws !== -1) return true
      const e = substEnd(src, k + 1)
      if (e === -1) return true
      // behind `for` the group is its arithmetic header `for ((...)) do`: the command word stays `for`, so that `do` is recognised
      if (!seen) cmd = '('
      seen = true
      k = e; continue
    }
    // the shell's blanks: the space and the tab only (a CR, a VT, a FF, a Unicode space is a word character; the newline is below)
    if (c === ' ' || c === '\t') { if (ws !== -1 && endWord(k)) return true; continue }
    if (c === '\n' || c === ';' || (c === '|' && !prevIsOp(src, k, '>')) || (c === '&' && !prevIsOp(src, k, '<') && !prevIsOp(src, k, '>') && src[k + 1] !== '>')) {
      if (ws !== -1 && endWord(k)) return true
      seen = false
      continue
    }
    if (ws === -1) ws = k
  }
  return ws !== -1 && endWord(src.length)
}
export function resolveJsonDumpSubst(cmd, opts) {
  const src = String(cmd ?? '')
  const cut = src.search(HEREDOC_CUT_RX)
  const head = cut === -1 ? src : src.slice(0, cut)
  const rewritten = head.replace(JSON_DUMP_SUBST_RX, (full, flag, code, args, offset) => {
    if (!JSON_DUMP_CODE_RX.test(code)) return full
    const segStart = topLevelScan(head, offset + flag.length - flag.trimStart().length)
    if (segStart === -1) return full
    if (!CURL_OWNER_RX.test(head.slice(segStart).replace(/^(?:\s|\\\r?\n)+/, ''))) return full
    const outside = head.replace(JSON_DUMP_SUBST_RX, (m, f, c) => (JSON_DUMP_CODE_RX.test(c) ? ' ' : m))
    if (COMMAND_SHADOW_RX.test(outside) || COMMAND_SHADOW_RX.test(outside.replace(/\\\n|["'\\]/g, '')) || hasUnspelledCommandWord(outside)) return full
    if (ARITH_EVAL_RX.test(outside) || ARITH_EVAL_RX.test(outside.replace(/\\\n|["'\\]/g, ''))) return full
    if (plainShellText(outside, PLAIN_REWRITE_COMMANDS, opts) < 0) return full // v4: the structural allowlist
    const text = [...args.matchAll(/'([^']*)'/g)].map((m) => m[1]).join(' ')
    return `${flag}'${text}'`
  })
  return rewritten + (cut === -1 ? '' : src.slice(cut))
}

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
  const literal = resolveLiteralHeredocSubst(String(command ?? ''))
  // The bus recipe's json.dumps rewrite is the schedule surface's: the security surface (db-write-gate) reads the command
  // as it always did, so a recipe whose text names a security table stays denied there.
  const src = resolveFlatSubst(resolveCatSubst(opts?.surface === 'security' ? literal : resolveJsonDumpSubst(literal, opts), opts), opts)
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

// Plain-word parser for one segment. Returns [{ value, dollar, star, ansi, sq }] or
// null when the segment is not a plain word list: a command or process
// substitution, grouping, brace expansion, a here-string. Redirections are
// parsed, not rejected: an output target lands on `words.redirects` (the caller
// decides whether it may be written), an fd dup (2>&1) and an input redirect
// are dropped.
const HEREDOC_OP_RX = /<<-?\s*(?:'[^']*'|"[^"]*"|[A-Za-z_]\w*)/g
const REDIRECT_OP_RX = /^(?:\d|&)?(?:>>|>\||>|<(?![<(]))/

function readWord(s, i) {
  const start = i
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
  // sq: the whole word is ONE single-quoted part ('...'): no expansion, escape or glob, so `value` is the very bytes
  // the program gets (the schedule create body, #2354 review)
  const sq = s[start] === "'" && i === s.indexOf("'", start + 1) + 1
  return { word: { value, dollar, star, ansi, sq }, i }
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
  const out = { urls: [], kinds: new Set(), dataIdx: new Set(), stdinData: false, sent: [], methods: [], configs: [], noCurlrc: false }
  const record = (kind, idx, value) => {
    out.kinds.add(kind)
    if (kind === 'method') out.methods.push(value)
    if (kind === 'config') out.configs.push(value)
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

// SCHEDWRITE1023, the ONE request `--allow-schedule-write` opens: a curl POST that creates a
// schedule, i.e. `POST <origin>/api/schedules` exactly (the create route). PUT (edit), PATCH,
// DELETE (cancel) and the POST sub-routes (/toggle, /run) are other operations on schedules and
// stay denied, as does every other HTTP client: its method is not provable from the command text.
// Proved from the option grammar, like form (a) -- including -q FIRST (no curlrc): an option parseCurl does not know, an expansion,
// a config file (-K), a file output (-o -D -c -w), a body kind (-F -T: -T is a PUT) or a method
// other than the exact string POST makes it null/false. With no -X the request must carry data
// (curl turns that into a POST). A header naming a method override is not inert here.
const SCHEDULE_POST_URL_RX = /^https?:\/\/[^/\s$?#]+\/api\/schedules$/i
const SCHEDULE_POST_KINDS = new Set(['header', 'safe', 'method', 'data', 'url'])
function isCurlSchedulePost(words) {
  const p = parseCurl(words)
  if (!p) return false
  // ~/.curlrc is read before the command line and can add `request = ...` / `output = ...` to this POST:
  // like the plain GET, the create POST proves its shape only with -q / --disable as the very first argument.
  if (!p.noCurlrc) return false
  if (words.some((w) => w.value === '--get' || /^-[A-Za-z]*G/.test(w.value))) return false // -G turns the data into a GET query
  for (const k of p.kinds) if (!SCHEDULE_POST_KINDS.has(k)) return false
  if (!p.sent.every(headerValueIsInert) || p.sent.some((h) => /method/i.test(h.value))) return false
  if (p.methods.some((m) => m !== 'POST')) return false
  if (!p.methods.length && !p.kinds.has('data')) return false // no body, no -X: a GET
  if (p.urls.length !== 1) return false
  const u = p.urls[0]
  return !u.star && !u.dollar && SCHEDULE_POST_URL_RX.test(u.value)
}

// The create handler takes `agent`, `targetSession` and `forceSend` from the body, and the API does not know its
// caller: opened as is, the route would let a listed sub-agent create a schedule for ANOTHER agent (the main agent by
// default) or for any session. So the gate proves the body (#2354 review): exactly ONE data option, written in the
// ORIGINAL command as one single-quoted word right after -d / --data / --data-raw / --data-binary / --json -- not a
// file (@x), not stdin, not a substitution (the json.dumps and heredoc rewrites in shellSegments would show this check
// a different text than curl sends), and the data word itself is that single-quoted word, not a double-quoted,
// escaped or unquoted twin of it ("$X" or ${X} expands, an unquoted ? globs, both behind a
// matching literal elsewhere) -- in a command of ONE line: no backslash-newline (shellSegments joins it with a space,
// which the shell does not) and no raw line break, in the body either -- that parses as a JSON object whose `agent` is the hook's own agent and which
// carries neither `targetSession` nor `forceSend` (key present at all, any value). Anything else stays denied.
// no dot: the hook knows its agent only through selfAgentFromProjectDir / acceptedTokenFile, which take no dot
const AGENT_NAME_RX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$/
const SCHEDULE_BODY_LITERAL_RX = /(?:^|[ \t])(?:-d|--data|--data-raw|--data-binary|--json)[ \t]+'([^']*)'/g
const SCHEDULE_BODY_OPTS = new Set(['-d', '--data', '--data-raw', '--data-binary', '--json'])
function scheduleCreateBodyOk(original, words, selfAgent, opts) {
  if (typeof selfAgent !== 'string' || !AGENT_NAME_RX.test(selfAgent)) return false
  // The two rewrites that turn agent-written TEXT into a literal word (the json.dumps argv form and the quoted-heredoc
  // substitution) would show this check a body curl never sends: a command they change opens nothing (#2354: a matching literal in a comment next to a rewritten body). The other rewrites leave a NUL
  // marker (token, opaque $(...)), which no typed literal can equal.
  const src = String(original ?? '')
  if (resolveJsonDumpSubst(src) !== src || resolveLiteralHeredocSubst(src) !== src) return false
  // v7: opts, so the documented token header (-H "Authorization: Bearer $(cat <accepted token file>)") is checked against the same files
  if (plainShellText(src, PLAIN_CREATE_COMMANDS, opts) !== 1) return false // v4: the create command is ONE plain curl, nothing around it
  // v3: JS \s is wider than the shell's blanks; any white space but the space and the tab (CR, LF, VT, FF, NBSP,
  // U+2028, BOM ...) is no word break for bash, so it denies here
  if (/[^\S \t]/.test(src)) return false
  const p = parseCurl(words)
  if (!p || p.dataIdx.size !== 1) return false
  const k = [...p.dataIdx][0]
  const w = words[k]
  if (w.dollar || w.ansi || w.star) return false
  if (!w.sq) return false
  if (!SCHEDULE_BODY_OPTS.has(words[k - 1]?.value)) return false
  const literals = [...src.matchAll(SCHEDULE_BODY_LITERAL_RX)].map((m) => m[1])
  if (literals.length !== 1 || literals[0] !== w.value) return false
  let body
  try { body = JSON.parse(w.value) } catch { return false }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false
  // a body that names the `agent` key more than once (an escaped spelling is the same
  // key) is denied, whichever value comes last. Every string token is matched in order, so a quoted "agent": inside a
  // value is no key; a nested object's `agent` key counts too (fail closed).
  const keys = [...w.value.matchAll(/"((?:[^"\\]|\\.)*)"(\s*:)?/g)].filter((m) => m[2]).map((m) => JSON.parse(`"${m[1]}"`))
  if (keys.filter((key) => key === 'agent').length !== 1) return false
  if (Object.hasOwn(body, 'targetSession') || Object.hasOwn(body, 'forceSend')) return false
  return body.agent === selfAgent
}

// The segment-level half of the same exemption: the segment's message-data-free text must reference the schedule
// API and nothing else of the surface (no directory, registry tool, schedule SQL, database file, tainted variable
// or stray token-file mention), the command itself must be the curl POST above, and its body the one proved above.
function isScheduleCreateSegment(residue, words, tainted, opts, tokenMention, original) {
  const r = scheduleSurfaceRefsAll(residue, opts)
  if (!r.api || r.dir || r.cli || r.sql || r.db) return false
  if ([...tainted].some((v) => new RegExp(`\\$\\{?${v}(?!\\w)`).test(residue))) return false
  if (tokenMention(residue)) return false
  return isCurlSchedulePost(words) && scheduleCreateBodyOk(original, words, opts.selfAgent, opts)
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
// The rest run or hand on whatever file they name.
const FILE_RUNNERS = new Set(['sqlite3', 'sqlite', 'source', '.', 'chmod', 'env', 'xargs', 'exec', 'eval', 'npx'])
const isInterpreter = (name) => FILE_INTERPRETERS.has(name) || /^python[0-9.]*$/.test(name)
const isFileRunner = (name) => FILE_RUNNERS.has(name) || isInterpreter(name)
const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
export function laterRuns(segs, k, targets) {
  if (!targets.length) return false
  for (let j = k + 1; j < segs.length; j++) {
    const s = segs[j]
    if (!targets.some((t) => [s.own, ...s.bodies].join('\n').includes(t))) continue
    const words = shellWords(s.own)
    if (!words || !words.length) return true
    const first = words[0].value
    if (targets.includes(first)) return true
    const name = commandName(words) || first.slice(first.lastIndexOf('/') + 1)
    if (isInterpreter(name)) {
      const stdin = targets.some((t) => new RegExp(`(?:^|[^<])<\\s*['"]?${escapeRx(t)}`).test(s.own))
      const code = words.some((w, i) => /^-[A-Za-z]*[ceE]$/.test(w.value) && targets.some((t) => (words[i + 1]?.value ?? '').includes(t)))
      const script = words.slice(1).find((w) => !w.value.startsWith('-'))
      if (stdin || code || (script && targets.includes(script.value))) return true
      continue
    }
    if (FILE_RUNNERS.has(name)) return true
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
export function dataResidue(seg, words, name, opts, stdinHeaderOnly = false) {
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
    if (!p) return seg.text
    // a config the gate cannot see keeps the whole segment in the judgement -- except `-K -` fed by exactly the fleet's
    // `printf 'header = "Authorization: Bearer %s"\n' "$(cat <token file>)" |`, whose config is one header line
    if (p.kinds.has('config') && !(stdinHeaderOnly && p.configs.length > 0 && p.configs.every((c) => c === '-'))) return seg.text
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

// Is segment k fed through a pipe by exactly `printf 'header = "Authorization: Bearer %s"\n' <accepted token file substitution>`?
// That is the fleet recipe's `curl -K -` config: one Authorization header, no URL, no method, no data.
const AUTH_HEADER_CONFIG_FORMAT = 'header = "Authorization: Bearer %s"\\n'
function stdinAuthHeaderOnly(segs, k) {
  const prev = k > 0 ? segs[k - 1] : null
  if (!prev || prev.sep !== '|' || prev.bodies.length) return false
  const w = shellWords(prev.own)
  return !!w && w.length === 3 && w.redirects.length === 0 && commandName(w) === 'printf'
    && w[1].value === AUTH_HEADER_CONFIG_FORMAT && w[2].value === TOKEN_NONCE
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
// A downloader's file-output options write a file of the caller's choosing, the database file
// included: `curl -o store/claudeclaw.db URL`. This runs only on a segment that names the database,
// so every spelling that can take a path counts, fail-closed: curl clusters (-sSo f, -ofile), the
// long names and their unique prefixes (curl accepts --out for --output), and the options that save
// a trace, a header dump, a cookie jar or a remote-named file, and a config file. A short option that takes a value
// ends the cluster scan: the rest of the word is that value (-XDELETE is not -D).
// w: -w/--write-out takes `%output{<file>}`; --hsts and --alt-svc keep a cache file they write back
const CURL_OUT_SHORT = 'oDcOKw' // K: a config file (also from stdin) can say `output = <file>`
const CURL_ARG_SHORT = 'AbCdeEFHmPQrtTuUwxXyYz'
const CURL_OUT_LONG = ['output', 'dump-header', 'cookie-jar', 'remote-name', 'trace', 'stderr', 'etag-save', 'libcurl', 'config',
  'write-out', 'hsts', 'alt-svc']
const WGET_OUT_SHORT = 'OoaP'
const WGET_OUT_LONG = ['output-document', 'output-file', 'append-output', 'directory-prefix']
const optionNameHits = (v, names) => {
  const n = v.slice(2).split('=')[0]
  return n.length >= 2 && names.some((l) => l.startsWith(n) || n.startsWith(l))
}
// The curl LONG options whose value is the NEXT word when written without `=`: that word is data (`--data -o`), not a switch. (The short
// ones, `-d -o`, `-H -o`, `-X -o`, never reach this scan: their values are removed before it, measured.)
// Only the exact long names are listed (curl also takes unique prefixes); an abbreviation is not skipped, so its next word is still
// scanned as before (fail closed).
const CURL_VALUE_LONG = new Set(['data', 'data-ascii', 'data-binary', 'data-raw', 'data-urlencode', 'header', 'request', 'user-agent', 'json'])
function downloaderWritesFile(words, name) {
  const curl = name === 'curl'
  if (!curl && name !== 'wget') return false
  let valueNext = false
  for (const w of words.slice(1)) {
    if (valueNext) { valueNext = false; continue }
    const v = w.value
    if (v.startsWith('--')) {
      if (optionNameHits(v, curl ? CURL_OUT_LONG : WGET_OUT_LONG)) return true
      if (curl && CURL_VALUE_LONG.has(v.slice(2))) valueNext = true
      continue
    }
    if (!v.startsWith('-') || v.length < 2) continue
    for (const ch of v.slice(1)) {
      if ((curl ? CURL_OUT_SHORT : WGET_OUT_SHORT).includes(ch)) return true
      if (curl && CURL_ARG_SHORT.includes(ch)) break
    }
  }
  return false
}
function dbSegmentWrites(words, name, text, downloaders = true) {
  if (DB_FILE_WRITERS.has(name)) return true
  if (downloaders && downloaderWritesFile(words, name)) return true
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
//
// SCHEDWRITE1023: gateOpts.allowScheduleWrite (a literal true, the hook's --allow-schedule-write) lets ONE kind of
// segment through that this decision otherwise denies: a segment whose only schedule reference is the dashboard
// schedule API and that is a curl POST of a new schedule (isCurlSchedulePost). The API reference itself stays in
// the decision, so PUT, PATCH, DELETE, the POST sub-routes and every other HTTP client stay denied with the flag.
// The store directory, the registry tool, the schedule table SQL and the dashboard
// database file stay judged exactly as without the flag.
export function scheduleSurfaceDeny(command, gateOpts = {}) {
  const opts = { parentCtx: cdsIntoStoreParent(command), projectRoot: gateOpts.projectRoot, selfAgent: gateOpts.selfAgent, surface: gateOpts.surface }
  const apiOpen = gateOpts.allowScheduleWrite === true
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
    const security = opts.surface === 'security'
    const residue = dataResidue(view, words, name, opts, !security && name === 'curl' && stdinAuthHeaderOnly(segs, k))
    // The database file is judged on what the command does, not on what its message data says, and on EVERY segment that
    // names it -- also one that names a schedule route (`curl -o <db> URL -d '/api/schedules'` made the segment
    // "strong" and skipped this check). A reference that only sits in message data is not a reference.
    // ...and a command path the gate cannot trust (name === '') is judged on its WHOLE segment: its residue drops the message
    // word of scripts/agent-msg.sh, which is no data when the script is not the real helper
    // The security surface (db-write-gate) keeps its own flow, as before this change: the database file is judged on the
    // segments that name nothing else, and without the downloader rule (a gap there is not this change's to close).
    if (security) {
      if (db) {
        if (dbSegmentWrites(words, name, view.text, false)) return true
        continue
      }
    } else {
      if ((db || strong) && dbRefsIn(name === '' ? view.text : residue) && dbSegmentWrites(words, name, view.text)) return true
      if (db) continue
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
    // The security surface reads the same of any output: SQL text written to a
    // file (`printf 'UPDATE approvals ..' > s.sql; sqlite3 db < s.sql`) is a
    // statement file the next segment runs, whichever command wrote it.
    if (opts.surface === 'security' && fileTargets.length && scriptFile && refsIn(residue)) return true
    if (!refsIn(residue)) continue // (c) only message data mentions it
    if (name === 'curl' && isPlainCurlGet(words)) continue // (a)
    if (apiOpen && name === 'curl' && isScheduleCreateSegment(residue, words, tainted, opts, tokenMention, command)) continue // SCHEDWRITE1023
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
function shellWordRuns(words, i) {
  const fish = baseName(words[i].value) === 'fish'
  const codes = []
  let cGiven = false
  let mainGiven = false
  let operand = false
  for (let j = i + 1; j < words.length; j++) {
    const v = words[j].value
    if (!/^[-+]/.test(v) || v === '--') {
      // fish: a -c/-C/--command/--init-command anywhere still runs code
      if (!fish) break
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
  return { codes, stdin: fish ? !mainGiven : !cGiven }
}

// shellSegments cuts at an escaped `\;` (tmux's own command separator); glue
// such pieces back together so `tmux a \; send-keys` stays one segment. opts: the gate's own (v6), so the recipe rewrite
// in shellSegments accepts the same token files as everywhere else in decide().
function codeSegments(command, opts) {
  const segs = shellSegments(command, opts)
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

function scanShellCode(command, opts) {
  const segs = codeSegments(command, opts)
  const codes = []
  const seen = new Set()
  const push = (c) => {
    const key = `${c.ansi ? 1 : 0}:${c.value}`
    if (seen.has(key)) return
    seen.add(key)
    codes.push(c)
  }
  let bad = false
  for (const seg of segs) {
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
        stdinBodies = (seg.bodies ?? []).map((b) => ({ value: b, ansi: false }))
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
      const runs = shellWordRuns(args, i)
      for (const c of runs.codes) push(c)
      if (!runs.stdin) continue
      for (const c of stdinCodes()) push(c)
    }
  }
  return { codes, bad }
}

export function shellCodeStrings(command) {
  return scanShellCode(command).codes.map((c) => c.value)
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
  // SCHEDWRITE1023: `--allow-schedule-write` on the hook command (set by the
  // scaffold for the agents named in SELF_PACE_SCHEDULE_WRITERS) opens exactly ONE
  // route: a curl POST that creates a schedule (POST /api/schedules, isCurlSchedulePost);
  // PUT, PATCH, DELETE, the POST sub-routes and other HTTP clients stay denied. Everything else
  // this gate denies stays denied: the self-schedule store (scheduled_tasks.json),
  // the scheduled-tasks directory, the registry tool, the schedule table SQL, the
  // dashboard database file, the self-pacing tools, `tmux send-keys`, /loop, the
  // scheduler binaries, the egress allowlist, and the other protected store files.
  // Only a literal true counts.
  const allowScheduleWrite = opts.allowScheduleWrite === true
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
    if (scheduleSurfaceDeny(String(toolInput?.command ?? ''), { ...opts, allowScheduleWrite })) return { deny: true }
    // Strip -d/--data payloads on the WHOLE command BEFORE splitting. A payload is
    // data, not an invocation; and since splitSegments is NOT quote-aware, a shell
    // separator (; && | &) INSIDE a dispatch body would otherwise orphan a fragment
    // that false-matches. Stripping first blanks the body (incl. any separators in
    // it), so the URL/method args still match but the body text never does. A
    // separator OUTSIDE the payload still splits, so `curl -d '' x ; crontab -r`
    // is still caught.
    //
    // The fleet's closing recipe (`--data-binary "$(python3 -c '<fixed json.dumps>' '<text>')"`) is resolved to the literal
    // it evaluates to FIRST (resolveJsonDumpSubst, the same rewrite the surface check applies), so its result text is
    // blanked like any other data payload instead of being matched as a method / tmux send-keys.
    const safeCommand = stripProseArguments(stripDataPayloads(stripGitCommitMessages(stripHeredocBodies(
      resolveJsonDumpSubst(String(toolInput?.command ?? ''), opts)))))
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
      if (!allowScheduleWrite && SCHEDULE_API_RX.test(seg) && HTTP_WRITE_RX.test(seg)) return { deny: true }
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
    // The fleet's closing recipe is resolved to the literal it evaluates to first (the same rewrite as above): its fixed
    // python snippet is not a command to decide again, and its result text is data, not a tmux send-keys or a method.
    if (substitutionInCommandPosition(resolveJsonDumpSubst(rawCommand, opts), { bodies })) return { deny: true, reason: 'dynamic-command' }
    // the code of each outermost substitution is a command of its own (scanShellCode does not look inside one)
    for (const body of bodies) {
      if (depth >= 4) return { deny: true, reason: 'shell-code-depth' }
      const inner = decide('Bash', { command: body }, { ...opts, depth: depth + 1, vars: dequoted.vars })
      if (inner.deny) return { deny: true, reason: inner.reason ?? 'shell-code' }
    }
    const scan = scanShellCode(rawCommand, opts)
    for (const code of scan.codes) {
      if (code.ansi) return { deny: true, reason: 'shell-code' }
      if (depth >= 4) return { deny: true, reason: 'shell-code-depth' }
      const inner = decide('Bash', { command: code.value }, { ...opts, depth: depth + 1, vars: dequoted.vars })
      if (inner.deny) return { deny: true, reason: inner.reason ?? 'shell-code' }
    }
    if (scan.bad) return { deny: true, reason: 'shell-code' }
    // tmux command shortcuts and `tmux a \; send-keys` chains
    for (const seg of codeSegments(rawCommand, opts)) {
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

// The deny text names the operation that was blocked. GATE_MSG stays the generic fallback and
// the fail-closed text. The classification below only chooses the SENTENCE, after the decision: it can never change a verdict.
const GATE_HEAD = 'Self-pace TILTOTT (governance hard-gate). '
const GATE_TAIL = 'Utemezest a fo agenstol kerj inter-agent uzenetben. Input-vezerelt vagy: csak az operator (channel) vagy egy ' +
  'peer (inter-agent) uzenete inditson. Ha varakozol, maradj idle a prompt-on -- a beerkezo uzenet majd ujrainditja a turn-t. ' +
  'SOHA ne valaszolj magadnak es SOHA ne dontsd el az operator helyett egy hozza intezett kerdest.'
// one label per SELF_PACE_BASH_PATTERNS entry, same order
const SELF_PACE_BASH_LABELS = [
  'tmux send-keys / paste-buffer / run-shell (billentyu-injektalas egy pane-be)',
  'nohup / setsid / disown + claude (onujraindito hatterfolyamat)',
  '/loop slash-skill (onallo ujrafuttatas)',
]
const SCHEDULE_CREATE_ONLY = 'A kapcsolo CSAK az uj utemezes letrehozasat engedi: `curl -q -X POST http://<host>/api/schedules` + adat (a -q az ELSO argumentum), ' +
  'egy URL, -K/-o/-D/-c/-G, method-override fejlec es mas kliens nelkul. A parancs egy sorban (sorvegi \\ nelkul), a torzs EGY egyszeres ' +
  'idezojeles inline JSON: -d \'{"agent":"<sajat nev>",...}\', csak a sajat agent, egyszer, targetSession es forceSend nelkul; fajl (@x), ' +
  'stdin, heredoc, valtozo vagy $(...) a torzsben nem megy at.'

function apiOperation(command, apiOpen) {
  if (!apiOpen) {
    return {
      what: 'iras a dashboard utemezes-API-ra (/api/schedules)',
      hint: 'Ehhez az ugynokhoz nincs utemezes-iras engedelyezve (SELF_PACE_SCHEDULE_WRITERS). Olvasni a `curl -q -s -H "Authorization: ' +
        'Bearer $(cat <TOKEN>)" http://.../api/schedules` GET megy (-q ELSO argumentum, <TOKEN> a repo-gyoker abszolut utja).',
    }
  }
  const method = [...command.matchAll(/(?:-X\s*|--request[\s=])['"]?(POST|PUT|PATCH|DELETE)\b/gi)].map((m) => m[1].toUpperCase()).pop()
    ?? (/(?:^|\s)(?:-T|--upload-file)\b/.test(command) ? 'PUT' : undefined)
  const sub = /\/api\/schedules\/[^\s'"/]+\/(toggle|run)\b/i.exec(command)
  if (sub) return { what: `POST /api/schedules/<id>/${sub[1].toLowerCase()} (al-utvonal)`, hint: SCHEDULE_CREATE_ONLY }
  if (method === 'DELETE') return { what: 'DELETE /api/schedules (utemezes torlese)', hint: SCHEDULE_CREATE_ONLY }
  if (method === 'PUT' || method === 'PATCH') return { what: `${method} /api/schedules (utemezes szerkesztese)`, hint: SCHEDULE_CREATE_ONLY }
  if (!/\bcurl\b/.test(command)) {
    return { what: 'a /api/schedules hivasa nem-curl kliensbol (a metodusa a szovegbol nem bizonyithato)', hint: SCHEDULE_CREATE_ONLY }
  }
  return { what: 'olyan /api/schedules hivas, ami nem a sima curl POST (uj utemezes)', hint: SCHEDULE_CREATE_ONLY }
}

function denyOperation(toolName, toolInput, opts = {}) {
  if (SELF_PACE_TOOLS.has(toolName)) {
    return { what: `a(z) ${toolName} eszkoz (onallo, jovobeli turn utemezese)`, hint: 'Sub-agentkent ez az eszkoz nem hasznalhato.' }
  }
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'NotebookEdit') {
    const fp = String(toolInput?.file_path ?? toolInput?.notebook_path ?? '')
    if (SCHEDULE_STORE_RX.test(fp)) return { what: 'iras a scheduled_tasks.json fajlba (a sajat utemezes-tar)', hint: 'Olvasni cat / grep / ls-sel lehet.' }
    if (SCHEDULE_DIR_PATH_RX.test(fp)) return { what: 'iras a scheduled-tasks konyvtarba (a dashboard utemezes-tara)', hint: 'Olvasni cat / grep / ls-sel lehet, abszolut uttal.' }
    return null
  }
  if (toolName !== 'Bash') return null
  const command = String(toolInput?.command ?? '')
  const i = SELF_PACE_BASH_PATTERNS.findIndex((re) => re.test(normalizeShellEvasion(command)))
  if (i >= 0) return { what: SELF_PACE_BASH_LABELS[i] ?? 'onallo ujrainditas', hint: 'Sub-agentkent ez a ut zarva van.' }
  const r = scheduleSurfaceRefs(command, { parentCtx: cdsIntoStoreParent(command), projectRoot: opts.projectRoot, selfAgent: opts.selfAgent })
  if (r.sql) return { what: 'utemezes-tabla SQL-iras (scheduled_tasks)', hint: 'Olvasni sqlite3 SELECT-tel lehet.' }
  if (r.db) return { what: 'a dashboard adatbazis fajl (claudeclaw.db) irasa vagy felulirasa', hint: 'Olvasni sqlite3 SELECT-tel lehet.' }
  if (r.cli) return { what: 'schedule-registry-cli register / unregister', hint: 'Csak a status es a verify megy.' }
  if (SCHEDULE_STORE_RX.test(command)) return { what: 'iras a scheduled_tasks.json fajlba (a sajat utemezes-tar)', hint: 'Olvasni cat / grep / ls-sel lehet.' }
  if (r.dir) return { what: 'iras a scheduled-tasks konyvtarba (a dashboard utemezes-tara)', hint: 'Olvasni ls / cat / grep / sed -n lehet, abszolut uttal (cd nelkul).' }
  if (SCHEDULER_RX.test(command)) return { what: 'utemezo binaris (crontab / at / batch / launchctl / systemd-run)', hint: 'Csak a pure listazas (crontab -l, atq, launchctl list) megy.' }
  if (r.api) return apiOperation(command, opts.allowScheduleWrite === true)
  return null
}

export function gateMessage(toolName, toolInput, opts = {}) {
  try {
    const op = denyOperation(toolName, toolInput, opts)
    if (op) return `${GATE_HEAD}Tiltott muvelet: ${op.what}. ${op.hint} ${GATE_TAIL}`
  } catch { /* the sentence is advisory: any failure falls back to the generic text */ }
  return GATE_MSG
}

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
  'store/egress-vendor-hosts.json, store/config-overrides.json, store/bash-sandbox-write-paths.json, ' +
  'store/email-standing-recipients.json, store/.approval-bot-token es store/.approval-bot-key ' +
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
const DECISION_DEADLINE_MS = Math.min(5000, Math.max(100, Number(process.env.SELF_PACE_GATE_DEADLINE_MS) || 5000))

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
    // SCHEDWRITE1023: the scaffold appends this flag to the hook command of the agents named in
    // SELF_PACE_SCHEDULE_WRITERS; without it, the gate is byte-for-byte what it was.
    const allowScheduleWrite = process.argv.includes('--allow-schedule-write')
    const verdict = await decideInWorker(payload?.tool_name, payload?.tool_input, { cwd: payload?.cwd, selfAgent, projectDir: process.env.CLAUDE_PROJECT_DIR || null, allowScheduleWrite })
    if (verdict.error) deny(FAIL_CLOSED_MSG(verdict.error.split('\n')[0]))
    if (verdict.deny) {
      deny(verdict.reason === 'egress-allowlist' ? ALLOWLIST_GATE_MSG
        : verdict.reason === 'dynamic-command' ? DYNAMIC_COMMAND_GATE_MSG
        : verdict.reason === 'protected-store-file' ? PROTECTED_STORE_GATE_MSG
        : String(verdict.reason ?? '').startsWith('mcp-') ? MCP_GATE_MSG
        : gateMessage(payload?.tool_name, payload?.tool_input, { selfAgent, allowScheduleWrite }))
    }
    allow()
  } catch (err) {
    deny(FAIL_CLOSED_MSG(err?.message ?? err))
  }
}
