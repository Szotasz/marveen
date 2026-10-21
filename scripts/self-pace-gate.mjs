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

import { lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'

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
export function allowlistBashSegmentAllowed(seg, ctx) {
  return readOnlyMentionAllowed(seg, (text) => protectedMention(text, ctx))
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
function readOnlyMentionAllowed(seg, mentions) {
  const s = String(seg ?? '').trim()
  if (!mentions(s)) return true
  const words = s.split(/\s+/)
  let i = 0
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++ // leading VAR=x
  const cmd = (words[i] ?? '').replace(/^.*\//, '')
  if (!ALLOWLIST_READERS.has(cmd)) return false
  for (const m of s.matchAll(OUTPUT_REDIRECT_RX)) {
    const target = m[1]
    if (/^&?\d+$/.test(target) || target === '/dev/null') continue // 2>&1, >/dev/null
    if (mentions(target) || /[$`]/.test(target)) return false
  }
  return true
}

export function protectedStoreBashSegmentAllowed(seg) {
  return readOnlyMentionAllowed(seg, (text) => PROTECTED_MENTION_RX.test(text))
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
  return { assigns, root: pathKey(resolve(store, '..')), store: pathKey(store), cwd: cwd ? resolve(String(cwd)) : null }
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
  const src = String(text ?? '').replace(/\$(?=['"])/g, '').replace(/\$\{HOME\}|\$HOME(?!\w)/g, homedir())
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

// A glob, brace or unresolved word that can expand onto a protected name.
function protectedPatternWord(text, ctx) {
  const src = String(text).replace(/\\\r?\n/g, '').replace(/\$\{IFS\}|\$IFS\b/g, '')
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

function expandHome(p) {
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
function pathKey(p) {
  return nameForms(realDeep(p))
}
function sameKey(a, b) {
  return a.some((f, i) => f === b[i])
}
function underKey(a, dir) {
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

export function maskInertLiterals(command, heredocs, lenient = false) {
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

function globMatchesName(glob, name) {
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
function expandBraces(word, cap) {
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
function normalizePathSegments(word) {
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
    if (strongRef(scheduleSurfaceRefs(path, opts))) return full
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
    return strongRef(scheduleSurfaceRefs(inner, opts)) ? full : NONCONTENT_MARKER
  })
}

// Split a command into the segments the SHELL would see: separators inside
// quotes or heredoc bodies do not split (maskInertLiterals decides that), and
// a heredoc body is handed back to the segment whose `<<` owns it. Returns null
// when the quoting cannot be resolved -- the caller then denies.
const SEGMENT_SEP_RX = /\|\||&&|\|&|;;|[;|\n]|(?<![<>])&(?!>)/g
export function shellSegments(command, opts) {
  const src = resolveFlatSubst(resolveCatSubst(resolveLiteralHeredocSubst(String(command ?? '')), opts), opts)
    .replace(/\\\r?\n/g, ' ')
  const heredocs = []
  const masked = maskInertLiterals(src, heredocs)
  if (masked == null || masked.length !== src.length) return null
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
    const own = src.slice(r.start, r.end)
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

function shellWords(text) {
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
function commandName(words) {
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
// sed: only -n/-E/-r and line-range print/delete scripts (`1,60p`, `$d`) -- no
// `w file`, no `e command`, no -i.
const SED_SCRIPT_RX = /^(?:(?:\d+|\$)(?:,(?:\d+|\$))?[pd];?)+$/
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

function isReadOnlyFsCommand(words, name) {
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
function isPipeSink(words, name) {
  if (TEXT_FILTERS.has(name)) return isReadOnlyFsCommand(words, name)
  // the inter-agent helper: its stdin becomes message content, nothing else
  const script = (name === 'bash' || name === 'sh') ? words[1] : words[0]
  return !!script && AGENT_MSG_RX.test(script.value) && words.every((w) => !w.dollar)
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
function dataResidue(seg, words, name) {
  const keep = (drop) => words.filter((_, i) => !drop.has(i)).map((w) => w.value).join(' ')
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
  const opts = { parentCtx: cdsIntoStoreParent(command), projectRoot: gateOpts.projectRoot, selfAgent: gateOpts.selfAgent }
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
    if (seg.bodies.length && refsIn(seg.bodies.join('\n')) && words.redirects.some((t) => t.value !== '/dev/null')) return true
    if (!refsIn(dataResidue(view, words, name))) continue // (c) only message data mentions it
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

function scanShellCode(command) {
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

function decide(toolName, toolInput, opts = {}) {
  const name = String(toolName ?? '')
  if (SELF_PACE_TOOLS.has(name)) return { deny: true }
  // Native file tools writing the self-schedule store would bypass any Bash regex.
  if (name === 'Write' || name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit') {
    const fp = String(toolInput?.file_path ?? toolInput?.notebook_path ?? '')
    if (SCHEDULE_STORE_RX.test(fp)) return { deny: true }
    if (fileToolTargetsAllowlist(toolInput, opts.allowlistPath, opts.cwd)) return { deny: true, reason: 'egress-allowlist' }
    if (fileToolTargetsProtectedStoreFile(toolInput, opts.storeDir, opts.cwd)) return { deny: true, reason: 'protected-store-file' }
    // ...and the dashboard's schedule store, which the runner turns into turns
    if (SCHEDULE_DIR_PATH_RX.test(fp)) return { deny: true }
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
    const protectedCtx = protectedContext(naiveSegs, opts.allowlistPath, opts.cwd)
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
      // The other store files that gate the sub-agent (c556a35a) first: they are matched by
      // name only, so a segment that names one of them gets that file's message even when
      // the allowlist check below would also deny it on an unresolved word (`> $TARGET`).
      if (!protectedStoreBashSegmentAllowed(seg)) return { deny: true, reason: 'protected-store-file' }
      // the egress allowlist and the extra hooks: a plain read only (EGRESSSELFEDIT824)
      if (!allowlistBashSegmentAllowed(seg, protectedCtx)) return { deny: true, reason: 'egress-allowlist' }
      cwdAfterSegment(seg, protectedCtx)
    }
    // The scheduler check is the ANCHORED one -- it fires on what sits at a
    // segment START -- so it is the one a fake segment boundary can mislead, and
    // the only one that gets quote-aware segments. Null (unresolvable quoting)
    // falls back to the naive split, i.e. to scanning strictly more.
    const masked = maskInertLiterals(safeCommand)
    for (const seg of (masked == null ? naiveSegs : splitSegments(masked))) {
      // scheduler binaries: deny the exec/submit forms, allow pure read-listing
      if (SCHEDULER_RX.test(seg) && !SCHEDULER_READ_RX.test(seg)) return { deny: true }
    }
    // Shell code handed to another shell (sh -c, eval, here-strings, heredocs,
    // tmux -c) is decided recursively; quoted, it was blanked above. The RAW
    // command is used: safeCommand blanks heredoc bodies and data payloads.
    const rawCommand = String(toolInput?.command ?? '')
    const depth = opts.depth ?? 0
    const scan = scanShellCode(rawCommand)
    for (const code of scan.codes) {
      if (code.ansi) return { deny: true, reason: 'shell-code' }
      if (depth >= 4) return { deny: true, reason: 'shell-code-depth' }
      const inner = decide('Bash', { command: code.value }, { ...opts, depth: depth + 1 })
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
  'se /loop self-pace. Ha csak egy dokumentumot irsz, ami az utemezo API-t vagy a store-t emliti ' +
  '(jegyzet, review-tervezet): a nativ Write tool-lal ird, a store-on kivuli utra -- az atmegy; ' +
  'egy fajlba iranyitott heredoc (cat <<EOF > fajl) nem. Utemezest a fo agenstol kerj inter-agent uzenetben. ' +
  'Input-vezerelt ' +
  'vagy: csak az operator (channel) vagy egy peer (inter-agent) uzenete inditson. Ha varakozol, ' +
  'maradj idle a prompt-on -- a beerkezo uzenet majd ujrainditja a turn-t. SOHA ne valaszolj ' +
  'magadnak es SOHA ne dontsd el az operator helyett egy hozza intezett kerdest.'

const ALLOWLIST_GATE_MSG =
  'Egress-engedelylista TILTOTT (governance hard-gate). Sub-agentkent NEM irhatod a ' +
  'store/egress-allowlist.json-t: ez a kapu RAD vonatkozik. Ha egy domain kell, kerd a fo ' +
  'agenst (inter-agent uzenet: domain + miert); o a gazda jovahagyasaval veszi fel. ' +
  'Ugyanigy NEM irhatod a store/extra-hooks.json-t es a local-hooks/ alatti szkripteket (minden ' +
  'sub-agens hookjai): ha kell egy, kerd a fo agenst. ' +
  'Olvasni szabad: cat / grep / jq a fajlra (ertelmezo -- python, node -- nem).'

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
    const verdict = await decideInWorker(payload?.tool_name, payload?.tool_input, { cwd: payload?.cwd, selfAgent })
    if (verdict.error) deny(FAIL_CLOSED_MSG(verdict.error.split('\n')[0]))
    if (verdict.deny) {
      deny(verdict.reason === 'egress-allowlist' ? ALLOWLIST_GATE_MSG
        : verdict.reason === 'protected-store-file' ? PROTECTED_STORE_GATE_MSG : GATE_MSG)
    }
    allow()
  } catch (err) {
    deny(FAIL_CLOSED_MSG(err?.message ?? err))
  }
}
