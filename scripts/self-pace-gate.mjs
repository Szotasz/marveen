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
//     Claude scheduled_tasks.json directly, tmux send-keys into a session,
//     POSTing a new schedule to the dashboard, or an OS scheduler (crontab / at /
//     launchctl / systemd-run, and a systemd timer armed with systemctl or
//     written into a unit directory). One exact systemd-run form, the foreground
//     scope of an install's heavy-run wrapper, is allowed: see HEAVY_SCOPE_RX.
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

import { readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
// Each is a pair: A, then anywhere later in the segment B (as a regex, A[\s\S]*B).
const SELF_PACE_BASH_PATTERNS = [
  // tmux pane injection -- every write-subcommand that can push keys/text/commands
  // into a pane (the actual incident vector), not just send-keys. [\s\S] (not
  // [^\n]) so an intra-segment newline cannot split the match.
  [/\btmux\b/gi, /\b(send-keys|paste-buffer|run-shell|set-buffer)\b/gi],
  // self-backgrounding that relaunches claude (nohup/setsid/disown + claude)
  [/\b(nohup|setsid|disown)\b/gi, /\bclaude\b/gi],
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
  [/\bclaude\b/gi, /(?:^|[\s'"])\/loop(?=[\s'"]|$)/gi],
]
// Does the segment have one of these shapes? B is looked for after the FIRST A only:
// any later A has less text after it, so the answer is the one A[\s\S]*B gives. As
// that regex, every A was tried against the whole rest of the segment, and a run of
// A without B was quadratic (ffc45c28, measured on develop 6158290b: 30000 `claude`
// 3.5 s, 30000 `tmux` or `nohup` 1.8 s; the hook fails open after 10 s). B keeps its
// `^` meaning the segment's start, which it never is after an A, as before.
export function selfPaceShape(seg) {
  const s = String(seg ?? '')
  return SELF_PACE_BASH_PATTERNS.some(([a, b]) => {
    a.lastIndex = 0
    const m = a.exec(s)
    if (!m) return false
    b.lastIndex = m.index + m[0].length
    return b.test(s)
  })
}

// OS-level schedulers + delayed exec (cron / launchd / systemd / at / batch): the
// shell route to the same self-pace the CronCreate tool-deny blocks at the runtime
// layer. Read where a command word starts (forEachCommandPosition below): at the
// start of a segment and inside a $(...) or backtick substitution, behind shell
// keywords, VAR=val assignments and wrappers (sudo, env, command, nice, time, ...),
// and with a path (`/usr/bin/at now`), so `sudo crontab -r`, `/usr/bin/at now`,
// `PATH=/bin crontab -` and `X=$(crontab -)` are all caught. Trailing \b(?!-) so it
// never fires on "netstat" / "crontab-helper.sh"; (?!\s*=) so a bare NAME=value
// assignment (`at=$(...)`) is not mistaken for the `at` binary.
//
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
// A scheduler command word, and a pure READ-listing of one's own schedule (parity
// with the store / schedule-API read exemptions: crontab -l, launchctl list/print,
// atq). Both are sticky (`y`): they are tried only where a command word starts, and
// what they read stays next to that word.
const SCHED_CMD_RX = new RegExp(
  String.raw`(?:crontab|systemd-run)\b(?!-)(?!\s*=)|launchctl\b(?!-)(?!\s*=)${LAUNCHCTL_SUBCOMMAND}|(?:batch|at)\b(?!-)(?!\s*=)${AT_INVOCATION}`,
  'iy',
)
const SCHED_READ_CMD_RX = /crontab\s+-l\b|launchctl\s+(?:list|print|dumpstate|blame|examine)\b|atq\b/iy

// The shell keywords that start a command inside a loop, a condition or a group.
// Measured 2026-09-30 (90a2257b): the scheduler check had no keyword branch, so `if
// true; then crontab -r; fi`, `for i in 1; do crontab -r; done`, `while false; do at
// now; done`, `{ crontab -r; }` and `! crontab -r` all passed, while the timer check
// below (cc8e80d7) already had one: the measured `for f in x.service x.timer; do cp
// ... "$U/$f"; done` puts `do cp` at the start. `coproc` runs its command like a
// keyword does (found in review: `coproc crontab -r` passed);
// with a NAME only in front of a compound command (`coproc NAME { ...; }`).
// SHELL_KEYWORDS is the same list as a regex, for the heavy-run scope form below.
const KEYWORD_WORDS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{'])
const SHELL_KEYWORDS = String.raw`(?:(?:${[...KEYWORD_WORDS].map((w) => (w === '{' ? '\\{' : w)).join('|')}|coproc(?:\s+[A-Za-z_]\w*(?=\s*\{))?)\s+)*`
// ...and at the head of a case arm (the same decision: `case x in *) crontab -r;; esac`
// passed). splitSegments cuts at `;`, `|` and a newline, so an arm's pattern stands at
// the start of its segment (`*) crontab -r`, or `b) ...` after `a|b)`), or after
// `case <word> in` for the first arm. The word is optional: the masked view blanks a
// quoted one (`case "$x" in`). Only at the start of a segment: in `$(date) at now` the
// `date)` follows a `(`, and there it is an argument, not an arm. The arm is
// `(?:case\s+(?:\S+\s+)?in\s+)?(?:\(\s*)?[^()\s;&|]+\s*\)\s*`, read from word
// boundaries computed once (forEachCommandPosition): tried at every start of a whole
// command, its pattern word ran over a run of backticks from each of them (30000
// backticks: 1.9 s before, as a regex).

// The install's heavy-run wrapper. An install can run its heavy compiles (tsc, next build)
// through a wrapper of its own that starts the command in a memory-capped, foreground
// systemd scope (ffc45c28, 90a2257b). Its name is an install setting, read the way
// scripts/hooks/egress-gate.mjs reads the dashboard port: SELF_PACE_HEAVY_WRAPPER in the
// environment, else the install .env, else the generic default heavy-run. The name goes
// into a regex and a systemd unit name, so only 1-40 characters of [A-Za-z0-9_.-] are
// taken; anything else falls through to the next source. Two places read it: the wrapper
// table (WRAPPERS) and the one allowed systemd-run form (HEAVY_SCOPE_RX).
export const HEAVY_WRAPPER_DEFAULT = 'heavy-run'
const isHeavyWrapperName = (v) => /^[A-Za-z0-9_.-]{1,40}$/.test(v)
function installDotenv() {
  try {
    return readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '.env'), 'utf-8')
  } catch {
    return '' // no .env: the default
  }
}
export function heavyWrapperName(env = process.env, dotenv = installDotenv()) {
  const fromEnv = String(env?.SELF_PACE_HEAVY_WRAPPER ?? '').trim()
  if (isHeavyWrapperName(fromEnv)) return fromEnv
  const m = /^SELF_PACE_HEAVY_WRAPPER=(.*)$/m.exec(String(dotenv ?? ''))
  const fromFile = (m?.[1] ?? '').trim().replace(/^["']|["']$/g, '')
  if (isHeavyWrapperName(fromFile)) return fromFile
  return HEAVY_WRAPPER_DEFAULT
}
export const HEAVY_WRAPPER = heavyWrapperName()
const HEAVY_WRAPPER_RX = HEAVY_WRAPPER.replace(/\./g, '\\.')

// The wrappers a command position is read through, with what each takes in front of
// the command it runs. Measured 2026-09-30 (ffc45c28, on develop too): `sudo -n
// crontab -r`, `sudo -u root crontab -r` and `timeout 60 crontab -r` passed, while
// `sudo crontab -r` was denied; the timer check below already read these (`sudo -n
// tee /etc/systemd/system/x.timer` was the one real write the plain prefix missed
// among 3250 measured commands, cc8e80d7). The other common wrappers are read the same
// way (found in review: a scheduler passed behind each): env with options and
// assignments, nice with an adjustment, nohup, command -p (only -p runs the command;
// -v and -V look it up), exec -a, stdbuf, setsid, flock <file>, doas, runuser, xargs as
// the head of a pipeline segment (`... | xargs crontab -r`), and GNU time or the shell
// keyword time with its options (found in review: `/usr/bin/time
// -o f -f %M crontab -r` and `time -p crontab -r` passed).
//
// valued: option letters that take a value, attached (`-uroot`) or as the next word;
// separate: letters whose value is always the next word; long: long options with a
// value (`--user=x` or `--user x`); bare: an option word without a value; needs: a word
// the wrapper takes after its options (timeout's duration, flock's lock file). Letters
// and names in any case, as the regexes read them with the i flag. The reader follows
// every reading of an option word at once (valued, bare, and the end of the options),
// so reading one wrong costs nothing: the masked view blanks a quoted value (`-f "%e
// %M"`), and there the bare reading keeps the command word after it. A wrapper is known
// by its last path component, and `--` ends its options: both are new for all but time
// (`/usr/bin/env crontab -r` and `nice -- crontab -r` passed).
// The heavy-run wrapper (HEAVY_WRAPPER) runs its command in a memory-capped scope:
// `<wrapper> [--no-wait] [--label NAME] [--] <command>`, the first word that is not one of
// its options being the command. Before, `<wrapper> -- crontab -r` passed: the gate saw the
// wrapper as the command. A command that only shares its prefix (a control tool such as
// `<wrapper>-ctl`) is no wrapper: a wrapper is known by its whole last path component. A
// configured name that is already one of the wrappers above keeps that wrapper's reading.
const WRAPPERS = new Map(Object.entries({
  sudo: { valued: 'ugpcdrth', long: ['user', 'group', 'prompt', 'close-from', 'chdir', 'role', 'type', 'other-user', 'command-timeout', 'host'], bare: /^(?:-[a-z]+|--[\w-]+)$/i },
  timeout: { valued: 'sk', long: ['signal', 'kill-after'], bare: /^(?:-[a-z]+|--[\w-]+)$/i, needs: true },
  env: { valued: 'ucs', long: ['unset', 'chdir', 'split-string'], bare: /^(?:-[a-z]*|--[\w-]+|[a-z_]\w*=\S*)$/i },
  nice: { valued: 'n', long: ['adjustment'], bare: /^-\d+$/ },
  nohup: {},
  command: { bare: /^-p$/i },
  exec: { separate: 'a', bare: /^-[cl]+$/i },
  stdbuf: { valued: 'ioe', long: ['input', 'output', 'error'] },
  setsid: { bare: /^(?:-[a-z]+|--[\w-]+)$/i },
  flock: { valued: 'we', long: ['timeout', 'conflict-exit-code'], bare: /^(?:-[a-z]+|--[\w-]+)$/i, needs: true },
  doas: { valued: 'u', bare: /^-[a-z]+$/i },
  runuser: { valued: 'u', long: ['user'], bare: /^(?:-[a-z]+|--[\w-]+)$/i },
  xargs: { valued: 'idelnpsa', bare: /^(?:-[a-z0]+|--[\w-]+(?:=\S+)?)$/i },
  time: { valued: 'of', long: ['output', 'format'], bare: /^(?:-[a-z]+|--[\w-]+)$/i },
  builtin: {},
}))
if (!WRAPPERS.has(HEAVY_WRAPPER)) WRAPPERS.set(HEAVY_WRAPPER, { long: ['label'], bare: /^(?:--no-wait|--label=\S+)$/i })
const WRAPPER_SPECS = [...WRAPPERS.values()]
const WRAPPER_INDEX = new Map([...WRAPPERS.keys()].map((name, i) => [name, i]))
const WRAPPER_NAME_MAX = Math.max(...[...WRAPPERS.keys()].map((name) => name.length))

// --- where a command word starts: read by a loop -----------------------------------
//
// ffc45c28 (found in review): the words in front of a
// command word were read by regexes, and their alternatives overlapped: an option that
// takes a value or none (`sudo -u`), a wrapper word two parts both read (`sudo`,
// `time`), `\s` over the newlines that also start a command, `(?:\S*/)?` from every
// `(`. Where no command word followed, the backtracking grew with the input: `time `
// x30000 + `true; crontab -r` (150 KB) took 10.05 s, and the hook FAILS OPEN after
// 10 s, so a slow gate is a bypass. Measured before this change (kimenet/ffc45c28
// redos-meres-3/4): 40 option words of `sudo -u`, `time -o` or `timeout -s` over 20 s;
// 150 000 newlines over 20 s; on develop 6158290b too, 30000 `sudo(` 2.3 s.
//
// So a loop walks the words. From each start it follows every way to read them --
// keyword, assignment, wrapper, each reading of an option word -- and reports each
// place where a command word can start. A (word, state) pair is taken once, however
// many readings lead to it, so the time is linear in the command. It reads every
// prefix the regexes read, and the few more named at WRAPPERS.

// What a JS regex \s matches, by char code: the loop splits words where \S+ ends.
function isWs(c) {
  return c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff
}

const ASSIGNMENT_START_RX = /[A-Za-z_]\w*=/y
const IDENTIFIER_WORD_RX = /[A-Za-z_]\w*(?=\s)/y
// cut: what closes the substitution a command position is in (0 nothing, 1 `)`, 2 a
// backtick), for the timer check, which reads a command's arguments up to it.
const cutOf = (text) => (text.includes('`') ? 2 : text.includes('(') ? 1 : 0)

// Calls onCommand(position, wordEnd, cut, name) once for each place in `s` where a
// command word can start, and each cut it can start in; name is where the last path
// component of the word starts. The starts: the start of `s`, where a
// case arm may stand; after each `(` and backtick; and with allStarts -- for a view
// that is a whole command, not one segment -- after each `;`, `&`, `|` and newline too,
// with a case arm after each start.
function forEachCommandPosition(s, allStarts, onCommand) {
  const n = s.length
  if (n === 0) return
  // where the word at i ends (i itself on a space), and where the next word starts
  const end = new Int32Array(n + 1)
  const next = new Int32Array(n + 1)
  end[n] = n
  next[n] = n
  for (let i = n - 1; i >= 0; i--) {
    const ws = isWs(s.charCodeAt(i))
    end[i] = ws ? i : end[i + 1]
    next[i] = ws ? next[i + 1] : i
  }
  // where a case arm's pattern word ([^()\s;&|]+) from i ends
  const runEnd = new Int32Array(n + 1)
  runEnd[n] = n
  for (let i = n - 1; i >= 0; i--) {
    const c = s[i]
    runEnd[i] = isWs(s.charCodeAt(i)) || c === '(' || c === ')' || c === ';' || c === '&' || c === '|' ? i : runEnd[i + 1]
  }
  // at the end of each word, the last `/` in it (-1: none)
  const slash = new Int32Array(n + 1)
  let last = -1
  for (let i = 0; i <= n; i++) {
    if (i === n || isWs(s.charCodeAt(i))) { slash[i] = last; last = -1 } else if (s.charCodeAt(i) === 47) last = i
  }
  const states = 2 * WRAPPER_SPECS.length + 1 // 0: a command position; 1 + 2w: wrapper w's options; 2 + 2w: its needed word
  const seen = new Uint32Array(Math.ceil((n * states * 3) / 32)) // one bit per (position, state, cut)
  const stack = []
  const push = (p, state, cut) => {
    if (p >= n) return
    const key = (p * states + state) * 3 + cut
    const bit = 1 << (key & 31)
    if (seen[key >>> 5] & bit) return
    seen[key >>> 5] |= bit
    stack.push(p, state, cut)
  }
  // where the command after a case arm that stands at q starts (-1: no arm there)
  const armEnd = (q) => {
    if (q < n && s[q] === '(') q = next[q + 1]
    if (q >= n || runEnd[q] === q) return -1
    const c = next[runEnd[q]]
    return c < n && s[c] === ')' ? next[c + 1] : -1
  }
  const wordIs = (q, w) => q < n && end[q] - q === w.length && end[q] < n && s.slice(q, end[q]).toLowerCase() === w
  const start = (a, cut, arm) => {
    const p = next[a]
    push(p, 0, cut)
    if (!arm || p >= n) return
    const arms = [armEnd(p)]
    if (wordIs(p, 'case')) {
      const w = next[end[p]] // case <word> in, or case in
      if (w < n && end[w] < n && wordIs(next[end[w]], 'in')) arms.push(armEnd(next[end[next[end[w]]]]))
      if (wordIs(w, 'in')) arms.push(armEnd(next[end[w]]))
    }
    // the cut matters in a segment, where only its start has an arm; a whole command's
    // starts are read for a shell word, which has no cut
    for (const e of arms) if (e > 0) push(e, 0, cut || (allStarts ? 0 : cutOf(s.slice(p, e))))
  }
  start(0, 0, true)
  for (let i = 0; i < n; i++) {
    const c = s[i]
    if (c === '(') start(i + 1, 1, allStarts)
    else if (c === '`') start(i + 1, 2, allStarts)
    else if (allStarts && (c === ';' || c === '&' || c === '|' || c === '\n')) start(i + 1, 0, true)
  }
  while (stack.length) {
    const cut = stack.pop()
    const state = stack.pop()
    const p = stack.pop()
    const e = end[p]
    const nx = next[e]
    if (state === 0) {
      const k = slash[e] >= p ? slash[e] + 1 : p
      onCommand(p, e, cut, k)
      if (e >= n) continue // the prefix words below are all followed by a space
      if (e - p <= 6) {
        const w = s.slice(p, e).toLowerCase()
        if (KEYWORD_WORDS.has(w)) push(nx, 0, cut)
        if (w === 'coproc') {
          push(nx, 0, cut)
          // `coproc NAME { ...; }`: the group after the name
          IDENTIFIER_WORD_RX.lastIndex = nx
          if (nx < n && IDENTIFIER_WORD_RX.test(s) && IDENTIFIER_WORD_RX.lastIndex === end[nx]) {
            const b = next[end[nx]]
            if (b < n && s[b] === '{' && end[b] === b + 1) push(b, 0, cut)
          }
        }
      }
      ASSIGNMENT_START_RX.lastIndex = p
      if (ASSIGNMENT_START_RX.test(s)) push(nx, 0, cut)
      if (e - k <= WRAPPER_NAME_MAX) {
        const wi = WRAPPER_INDEX.get(s.slice(k, e).toLowerCase())
        if (wi !== undefined) push(nx, 1 + 2 * wi, cut)
      }
      continue
    }
    const spec = WRAPPER_SPECS[(state - 1) >> 1]
    if ((state & 1) === 0) { // the word the wrapper needs, then the command
      if (e < n) push(nx, 0, cut)
      continue
    }
    const after = spec.needs ? state + 1 : 0
    push(p, after, cut) // the options may end before this word
    if (e >= n) continue // an option is followed by a space
    const word = s.slice(p, e)
    const valueNext = () => { if (nx < n && end[nx] < n) push(next[end[nx]], state, cut) }
    if (word === '--') push(nx, after, cut)
    if (spec.bare && spec.bare.test(word)) push(nx, state, cut)
    if (word.length >= 2 && word[0] === '-' && word[1] !== '-') {
      const letter = word[1].toLowerCase()
      if (spec.valued && spec.valued.includes(letter)) {
        if (word.length === 2) valueNext()
        else push(nx, state, cut)
      }
      if (spec.separate && spec.separate.includes(letter) && word.length === 2) valueNext()
    }
    if (spec.long && word.startsWith('--')) {
      const eq = word.indexOf('=')
      if (spec.long.includes((eq === -1 ? word.slice(2) : word.slice(2, eq)).toLowerCase())) {
        if (eq === -1) valueNext()
        else if (eq < word.length - 1) push(nx, state, cut)
      }
    }
  }
}

// The match of a sticky command-word regex in the word s[p, e): at p, or after a `/`
// in it (a path), the last `/` first, as `(?:\S*/)?` read it. Per regex, `memo` holds
// for each word end the last place after a `/` where the regex matches, so the words
// that start inside one token (after a `(`) share one scan of it.
function commandWordMatch(s, p, e, rx, memo) {
  let at = memo.get(e)
  if (at === undefined) {
    at = -1
    let a = e
    while (a > 0 && !isWs(s.charCodeAt(a - 1))) a--
    for (let j = e - 2; j >= a; j--) {
      if (s.charCodeAt(j) !== 47) continue
      rx.lastIndex = j + 1
      if (rx.test(s)) { at = j + 1; break }
    }
    memo.set(e, at)
  }
  rx.lastIndex = at > p ? at : p
  return rx.exec(s)
}

// Does this segment run a scheduler (and not only list one's own schedule)?
function schedulesInSegment(seg) {
  const memoRun = new Map()
  const memoRead = new Map()
  let runs = false
  let reads = false
  forEachCommandPosition(seg, false, (p, e) => {
    if (!runs && commandWordMatch(seg, p, e, SCHED_CMD_RX, memoRun)) runs = true
    if (!reads && commandWordMatch(seg, p, e, SCHED_READ_CMD_RX, memoRead)) reads = true
  })
  return runs && !reads
}

// --- a command handed to a shell as text ------------------------------------------
//
// `bash -c '<script>'`, `sh -c "<script>"`, `su -c '<script>' <user>` and `flock <file>
// -c '<script>'` run their quoted argument, which every check here reads as inert text.
// Measured 2026-09-30 (ffc45c28): `bash -c 'crontab -r'` and
// `sh -c "crontab -r"` passed. The shell word is looked for at a command position in the
// MASKED command, so a heredoc body or quoted prose that only mentions one is not read;
// masking keeps the length, so the quoted argument is then taken from the same place
// in the command itself and judged as a command of its own (gateDecision, depth <= 3).
// The -c option is the first word of the form -...c after the shell word, before any
// `;`, `&`, `|`, newline or quote, and the script is the quoted word right after it.
const SHELL_C_WORD_RX = /(?:bash|sh|dash|zsh|ksh|su|runuser|flock)\b/iy
export function shellCScripts(command) {
  const src = String(command ?? '').replace(/\\\r?\n/g, ' ')
  const view = maskInertLiterals(src, { strict: false }) ?? src
  const n = view.length
  // the first ; & | newline or quote at or after i; the first -...c option (a space,
  // a dash, letters ending in c, a space) at or after i, and where it ends
  const stopAt = new Int32Array(n + 1)
  const optAt = new Int32Array(n + 1)
  const optEnd = new Int32Array(n + 1)
  stopAt[n] = n
  optAt[n] = n
  for (let i = n - 1; i >= 0; i--) {
    const c = view[i]
    stopAt[i] = c === ';' || c === '&' || c === '|' || c === '\n' || c === "'" || c === '"' ? i : stopAt[i + 1]
    optAt[i] = optAt[i + 1]
    if (isWs(view.charCodeAt(i)) && view[i + 1] === '-') {
      let j = i + 2
      while (j < n && /[A-Za-z]/.test(view[j])) j++
      if (j > i + 2 && view[j - 1] === 'c' && j < n && isWs(view.charCodeAt(j))) { optAt[i] = i; optEnd[i] = j }
    }
  }
  // where a quoted string opened at i closes, as the shell reads it
  const sq = new Int32Array(n + 2)
  const dq = new Int32Array(n + 2)
  sq[n] = sq[n + 1] = dq[n] = dq[n + 1] = -1
  for (let i = n - 1; i >= 0; i--) {
    sq[i] = src[i] === "'" ? i : sq[i + 1]
    dq[i] = src[i] === '"' ? i : src[i] === '\\' ? dq[Math.min(i + 2, n)] : dq[i + 1]
  }
  const memo = new Map()
  const scripts = new Set() // by the position the script starts at
  const out = []
  forEachCommandPosition(view, true, (p, e) => {
    const m = commandWordMatch(view, p, e, SHELL_C_WORD_RX, memo)
    if (!m) return
    const ne = m.index + m[0].length
    const k = optAt[ne]
    if (k >= n || stopAt[ne] < k) return
    let at = optEnd[k]
    while (at < n && (src[at] === ' ' || src[at] === '\t')) at++
    if (scripts.has(at)) return
    scripts.add(at)
    if (src[at] === "'") {
      const close = sq[at + 1]
      if (close !== -1) out.push(src.slice(at + 1, close))
    } else if (src[at] === '"') {
      const close = dq[at + 1]
      if (close !== -1) out.push(src.slice(at + 1, close).replace(/\\(["\\$`])/g, '$1'))
    }
  })
  return out
}

// --- the one systemd-run form this gate allows ----------------------------------
//
// Card 90a2257b (074645b4). An install's heavy-run wrapper (HEAVY_WRAPPER, above) runs
// every heavy compile (tsc, next build) in a FOREGROUND transient scope with a memory cap:
//   systemd-run --user --scope --quiet --collect --slice=<wrapper>.slice
//     --unit=<wrapper>-<label> -p MemoryMax=<size> -- /usr/bin/time -o <file> -f %M <command>
// A scope runs its command now and ends with it: no timer, no --on-*, no service
// that outlives the call, so it schedules nothing. The operator accepted exactly
// this form and asked for a documented exception here instead of a blind spot.
// So this ONE form -- these options in this order, unquoted, at a command
// position (also after a shell keyword, as the scheduler check reads one), nothing (no
// sudo, env, path) in front of the binary -- is transparent
// to the gate: the prefix and the time tail are replaced by a command separator,
// and the command after them is judged as if it were run directly, so a scheduler,
// a timer or a pane injection behind the prefix is still denied. Every other systemd-run (an
// --on-* or timer option, no --scope, another slice or unit name, another
// property, another order) is not this form and stays denied by the scheduler check.
// The label charset is [A-Za-z0-9_.-] (a label cleaned with tr -c 'A-Za-z0-9_.-' '-' fits it).
// The GNU time tail is part of the form (found in review): it goes with the prefix,
// so the gate judges the command behind it exactly as if it ran on its own.
// Before, /usr/bin/time was the command the gate saw, and a scheduler behind it
// went through. The tail is exactly `/usr/bin/time -o <file> -f %M`, the file a
// plain word, a plain $NAME or ${NAME}, or a quoted string of those: never a
// command substitution or a backquote, because whatever sits in the removed tail
// is never judged. Any other tail (none, no -o, another format, an expansion in
// the file name) is not the form, and the whole systemd-run stays denied.
// A variable in the file name is read whole: `$AB` is the variable AB, never the
// variable A and a letter B. Measured 2026-09-30 (after a review case):
// with both readings open, a tail that is not the form (`-f %N`) was retried over
// every way to split the names, exponentially: 26 variables of two letters took 1 s
// in a 214-byte command, 32 of them would pass the hook's 10 s limit, and the hook
// fails open. One reading per character keeps the match linear.
const HEAVY_SCOPE_VAR = String.raw`\$[A-Za-z_][A-Za-z0-9_]*(?![A-Za-z0-9_])|\$\{[A-Za-z_][A-Za-z0-9_]*\}`
const HEAVY_SCOPE_TIME_FILE = String.raw`(?:(?:[A-Za-z0-9_./+:@%-]|${HEAVY_SCOPE_VAR})+|'[^'\n]*'|"(?:[A-Za-z0-9_./+:@% -]|${HEAVY_SCOPE_VAR})*")`
// The keywords in front of the form, on the form's own line. With `\s+` they ran over
// the newlines, and every newline is a start of its own, so a run of 30000 `then`
// lines was read again from each line (7.5 s on 150 KB). A keyword on an earlier
// line adds nothing: the newline after it is the start the form is read from.
const HEAVY_SCOPE_KEYWORDS = SHELL_KEYWORDS.replace(/\\s/g, '[ \\t]')
const HEAVY_SCOPE_RX = new RegExp(
  String.raw`(^|[;&|(\`\n])([ \t]*${HEAVY_SCOPE_KEYWORDS})systemd-run[ \t]+--user[ \t]+--scope[ \t]+--quiet[ \t]+--collect[ \t]+--slice=${HEAVY_WRAPPER_RX}\.slice[ \t]+--unit=${HEAVY_WRAPPER_RX}-[A-Za-z0-9_.-]+[ \t]+-p[ \t]+MemoryMax=[1-9][0-9]*[KMGT]?[ \t]+--[ \t]+/usr/bin/time[ \t]+-o[ \t]+${HEAVY_SCOPE_TIME_FILE}[ \t]+-f[ \t]+%M(?=[ \t]+[^\s;&|)\`])`,
  'g',
)
export function unwrapHeavyScope(command) {
  return String(command ?? '').replace(HEAVY_SCOPE_RX, (_, boundary, ws) => `${boundary}${ws};`)
}

// --- systemd timers -----------------------------------------------------------
//
// Measured 2026-09-27: an agent installed a systemd USER timer in two steps --
// wrote the unit files into ~/.config/systemd/user, then ran `systemctl --user
// enable --now <name>.timer` -- and the timer's job messaged the agent's own
// queue on a finding, so the agent woke up on turns it had scheduled for itself,
// twice in an hour. The scheduler check catches `systemd-run` (a transient timer in one
// call), but neither of these steps: `systemctl` is not a scheduler binary, and
// writing a file is not an invocation.
//
// An inventory of one install two days later (43 timer units) showed how agents
// actually create them: 36 through Bash (among them 23 a heredoc redirect into
// the unit file and 9 a cp/install of prepared unit files, the unit directory
// often held in a variable), 1 with the Edit tool, and in 9 the write and the
// enable were separate tool calls. So each step is checked on its own, and
// either one alone is a deny:
//   (a) systemctl with a timer argument and a verb that is not a pure read or a
//       disarm. An ALLOWLIST on purpose: enable, start, restart, reenable, link,
//       edit, add-wants, unmask, and any verb systemd adds later arm a timer;
//   (b) a write whose target is a timer unit in a systemd unit directory: a
//       redirect, tee, cp/mv/install/ln/rsync, dd of=, sed -i, a script's write
//       call (open(..., 'w'), write_text, writeFileSync, shutil.copy, ...), and
//       the native Write/Edit/NotebookEdit tools.
// Reading stays allowed: status, show, cat, list-timers, is-active, is-enabled,
// journalctl, cat/ls/grep/diff on a unit file, copying a unit file OUT of the
// directory. So do stopping and disabling a timer, and running a .service once.
//
// Like the scheduler check, both shell checks read what the SHELL would run: quoted text
// and heredoc bodies are inert (maskInertLiterals), so a message or a card
// comment that quotes the very command is not a deny. A unit name or a path in
// quotes is still an argument, so those are read from the command with only the
// heredoc bodies blanked. Unlike the scheduler check, one `"...$(...)..."` does not
// send the WHOLE command to the naive split: measured on 3250 real commands that
// mention systemctl, a unit directory or a timer, that fallback let the prose of
// quoted heredoc bodies (messages, card comments) read as commands, and most of
// those commands carry a `"$(date ...)"` somewhere. Here only that one region
// stays visible (maskInertLiterals `strict: false`).
//
// KNOWN LIMITATIONS, the same class as the other anchored checks: a wrapper that
// WRAPPERS does not know, a command fed to an interpreter as a quoted heredoc (`bash
// <<'EOF'`, `ssh host bash -s <<'EOF'`), a unit name that only a runtime
// expansion yields, an existing timer edited through a script's argv, and a
// script file that does it all (the gate sees `bash install.sh`, not what it runs).
//
// A systemd unit directory: the directory systemd loads unit files from, or one
// of its .wants/.requires/.upholds/.d subdirectories (an enable symlink, a
// drop-in). A file elsewhere under it (a `retired/` folder) is never loaded.
const UNIT_DIR_RX = /(?:^|\/)systemd\/(?:user|system)(?:\.control)?(?:\/[^/]+\.(?:wants|requires|upholds|d))?\/?$/
// A line of script code (python, node) that writes, copies or links a file.
// `open(` counts with a write mode after it on the line: the path expression often
// has parentheses of its own (`open(os.path.expanduser('...'), 'w')`). The mode is
// looked for after the FIRST `open(` only, which finds it whenever any `open(` has
// one after it: as `open\s*\(.*?,` the regex looked after every `open(` to the end
// of the line, and 30000 of them took 0.9 s (ffc45c28, measured on cb4fb725).
const SCRIPT_OPEN_RX = /\bopen\s*\(/g
const SCRIPT_MODE_RX = /,\s*['"][wax]b?\+?['"]/g
const SCRIPT_CALL_RX = /\.write_(?:text|bytes)\s*\(|\b(?:writeFileSync|appendFileSync|copyFileSync|symlinkSync|renameSync)\s*\(|\bshutil\.(?:copy\w*|move)\s*\(|\bos\.(?:symlink|rename|replace)\s*\(/
function scriptWrites(line) {
  if (SCRIPT_CALL_RX.test(line)) return true
  SCRIPT_OPEN_RX.lastIndex = 0
  const o = SCRIPT_OPEN_RX.exec(line)
  if (!o) return false
  SCRIPT_MODE_RX.lastIndex = o.index + o[0].length
  return SCRIPT_MODE_RX.test(line)
}
// ...and a timer unit's path on the same line: a unit directory, then `.timer` later
// in the same word (`\S*\.timer\b` after the directory). Where each word ends is
// computed once, so many directory mentions in one word are not each read to its end.
const UNIT_DIR_MENTION_RX = /systemd\/(?:user|system)(?:\.control)?\//gi
function namesTimerUnitPath(line) {
  const timers = [...line.matchAll(/\.timer\b/gi)].map((m) => m.index)
  if (timers.length === 0) return false
  const n = line.length
  const wordEnd = new Int32Array(n + 1)
  wordEnd[n] = n
  for (let i = n - 1; i >= 0; i--) wordEnd[i] = isWs(line.charCodeAt(i)) ? i : wordEnd[i + 1]
  let t = 0
  for (const m of line.matchAll(UNIT_DIR_MENTION_RX)) {
    const from = m.index + m[0].length
    while (t < timers.length && timers[t] < from) t++
    if (t < timers.length && timers[t] < wordEnd[from]) return true
  }
  return false
}
// systemctl verbs that only READ state, or that DISARM a timer.
const SYSTEMCTL_SAFE_VERBS = new Set([
  'status', 'show', 'cat', 'help', 'list-units', 'list-timers', 'list-unit-files', 'list-dependencies',
  'list-jobs', 'list-sockets', 'list-paths', 'list-automounts', 'list-machines', 'is-active', 'is-enabled',
  'is-failed', 'is-system-running', 'get-default', 'show-environment', 'daemon-reload',
  'stop', 'disable', 'mask', 'kill', 'reset-failed', 'clean',
])
// systemctl options that take their value as the NEXT word (`-p Prop show x.timer`),
// so the value is not mistaken for the verb.
const SYSTEMCTL_VALUE_OPTS = new Set([
  '-p', '--property', '-P', '-t', '--type', '--state', '-H', '--host', '-M', '--machine', '-n', '--lines',
  '-o', '--output', '-s', '--signal', '--kill-whom', '--kill-value', '--job-mode', '--root', '--image',
  '--what', '--timestamp', '--preset-mode', '--when', '--drop-in', '--message', '--check-inhibitors',
])
// The command words that arm a timer or write a file, read where a command word
// starts (forEachCommandPosition), as for the scheduler check.
const TIMER_CMD_WORD_RX = /(systemctl|tee|cp|mv|install|ln|rsync|dd|sed)\b(?!-)(?!\s*=)/iy

// A unit argument that names a timer: <x>.timer, a glob, or a brace form
// (x.{service,timer}). A `)` or backtick closing a substitution, or punctuation
// after it, is not part of the name; a bare ".timer" names nothing.
function isTimerName(word) {
  const w = String(word).replace(/[)`'",;:.]+$/, '')
  return /[^\s/`'"]\.timer$/i.test(w) || /\{[^}]*\btimer\b[^}]*\}$/i.test(w)
}

// A name the command does not spell out: nothing but a variable, a substitution
// or a glob (`$f`, `${name}`, `*`). `x.service.bak.$TS` is spelled out enough.
function isUnknownName(base) {
  return /^(?:\$\{?[A-Za-z_]\w*\}?|\$\([^)]*\)|[*?]+)$/.test(base)
}

// A path's directory and last component; a trailing slash names a directory.
function splitPath(p) {
  const s = String(p)
  if (s.endsWith('/')) return [s.slice(0, -1), '']
  const k = s.lastIndexOf('/')
  return k === -1 ? ['', s] : [s.slice(0, k), s.slice(k + 1)]
}

// One shell word from index i: quotes removed, a backslash escape resolved.
function readWord(s, i) {
  let w = ''
  while (i < s.length && !/[\s<>]/.test(s[i])) {
    const c = s[i]
    if (c === "'") {
      const e = s.indexOf("'", i + 1)
      const end = e === -1 ? s.length : e
      w += s.slice(i + 1, end); i = end + 1; continue
    }
    if (c === '"') {
      let j = i + 1
      while (j < s.length && s[j] !== '"') {
        if (s[j] === '\\' && j + 1 < s.length) { w += s[j + 1]; j += 2 } else { w += s[j]; j++ }
      }
      i = j + 1; continue
    }
    if (c === '\\' && i + 1 < s.length) { w += s[i + 1]; i += 2; continue }
    w += c; i++
  }
  return [w, i]
}

// The argument words of one command segment, and the files its output
// redirections write. Enough to read a unit name or a path; it is not a shell.
function shellWords(text) {
  const s = String(text ?? '')
  const words = []
  const outTargets = []
  let i = 0
  while (i < s.length) {
    if (/\s/.test(s[i])) { i++; continue }
    // a redirection: an fd number glued in front (2>), the operator, its target
    const op = /^(?:\d+|&)?(>>?\|?|<<<|<<-?|<>|<)(&?)/.exec(s.slice(i))
    if (op) {
      i += op[0].length
      while (i < s.length && /\s/.test(s[i])) i++
      const [t, e] = readWord(s, i)
      i = e
      if (op[1].startsWith('>') && !op[2]) outTargets.push(t) // `>&2` copies an fd, writes no file
      continue
    }
    const [w, e] = readWord(s, i)
    if (e === i) { i++; continue }
    words.push(w)
    i = e
  }
  return { words, outTargets }
}

// (a) the verb and the units of a `systemctl` call: arms a timer unless the verb
// is on the read/disarm allowlist.
function systemctlArmsTimer(args) {
  let verb = null
  const units = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a.startsWith('-')) { if (SYSTEMCTL_VALUE_OPTS.has(a)) i++; continue }
    if (verb === null) verb = a.toLowerCase().replace(/[)`'",;:.]+$/, '')
    else units.push(a)
  }
  return verb !== null && !SYSTEMCTL_SAFE_VERBS.has(verb) && units.some(isTimerName)
}

// (b) what a write binary writes: dd of=, tee and sed -i write FILES; cp, mv,
// install, ln and rsync COPY their sources to a destination (-t DIR, or the last
// operand), which can be a file or a directory.
function writeTargets(bin, args) {
  const none = { files: [], copies: [] }
  if (bin === 'dd') return { files: args.filter((a) => a.startsWith('of=')).map((a) => a.slice(3)), copies: [] }
  const operands = []
  let dest = null
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '-t' || a === '--target-directory') { dest = args[++i] ?? null; continue }
    if (a.startsWith('--target-directory=')) { dest = a.slice(a.indexOf('=') + 1); continue }
    if (a.startsWith('-')) continue
    operands.push(a)
  }
  if (bin === 'tee') return { files: operands, copies: [] }
  if (bin === 'sed') return args.some((a) => /^-[a-zA-Z]*i|^--in-place/.test(a)) ? { files: operands.slice(1), copies: [] } : none
  if (bin === 'install' && args.includes('-d')) return none // creates directories
  if (dest != null) return { files: [], copies: [{ dest, sources: operands }] }
  if (operands.length >= 2) return { files: [], copies: [{ dest: operands[operands.length - 1], sources: operands.slice(0, -1) }] }
  // `ln -s SRC` with one operand links into the working directory
  if (bin === 'ln' && operands.length === 1) return { files: [], copies: [{ dest: '.', sources: operands }] }
  return none
}

// A file written from a heredoc in the command: `cat > inst.sh <<'EOF' ... EOF`, as
// [file, body] pairs: an output redirect's target on the opener's line (its `>` may end
// the line before), and the body up to the first line that is only the tag. An opener
// inside a body already taken is part of that body. As one regex, the opener was looked
// for after every `>` of a line to the line's end, and 20000 redirects into a unit
// directory took over 20 s (ffc45c28, measured on cb4fb725); here the openers, the
// targets and the tag lines are each found once, and `ran` (the files the command runs)
// is asked once per opener.
function heredocInstallers(command, ran) {
  const s = String(command ?? '')
  const out = []
  if (!s.includes('<<')) return out
  const tagLines = new Map() // the starts of the lines that are only a tag (after a newline), by tag
  for (let ls = s.indexOf('\n') + 1; ls > 0;) {
    const nl = s.indexOf('\n', ls)
    const m = /^[ \t]*([A-Za-z_]\w*)[ \t]*$/.exec(s.slice(ls, nl === -1 ? s.length : nl))
    if (m) (tagLines.get(m[1]) ?? tagLines.set(m[1], []).get(m[1])).push(ls)
    ls = nl + 1
  }
  const targets = [] // [where the target word starts, the file], in order
  for (const m of s.matchAll(/>\s*(["']?)([^\s"'<>;|&]+)\1/g)) targets.push([m.index + m[0].length - m[1].length - m[2].length, m[2]])
  const tagAt = new Map() // per tag, the first tag line not yet passed
  let taken = 0
  let lineStart = 0
  let nextNl = s.indexOf('\n')
  let t = 0
  for (const m of s.matchAll(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1/g)) {
    const o = m.index
    if (o < taken) continue
    while (nextNl !== -1 && nextNl < o) { lineStart = nextNl + 1; nextNl = s.indexOf('\n', lineStart) }
    while (t < targets.length && targets[t][0] < lineStart) t++
    if (t >= targets.length || targets[t][0] >= o) continue // no redirect on the opener's line
    const openEnd = o + m[0].length
    const nl = nextNl !== -1 && openEnd <= nextNl ? nextNl : s.indexOf('\n', openEnd)
    if (nl === -1) continue
    const lines = tagLines.get(m[2]) ?? []
    let k = tagAt.get(m[2]) ?? 0
    while (k < lines.length && lines[k] < nl + 2) k++
    tagAt.set(m[2], k)
    if (k >= lines.length) continue // no closing tag line
    const close = lines[k]
    const closeEnd = s.indexOf('\n', close)
    taken = closeEnd === -1 ? s.length : closeEnd
    for (let j = t; j < targets.length && targets[j][0] < o; j++) {
      if (ran(targets[j][1])) { out.push([targets[j][1], s.slice(nl + 1, close - 1)]); break }
    }
  }
  return out
}

// The files a command runs (the installer rule): at a command position of the masked
// command, as the first operand of a shell, `source` or `.` (options without an `n`:
// `bash -n` only parses), or as the command itself; one pair of quotes around the
// word dropped. A word ends at a space, `;`, `&`, `|`, `(` or `)`, so the words after
// the starts do not overlap, and each is read once.
function ranFiles(masked) {
  const s = String(masked ?? '')
  const n = s.length
  const files = new Set()
  const next = new Int32Array(n + 1) // the first non-space at or after i
  next[n] = n
  for (let i = n - 1; i >= 0; i--) next[i] = isWs(s.charCodeAt(i)) ? next[i + 1] : i
  const wordAt = (i) => {
    let j = i
    while (j < n && !isWs(s.charCodeAt(j)) && !';&|()'.includes(s[j])) j++
    return [s.slice(i, j), j]
  }
  const add = (w) => files.add(w.replace(/^["']/, '').replace(/["']$/, ''))
  const read = (a) => {
    let i = next[a]
    const [w, e] = wordAt(i)
    if (!w) return
    add(w)
    if (!['bash', 'sh', 'zsh', 'dash', 'source', '.'].includes(w) || e >= n || !isWs(s.charCodeAt(e))) return
    for (i = next[e]; ;) {
      const [o, oe] = wordAt(i)
      const option = /^--[\w-]+$/.test(o) || (/^-[A-Za-z]+$/.test(o) && !o.includes('n'))
      if (!option || oe >= n || !isWs(s.charCodeAt(oe))) break
      i = next[oe]
    }
    const [f] = wordAt(i)
    if (f) add(f)
  }
  read(0)
  for (let i = 0; i < n; i++) if (';&|(\n'.includes(s[i])) read(i + 1)
  return files
}

// Does this Bash command arm a systemd timer, or write a timer unit into a unit
// directory? `depth` bounds the installer recursion below.
function armsSystemdTimer(command, naiveSegs, depth = 0) {
  // The argument reading below costs what it scans. A command inside `$(...)` reads
  // its arguments to the `)`, and nested substitutions with no close each read the
  // rest of the segment again (ffc45c28, measured on cb4fb725: 20000 nested `$(systemctl
  // status` over 20 s). A real command scans its segments a few times at most; past
  // this budget the command is denied, as one the gate cannot read in time.
  let budget = 16 * String(command ?? '').length + 65536
  // The segments the shell really has (masked: quotes and heredoc bodies blank),
  // and the same spans with only the heredoc bodies blank: quoted arguments are
  // read from those. The two strings have the same length (maskInertLiterals
  // blanks in place). Only an unterminated quote or heredoc falls back to the
  // naive segments here (see the strict: false note above).
  const masked = maskInertLiterals(command, { strict: false })
  const bodiesBlank = maskInertLiterals(command, { quotes: false, strict: false })
  const pairs = []
  if (masked == null || bodiesBlank == null) {
    for (const s of naiveSegs) pairs.push([s, s])
  } else {
    const sep = /&&|\|\||[;&|]|\r?\n/g
    let last = 0
    let m
    while ((m = sep.exec(masked))) {
      pairs.push([masked.slice(last, m.index), bodiesBlank.slice(last, m.index)])
      last = m.index + m[0].length
    }
    pairs.push([masked.slice(last), bodiesBlank.slice(last)])
  }
  // A name the command leaves to a variable or a glob (`"$U/$f"` in a for loop)
  // writes a timer if the command names one anywhere.
  const mentionsTimer = /\.timer\b|[{,]timer[,}]/i.test(String(command ?? ''))
  const vars = {} // literal NAME=value assignments earlier in the same command
  let cwdInUnitDir = false // after `cd <unit dir>`, a relative path is inside it
  const expand = (w) => String(w).replace(/\$\{?([A-Za-z_]\w*)\}?/g, (full, n) => (Object.hasOwn(vars, n) ? vars[n] : full))
  const isUnitDir = (d) => (d === '' || d === '.' ? cwdInUnitDir : UNIT_DIR_RX.test(d))
  const namesTimer = (base) => isTimerName(base) || (isUnknownName(base) && mentionsTimer)
  // A FILE written into a unit directory: a timer unit, or a drop-in of one
  // (x.timer.d/override.conf changes its schedule). A directory itself is not a
  // file (a redirect onto one fails), so `-> ~/.config/systemd/user/` is nothing.
  const writesTimerFile = (t) => {
    const [dir, base] = splitPath(expand(t))
    return base !== '' && base !== '.' && isUnitDir(dir) && (namesTimer(base) || /\.timer\.d$/i.test(dir))
  }
  // A copy INTO a unit directory writes a timer if a source is one; a copy onto
  // a file path is a file write.
  const copiesTimerIn = ({ dest, sources }) => {
    const p = expand(dest)
    const [dir, base] = splitPath(p)
    // the destination directory: `DIR/`, `.`, or a unit directory without the slash
    const destDir = base === '' ? dir : base === '.' ? '' : UNIT_DIR_RX.test(p) ? p : null
    if (destDir === null) return writesTimerFile(dest)
    return isUnitDir(destDir) && sources.some((s) => namesTimer(splitPath(expand(s))[1]))
  }

  for (const [mseg, bseg] of pairs) {
    const lead = mseg.length - mseg.trimStart().length
    const m = mseg.slice(lead)
    const b = bseg.slice(lead)
    const { words, outTargets } = shellWords(b)
    if (outTargets.some(writesTimerFile)) return true
    // the segment's command words that arm or write, each with where its arguments
    // start and the substitution it is in; one per such place
    const found = new Map()
    const memo = new Map()
    forEachCommandPosition(m, false, (p, e, cut) => {
      const cm = commandWordMatch(m, p, e, TIMER_CMD_WORD_RX, memo)
      if (cm) found.set((cm.index + cm[0].length) * 3 + cut, cm[1].toLowerCase())
    })
    for (const [key, bin] of found) {
      const cut = key % 3
      // a command that starts a substitution ends where the substitution does
      let rest = b.slice((key - cut) / 3)
      const close = cut === 2 ? rest.indexOf('`') : cut === 1 ? rest.indexOf(')') : -1
      budget -= close === -1 ? rest.length : close
      if (budget < 0) return true
      if (close !== -1) rest = rest.slice(0, close)
      const { words: args } = shellWords(rest)
      if (bin === 'systemctl') {
        if (systemctlArmsTimer(args.map(expand))) return true
        continue
      }
      const { files, copies } = writeTargets(bin, args)
      if (files.some(writesTimerFile) || copies.some(copiesTimerIn)) return true
    }
    // what this segment leaves for the next ones: its assignments, its cd
    const w = words[0] === 'export' || words[0] === 'local' || words[0] === 'readonly' ? words.slice(1) : words
    for (const a of w) {
      const as = /^([A-Za-z_]\w*)=(.*)$/s.exec(a)
      if (!as) break
      if (!/\$\(|`/.test(as[2])) vars[as[1]] = expand(as[2])
    }
    const cmd0 = (words[0] ?? '').replace(/^[({]+/, '')
    if (cmd0 === 'cd' || cmd0 === 'pushd') cwdInUnitDir = UNIT_DIR_RX.test(expand(words[1] ?? ''))
  }
  // An installer written AND run in the same command (measured: 1 of the 36
  // creations wrote `install-...-timer.sh` from a heredoc, then `bash` ran it): the
  // body is checked as commands when the command runs that very file with a shell.
  if (depth < 2 && masked != null) {
    // run at a command position (the `cat > file` line itself is not one), with a
    // shell, `source`/`.`, or as ./file; in `masked` a quoted body is blank, so a
    // message that merely SAYS `bash inst.sh` runs nothing. `bash -n` only parses
    // (measured: in 7 of the 8 commands this rule met among 3250 real ones, the
    // arming script was only syntax-checked), so a short option with `n` is no run.
    const run = ranFiles(masked)
    for (const [, body] of heredocInstallers(command, (f) => run.has(f) || run.has('./' + f))) {
      if (armsSystemdTimer(body, splitSegments(body), depth + 1)) return true
    }
  }
  // A script's own write call (python/node, e.g. in a heredoc body), per line.
  return naiveSegs.some((seg) => scriptWrites(seg) && namesTimerUnitPath(seg))
}

// The native file tools: a timer unit written straight into a unit directory.
function isTimerUnitPath(fp) {
  const [dir, base] = splitPath(fp)
  return dir !== '' && UNIT_DIR_RX.test(dir) && isTimerName(base)
}

// The Claude self-schedule store. Blocked for WRITE on any route (a Bash write,
// or the native Write/Edit/NotebookEdit tool); a read/grep is legit diagnostics.
const SCHEDULE_STORE_RX = /scheduled_tasks\.json/i
// Write-intent shell tokens (redirect / tee / in-place edit / dd / copy-move).
const WRITE_INTENT_RX = /(>>?|\btee\b|\bsed\b[\s\S]*\s-i|\bdd\b|\bcp\b|\bmv\b)/i
// Dashboard schedule API. A WRITE method (POST/PUT/PATCH/DELETE) creates/edits a
// self-paced cron; a GET (list / pending / agents) is legit diagnostics -> allowed.
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
// What this gate CANNOT see -- a script that builds the path at runtime, a glob that
// does not spell the name -- is written down, not hidden: the dashboard keeps a hash
// baseline of the file and reports every change, whoever made it, by whatever route
// (src/egress-allowlist-baseline.ts). This gate narrows the casual route; that one
// catches the rest after the fact.
const ALLOWLIST_BASENAME = 'egress-allowlist.json'
// The STORE objects, not the concept: the file and its history directory, or a glob that
// starts on the name (egress-allow*, egress-allowlist.*). A plain /egress[-_]?allow/ also
// matched this gate's own source and test names (egress-allowlist-baseline.ts), so no
// sub-agent could run, stage or diff them -- review on #1678.
const ALLOWLIST_MENTION_RX = /egress[-_]?allowlist(?:\.json|\.history)|egress[-_]?allow[\w.]*[*?[]/i
const ALLOWLIST_READERS = new Set([
  'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'jq', 'wc', 'ls', 'stat',
  'file', 'shasum', 'sha256sum', 'md5', 'md5sum', 'diff', 'cmp', 'echo', 'printf',
])
// Output redirects: `>`, `>>`, `>|`, `&>`, `&>>`, `N>`. The target is the next word.
const OUTPUT_REDIRECT_RX = /(?:&>>?|\d*>>?\|?)\s*([^\s;&|<>]+)/g

export function allowlistBashSegmentAllowed(seg) {
  const s = String(seg ?? '').trim()
  if (!ALLOWLIST_MENTION_RX.test(s)) return true
  const words = s.split(/\s+/)
  let i = 0
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++ // leading VAR=x
  const cmd = (words[i] ?? '').replace(/^.*\//, '')
  if (!ALLOWLIST_READERS.has(cmd)) return false
  for (const m of s.matchAll(OUTPUT_REDIRECT_RX)) {
    const target = m[1]
    if (/^&?\d+$/.test(target) || target === '/dev/null') continue // 2>&1, >/dev/null
    if (ALLOWLIST_MENTION_RX.test(target) || /[$`]/.test(target)) return false
  }
  return true
}

function expandHome(p) {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
}
function realOrSelf(p) {
  try { return realpathSync(p) } catch { return p }
}

// Does a native file-tool call target the allowlist? `allowlistPath` is the real file
// this install's egress-gate reads; tests pass a tmp one.
export function fileToolTargetsAllowlist(toolInput, allowlistPath = DEFAULT_ALLOWLIST_PATH, cwd = process.cwd()) {
  const raw = String(toolInput?.file_path ?? toolInput?.notebook_path ?? '')
  if (!raw) return false
  if (basename(raw).toLowerCase() === ALLOWLIST_BASENAME) return true
  const abs = resolve(cwd, expandHome(raw))
  return realOrSelf(abs) === realOrSelf(allowlistPath)
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
//     (`X=$(crontab -)`, `X=`crontab -``) is caught by the scheduler check, which
//     reads a command position after both `(` and the backtick.
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
// `launchctl`, and the scheduler check's end-of-segment branch reads a bare `launchctl`
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
// stayed denied, because the scheduler regex carried its OWN boundary anchor
// (the bar among them), so it re-found a command position INSIDE a
// segment. Keeping the quoted text in the segment at all was the mistake. The
// `launchctl` cases passed only by luck -- LAUNCHCTL_SUBCOMMAND's lookahead
// happened to reject the following bar. So the primitive is not "split more
// carefully", it is "the inert text must not be there": mask it out, then let
// the existing splitter and regexes run unchanged on what remains.
//
// `{ quotes: false }` blanks the heredoc bodies only and keeps the quoted text as
// it is (same length): a quoted word can be an ARGUMENT -- a unit name, a path --
// and the systemd-timer check reads its arguments from that.
// `{ strict: false }` does not give up on a region that can command-substitute
// (a double-quoted string or an unquoted-tag heredoc body with $(...) or a
// backtick): it keeps THAT region as it is, visible, and masks the rest. Only an
// unterminated quote or heredoc is still null. The scheduler check keeps the
// strict default; the systemd-timer check uses this.
export function maskInertLiterals(command, { quotes = true, strict = true } = {}) {
  const src = String(command ?? '').replace(/\\\r?\n/g, ' ')
  let cur = ''
  let i = 0

  // Inert regions collapse to spaces: the text is gone, and with it every
  // separator inside it -- which is precisely what prose was faking.
  const blank = (s) => ' '.repeat(s.length)
  const quoted = (s) => (quotes ? blank(s) : s)

  while (i < src.length) {
    const c = src[i]

    // backslash escape outside quotes: consumes the next character
    if (c === '\\' && i + 1 < src.length) { cur += src.slice(i, i + 2); i += 2; continue }

    // heredoc: <<TAG / <<-TAG / <<'TAG' / <<"TAG"
    const here = /^<<-?\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z_]\w*))/.exec(src.slice(i))
    if (here) {
      const tag = here[1] ?? here[2] ?? here[3]
      const quotedTag = here[1] != null || here[2] != null
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
      if (!quotedTag && /\$\(|`/.test(body)) { // unquoted tag expands the body
        if (strict) return null
        cur += body + rel[0]
        i += rel.index + rel[0].length
        continue
      }
      cur += blank(body) + rel[0]
      i += rel.index + rel[0].length
      continue
    }

    if (c === "'") { // literal until the next ' -- a backslash is NOT special here
      const end = src.indexOf("'", i + 1)
      if (end === -1) return null
      cur += quoted(src.slice(i, end + 1)); i = end + 1; continue
    }

    if (c === '$' && src[i + 1] === "'") { // ANSI-C: \' does escape
      let j = i + 2
      while (j < src.length && src[j] !== "'") { j += src[j] === '\\' ? 2 : 1 }
      if (j >= src.length) return null
      cur += quoted(src.slice(i, j + 1)); i = j + 1; continue
    }

    if (c === '"') {
      let j = i + 1
      while (j < src.length && src[j] !== '"') { j += src[j] === '\\' ? 2 : 1 }
      if (j >= src.length) return null
      const inner = src.slice(i + 1, j)
      if (/\$\(|`/.test(inner)) { // may run a command -> not inert
        if (strict) return null
        cur += src.slice(i, j + 1); i = j + 1; continue
      }
      cur += quoted(src.slice(i, j + 1)); i = j + 1; continue
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
// is not blanked. Such a payload is then still denied by the scheduler check, which
// reads both `$(` and the backtick as the start of a command,
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
// -r)"`) is left intact so the scheduler check still catches the real substitution.
// Scoped to git commit/tag/stash so a `-m` on an unrelated binary is untouched.
// Heredoc bodies are DATA, not commands. A worker writing a real commit message
// through `git commit -F - <<EOF … EOF` had the turn denied because one prose
// line happened to start with "at " -- which the scheduler check reads as the `at`
// scheduler at a segment start. A heredoc body is data, so blank it before any
// pattern runs. Handles <<- for tab-indented bodies.
//
// EXCEPT when the body can still run something. A QUOTED marker (<<'EOF' or
// <<"EOF") is literal: the shell performs no expansion inside it, so blanking is
// safe. An UNQUOTED marker (<<EOF) is not -- the shell expands $(...) and
// backticks in that body at exec time, so blanking one would hide a live
// command substitution from the scheduler check and the gate would stop seeing
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

// The owner, as it stood (develop): the first word of the last command piece after
// the pass-through prefixes.
function ownerByPrefixList(before) {
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

// `string` up to `offset` is the command before the << redirect. The owner is read from
// the command segment the redirect stands in (after the last newline, ;, | or &), and
// besides the first word above, a SHELL is found as any command word the reader finds
// there (ffc45c28): through a wrapper with options the pass-through list does not know,
// `timeout 60 bash <<'EOF'`, `sudo -u root bash <<'EOF'`, `setsid bash <<'EOF'` and
// `nice -n 5 bash <<'EOF'` fed their body to bash, and the body was blanked. Only a
// shell: a body a wrapped python runs is python, and read as shell lines its prose
// strings were measured to deny real commands (5 in the 26653 of the corpus).
const HEREDOC_SHELL_RX = /^(?:bash|sh|zsh|dash|ksh|ash|ssh)$/
function heredocOwnerRunsBody(string, offset) {
  let a = offset
  while (a > 0 && !'\n;|&'.includes(string[a - 1])) a--
  const seg = string.slice(a, offset)
  if (ownerByPrefixList(seg)) return true
  let runs = false
  forEachCommandPosition(seg, false, (p, e, cut, k) => {
    if (runs || e - k > 24) return
    const word = seg.slice(k, e)
    if (HEREDOC_SHELL_RX.test(word)) runs = true
    else if (['docker', 'podman', 'kubectl'].includes(word) && /(?:^|\s)exec(?=\s|$)/.test(seg.slice(e))) runs = true
  })
  return runs
}

// The heredocs of a command, exactly as the regex
//   /(<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2)([\s\S]*?)(^\s*\3\s*$)/gm
// matches them, in one pass: [{ offset, open, quote, body, close }]. As that regex, an
// opener with no closing line read the rest of the command looking for one, and a run
// of them was quadratic (ffc45c28, measured on develop 6158290b: 20000 unclosed `<<EOF`
// lines 3.4 s, `<<-EOF` lines 4.6 s; the hook fails open after 10 s). Here the lines
// that can close a heredoc (only whitespace around a tag) are indexed once, by tag.
// The regex's own readings are kept: an unquoted tag with no closing line of its own
// is closed by a line of a shorter prefix of it (the regex backtracks into the tag),
// `<<<` is read from its second `<`, the closing match starts at the first line start
// of the whitespace before its tag (\s spans lines), and it ends before the last line
// break of the whitespace after it.
export function heredocSpans(command) {
  const s = String(command ?? '')
  const n = s.length
  const out = []
  if (!s.includes('<<')) return out
  const isBreak = (i) => { const c = s.charCodeAt(i); return c === 10 || c === 13 || c === 0x2028 || c === 0x2029 }
  const lineStarts = [0] // every position `^` holds at (after a line break)
  for (let i = 0; i < n; i++) if (isBreak(i)) lineStarts.push(i + 1)
  const firstLineStartFrom = (x) => { // the first line start >= x
    let lo = 0
    let hi = lineStarts.length
    while (lo < hi) { const mid = (lo + hi) >> 1; if (lineStarts[mid] < x) lo = mid + 1; else hi = mid }
    return lo < lineStarts.length ? lineStarts[lo] : -1
  }
  // the lines that are only a tag with whitespace around it: by tag, [line start, tag position], in order
  const tagLines = new Map()
  for (let k = 0; k < lineStarts.length; k++) {
    const ls = lineStarts[k]
    const le = k + 1 < lineStarts.length ? lineStarts[k + 1] - 1 : n
    let a = ls
    while (a < le && isWs(s.charCodeAt(a))) a++
    let b = le
    while (b > a && isWs(s.charCodeAt(b - 1))) b--
    if (b > a && /^[A-Za-z_][A-Za-z0-9_]*$/.test(s.slice(a, b))) {
      const tag = s.slice(a, b)
      if (!tagLines.has(tag)) tagLines.set(tag, [])
      tagLines.get(tag).push([ls, a])
    }
  }
  // the closing match of `tag` for a body that starts at bs: [its start, its end], or null
  const closeFor = (tag, bs) => {
    const lines = tagLines.get(tag)
    if (!lines) return null
    let lo = 0
    let hi = lines.length
    while (lo < hi) { const mid = (lo + hi) >> 1; if (lines[mid][0] < bs) lo = mid + 1; else hi = mid }
    if (lo >= lines.length) return null
    const a = lines[lo][1]
    let w = a // the whitespace before the tag, back to the last non-space
    while (w > 0 && isWs(s.charCodeAt(w - 1))) w--
    const start = firstLineStartFrom(Math.max(bs, w))
    let e = a + tag.length // the whitespace after it, then back to its last line break
    while (e < n && isWs(s.charCodeAt(e))) e++
    if (e < n) while (!isBreak(e - 1)) e--
    return [start, e < n ? e - 1 : n]
  }
  const OPEN_RX = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)/y
  let from = 0
  for (let i = s.indexOf('<<'); i !== -1; i = s.indexOf('<<', i + 1)) {
    if (i < from) continue
    OPEN_RX.lastIndex = i
    const m = OPEN_RX.exec(s)
    if (!m) continue
    const quote = m[1]
    const word = m[2]
    const tagAt = i + m[0].length - word.length
    let found = null
    if (quote) {
      if (s[tagAt + word.length] === quote) {
        const c = closeFor(word, tagAt + word.length + 1)
        if (c) found = [word, tagAt + word.length + 1, c]
      }
    } else {
      for (let k = word.length; k >= 1 && !found; k--) {
        const c = closeFor(word.slice(0, k), tagAt + k)
        if (c) found = [word.slice(0, k), tagAt + k, c]
      }
    }
    if (!found) continue
    const [, bodyStart, [closeStart, closeEnd]] = found
    out.push({ offset: i, open: s.slice(i, bodyStart), quote, body: s.slice(bodyStart, closeStart), close: s.slice(closeStart, closeEnd) })
    from = closeEnd
  }
  return out
}

export function stripHeredocBodies(command) {
  const cmd = String(command ?? '')
  if (!/<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*/.test(cmd)) return cmd
  let out = ''
  let at = 0
  for (const { offset, open, quote, body, close } of heredocSpans(cmd)) {
    const end = offset + open.length + body.length + close.length
    const literal = quote === "'" || quote === '"'
    out += cmd.slice(at, offset)
    if (!literal && (body.includes('$(') || body.includes('`'))) out += cmd.slice(offset, end)
    // A quoted body the shell will not expand is still executed when an
    // interpreter/remote-executor owns the redirect -- keep it visible then.
    else if (heredocOwnerRunsBody(cmd, offset)) out += cmd.slice(offset, end)
    else out += `${open}\n${close}`
    at = end
  }
  return out + cmd.slice(at)
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

// Pure decision: does this tool call set up self-pace / self-injection?
export function gateDecision(toolName, toolInput, opts = {}, depth = 0) {
  const name = String(toolName ?? '')
  if (SELF_PACE_TOOLS.has(name)) return { deny: true }
  // Native file tools writing the self-schedule store would bypass any Bash regex.
  if (name === 'Write' || name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit') {
    const fp = String(toolInput?.file_path ?? toolInput?.notebook_path ?? '')
    if (SCHEDULE_STORE_RX.test(fp)) return { deny: true }
    // ...and a timer unit written straight into a systemd unit directory
    if (isTimerUnitPath(fp)) return { deny: true }
    if (fileToolTargetsAllowlist(toolInput, opts.allowlistPath, opts.cwd)) return { deny: true, reason: 'egress-allowlist' }
  }
  if (name === 'Bash') {
    // Strip -d/--data payloads on the WHOLE command BEFORE splitting. A payload is
    // data, not an invocation; and since splitSegments is NOT quote-aware, a shell
    // separator (; && | &) INSIDE a dispatch body would otherwise orphan a fragment
    // that false-matches. Stripping first blanks the body (incl. any separators in
    // it), so the URL/method args still match but the body text never does. A
    // separator OUTSIDE the payload still splits, so `curl -d '' x ; crontab -r`
    // is still caught.
    // The one allowed systemd-run form (HEAVY_SCOPE_RX) is unwrapped FIRST, so
    // every check below judges the command it runs. First, because the heredoc
    // stripper decides by the command that owns a heredoc whether its body runs:
    // behind the prefix that owner is the command the scope runs, and in
    // `systemd-run <the form> bash <<'EOF'` the body goes to bash. Unwrapped after
    // it, the owner would read as systemd-run and the body would be blanked.
    const unwrapped = unwrapHeavyScope(String(toolInput?.command ?? ''))
    const safeCommand = stripProseArguments(stripDataPayloads(stripGitCommitMessages(stripHeredocBodies(unwrapped))))
    // A script handed to a shell as text (shellCScripts) is judged as a command of its own.
    if (depth < 3) {
      for (const script of shellCScripts(safeCommand)) {
        if (gateDecision('Bash', { command: script }, opts, depth + 1).deny) return { deny: true }
      }
    }
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
      if (selfPaceShape(normalizeShellEvasion(seg))) return { deny: true }
      // self-schedule store: block WRITE only (a read/grep is legit diagnostics)
      if (SCHEDULE_STORE_RX.test(seg) && WRITE_INTENT_RX.test(seg)) return { deny: true }
      // dashboard schedule API: block WRITE methods only (GET list/pending is legit)
      if (SCHEDULE_API_RX.test(seg) && HTTP_WRITE_RX.test(seg)) return { deny: true }
      // the egress allowlist: a plain read only (EGRESSSELFEDIT824)
      if (!allowlistBashSegmentAllowed(seg)) return { deny: true, reason: 'egress-allowlist' }
    }
    // The scheduler check is the ANCHORED one -- it fires on what sits at a
    // segment START -- so it is the one a fake segment boundary can mislead, and
    // the only one that gets quote-aware segments. Null (unresolvable quoting)
    // falls back to the naive split, i.e. to scanning strictly more.
    const masked = maskInertLiterals(safeCommand)
    for (const seg of (masked == null ? naiveSegs : splitSegments(masked))) {
      // scheduler binaries: deny the exec/submit forms, allow pure read-listing
      if (schedulesInSegment(seg)) return { deny: true }
    }
    // a systemd timer, armed with systemctl or written into a unit directory. The
    // timer check masks the heredoc bodies itself, and reads one only where the
    // command runs the file the body was written to (an installer written and run
    // in one command), so it gets the command before stripHeredocBodies: a body
    // that stripper blanks is exactly the one the installer rule has to read.
    const timerCommand = stripProseArguments(stripDataPayloads(stripGitCommitMessages(unwrapped)))
    if (armsSystemdTimer(timerCommand, splitSegments(timerCommand))) return { deny: true }
  }
  return { deny: false }
}

const GATE_MSG =
  'Self-pace TILTOTT (governance hard-gate). Sub-agentkent NEM utemezhetsz sajat ' +
  'jovobeli turn-t: se ScheduleWakeup/Cron*/RemoteTrigger, se tmux send-keys, se ' +
  'scheduled_tasks.json iras, se /api/schedules POST, se /loop self-pace, se OS-utemezo ' +
  '(crontab, at, systemd-run, systemd timer: systemctl enable/start ... .timer, vagy .timer ' +
  'unit-fajl irasa a systemd unit-konyvtarba). Input-vezerelt ' +
  'vagy: csak az operator (channel) vagy egy peer (inter-agent) uzenete inditson. Ha varakozol, ' +
  'maradj idle a prompt-on -- a beerkezo uzenet majd ujrainditja a turn-t. SOHA ne valaszolj ' +
  'magadnak es SOHA ne dontsd el az operator helyett egy hozza intezett kerdest.'

const ALLOWLIST_GATE_MSG =
  'Egress-engedelylista TILTOTT (governance hard-gate). Sub-agentkent NEM irhatod a ' +
  'store/egress-allowlist.json-t: ez a kapu RAD vonatkozik. Ha egy domain kell, kerd a fo ' +
  'agenst (inter-agent uzenet: domain + miert); o a gazda jovahagyasaval veszi fel. ' +
  'Olvasni szabad: cat / grep / jq a fajlra (ertelmezo -- python, node -- nem).'

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
  const { deny: shouldDeny, reason } = gateDecision(payload?.tool_name, payload?.tool_input, { cwd: payload?.cwd })
  if (shouldDeny) deny(reason === 'egress-allowlist' ? ALLOWLIST_GATE_MSG : GATE_MSG)
  allow()
}
