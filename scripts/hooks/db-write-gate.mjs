#!/usr/bin/env node
// PreToolUse gate: agent writes to the dashboard's SECURITY surface
// (APPROVALDBGATE1030), for EVERY agent, the main agent included.
//
// What it denies:
//   1. An SQL write (INSERT / UPDATE / DELETE / REPLACE / DROP / ALTER / CREATE
//      TRIGGER|INDEX ... ON) on a security table of the dashboard database
//      (SECURITY_TABLES in self-pace-gate.mjs: approvals, approval_events,
//      auth_sessions, dashboard_users, device_keys, vault_ssh_keys), whatever
//      program runs it: sqlite3, python -c, node -e, a heredoc, a pipe. Also
//      PRAGMA writable_schema and any write on sqlite_master / sqlite_schema
//      (and the temp aliases): through them a table is renamed, written under
//      the new name and renamed back without its name ever being spelled.
//   2. A FILE-level write of the database (store/claudeclaw.db and its -wal,
//      -shm, -journal): a redirect onto it, cp/mv/tee/dd/rm/ln/... naming it, a
//      sqlite3 dot-command that replaces or runs files, a native Write/Edit.
//   3. A write of this gate's own wiring and of the autonomy levels, in THIS
//      INSTALL: .claude/settings.json, .claude/settings.local.json,
//      scripts/hooks/, scripts/self-pace-gate.mjs, store/extra-hooks.json,
//      store/autonomy-config.json. "This install" is the root this file sits in
//      (scripts/hooks/ -> ../..), never the cwd: the same Edit in a worktree's
//      own copy passes, and every path is compared after realpath (symlinks and
//      ".." resolved, case folded as a case-insensitive volume reads it). An
//      archive extracted or a patch applied with no target directory writes
//      into the cwd: there the cwd is the target.
//
// What still passes: SQL reads (SELECT, sqlite3 -readonly), SQL writes on any
// other table (UPDATE agent_messages in the skills, the daily_logs date fix in
// CLAUDE.md), the kanban tool, reads of the protected files (cat/grep/jq/diff,
// git diff/log/show), running a hook script, and MESSAGE TEXT that merely
// quotes such a command: the data argument of curl -d/--data*, git commit -m/-F,
// gh --body/--title, scripts/agent-msg.sh, the kanban tool's --title. Only that
// argument is dropped, never the segment: `curl -d '...'; sqlite3 ... 'UPDATE
// approvals ...'` is still denied on its second segment.
//
// THE LIMIT, stated (Samu 56076, Dani 56081): this is a TEXT-BASED BRAKE, NOT AN
// OS BOUNDARY. It reads the command text; a program that builds the statement or
// the path at run time (a script file written earlier with the Write tool, a
// string assembled from pieces in an interpreter) passes. The owner-approval
// record is trustworthy only once GROMZODONTES1030 (F1-F3) moves the decision
// to the mxd store, which no agent can forge; this gate does not make the
// approvals table that place.
//
// Engine: scheduleSurfaceDeny in scripts/self-pace-gate.mjs (segments, quoting,
// escape/glob variants, message-data residue), run with `surface: 'security'`.

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import {
  commandName,
  cwdAfterSegment,
  dataResidue,
  expandBraces,
  expandHome,
  globMatchesName,
  isReadOnlyFsCommand,
  laterRuns,
  nameForms,
  normalizePathSegments,
  pathKey,
  sameKey,
  scheduleSurfaceDeny,
  scheduleSurfaceVariants,
  shellSegments,
  shellWords,
  underKey,
} from '../self-pace-gate.mjs'

// The install this gate guards: scripts/hooks/ -> scripts/ -> root.
export const INSTALL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

// The install's own gate wiring and autonomy levels (Dani 56081 point 5, Samu 56090).
export const PROTECTED_INSTALL_PATHS = [
  { rel: '.claude/settings.json' },
  { rel: '.claude/settings.local.json' },
  { rel: 'scripts/hooks', dir: true },
  { rel: 'scripts/self-pace-gate.mjs' },
  { rel: 'store/extra-hooks.json' },
  { rel: 'store/autonomy-config.json' },
  // The main checkout's git wiring (Samu 56299 2, Dani 56284): its remote, its remote-tracking refs and its hooks. A
  // worktree shares them, so a ref or a URL changed from a worktree is changed for the install's pull as well.
  { rel: '.git/config' },
  { rel: '.git/packed-refs' },
  { rel: '.git/refs/remotes', dir: true },
  { rel: '.git/hooks', dir: true },
  // The user's git config, read by every git on the machine (Samu 56310 2): an url.*.insteadOf there redirects origin.
  { home: '.gitconfig' },
  { home: 'git/config', xdg: true },
]
// The database file, by NAME anywhere (as the Bash rule reads it).
const DB_FILE_NAME_RX = /(?:^|\/)claudeclaw\.db(?:-wal|-shm|-journal)?$/i

const targetCache = new Map()
export function installTargets(root = INSTALL_ROOT) {
  const k = resolve(root)
  if (!targetCache.has(k)) {
    targetCache.set(k, {
      rootKey: pathKey(k),
      list: PROTECTED_INSTALL_PATHS.map((t) => {
        const abs = t.home == null ? resolve(k, t.rel)
          : t.xdg ? resolve(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), t.home) : resolve(homedir(), t.home)
        const key = pathKey(abs)
        // the lexical and the real spelling, segment by segment, for glob words
        const segs = [normalizePathSegments(abs), normalizePathSegments(key[0])]
        return { ...t, abs, key, segs }
      }),
    })
  }
  return targetCache.get(k)
}

// Which words are resolved at all: anything path-like (a slash, a dotted name,
// a ~), since a symlink under any name can lead into a target (Dani 56096), and
// any word that names a target segment, a glob or an expansion. Inside a
// protected directory every relative word is a candidate.
const PATH_LIKE_RX = /\/|\.\w|^~/
const TARGET_SEGMENT_NAMES = new Set(['settings.json', 'settings.local.json', 'hooks', 'self-pace-gate.mjs',
  'extra-hooks.json', 'autonomy-config.json', '.claude', 'scripts', 'store', '.', '..', '~'])
const GLOB_CHAR_RX = /[*?[{]/
const UNRESOLVED_RX = /\$\{[^}]*\}|\$\(|\$[A-Za-z_]\w*|\$[0-9@*#?$!-]|[`\u0000\u0003]/

// Every path-like word of a text: split on shell and code punctuation, in every
// spelling scheduleSurfaceVariants reads (quotes removed, escapes decoded, string
// concatenation glued). Once with , and {} as separators (code: open('x','w')),
// once without (a brace-expansion word stays whole).
function pathWords(text) {
  const out = new Set()
  const src = String(text ?? '').replace(/\$\{HOME\}|\$HOME(?!\w)/g, homedir())
  for (const v of scheduleSurfaceVariants(src)) {
    for (const t of v.split(/[\s;&|<>()'"`=,:{}]+/)) if (t) out.add(t)
    for (const t of v.split(/[\s;&|<>()'"`=]+/)) if (t) out.add(t)
  }
  return [...out]
}

function isCandidate(word, ctx) {
  if (GLOB_CHAR_RX.test(word) || UNRESOLVED_RX.test(word)) return true
  if (ctx.cwdInsideDir && !word.startsWith('/') && !word.startsWith('~')) return true
  if (PATH_LIKE_RX.test(word)) return true
  const root = basename(ctx.root).toLowerCase()
  return nameForms(word).some((f) => f.split('/').some((s) => TARGET_SEGMENT_NAMES.has(s) || s === root))
}

// Where a word lands relative to the protected paths: 'exact' (the path
// itself), 'under' (inside a protected directory), 'ancestor' (a directory at
// or below the install root that contains a protected path), or null.
// 'unresolved': an expansion this gate cannot resolve, followed by a protected
// path's tail (`$WT/.claude/settings.json`): read as that path (fail closed).
export function classifyWord(word, ctx) {
  const { list, rootKey } = installTargets(ctx.root)
  let w = String(word)
  if (w === '~' || w.startsWith('~/')) w = expandHome(w === '~' ? '~/' : w)
  if (UNRESOLVED_RX.test(w)) {
    const tail = ('/' + w.split(UNRESOLVED_RX).pop()).replace(/\/+/g, '/').replace(/\/$/, '')
    for (const f of nameForms(tail)) {
      for (const t of list) {
        const rel = '/' + (t.rel ?? t.home).toLowerCase()
        if (f.endsWith(rel) || (t.dir && f.includes(rel + '/'))) return 'unresolved'
      }
    }
    return null
  }
  if (GLOB_CHAR_RX.test(w)) {
    const exps = /[{}]/.test(w) ? expandBraces(w, 1024) : [w]
    if (!exps) return 'unresolved' // too many expansions to prove harmless
    let best = null
    for (const e of exps) {
      const abs = e.startsWith('/') ? e : (ctx.cwd ? resolve(ctx.cwd, e) : null)
      if (!abs) continue
      const W = normalizePathSegments(abs)
      for (const t of list) {
        for (const T of t.segs) {
          const n = Math.min(W.length, T.length)
          let ok = true
          for (let i = 0; i < n && ok; i++) ok = nameForms(W[i]).some((f) => globMatchesName(f, T[i]))
          if (!ok) continue
          if (W.length === T.length) return 'exact'
          if (W.length > T.length) { if (t.dir) return 'under'; continue }
          best = 'ancestor'
        }
      }
    }
    return best
  }
  const abs = w.startsWith('/') ? w : (ctx.cwd ? resolve(ctx.cwd, w) : null)
  if (!abs) return null
  const key = pathKey(abs)
  let best = null
  for (const t of list) {
    if (sameKey(key, t.key)) return 'exact'
    if (t.dir && underKey(key, t.key)) return 'under'
    if (underKey(t.key, key) && underKey(key, rootKey)) best = 'ancestor'
  }
  return best
}

function hitsIn(text, ctx) {
  const hits = []
  for (const w of pathWords(text)) {
    if (!isCandidate(w, ctx)) continue
    const c = classifyWord(w, ctx)
    if (c) hits.push({ word: w, kind: c })
  }
  return hits
}

// Commands that only read a file they name (the output redirect is checked apart).
const READERS = new Set(['cat', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'fgrep', 'rg', 'jq', 'wc', 'ls',
  'stat', 'file', 'shasum', 'sha1sum', 'sha256sum', 'md5', 'md5sum', 'diff', 'cmp', 'echo', 'printf', 'test', '[',
  'readlink', 'realpath', 'basename', 'dirname', 'du', 'pwd', 'cd', 'pushd', 'popd'])
const GIT_READ = new Set(['diff', 'log', 'show', 'status', 'blame', 'ls-files', 'grep', 'rev-parse', 'ls-tree', 'cat-file'])
const INTERPRETERS = new Set(['python', 'python3', 'node', 'bash', 'sh', 'zsh'])
// Commands that change what a DIRECTORY holds: pointed at a directory that
// contains a protected path, they reach it without naming it.
const DIR_CHANGERS = new Set(['rm', 'rmdir', 'mv', 'cp', 'rsync', 'ln', 'install', 'tar', 'bsdtar', 'gtar', 'unzip',
  'cpio', 'patch', 'ditto', '7z', '7za', 'chmod', 'chown', 'chflags', 'find'])

// Programs that write into the CWD when no target directory is named: an
// archive extracted, a patch applied (Dani 56276 2a). The names they create
// come from the archive or the patch, not from the command.
const IMPLICIT_WRITER_RX = /(?:^|[\s;&|(/])(?:tar|bsdtar|gtar|unzip|patch|cpio|7z|7za)(?=\s|$)/
function writesIntoCwd(words, name) {
  const vals = words.map((w) => w.value)
  const named = (...flags) => vals.some((v, i) => flags.some((f) =>
    v === f ? i + 1 < vals.length : v.startsWith(f + '=') || (f.length === 2 && v.startsWith(f) && v.length > 2)))
  if (name === 'tar' || name === 'bsdtar' || name === 'gtar') {
    const extract = vals.slice(1).some((v) => v === '--extract' || v === '--get' || (!v.startsWith('--') && /^-?[A-Za-z]*x/.test(v)))
    return extract && !named('-C', '--directory', '--cd')
  }
  if (name === 'unzip') return !named('-d')
  if (name === 'patch') return !named('-d', '--directory')
  if (name === 'cpio') return vals.slice(1).some((v) => /^-[A-Za-z]*i/.test(v) || v === '--extract') && !named('-D', '--directory')
  if (name === '7z' || name === '7za') return ['x', 'e'].includes(vals[1]) && !vals.some((v) => v.startsWith('-o'))
  return false
}

// GIT (Samu 56294/56299/56310, Dani 56284/56308; measured on a throwaway clone, probes/gitprobe-2b-1030.txt): a
// worktree shares the main checkout's refs and .git/config, so `merge --ff-only origin/<branch>` in the install can take
// a commit any worktree put under refs/remotes/origin; `pull --ff-only origin <branch>` fetches the ref itself and does
// not, unless the remote's address is redirected (url.*.insteadOf from -c, from the GIT_CONFIG_* environment or from the
// user's config). So:
//   - everywhere: no write of refs/remotes/* (update-ref, a refspec onto it, branch -f/-m/-c on an origin name), no
//     write of the remote/hook config keys (any scope), no -c or --config-env with such a key, no GIT_CONFIG_* / GIT_DIR /
//     GIT_WORK_TREE in the command;
//   - in the install's main checkout (the cwd or a -C/--git-dir/--work-tree inside it, an unresolved one counted as
//     inside): only reads, `fetch [origin]` and exactly `pull --ff-only origin <branch>`, plus `checkout -- <paths>` and
//     `restore <paths>` with no ref (they put back the reviewed tree: the host update skill's clean-up step); every
//     other writing subcommand is denied, and so is any -c there.
const GIT_WORD_RX = /(?:^|[\s;&|(/])git(?=\s|$)/
const GIT_ENV_RX = /(?:^|[\s;&|(])(?:export\s+|env\s+)?GIT_(?:CONFIG\w*|DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|SSH_COMMAND|SSH|EXEC_PATH|TEMPLATE_DIR|ALTERNATE_OBJECT_DIRECTORIES)=/
const GIT_PROTECTED_KEY_RX = /^(?:remote\..+\.(?:url|pushurl|fetch|pushurl)|core\.hookspath|include\.path|includeif\..+|url\..+\.(?:insteadof|pushinsteadof))$/i
const GIT_ROOT_READS = new Set([...['diff', 'log', 'show', 'status', 'blame', 'ls-files', 'grep', 'rev-parse', 'ls-tree', 'cat-file'],
  'rev-list', 'merge-base', 'describe', 'shortlog', 'for-each-ref', 'show-ref', 'name-rev', 'check-ignore', 'count-objects',
  'ls-remote', 'cherry', 'whatchanged', 'version', 'help'])
const GIT_FETCH_FLAGS = new Set(['-q', '--quiet', '--prune', '-p'])

// The git words of a segment: the words after any leading assignments and `env`, or null when it is not git.
function gitWords(words) {
  let i = 0
  while (i < words.length && ASSIGN_RX.test(words[i].value)) i++
  if (words[i]?.value === 'env') { i++; while (i < words.length && (ASSIGN_RX.test(words[i].value) || words[i].value.startsWith('-'))) i++ }
  const rest = words.slice(i)
  return commandName(rest) === 'git' ? rest : null
}

// The main checkout this repo dir belongs to: the nearest directory up from it that has a .git entry.
function repoTop(dir) {
  for (let d = resolve(dir); ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return d
    if (dirname(d) === d) return null
  }
}

// 'deny', 'allow' (an allowed write in the main checkout: decided, no path rule after it), or null (judge as any other).
export function gitDecision(words, ctx) {
  const { rootKey } = installTargets(ctx.root)
  const inRootDir = (dir) => { const top = dir && repoTop(dir); return !!top && sameKey(pathKey(top), rootKey) }
  let dir = ctx.cwd
  let dirUnknown = !ctx.cwd
  let pointsIn = false
  const configs = []
  let i = 1
  for (; i < words.length && words[i].value.startsWith('-'); i++) {
    const v = words[i].value
    const val = () => (v.includes('=') ? v.slice(v.indexOf('=') + 1) : words[++i]?.value ?? '')
    if (v === '-C') {
      const d = val()
      if (/[$`\u0000]/.test(d) || words[i]?.dollar) dirUnknown = true
      else if (d.startsWith('/') || d === '~' || d.startsWith('~/')) { dir = resolve(expandHome(d === '~' ? '~/' : d)); dirUnknown = false }
      else if (dir) dir = resolve(dir, d)
      else dirUnknown = true
    } else if (v === '-c' || v.startsWith('--config-env')) {
      configs.push(val().split('=')[0])
    } else if (/^--(?:git-dir|work-tree)(?:=|$)/.test(v)) {
      const d = val()
      if (/[$`\u0000]/.test(d) || !(d.startsWith('/') || ctx.cwd)) pointsIn = true
      else if (inRootDir(resolve(ctx.cwd ?? '/', expandHome(d)))) pointsIn = true
    }
  }
  const sub = words[i]?.value ?? ''
  const args = words.slice(i + 1).map((w) => w.value)
  // everywhere
  if (configs.some((k) => GIT_PROTECTED_KEY_RX.test(k))) return 'deny'
  if (args.some((a) => /(?:^|:)\+?refs\/remotes\//.test(a) && (a.includes(':') || sub === 'update-ref' || sub === 'symbolic-ref'))) return 'deny'
  if (sub === 'update-ref' && args.includes('--stdin')) return 'deny'
  if (sub === 'fetch' && args.some((a) => a.startsWith('--refmap'))) return 'deny'
  if (sub === 'branch' && args.some((a) => /^-[A-Za-z]*[fmMcC]|^--(?:force|move|copy)$/.test(a))
    && args.some((a) => /^(?:origin\/|remotes\/|refs\/remotes\/)/.test(a))) return 'deny'
  if (sub === 'config') {
    const plain = args.filter((a) => !a.startsWith('-'))
    const verb = ['set', 'unset', 'get', 'list', 'edit', 'rename-section', 'remove-section'].includes(plain[0]) ? plain.shift() : null
    const reading = verb === 'get' || verb === 'list' || args.some((a) => /^--(?:get|get-all|get-regexp|get-urlmatch|list)$|^-l$/.test(a))
      || (!verb && plain.length === 1 && !args.some((a) => /^--(?:unset|unset-all|add|replace-all|rename-section|remove-section|edit)$|^-e$/.test(a)))
    if (!reading && (verb === 'edit' || args.some((a) => a === '--edit' || a === '-e') || GIT_PROTECTED_KEY_RX.test(plain[0] ?? '')
      || ['rename-section', 'remove-section'].includes(verb ?? '') || args.some((a) => /^--(?:rename|remove)-section$/.test(a)))) return 'deny'
  }
  if (sub === 'remote' && ['set-url', 'rename', 'remove', 'rm', 'set-branches', 'set-head'].includes(args[0] ?? '')) return 'deny'
  if (sub === 'remote' && args[0] === 'add' && args.includes('origin')) return 'deny'
  // the main checkout
  const inRoot = pointsIn || dirUnknown || inRootDir(dir)
  if (!inRoot) return null
  if (configs.length) return 'deny'
  if (GIT_ROOT_READS.has(sub)) return null
  if (sub === 'fetch') return args.every((a) => GIT_FETCH_FLAGS.has(a)) || (args.filter((a) => !GIT_FETCH_FLAGS.has(a)).join(' ') === 'origin') ? 'allow' : 'deny'
  if (sub === 'pull') {
    const rest = args.filter((a) => a !== '-q' && a !== '--quiet')
    return rest.length === 3 && rest[0] === '--ff-only' && rest[1] === 'origin' && /^[A-Za-z0-9._\/-]+$/.test(rest[2]) && !rest[2].startsWith('-') ? 'allow' : 'deny'
  }
  if (sub === 'checkout') {
    const dash = args.indexOf('--')
    return dash >= 0 && dash < args.length - 1 && args.slice(0, dash).every((a) => a === '-q' || a === '--quiet') ? 'allow' : 'deny'
  }
  if (sub === 'restore') {
    return args.some((a) => /^(?:-s|--source)(?:=|$)|^-s./.test(a)) || !args.some((a) => !a.startsWith('-')) ? 'deny' : 'allow'
  }
  // branch / tag: a listing only. A name without a listing option creates one.
  const listing = (flags, listFlags) => {
    const names = args.filter((a) => !a.startsWith('-'))
    return args.filter((a) => a.startsWith('-')).every((a) => flags.test(a)) && (!names.length || args.some((a) => listFlags.test(a)))
  }
  const LIST_ARG = /^(?:-l|--list|--contains|--no-contains|--merged|--no-merged|--points-at)$/
  if (sub === 'branch') return listing(/^(?:-a|-r|-v|-vv|-l|--list|--all|--remotes|--show-current|--verbose|--no-color|--color|--contains|--no-contains|--merged|--no-merged|--format=.*|--sort=.*)$/, LIST_ARG) ? null : 'deny'
  if (sub === 'tag') return listing(/^(?:-l|--list|-n\d*|--contains|--no-contains|--points-at|--merged|--no-merged|--sort=.*|--format=.*)$/, LIST_ARG) ? null : 'deny'
  if (sub === 'remote') return args.length === 0 || ['-v', '--verbose', 'show', 'get-url'].includes(args[0]) ? null : 'deny'
  if (sub === 'config') return args.some((a) => /^--(?:get|get-all|get-regexp|get-urlmatch|list)$|^-l$/.test(a)) || ['get', 'list'].includes(args[0]) ? null : 'deny'
  if (sub === 'stash') return ['list', 'show'].includes(args[0]) ? null : 'deny'
  if (sub === 'worktree') return ['list', 'add', 'prune', 'remove'].includes(args[0]) ? null : 'deny'
  return 'deny'
}

function gitIsRead(words) {
  let i = 1
  while (i < words.length && words[i].value.startsWith('-')) {
    if (['-C', '--git-dir', '--work-tree'].includes(words[i].value)) i++
    else if (words[i].value === '-c') return false // a config override can name a pager or a hook
    i++
  }
  return GIT_READ.has(words[i]?.value) && !words.some((w) => /^--(?:ext-diff|output)(?:=|$)/.test(w.value))
}

// Running a protected script is not writing it: `node <path>`, `python3 <path>`,
// `bash <path>`, or the path as the command word, with the hit as the script.
function isExecOf(words, name, hitWords) {
  if (hitWords.has(words[0]?.value) && !words.slice(1).some((w) => hitWords.has(w.value))) return true
  if (!INTERPRETERS.has(name)) return false
  const script = words.findIndex((w, i) => i > 0 && !w.value.startsWith('-'))
  if (script < 0 || words.slice(1, script).some((w) => /^-[A-Za-z]*[ceE]$/.test(w.value))) return false
  return hitWords.has(words[script].value) && !words.slice(script + 1).some((w) => hitWords.has(w.value))
}

const CONTROL_PREFIX_RX = /^(?:(?:do|then|else|elif|if|while|until|!|\{)\s+)+/
const ASSIGN_RX = /^([A-Za-z_]\w*)=/

// Bash: does the command write a protected install path? true = deny.
export function installFileDeny(command, opts = {}) {
  const cmd = String(command ?? '')
  const ctx0 = { root: opts.root ?? INSTALL_ROOT, cwd: opts.cwd ? resolve(String(opts.cwd)) : null }
  const insideDir = (cwd) => !!cwd && installTargets(ctx0.root).list.some((t) => t.dir && underKey(pathKey(cwd), t.key))
  const ctx = { ...ctx0, cwdInsideDir: insideDir(ctx0.cwd) }
  // fast path: nothing in any spelling of the whole command reaches a target,
  // and no program in it writes into the cwd on its own
  if (!hitsIn(cmd, ctx).length && !IMPLICIT_WRITER_RX.test(cmd) && !GIT_WORD_RX.test(cmd)) return false
  // the git environment that redirects a remote or points git at another repo or work tree, anywhere in a git command
  if (GIT_WORD_RX.test(cmd) && GIT_ENV_RX.test(cmd)) return 'git'
  // the cwd is the install root, a directory on the way to a protected path, or
  // inside a protected directory: an implicit writer there reaches it
  const { list, rootKey } = installTargets(ctx.root)
  const cwdReaches = (cwd) => {
    if (!cwd) return false
    const key = pathKey(cwd)
    return underKey(key, rootKey) && list.some((t) => underKey(t.key, key) || (t.dir && underKey(key, t.key)))
  }
  // A flat $(...) naming a protected path is kept as written (not replaced by an
  // opaque marker), so its segment fails to parse below and is denied.
  const segs = shellSegments(cmd, { surface: 'security', projectRoot: ctx.root, keepSubst: (inner) => hitsIn(inner, ctx).length > 0 })
  if (!segs) return true // unresolvable quoting around a protected path: fail closed
  const tainted = new Set()
  for (const seg of segs) {
    const own = seg.own.slice((CONTROL_PREFIX_RX.exec(seg.own)?.[0] ?? '').length).trimStart()
    const view = { ...seg, own, text: [own, ...seg.bodies].join('\n') }
    ctx.cwdInsideDir = insideDir(ctx.cwd)
    const rawHits = hitsIn(view.text, ctx)
    const usesTainted = [...tainted].some((n) => new RegExp(`\\$\\{?${n}(?!\\w)`).test(own))
    const words = shellWords(own)
    const name = words ? commandName(words) : ''
    const git = words && gitWords(words)
    if (git) {
      const g = gitDecision(git, ctx)
      if (g === 'deny') return 'git'
      if (g === 'allow') continue
    }
    if (!rawHits.length && !usesTainted) {
      if (words && words.length && writesIntoCwd(words, name) && cwdReaches(ctx.cwd)) return true
      cwdAfterSegment(own, ctx)
      continue
    }
    if (!words || !words.length) return true
    // an output redirect onto a protected path (or onto a word built at run time)
    for (const r of words.redirects) {
      if (r.value === '/dev/null') continue
      if (['exact', 'under', 'unresolved'].includes(classifyWord(r.value, ctx))) return true
      if (usesTainted && /\$/.test(r.value)) return true
    }
    // a heredoc body that names a protected path, written to a file that the same command then runs or feeds (a
    // script); a message or comment file that only mentions the path passes (Marveen 56653)
    const fileTargets = words.redirects.map((t) => t.value).filter((v) => v !== '/dev/null')
    if (seg.bodies.length && seg.bodies.some((b) => hitsIn(b, ctx).length) && laterRuns(segs, segs.indexOf(seg), fileTargets)) return true
    // an assignment carries the path to a later word (`F=<path>; cp x $F`): the
    // name is tainted, and a later segment that uses it is judged as naming it
    if (words.every((w) => ASSIGN_RX.test(w.value)) || /^(?:export|local|declare|readonly|typeset)$/.test(words[0].value)) {
      for (const w of words) { const m = ASSIGN_RX.exec(w.value); if (m) tainted.add(m[1]) }
      continue
    }
    const hits = hitsIn(dataResidue(view, words, name, { surface: 'security' }), ctx)
    if (!hits.length && !usesTainted) { cwdAfterSegment(own, ctx); continue } // only message data names it
    if (READERS.has(name) || isReadOnlyFsCommand(words, name)) {
      // ...but not as the file list of a pipe into a program that acts on it (xargs rm)
      const next = segs[segs.indexOf(seg) + 1]
      if ((seg.sep === '|' || seg.sep === '|&') && next) {
        const nw = shellWords(next.own)
        const nn = nw ? commandName(nw) : ''
        if (!nw || !(READERS.has(nn) || isReadOnlyFsCommand(nw, nn))) return true
      }
      cwdAfterSegment(own, ctx)
      continue
    }
    if (name === 'git' && gitIsRead(words)) continue
    const hitWords = new Set(hits.map((h) => h.word))
    if (!usesTainted && isExecOf(words, name, hitWords)) continue
    if (!usesTainted && hits.every((h) => h.kind === 'ancestor') && !DIR_CHANGERS.has(name)) continue
    return true
  }
  // (A path inside a $(...) is not lost to the parser: keepSubst above keeps
  // that substitution as written, and its segment then fails to parse.)
  return false
}

// Native file tools: the target, resolved against the payload cwd.
export function fileToolDeny(toolInput, opts = {}) {
  const raw = String(toolInput?.file_path ?? toolInput?.notebook_path ?? '')
  if (!raw) return null
  if (nameForms(raw).some((f) => DB_FILE_NAME_RX.test(f))) return 'db'
  const ctx = { root: opts.root ?? INSTALL_ROOT, cwd: opts.cwd ? resolve(String(opts.cwd)) : process.cwd() }
  const c = classifyWord(raw, ctx)
  return c === 'exact' || c === 'under' || c === 'unresolved' ? 'install-file' : null
}

function decide(toolName, toolInput, opts = {}) {
  const name = String(toolName ?? '')
  if (name === 'Write' || name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit') {
    const r = fileToolDeny(toolInput, opts)
    return r ? { deny: true, reason: r } : { deny: false }
  }
  if (name === 'Bash') {
    const command = String(toolInput?.command ?? '')
    if (scheduleSurfaceDeny(command, { surface: 'security', projectRoot: opts.root ?? INSTALL_ROOT })) return { deny: true, reason: 'db' }
    const file = installFileDeny(command, opts)
    if (file) return { deny: true, reason: file === 'git' ? 'git' : 'install-file' }
  }
  return { deny: false }
}

// Pure decision; an exception inside it is a DENY.
export function gateDecision(toolName, toolInput, opts = {}) {
  try {
    return decide(toolName, toolInput, opts)
  } catch (err) {
    return { deny: true, error: String(err?.stack ?? err) }
  }
}

const LIMIT_MSG =
  ' (Ez szoveg-alapu fek, NEM OS-hatar: egy elore megirt szkriptfajl atmegy rajta. A jovahagyas ' +
  'hitelessege a GROMZODONTES1030 F1-F3 utan az mxd-taron mulik, nem ezen a kapun.)'

export const DB_GATE_MSG =
  'Biztonsagi DB-iras TILTOTT (APPROVALDBGATE1030, minden ugynokre, a fo ugynokre is). NEM irhatod a ' +
  'dashboard adatbazisanak biztonsagi tablait (approvals, approval_events, auth_sessions, dashboard_users, ' +
  'device_keys, vault_ssh_keys) semmilyen programmal (sqlite3, python, node, heredoc), es NEM irhatod fajl ' +
  'szinten a store/claudeclaw.db-t (-wal/-shm/-journal is: cp/mv/tee/>/rm/ln, sqlite3 .restore/.read/.backup), ' +
  'es NEM hasznalhatod a PRAGMA writable_schema-t, sem a sqlite_master/sqlite_schema irasat. ' +
  'Jovahagyast a dashboard API-n kerj es hasznalj fel (/api/approvals). Olvasni szabad (SELECT, sqlite3 -readonly), ' +
  'mas tablat irni is (agent_messages, daily_logs). Masolat a DB-rol: sqlite3 -readonly <db> "VACUUM INTO \'/tmp/x.db\'". ' +
  'Ha egy uzenet vagy kanban-szoveg idez ilyen parancsot: curl -d / git commit -m / a kanban-eszkoz --title atmegy; ' +
  'egy fajlba irt szoveg is atmegy, KIVEVE ha ugyanaz a parancs utana futtatja vagy a sqlite3-ba tolja ' +
  '(az egy SQL-szkript).' + LIMIT_MSG

export const INSTALL_FILE_GATE_MSG =
  'Telepitesi kapu-fajl irasa TILTOTT (APPROVALDBGATE1030, minden ugynokre, a fo ugynokre is). NEM irhatod a ' +
  'futo telepites .claude/settings.json, .claude/settings.local.json, scripts/hooks/, scripts/self-pace-gate.mjs, ' +
  'store/extra-hooks.json es store/autonomy-config.json fajljat (Write/Edit, cp/mv/tee/>/sed -i/python, symlinken ' +
  'vagy ..-on at sem; tar -x/unzip/patch/cpio/7z celkonyvtar nelkul a telepites gyokereben vagy a scripts/-ben sem). ' +
  'Egy git worktree SAJAT masolata szabad: ott fejlessz, es PR-ral kerul a telepitesbe. ' +
  'Olvasni szabad (cat/grep/jq/diff, git diff/log/show), hook-szkriptet futtatni is. Valtoztatas a gazda ' +
  'jovahagyasaval a fo ugynokon at. Ha egy feloldatlan valtozo utan vedett ut-veg all ($X/.claude/settings.json), ' +
  'azt nem tudom ellenorizni, ezert tiltom: kifejezett ut kell. Egy fajlba irt szoveg, ami csak EMLITI a vedett utat ' +
  '(uzenet, komment), atmegy; az nem, amit ugyanaz a parancs utana futtat (egy szkript). Elrontott telepites helyreallitasa: docs/db-write-gate.md, "Vesz-helyreallitas" szakasz.' + LIMIT_MSG

// The rescue path is named in the text (Samu 56320 2): the owner's own terminal, or an approval request for it.
export const RESCUE_DOC = 'docs/db-write-gate.md'
export const GIT_GATE_MSG =
  'Git-iras a telepitesben TILTOTT (APPROVALDBGATE1030, minden ugynokre, a fo ugynokre is). A futo telepites fo ' +
  'checkoutjaban (cwd vagy -C) csak olvaso git mehet, plusz pontosan "git fetch [origin]", "git pull --ff-only origin <ag>", ' +
  'es a "git checkout -- <utak>" / "git restore <utak>" ref nelkul. Tiltott ott: merge (--ff-only origin/<ag> is: egy ' +
  'worktree-bol atirt refbol huzna), reset (origin/-lal is), checkout <ag>, switch, rebase, cherry-pick, apply, am, stash, ' +
  'clean, restore --source, pull nem-origin forrasbol, es barmilyen -c. Mindenhol tiltott: a refs/remotes/* irasa ' +
  '(update-ref, refspec, branch -f origin-nevvel), a remote.*.url/pushurl/fetch, core.hooksPath, include.path, includeIf.*, ' +
  'url.*.insteadOf config-irasa (--global/--system is), es a GIT_CONFIG_*/GIT_DIR/GIT_WORK_TREE kornyezeti valtozo. ' +
  'Fejleszteni worktree-ben kell. Elrontott prod fa helyreallitasa: ' + RESCUE_DOC + ', "Vesz-helyreallitas" szakasz ' +
  '(a gazda sajat terminaljaban, vagy jovahagyas-keressel a pontos paranccsal).' + LIMIT_MSG

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

// The hook entry, as self-pace-gate's: the decision runs in a worker with a
// deadline, and a throw, a hang or a missing verdict is a DENY (exit 1 or a
// harness timeout would read as "allow"). Stdin that is not JSON allows: it
// comes from the harness, not from the agent.
const DECISION_DEADLINE_MS = Math.min(5000, Math.max(100, Number(process.env.DB_WRITE_GATE_DEADLINE_MS) || 5000))

const FAIL_CLOSED_MSG = (why) => 'DB-iro kapu: belso hiba vagy idotullepes a vizsgalat kozben ' +
  `(${String(why).slice(0, 200)}). Fail-closed: a hivas nem vizsgalhato, ezert TILTVA.` + LIMIT_MSG

function decideInWorker(toolName, toolInput, opts = {}) {
  return new Promise((resolvePromise, reject) => {
    const w = new Worker(new URL(import.meta.url), {
      workerData: { dbWriteGateWorker: true, toolName, toolInput, opts },
    })
    const timer = setTimeout(() => {
      w.terminate()
      reject(new Error(`decision exceeded ${DECISION_DEADLINE_MS} ms`))
    }, DECISION_DEADLINE_MS)
    w.once('message', (m) => {
      clearTimeout(timer)
      w.terminate()
      if (m?.ok === true && typeof m.deny === 'boolean') resolvePromise(m)
      else reject(new Error(m?.error ?? 'malformed verdict from the decision worker'))
    })
    w.once('error', (e) => { clearTimeout(timer); reject(e) })
    w.once('exit', (code) => { clearTimeout(timer); reject(new Error(`decision worker exited ${code} without a verdict`)) })
  })
}

if (!isMainThread && workerData?.dbWriteGateWorker) {
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
    allow()
  }
  try {
    const verdict = await decideInWorker(payload?.tool_name, payload?.tool_input, { cwd: payload?.cwd })
    if (verdict.error) deny(FAIL_CLOSED_MSG(verdict.error.split('\n')[0]))
    if (verdict.deny) deny(verdict.reason === 'git' ? GIT_GATE_MSG : verdict.reason === 'install-file' ? INSTALL_FILE_GATE_MSG : DB_GATE_MSG)
    allow()
  } catch (err) {
    deny(FAIL_CLOSED_MSG(err?.message ?? err))
  }
}
