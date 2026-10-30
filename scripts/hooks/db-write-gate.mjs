#!/usr/bin/env node
// PreToolUse gate: agent writes to the dashboard's SECURITY surface
// (APPROVALDBGATE1030), for EVERY agent, the main agent included.
//
// What it denies:
//   1. An SQL write (INSERT / UPDATE / DELETE / REPLACE / DROP / ALTER / CREATE
//      TRIGGER|INDEX ... ON) on a security table of the dashboard database
//      (SECURITY_TABLES in self-pace-gate.mjs: approvals, approval_events,
//      auth_sessions, dashboard_users, device_keys, vault_ssh_keys), whatever
//      program runs it: sqlite3, python -c, node -e, a heredoc, a pipe.
//   2. A FILE-level write of the database (store/claudeclaw.db and its -wal,
//      -shm, -journal): a redirect onto it, cp/mv/tee/dd/rm/ln/... naming it, a
//      sqlite3 dot-command that replaces or runs files, a native Write/Edit.
//   3. A write of this gate's own wiring and of the autonomy levels, in THIS
//      INSTALL: .claude/settings.json, .claude/settings.local.json,
//      scripts/hooks/, scripts/self-pace-gate.mjs, store/extra-hooks.json,
//      store/autonomy-config.json. "This install" is the root this file sits in
//      (scripts/hooks/ -> ../..), never the cwd: the same Edit in a worktree's
//      own copy passes, and every path is compared after realpath (symlinks and
//      ".." resolved, case folded as a case-insensitive volume reads it).
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

import { readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
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
        const abs = resolve(k, t.rel)
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
        const rel = '/' + t.rel.toLowerCase()
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
  // fast path: nothing in any spelling of the whole command reaches a target
  const wholeHits = hitsIn(cmd, ctx).length > 0
  if (!wholeHits) return false
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
    if (!rawHits.length && !usesTainted) { cwdAfterSegment(own, ctx); continue }
    if (!words || !words.length) return true
    // an output redirect onto a protected path (or onto a word built at run time)
    for (const r of words.redirects) {
      if (r.value === '/dev/null') continue
      if (['exact', 'under', 'unresolved'].includes(classifyWord(r.value, ctx))) return true
      if (usesTainted && /\$/.test(r.value)) return true
    }
    // a heredoc body that names a protected path, written to a file: a script
    // the next segment can run
    if (seg.bodies.length && seg.bodies.some((b) => hitsIn(b, ctx).length) && words.redirects.some((t) => t.value !== '/dev/null')) return true
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
    if (installFileDeny(command, opts)) return { deny: true, reason: 'install-file' }
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
  'szinten a store/claudeclaw.db-t (-wal/-shm/-journal is: cp/mv/tee/>/rm/ln, sqlite3 .restore/.read/.backup). ' +
  'Jovahagyast a dashboard API-n kerj es hasznalj fel (/api/approvals). Olvasni szabad (SELECT, sqlite3 -readonly), ' +
  'mas tablat irni is (agent_messages, daily_logs). Masolat a DB-rol: sqlite3 -readonly <db> "VACUUM INTO \'/tmp/x.db\'". ' +
  'Ha egy uzenet vagy kanban-szoveg idez ilyen parancsot: curl -d / git commit -m / a kanban-eszkoz --title atmegy; ' +
  'egy fajlba iranyitott heredoc nem, azt a nativ Write tool-lal ird.' + LIMIT_MSG

export const INSTALL_FILE_GATE_MSG =
  'Telepitesi kapu-fajl irasa TILTOTT (APPROVALDBGATE1030, minden ugynokre, a fo ugynokre is). NEM irhatod a ' +
  'futo telepites .claude/settings.json, .claude/settings.local.json, scripts/hooks/, scripts/self-pace-gate.mjs, ' +
  'store/extra-hooks.json es store/autonomy-config.json fajljat (Write/Edit, cp/mv/tee/>/sed -i/python, symlinken ' +
  'vagy ..-on at sem). Egy git worktree SAJAT masolata szabad: ott fejlessz, es PR-ral kerul a telepitesbe. ' +
  'Olvasni szabad (cat/grep/jq/diff, git diff/log/show), hook-szkriptet futtatni is. Valtoztatas a gazda ' +
  'jovahagyasaval a fo ugynokon at. Kifejezett ut kell: valtozoba ($X/...) rakott celutat nem tudok ellenorizni, ' +
  'ezert tiltom.' + LIMIT_MSG

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
    if (verdict.deny) deny(verdict.reason === 'install-file' ? INSTALL_FILE_GATE_MSG : DB_GATE_MSG)
    allow()
  } catch (err) {
    deny(FAIL_CLOSED_MSG(err?.message ?? err))
  }
}
