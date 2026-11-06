#!/usr/bin/env node
// PreToolUse gate for the SUB-AGENTS: mxd's run dir is off limits (MXDAGENTSOCKID1106).
//
// mxd (the local Matrix daemon behind the Gromzo channel) keeps its sockets and the per-agent token files in one
// run dir: /run/marveen-mxd on Linux, /Library/Application Support/Marveen/mxd-run on macOS. Every agent runs as
// the same OS user, so the OS lets every agent READ a token file there, and connect to agent.sock and dash.sock
// (writes and deletes are refused by the OS). A sub-agent has no legitimate reason to name that dir in a tool call:
// its own Gromzo plugin reaches agent.sock from its own process, and the owner's diagnosis goes through doctor,
// which calls mxdctl from a script. So this gate denies, for a sub-agent:
//   1. a path under a run dir, in a Bash word, an assignment or option value, a relative word after a `cd`, a glob
//      or brace pattern that could match one, a symlink or `..` that resolves into one, any case (APFS);
//   2. a run-dir spelling as a SUBSTRING of any word or text: a `python3 -c '...connect("<run dir>/agent.sock")'`
//      is one word after quote removal, and a heredoc body or `node -e` code is the same (Dani 71573 (a));
//   3. a recursive reader (grep -r, rg, find, tar, cp -r, ...) or the Grep tool rooted at an ANCESTOR of a run dir:
//      `grep -r . <parent>` reads the token files without naming them;
//   4. setting MXD_AGENT or MXD_AGENT_TOKEN_FILE, in any form (X=, export, env, declare/typeset -x, env -S,
//      printf -v, read, a nameref, a ${X:=} default, an environ[...] = in interpreter code);
//   5. starting a gromzo-channel entry point (dist/server.js, server.ts, e2e-probe.ts/js) with a JS runtime or an
//      interpreter, after a `cd` too;
//   6. the native file tools (Read, Write, Edit, MultiEdit, NotebookEdit, Grep, Glob) and every MCP tool on such a
//      path (every string leaf of an MCP call is read, with no key list).
//
// A TEXT BRAKE, NOT AN OS BOUNDARY. What it cannot see: a path built at run time, an encoded one, and a script
// file written earlier and run by name. The main agent is out of scope on purpose (Samu 71433, Dani 71573 (2)):
// it is the owner's session, and its plugin connects in-process.
//
// Reuse, no new tokeniser (Dani 71436): the shell texts come from bash-egress-parser.mjs (liftSubstitutions,
// shellWords, functionDefs, commandIndex), the path keys from self-pace-gate.mjs (pathKey: realpath + symlink +
// `..` on a missing tail too, in every case fold; normalizePathSegments; globMatchesName; expandBraces;
// splitSegments). Nothing in those files changes.

import { readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { commandIndex, functionDefs, liftSubstitutions, shellWords } from './bash-egress-parser.mjs'
import {
  expandBraces, globMatchesName, nameForms, normalizePathSegments, pathKey, shellSegments, splitSegments, underKey,
} from '../self-pace-gate.mjs'

// Both platforms on every host: a Linux path named on a Mac (or the reverse) is still nothing a sub-agent needs.
export const RUN_DIRS = Object.freeze([
  '/run/marveen-mxd',
  '/var/run/marveen-mxd',
  '/Library/Application Support/Marveen/mxd-run',
])

export const MXD_ENV_NAMES = Object.freeze(['MXD_AGENT', 'MXD_AGENT_TOKEN_FILE'])

// Caps: a command is read at most this deep and this wide; past them the narrowed raw rule decides (budgetRule).
const MAX_DEPTH = 8
const MAX_TEXTS = 400
const MAX_PATH_CHECKS = 20000
const MAX_BRACE_WORDS = 256
const MAX_LEAVES = 20000

class BudgetExceeded extends Error {}

// The run dirs as compared: every nameForms() of the literal AND of its real path (realDeep follows a symlinked
// parent, so on macOS /var/run/... reads as /private/var/run/...). Computed per call so a test may pass its own.
function runDirTable(runDirs) {
  const keys = []
  const spellings = new Set()
  for (const d of runDirs) {
    const lexical = nameForms(d)
    const real = pathKey(d)
    keys.push(lexical, real)
    for (const f of [...lexical, ...real]) spellings.add(f.toLowerCase())
  }
  return { keys, spellings: [...spellings], segs: [...spellings].map((s) => normalizePathSegments(s)) }
}

// Is a path key under (or equal to) a run dir? `underKey` compares form by form.
function keyUnderRun(key, table) {
  return table.keys.some((rk) => underKey(key, rk))
}
// Is a path key an ANCESTOR of (or equal to) a run dir? The root `/` is everyone's ancestor.
function keyAncestorOfRun(key, table) {
  return table.keys.some((rk) => rk.some((f, i) => {
    const a = key[i]
    if (!a) return false
    const dir = a.endsWith('/') ? a : a + '/'
    return f === a || f.startsWith(dir)
  }))
}

// ---------------------------------------------------------------- raw text rules (substring, env, entry point)

// The readings of a text the substring rule looks at: as written, with quotes and backslashes removed (so
// `"/run/marv"'een-mxd'` and `\/run\/marveen-mxd` read whole), and with `//` and `/./` squeezed. Each in every
// nameForms() fold, lower-cased.
function rawReadings(text) {
  const s = String(text ?? '')
  const unquoted = s.replace(/\$(?=['"])/g, '').replace(/['"\\]/g, '')
  const out = new Set()
  for (const v of [s, unquoted]) {
    for (const f of nameForms(v)) {
      const low = f.toLowerCase()
      out.add(low)
      out.add(low.replace(/\/(?:\.?\/)+/g, '/'))
    }
  }
  return [...out]
}
function namesRunDir(text, table) {
  return rawReadings(text).some((r) => table.spellings.some((sp) => r.includes(sp)))
}

// Setting an MXD env name inside a word or a code text: NAME= / NAME+= (not ==), "NAME"] = (python environ),
// 'NAME': (a dict or env object literal), ${NAME:=x} / ${NAME=x}, putenv/setenv/setdefault("NAME". A reference
// ($NAME, "$NAME" = x in a test) is not a set. ${NAME:-x}, ${NAME:+x}, ${NAME:?x} only read.
const ENV_SET_RX = /(?<![\w$])MXD_AGENT(?:_TOKEN_FILE)?['"\]]*\s*(?:\+?=(?!=)|:(?![-+?:/]))|(?:putenv|setenv|setdefault)\s*\(\s*['"]?MXD_AGENT(?:_TOKEN_FILE)?\b/
function setsMxdEnv(text) {
  const s = String(text ?? '')
  return ENV_SET_RX.test(s) || ENV_SET_RX.test(s.replace(/['"\\]/g, ''))
}

// A gromzo-channel entry point: a path with a `gromzo-channel` segment that ends in dist/server.js, server.ts/js
// or e2e-probe.ts/js (any version dir between, as in the plugin cache).
const ENTRY_RX = /(?:^|[\/\s'"`(\[,=])gromzo-channel\/(?:[^\/\s'"`]+\/)*?(?:dist\/server\.[cm]?js|server\.[cm]?[jt]s|e2e-probe\.[cm]?[jt]s)(?![\w.-])/i
function namesEntryPoint(text) {
  return nameForms(String(text ?? '')).some((f) => ENTRY_RX.test(f))
}

// Who may start an entry point. A JS runner takes it as a plain argument (`node dist/server.js`, `npx tsx
// e2e-probe.ts`, `xargs node`): any word naming one denies, relative words resolved through the cd chain (Dani
// 71573 (d)). An interpreter's code only when it also spawns a process: a python edit script that merely names
// plugin/gromzo-channel/server.ts as the file it patches is data (measured: the fleet's common edit pattern).
const JS_RUNNERS = new Set(['node', 'nodejs', 'bun', 'bunx', 'deno', 'tsx', 'ts-node', 'ts-node-esm', 'npx', 'pnpx',
  'pnpm', 'yarn', 'npm', 'corepack', 'xargs', 'watch', 'parallel'])
const INTERPRETERS = new Set(['python', 'python3', 'perl', 'ruby', 'php', 'osascript'])
const isJsRunner = (cmd) => JS_RUNNERS.has(cmd)
const isLauncher = (cmd) => JS_RUNNERS.has(cmd) || INTERPRETERS.has(cmd) || /^python3?(?:\.\d+)?$/.test(cmd)
// The process-spawn APIs only (not a bare `exec`, `spawn` or a backtick: an edit script carries the TS source it
// patches, and that source is full of them -- measured).
const SPAWN_RX = /\bsubprocess\b|\bos\.(?:system|popen|exec\w*|spawn\w*|posix_spawn\w*)\s*\(|\bpty\.spawn\b|\bchild_process\b|\bOpen3\b|\bIPC::Open\d\b|\bBun\.spawn\b|\bDeno\.(?:run|Command)\b/
function codeStartsEntry(code, jsRunner) {
  return namesEntryPoint(code) && (jsRunner || SPAWN_RX.test(String(code)))
}
// Code that sets an MXD env name: an environ / process.env / ENV / %ENV write, putenv / setenv, or (with a process
// spawn in the same code) the name as a key or an assignment (`env={..., "MXD_AGENT": "x"}`, `"MXD_AGENT=x node"`).
const ENV_WRITE_RX = /(?:environ|process\.env|\bENV|\$ENV)\s*(?:\[\s*['"]?|\{\s*['"]?|\.)MXD_AGENT(?:_TOKEN_FILE)?['"]?\s*[\]}]?\s*(?:\|\|)?=(?!=)|(?:putenv|setenv|setdefault|update)\s*\(\s*['"]?MXD_AGENT(?:_TOKEN_FILE)?\b/
function codeSetsMxdEnv(code) {
  const s = String(code ?? '')
  return ENV_WRITE_RX.test(s) || (SPAWN_RX.test(s) && setsMxdEnv(s))
}

// Readers that walk a tree: rooted at a run dir's ancestor they read the token files without naming them.
// `find` / `fd` alone list NAMES (no content, and a name is no secret): only with an action that reads or removes
// (-exec, -ok, -delete; fd -x / -X) do they count. Measured: `find / -name x` is a common fleet lookup (~40 a week).
// `feeds`: the same text hands a list to a reader (`| xargs cat`, `| parallel`, `| while read f; do cat "$f"`): then a
// find / fd that only lists names is the first half of a read (Dani 71760 (4)).
function recursiveReader(cmd, words, feeds = false) {
  if (feeds && ['find', 'gfind', 'fd', 'fdfind'].includes(cmd)) return true
  if (['rg', 'ag', 'ack', 'ugrep', 'ug', 'rsync', 'ditto', 'tar', 'gtar', 'bsdtar', '7z', '7za'].includes(cmd)) return true
  if (['find', 'gfind'].includes(cmd)) return words.some((w) => /^-(?:exec|execdir|ok|okdir|delete|fprint|fprintf|fls)$/.test(w))
  if (cmd === 'fd' || cmd === 'fdfind') return words.some((w) => /^(?:-[xX]|--exec|--exec-batch)$/.test(w))
  const opts = words.filter((w) => w.startsWith('-'))
  if (['grep', 'egrep', 'fgrep', 'zgrep', 'ggrep'].includes(cmd)) {
    return opts.some((w) => /^-[A-Za-z]*[rR]/.test(w) && !w.startsWith('--')) || opts.some((w) =>
      /^--(?:recursive|dereference-recursive|directories=recurse)$/.test(w)) || words.some((w, i) => w === '-d' && words[i + 1] === 'recurse')
  }
  if (['cp', 'gcp', 'scp', 'zip'].includes(cmd)) {
    return opts.some((w) => (/^-[A-Za-z]*[rRa]/.test(w) && !w.startsWith('--')) || /^--(?:recursive|archive|recurse-paths)$/.test(w))
  }
  return false
}

const CWD_WALKERS = new Set(['rg', 'ag', 'ack', 'ugrep', 'ug', 'grep', 'egrep', 'fgrep', 'zgrep', 'ggrep', 'find', 'gfind'])
const NON_TREE_OPTS = new Set(['-C', '--directory', '-f', '--file', '-T', '--files-from', '-X', '--exclude-from'])

// ---------------------------------------------------------------- path rules

const GLOB_RX = /[*?[]/
const RUN_DIR_NAME_RX = /marveen-mxd|mxd-run/
// The candidates a word names as a path: absolute (or ~/, $HOME/) as is, relative against every cwd the command
// has been in. A path word, an assignment value (D=/x) and an option value (--file=/x) are each read.
function wordValues(w, ctx) {
  const vals = [w]
  const assign = /^[A-Za-z_]\w*\+?=(.*)$/s.exec(w)
  if (assign) vals.push(assign[1])
  const opt = /^--?[A-Za-z][\w-]*=(.*)$/s.exec(w)
  if (opt) vals.push(opt[1])
  return [...new Set(vals.flatMap((v) => expandVars(v, ctx)))]
    .map((v) => (v === '~' ? homedir() : v.startsWith('~/') ? join(homedir(), v.slice(2)) : v))
    // ~+ is $PWD, ~- is $OLDPWD, ~N / ~+N / ~-N a dirs-stack entry: each is one of the cwds the command has been in,
    // so the rest is read relative to every one of them (Dani 71760 (2))
    .map((v) => { const m = /^~[+-]\d*(?=\/|$)|^~\d+(?=\/|$)/.exec(v); return m ? '.' + v.slice(m[0].length) : v })
    .map((v) => (v.startsWith('file://') ? v.slice('file://'.length) : v))
}

// A word's variables, as far as the command itself fixes them (Dani 71760 (1)): $HOME, and every NAME the command
// assigns a literal value (ctx.assigns: `D=/x; cat $D/y`, `export P=...`, a prefix assignment); a NAME assigned more
// than once yields one variant per value, capped. A variable left over that does not START the word is unknown at
// run time and reads as `*`, so the pattern rule still sees a run-dir name around it; a leading unknown one leaves
// the word as it is (a run-time path: the documented limit).
const VAR_RX = /\$\{([A-Za-z_]\w*)[^}]*\}|\$([A-Za-z_]\w*)/g
const MAX_VAR_VARIANTS = 16
const varNames = (x) => [...x.matchAll(VAR_RX)].map((m) => m[1] ?? m[2])
// `${NAME:-word}`, `${NAME-word}`, `${NAME:=word}`, `${NAME=word}`, `${NAME:+word}`, `${NAME+word}`: the word is one
// reading, the variable itself the other (Dani 71789 (1)).
const DEFAULT_RX = /\$\{([A-Za-z_]\w*)(:?[-=+])([^}]*)\}/
// `${NAME[i]}`, `${NAME[@]}`, `${NAME[*]}` of a literal array (Dani 71789 (2)); `$NAME` / `${NAME}` of an array is its
// element 0, as in bash.
const ARRAY_REF_RX = /\$\{([A-Za-z_]\w*)\[([^\]]*)\]\}/
function expandVars(v, ctx) {
  let out = [String(v).replace(/\$\{HOME\}|\$HOME(?![\w])/g, homedir())]
  const assigns = ctx?.assigns ?? new Map()
  const arrays = ctx?.arrays ?? new Map()
  for (let round = 0; round < 6; round++) {
    let changed = false
    const next = []
    for (const x of out) {
      const d = DEFAULT_RX.exec(x)
      if (d) {
        changed = true
        next.push(x.replace(d[0], () => d[3]), x.replace(d[0], () => `\${${d[1]}}`))
        continue
      }
      const a = ARRAY_REF_RX.exec(x)
      if (a && arrays.has(a[1])) {
        changed = true
        for (const els of arrays.get(a[1])) {
          // @ / * joined both ways: a space (the default IFS) and nothing (an empty IFS)
          const picks = a[2] === '@' || a[2] === '*' ? [els.join(' '), els.join('')] : /^\d+$/.test(a[2]) ? [els[Number(a[2])] ?? ''] : els
          for (const el of picks) next.push(x.replace(a[0], () => el))
        }
        continue
      }
      const names = [...new Set(varNames(x).filter((n) => assigns.has(n) || arrays.has(n)))]
      if (!names.length) { next.push(x); continue }
      changed = true
      let variants = [x]
      for (const n of names) {
        const rx = new RegExp(`\\$\\{${n}\\}|\\$${n}(?![\\w])`, 'g')
        const vals = [...(assigns.get(n) ?? []), ...(arrays.get(n) ?? []).map((els) => els[0] ?? '')]
        variants = variants.flatMap((y) => vals.map((val) => y.replace(rx, () => val))).slice(0, MAX_VAR_VARIANTS)
      }
      next.push(...variants)
    }
    out = [...new Set(next)].slice(0, MAX_VAR_VARIANTS)
    if (!changed) break
  }
  const unknown = out.filter((x) => x.includes('$')).map((x) => x.replace(VAR_RX, (m, a, b, at) => (at === 0 ? m : '*')))
  return [...new Set([...out, ...unknown])]
}

// The literal assignments of a text's segments, into ctx.assigns (and CDPATH into ctx.cdpaths): standalone and prefix
// assignments, and export / declare / typeset / local / readonly NAME=value. A value is itself expanded with what is
// known so far (`A=/run; B=$A/x`); a value that stays unknown is not recorded.
function collectAssigns(segments, ctx) {
  for (const seg of segments) {
    const words = segmentWords(seg)
    const ci = commandIndex(words)
    const cmd = basename(words[ci] ?? '')
    const decl = ['export', 'declare', 'typeset', 'local', 'readonly'].includes(cmd) ? words.slice(ci + 1) : []
    const pre = [...words.slice(0, ci), ...decl]
    // bash takes `NAME+=x` / `NAME+=(...)` as an assignment; commandIndex reads it as the command word
    for (let j = ci; j < words.length && /^[A-Za-z_]\w*\+=/.test(words[j]); j++) {
      pre.push(words[j])
      if (/^[A-Za-z_]\w*\+=\(/.test(words[j]) && !words[j].endsWith(')')) while (j + 1 < words.length && !words[j].endsWith(')')) pre.push(words[++j])
    }
    for (let k = 0; k < pre.length; k++) {
      const w = pre[k]
      // a literal array: `a=(x y)` reaches here as the words `a=(x` and `y)` (commandIndex skips them as one assignment)
      const arr = /^([A-Za-z_]\w*)(\+?)=\((.*)$/s.exec(w)
      if (arr) {
        const parts = [arr[3]]
        while (!parts[parts.length - 1].endsWith(')') && k + 1 < pre.length) parts.push(pre[++k])
        parts[parts.length - 1] = parts[parts.length - 1].replace(/\)$/, '')
        const els = parts.filter((x) => x !== '').map((x) => expandVars(x, ctx).find((y) => !y.includes('$')) ?? x)
        const prev = ctx.arrays.get(arr[1]) ?? []
        const add = arr[2] && prev.length ? prev.map((q) => [...q, ...els]) : [els]
        ctx.arrays.set(arr[1], [...prev, ...add].slice(0, MAX_VAR_VARIANTS))
        continue
      }
      const m = /^([A-Za-z_]\w*)(\+?)=(.*)$/s.exec(w)
      if (!m) continue
      const vals = expandVars(m[3], ctx).filter((x) => !x.includes('$'))
      if (!vals.length) continue
      const prev = ctx.assigns.get(m[1]) ?? []
      const add = m[2] ? (prev.length ? prev.flatMap((q) => vals.map((x) => q + x)) : vals) : vals
      ctx.assigns.set(m[1], [...new Set([...prev, ...add])].slice(0, MAX_VAR_VARIANTS))
      if (m[1] === 'CDPATH') for (const x of add) for (const d of x.split(':')) if (d) ctx.cdpaths.add(d)
    }
  }
}
function candidates(v, cwds) {
  if (v === '') return []
  if (isAbsolute(v)) return [v]
  return [...cwds].map((c) => join(c, v))
}

// A literal path: under a run dir lexically (`..`, `//` resolved) or by its real path (symlinks, case on APFS).
// 'under' | 'ancestor' | null.
function literalPathVerdict(p, table, ctx) {
  if (++ctx.budget.n > MAX_PATH_CHECKS) throw new BudgetExceeded('path checks')
  const lexical = nameForms(resolve(p))
  const real = pathKey(p)
  if (keyUnderRun(lexical, table) || keyUnderRun(real, table)) return 'under'
  if (keyAncestorOfRun(lexical, table) || keyAncestorOfRun(real, table)) return 'ancestor'
  return null
}

// A glob / brace pattern: could it match a run dir or something under it? Brace groups are expanded (past the cap,
// budgetRule decides). Each expansion is compared segment by segment with every
// run-dir spelling: a `**` segment matches any depth. The glob-free leading part is also read through its real
// path, so a symlinked parent does not hide the target.
// `raw`: the word as written (not joined to a cwd), for the over-the-cap rule.
function patternVerdict(v, table, ctx, raw = v) {
  const words = /[{]/.test(v) ? expandBraces(v, MAX_BRACE_WORDS) : [v]
  // past the cap (a TS import list in a sed script expands to hundreds, measured): a run-dir NAME in the word decides
  if (!words) return rawReadings(raw).some((r) => RUN_DIR_NAME_RX.test(r)) ? 'under' : null
  let verdict = null
  for (const w of words) {
    if (!GLOB_RX.test(w)) {
      const r = literalPathVerdict(w, table, ctx)
      if (r === 'under') return r
      verdict ??= r
      continue
    }
    const segs = normalizePathSegments(w)
    const first = segs.findIndex((s) => GLOB_RX.test(s))
    const forms = [segs]
    if (first > 0) {
      if (++ctx.budget.n > MAX_PATH_CHECKS) throw new BudgetExceeded('path checks')
      const prefix = segs.slice(0, first).join('/') || '/'
      for (const f of pathKey(prefix)) forms.push([...normalizePathSegments(f), ...segs.slice(first)])
    }
    for (const g of forms) {
      for (const rs of table.segs) {
        const r = globAgainst(g, rs)
        if (r === 'under') return r
        verdict ??= r
      }
    }
  }
  return verdict
}
// A `**` segment matches any depth only BEFORE another segment (zsh's `**/`, bash globstar, the Glob tool); as the
// last segment it is one level, like `*`. So `/**/agent.sock` is under a run dir, and a bare `/**` (a JS doc
// comment in a python edit script, measured: the bulk of the first false positives) is only an ancestor.
function globAgainst(g, rs) {
  for (let i = 0; i < rs.length; i++) {
    if (i >= g.length) return 'ancestor'
    if (g[i].includes('**') && i < g.length - 1) return 'under'
    if (!globMatchesName(g[i], rs[i])) return null
  }
  return 'under'
}

function pathVerdict(w, table, ctx) {
  let verdict = null
  for (const v of wordValues(w, ctx)) {
    if (v !== w && namesRunDir(v, table)) return 'under'
    for (const c of candidates(v, ctx.cwds)) {
      const r = GLOB_RX.test(c) || /[{]/.test(c) ? patternVerdict(c, table, ctx, v) : literalPathVerdict(c, table, ctx)
      if (r === 'under') return r
      verdict ??= r
    }
  }
  return verdict
}

// ---------------------------------------------------------------- Bash

const SEGMENT_LEAD_RX = /^(?:[({!]\s*|(?:if|then|else|elif|do|while|until|time)\s+)+/
const segmentWords = (seg) => shellWords(String(seg).replace(SEGMENT_LEAD_RX, ''))
function segCommand(seg) {
  const words = segmentWords(seg)
  return basename(words[commandIndex(words)] ?? '').toLowerCase()
}

// The cwds a text visits: every `cd`/`pushd` target and `-C` dir, in order, a relative one resolved against every cwd seen so
// far. A target with an expansion is unknown and adds nothing (a path word in it is judged on its own). The set is
// cumulative: a word is resolved against EVERY cwd the command has been in, so a cd behind `||` or inside quotes
// can only make the check stricter.
const CHDIR_OPTS = new Set(['-C', '--directory', '--chdir'])
function collectCwds(segments, ctx) {
  for (const seg of segments) {
    const words = segmentWords(seg)
    const ci = commandIndex(words)
    const cmd = basename(words[ci] ?? '')
    if (cmd !== 'cd' && cmd !== 'pushd') continue
    const arg = words.slice(ci + 1).find((w) => !/^-[LPe@]+$/.test(w) && w !== '--')
    if (arg === undefined) { ctx.cwds.add(homedir()); continue }
    if (arg === '-' || arg.includes('`')) continue
    addCwd(arg, ctx, true)
  }
}
// `-C DIR` / `--directory DIR` / `--chdir DIR` (tar, git, make, env): THIS command's relative words land there, and
// only its own (a remote `ssh h 'tar -C / ...'` moves no later local command).
function segmentChdirs(words, ctx) {
  const local = { ...ctx, cwds: new Set(ctx.cwds) }
  for (const [k, w] of words.entries()) {
    const m = /^--(?:directory|chdir)=(.+)$/s.exec(w)
    const dir = m ? m[1] : CHDIR_OPTS.has(w) ? words[k + 1] : undefined
    if (dir === undefined || dir.includes('`')) continue
    addCwd(dir, local, false)
  }
  return local.cwds.size === ctx.cwds.size ? ctx : local
}
// A dir the command moves into: every fully known expansion of it; a relative one against every cwd so far and, for
// `cd` / `pushd`, against every CDPATH entry too (Dani 71760 (3)). An inherited CDPATH counts as well.
function addCwd(word, ctx, viaCd) {
  for (const v of wordValues(word, ctx)) {
    if (/[$*?[]/.test(v)) continue
    if (isAbsolute(v)) { ctx.cwds.add(resolve(v)); continue }
    const viaCdpath = viaCd && !/^\.\.?(?:\/|$)/.test(v)
    const bases = [...ctx.cwds, ...(viaCdpath ? [...ctx.cdpaths].filter((d) => isAbsolute(d)) : [])]
    for (const c of bases) ctx.cwds.add(resolve(c, v))
  }
}

// Setting an MXD env name in a segment's EXECUTED positions (never in prose: a commit message, a PR body or a heredoc
// that only writes a file may mention the name as it likes):
//   - a prefix assignment, and everything before the command word (env NAME=x, env -S 'NAME=x node ...');
//   - export / declare / typeset / local / readonly with NAME=x or a bare NAME (export -n does not set: allowed);
//     a nameref to one (declare -n r=MXD_AGENT);
//   - printf -v NAME, read NAME (and mapfile, readarray, getopts): no export of their own, but the launcher exports
//     these names into the agent's environment, and an assignment to an exported variable reaches every child.
function envFormDeny(cmd, words, ci) {
  const named = (w) => MXD_ENV_NAMES.includes(w)
  const sets = (w) => /^(?:MXD_AGENT|MXD_AGENT_TOKEN_FILE)\+?=/.test(w)
  // the command word too: bash takes `NAME+=x cmd` as an assignment, commandIndex does not
  if (words.slice(0, ci + 1).some(setsMxdEnv)) return true
  const args = words.slice(ci + 1)
  if (cmd === 'export') return !args.some((w) => /^-[A-Za-z]*n/.test(w)) && args.some((w) => named(w) || sets(w))
  if (['declare', 'typeset', 'local', 'readonly'].includes(cmd)) {
    return args.some((w) => named(w) || sets(w) || named(/^[A-Za-z_]\w*=(.*)$/s.exec(w)?.[1] ?? ''))
  }
  if (cmd === 'printf') return args.some((w, i) => (w === '-v' && named(args[i + 1] ?? '')) || (w.startsWith('-v') && named(w.slice(2))))
  if (['read', 'mapfile', 'readarray', 'getopts'].includes(cmd)) return args.some(named)
  return false
}

// Commands whose quoted multi-word argument is a SHELL text of its own (-c bodies, ssh 'cmd', watch '...',
// xargs sh -c, eval, trap). The prefix commands (env, sudo, nohup, timeout, ...) are skipped by commandIndex, so
// the first word is read too. Interpreter code (python -c, node -e) is not shell: it gets the env and entry-point
// checks, and the substring rule, which reads every text.
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'mksh', 'fish', 'busybox'])
const SHELL_TEXT_CMDS = new Set([...SHELLS, 'eval', 'su', 'xargs', 'watch', 'parallel', 'trap', 'ssh', 'script',
  'tmux', 'screen', 'sudo', 'env', 'nohup', 'setsid', 'timeout', 'exec', 'command', 'builtin', 'stdbuf', 'nice', 'time'])

// The command(s) a heredoc body is fed to: the segments of the operator's line that carry a `<<`.
function heredocConsumers(stripped, bodyStart) {
  const lineStart = stripped.lastIndexOf('\n', bodyStart - 2) + 1
  const line = stripped.slice(lineStart, Math.max(lineStart, bodyStart - 1))
  return splitSegments(line).filter((seg) => seg.includes('<<')).map(segCommand)
}
const blank = (s, from, to) => s.slice(0, from) + s.slice(from, to).replace(/[^\n]/g, ' ') + s.slice(to)

// The command a segment effectively runs: through xargs / watch / parallel, the program they start.
function effectiveCommand(cmd, args) {
  if (!['xargs', 'watch', 'parallel'].includes(cmd)) return cmd
  return basename(args.find((w) => !w.startsWith('-')) ?? '').toLowerCase()
}

// -> { deny, reason } for one Bash command. `ctx.cwds` starts with the hook's cwd (when known).
// Two passes. The first reads every text the command carries (the command, $(...) and backtick bodies, shell
// heredocs, function bodies, shell-text arguments) and every cwd it visits; the second judges every word against
// ALL of those cwds, so a `cd` inside a function body or a later text counts for every word (only stricter).
function bashVerdict(command, table, ctx) {
  const queue = [{ text: String(command ?? ''), depth: 0 }]
  const seen = new Set()
  const read = []
  while (queue.length) {
    const { text, depth } = queue.shift()
    if (seen.has(text)) continue
    seen.add(text)
    if (seen.size > MAX_TEXTS || depth > MAX_DEPTH) throw new BudgetExceeded('texts')
    // (a) the substring rule reads EVERY text, data included (Dani 71573: an accepted price)
    if (namesRunDir(text, table)) return { deny: true, reason: 'run-dir' }
    const lift = liftSubstitutions(text)
    for (const inner of lift.inners) queue.push({ text: inner, depth: depth + 1 })
    for (const d of functionDefs(lift.stripped)) queue.push({ text: lift.stripped.slice(d.bodyStart, d.bodyEnd), depth: depth + 1 })
    // The segments: quote-aware where the quoting resolves (self-pace's shellSegments, which also hands each heredoc
    // body to the segment that owns it), else the naive split with the bodies blanked. A heredoc body is a shell
    // text when a shell reads it, code when an interpreter does, data otherwise; its lines are never commands of
    // THIS text.
    const segments = []
    const bodies = []
    const quoted = shellSegments(lift.stripped)
    if (quoted) {
      for (const seg of quoted) {
        segments.push(seg.own)
        for (const body of seg.bodies) bodies.push({ body, consumers: [segCommand(seg.own)] })
      }
    } else {
      let segText = lift.stripped
      for (const [from, to] of lift.bodies) {
        bodies.push({ body: text.slice(from, to), consumers: heredocConsumers(lift.stripped, from) })
        segText = blank(segText, from, to)
      }
      segments.push(...splitSegments(segText).filter(Boolean))
    }
    for (const { body, consumers } of bodies) {
      if (consumers.some((c) => SHELLS.has(c))) queue.push({ text: body, depth: depth + 1 })
      if (consumers.some(isLauncher)) {
        if (codeSetsMxdEnv(body)) return { deny: true, reason: 'env' }
        if (codeStartsEntry(body, consumers.some(isJsRunner))) return { deny: true, reason: 'entry' }
      }
    }
    collectAssigns(segments, ctx)
    collectCwds(segments, ctx)
    const parsed = segments.map((seg) => {
      const words = segmentWords(seg)
      const ci = commandIndex(words)
      const cmd = basename(words[ci] ?? '').toLowerCase()
      return { words, ci, cmd, run: effectiveCommand(cmd, words.slice(ci + 1)) }
    })
    // text piped into a bare shell (`echo '...' | sh`) is a shell text: every quoted string in this text is read as one
    const pipedShell = parsed.some((p) => SHELLS.has(p.cmd) && !p.words.slice(p.ci + 1).some((w) => !w.startsWith('-')))
    for (const { words, ci, cmd } of parsed) {
      if (!(pipedShell || SHELL_TEXT_CMDS.has(cmd) || SHELL_TEXT_CMDS.has(basename(words[0] ?? '')))) continue
      for (const w of words) if (/\s/.test(w)) queue.push({ text: w, depth: depth + 1 })
    }
    read.push(parsed)
  }
  for (const parsed of read) {
    // `... | xargs node` (or parallel) takes its script path from another segment's output: an entry path WRITTEN in
    // any segment of that text counts (as written only: a relative word there is not resolved through the cwds, or
    // `npm test` next to a `grep server.ts` in the plugin dir would read as a launch -- measured)
    const textRunner = parsed.some((p) => ['xargs', 'parallel'].includes(p.cmd) && isJsRunner(p.run))
    const feeds = parsed.some((p) => ['xargs', 'parallel', 'read'].includes(p.cmd))
    for (const { words, ci, cmd, run } of parsed) {
      if (envFormDeny(cmd, words, ci)) return { deny: true, reason: 'env' }
      const sctx = segmentChdirs(words, ctx)
      const args = words.slice(ci + 1)
      const launcher = isLauncher(run) || isLauncher(cmd)
      const jsRunner = isJsRunner(run)
      const recursive = recursiveReader(cmd, args, feeds)
      for (const [k, w] of words.entries()) {
        const v = pathVerdict(w, table, sctx)
        if (v === 'under') return { deny: true, reason: 'run-dir' }
        // the value of tar -C / -f (a dir to chdir to, the archive) is no tree it walks
        const optValue = k > ci && NON_TREE_OPTS.has(words[k - 1])
        if (v === 'ancestor' && recursive && !w.startsWith('-') && !optValue) return { deny: true, reason: 'ancestor' }
        if (launcher && codeSetsMxdEnv(w)) return { deny: true, reason: 'env' }
        if (textRunner && namesEntryPoint(w)) return { deny: true, reason: 'entry' }
        if (launcher) {
          if (codeStartsEntry(w, jsRunner)) return { deny: true, reason: 'entry' }
          if (jsRunner) {
            for (const val of wordValues(w, sctx)) {
              for (const c of candidates(val, sctx.cwds)) if (namesEntryPoint(resolve(c))) return { deny: true, reason: 'entry' }
            }
          }
        }
      }
      // a searcher with no path argument walks its cwd (tar, cp and rsync read only what they are given)
      if (recursive && CWD_WALKERS.has(cmd) && !args.some((w) => !w.startsWith('-') && /\//.test(w))
        && [...ctx.cwds].some((c) => literalPathVerdict(c, table, ctx) === 'ancestor')) return { deny: true, reason: 'ancestor' }
    }
  }
  return { deny: false }
}

// What decides when the caps are hit: the command names the run dir's or the plugin's NAME anywhere, or an MXD env
// name (the narrowed form of the parser's own "cannot read it" rule).
const BUDGET_RX = /marveen-mxd|mxd-run|gromzo-channel|MXD_AGENT/i
function budgetRule(text) {
  return rawReadings(text).some((r) => BUDGET_RX.test(r))
}

// ---------------------------------------------------------------- native and MCP tools

const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

function leaves(v, out = [], depth = 0) {
  if (out.length > MAX_LEAVES) throw new BudgetExceeded('leaves')
  if (typeof v === 'string') out.push(v)
  else if (v && typeof v === 'object' && depth < 32) for (const x of Object.values(v)) leaves(x, out, depth + 1)
  return out
}

function fileToolVerdict(toolName, input, table, ctx) {
  const str = (k) => (typeof input?.[k] === 'string' ? input[k] : null)
  if (FILE_TOOLS.has(toolName)) {
    for (const k of ['file_path', 'notebook_path', 'path']) {
      const p = str(k)
      if (p === null) continue
      if (namesRunDir(p, table) || pathVerdict(p, table, ctx) === 'under') return { deny: true, reason: 'run-dir' }
    }
    return { deny: false }
  }
  if (toolName === 'Grep') {
    // Grep walks its path (the cwd when none is given): under a run dir, or an ancestor of one, reads the tokens
    const p = str('path') ?? [...ctx.cwds][0] ?? null
    for (const s of [p, str('glob')]) if (s !== null && namesRunDir(s, table)) return { deny: true, reason: 'run-dir' }
    if (p === null) return { deny: false }
    const v = pathVerdict(p, table, ctx)
    if (v === 'under') return { deny: true, reason: 'run-dir' }
    if (v === 'ancestor') return { deny: true, reason: 'ancestor' }
    return { deny: false }
  }
  if (toolName === 'Glob') {
    const base = str('path') ?? [...ctx.cwds][0] ?? null
    const pattern = str('pattern') ?? ''
    for (const s of [base, pattern]) if (s !== null && namesRunDir(s, table)) return { deny: true, reason: 'run-dir' }
    if (base !== null && pathVerdict(base, table, ctx) === 'under') return { deny: true, reason: 'run-dir' }
    const full = isAbsolute(pattern) || pattern.startsWith('~') || base === null ? pattern : join(base, pattern)
    if (full && pathVerdict(full, table, { ...ctx, cwds: new Set(base ? [base] : []) }) === 'under') return { deny: true, reason: 'run-dir' }
    return { deny: false }
  }
  return null
}

function mcpVerdict(input, table, ctx) {
  for (const leaf of leaves(input)) {
    if (namesRunDir(leaf, table)) return { deny: true, reason: 'run-dir' }
    const t = leaf.trim()
    if (t.startsWith('/') || t.startsWith('~/') || t.startsWith('file://')) {
      if (pathVerdict(t, table, ctx) === 'under') return { deny: true, reason: 'run-dir' }
    }
  }
  return { deny: false }
}

// ---------------------------------------------------------------- the decision

// -> { deny: boolean, reason?: 'run-dir'|'ancestor'|'env'|'entry'|'cwd'|'budget' }
// opts.cwd: the hook payload's cwd. opts.runDirs: tests only.
export function gateDecision(toolName, toolInput, opts = {}) {
  const table = runDirTable(opts.runDirs ?? RUN_DIRS)
  const cwd = typeof opts.cwd === 'string' && isAbsolute(opts.cwd) ? opts.cwd : null
  const cdpaths = new Set(String(process.env.CDPATH ?? '').split(':').filter((d) => isAbsolute(d)))
  const ctx = { cwds: new Set(cwd ? [cwd] : []), budget: { n: 0 }, assigns: new Map(), arrays: new Map(), cdpaths }
  const name = String(toolName ?? '')
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {}
  try {
    if (cwd && literalPathVerdict(cwd, table, ctx) === 'under') return { deny: true, reason: 'cwd' }
    if (name === 'Bash') return bashVerdict(typeof input.command === 'string' ? input.command : '', table, ctx)
    const file = fileToolVerdict(name, input, table, ctx)
    if (file) return file
    if (/^mcp__/i.test(name)) return mcpVerdict(input, table, ctx)
    return { deny: false }
  } catch (err) {
    if (!(err instanceof BudgetExceeded)) throw err
    const text = name === 'Bash' ? String(input.command ?? '') : JSON.stringify(input)
    return budgetRule(text) ? { deny: true, reason: 'budget' } : { deny: false }
  }
}

// ---------------------------------------------------------------- hook entry

const LIMIT = ' (Szoveg-fek, nem OS-hatar: a futaskor epitett utvonalat nem latja. MXDAGENTSOCKID1106.)'
export const DENY_MSG = {
  'run-dir': 'mxd-kapu: a hivas az mxd futasi mappajat nevezi (agent.sock, dash.sock vagy egy tokens/ fajl). ' +
    'Sub-agensnek ide nincs ut: a sajat Gromzo-pluginod a sajat folyamatabol kapcsolodik, a diagnozis a doctoron ' +
    'megy. Ha egy forrasfajlban keresel, ami ezt az utvonalat tartalmazza, olvasd a GitHub API-n, vagy a literal ' +
    'nelkuli mintaval.' + LIMIT,
  ancestor: 'mxd-kapu: rekurziv olvasas (grep -r, rg, find, tar, cp -r, Grep eszkoz) az mxd futasi mappajanak egy ' +
    'szulo-mappajan: igy a token-fajlok is beolvasodnanak. Szukitsd a keresest egy konkret mappara.' + LIMIT,
  env: 'mxd-kapu: a hivas az MXD_AGENT vagy az MXD_AGENT_TOKEN_FILE erteket allitana (X=, export, env, declare -x, ' +
    'printf -v, read, environ[...] =). Ezt csak az indito allitja.' + LIMIT,
  entry: 'mxd-kapu: a hivas a gromzo-channel belepesi pontjat inditana (dist/server.js, server.ts, e2e-probe). ' +
    'A plugint a Claude Code inditja, sub-agens kezzel nem.' + LIMIT,
  cwd: 'mxd-kapu: a munkamappa az mxd futasi mappajan belul van.' + LIMIT,
  budget: 'mxd-kapu: a parancs tul hosszu vagy tul mely a vizsgalathoz, es mxd- vagy gromzo-nevet tartalmaz. ' +
    'Bontsd kisebb hivasokra.' + LIMIT,
}
const FAIL_CLOSED_MSG = (why) => `mxd-kapu: belso hiba a vizsgalat kozben (${String(why).slice(0, 200)}). ` +
  'Fail-closed: TILTVA.' + LIMIT

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }))
  process.exit(0)
}

function isInvokedDirectly() {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === (process.argv[1] ? realpathSync(process.argv[1]) : '')
  } catch {
    return false
  }
}

if (isInvokedDirectly()) {
  process.on('uncaughtException', (err) => deny(FAIL_CLOSED_MSG(err?.message ?? err)))
  let payload = null
  try {
    payload = JSON.parse(readFileSync(0, 'utf-8'))
  } catch {
    process.exit(0) // not JSON: from the harness, not the agent
  }
  try {
    const verdict = gateDecision(payload?.tool_name, payload?.tool_input, { cwd: payload?.cwd })
    if (verdict.deny) deny(DENY_MSG[verdict.reason] ?? DENY_MSG['run-dir'])
    process.exit(0)
  } catch (err) {
    deny(FAIL_CLOSED_MSG(err?.message ?? err))
  }
}
