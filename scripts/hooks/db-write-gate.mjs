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

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
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
  splitSegments,
  underKey,
} from '../self-pace-gate.mjs'
import { claudeInvocations } from './child-claude-channel-guard.mjs'

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
  // The sub-agents' sender-role gates (GROMZOGATECONF1030 (c), Samu 59516): only the dashboard writes them, so no
  // agent can widen its own gate for its next restart.
  { rel: 'store/agent-sender-role-gates.json' },
  // The dashboard's settings overrides (APPROVALSLACK1030, Samu 66026 / 65935): NOTIFY_SLACK_TARGET there names where
  // the owner's approval requests go, SLACK_OWNER_USER_ID whose Slack reaction approves. The sub-agents were already kept out (self-pace-gate, #2153); this covers the main agent.
  // The dashboard writes it through its API, which this gate does not see.
  { rel: 'store/config-overrides.json' },
  // The owner Slack target last announced (Dani 66036): the drift check compares against it.
  { rel: 'store/.owner-slack-target' },
  // The main checkout's git wiring (Samu 56299 2, Dani 56284): its remote, its remote-tracking refs and its hooks. A
  // worktree shares them, so a ref or a URL changed from a worktree is changed for the install's pull as well.
  { rel: '.git/config' },
  { rel: '.git/packed-refs' },
  { rel: '.git/refs/remotes', dir: true },
  { rel: '.git/hooks', dir: true },
  // The user's git config, read by every git on the machine (Samu 56310 2): an url.*.insteadOf there redirects origin.
  { home: '.gitconfig' },
  { home: 'git/config', xdg: true },
  // Every agent's own Claude settings (ENVRELAXGATE1104, Samu 67797): a sub-agent's gate hooks live in its
  // agents/<name>/.claude/settings.json, so one edit there takes a gate out (or adds disableAllHooks / an env block). Only
  // the dashboard writes them (on every spawn); no agent, the main agent included. `*` is ONE path segment (the agent's
  // name). A pattern has NO ancestor here: agents/<name> is where every sub-agent works, and a directory changer naming
  // its .claude directory is caught by claudeDirCopyIn below.
  { rel: 'agents/*/.claude/settings.json', pattern: true },
  { rel: 'agents/*/.claude/settings.local.json', pattern: true },
  // ...and the user-level settings of its isolated CLAUDE_CONFIG_DIR (Samu 67832): a disableAllHooks there switches off
  // every hook of that agent. Claude Code's own writes (/effort, /model) are not tool calls, so this gate never sees them.
  { rel: 'agents/*/.claude-config/settings.json', pattern: true },
]
// ENVRELAXGATE1104 (Dani's inventory 67751 and plan v2, Samu 67732/67752/67763): files whose ONE write turns a gate off or
// gives an agent a right, for a SUB-AGENT only. The main agent writes the install .env legitimately (self-rename), so
// these are not in the common list above; the same real-path engine measures them, so a worktree's own copy (another
// root) stays free, and a read (`sed -n`, `grep`, `cat`, the seed skills' `PORT="$(sed -n ... .env)"`) passes.
//   .env                                -- SUDO_AGENTS (agentMaySudo reads it on every spawn: sudo at the next respawn),
//                                          MAIN_AGENT_ID (who the governance gates exempt), and the hooks' relaxing switches
//   store/provenance-gate-rules.json    -- "enabled": false switches the provenance gate off (missing today: creating it)
//   store/outgoing-copy-gate-rules.json -- no_name_rule: true drops the name check silently; deleting it fails open
//   store/credential-gate.json          -- mode: warn turns the credential gate into a warning (missing today)
//   store/egress-measure-hosts.json     -- a host there lets curl -q GET/HEAD through (bash-egress-parser.mjs)
//   store/.fleet-memgate-observe        -- its presence puts the fleet memory gate into observe-only (fleet-memory-gate.sh)
export const SUBAGENT_PROTECTED_INSTALL_PATHS = [
  { rel: '.env' },
  { rel: 'store/provenance-gate-rules.json' },
  { rel: 'store/outgoing-copy-gate-rules.json' },
  { rel: 'store/credential-gate.json' },
  { rel: 'store/egress-measure-hosts.json' },
  { rel: 'store/.fleet-memgate-observe' },
  // The user's shared Claude settings (Dani 67840/67841): every agents/*/.claude-config/settings.local.json is a
  // SYMLINK to ~/.claude/settings.local.json, a real file the main agent loads too, so a sub-agent writing it (through
  // its symlink or straight) changes every session's settings. The main agent writes them legitimately: sub-agent only.
  // The real path is compared, so the symlink route lands here. ~/.claude/projects (memory files) is not touched.
  { home: '.claude/settings.json' },
  { home: '.claude/settings.local.json' },
  // The MAIN agent's isolated config dir (MAIN_AGENT_ISOLATED_CONFIG, Samu 68206/68210): its settings.json (env,
  // permissions, enabledPlugins, extraKnownMarketplaces, hooks) and a settings.local.json created there are loaded at
  // the main agent's next start, and so are its plugin registries (plugins/*.json) and its state. Every REAL file in it
  // is the main agent's; a sub-agent writes none of them. Its symlinked entries (projects, skills, agents, hooks, the
  // plugin cache...) resolve into ~/.claude, and the real path is compared, so they are judged where they land, not
  // here. The whole directory, as a directory: one entry covers a file Claude Code adds there tomorrow.
  { rel: '.channels-config', dir: true },
  // The MCP server lists (ENVRELAXMCPCFG1104, Samu 68033/68034): a stdio server written into one of them runs as a
  // command at the agent's next start, outside every PreToolUse gate, and the dashboard's reconcile only ever ADDS
  // servers, so the entry would stay. A sub-agent writes none of them; the main agent and the dashboard do (fleet MCP
  // setup), so this is the sub-agent list:
  //   agents/*/.mcp.json                   -- an agent's project-scope servers (its own and another's)
  //   agents/*/.claude-config/.claude.json -- an agent's isolated user-scope servers (mcpServers, projects[].mcpServers)
  //   .mcp.json                            -- the install's project-scope servers (tracked: a worktree's own copy is
  //                                           another root and stays free)
  //   .channels-config/.claude.json        -- the main agent's isolated user config (MAIN_AGENT_ISOLATED_CONFIG):
  //                                           covered by the .channels-config directory entry above (#2503)
  //   ~/.claude.json                       -- the shared user config: the reconcile copies servers FROM it
  // Claude Code's own writes of .claude.json (its state, on every session) are not tool calls: this gate never sees
  // them. Its backups/ copies are not listed (stated limit).
  { rel: 'agents/*/.mcp.json', pattern: true },
  { rel: 'agents/*/.claude-config/.claude.json', pattern: true },
  { rel: '.mcp.json' },
  { home: '.claude.json' },
]

// Is the hook's caller a sub-agent? The main agent runs in the install root (its CLAUDE_PROJECT_DIR), a sub-agent in
// agents/<name>. Anything that is not exactly the install root counts as a sub-agent, an unset project dir too
// (fail-closed: the main agent's hook always has it). A second signal (Dani 67822): a CLAUDE_CONFIG_DIR under the
// install's agents/ is a sub-agent's isolated config, which a child `claude` it starts from the install root inherits;
// the main agent's config is ~/.claude or <root>/.channels-config, never under agents/. `env -i` drops it (stated limit).
export function isSubAgentCaller(projectDir, root = INSTALL_ROOT, configDir = null) {
  if (configDir && underKey(pathKey(resolve(String(configDir))), pathKey(join(resolve(root), 'agents')))) return true
  if (!projectDir) return true
  return !sameKey(pathKey(resolve(String(projectDir))), pathKey(resolve(root)))
}

// The database file, by NAME anywhere (as the Bash rule reads it).
const DB_FILE_NAME_RX = /(?:^|\/)claudeclaw\.db(?:-wal|-shm|-journal)?$/i

// The CALLER's own Claude settings, wherever they are (Samu 67803, 67832): a sub-agent's gate hooks live in
// <CLAUDE_PROJECT_DIR>/.claude/settings.json, and its user-level settings in <CLAUDE_CONFIG_DIR>/settings.json (unset:
// ~/.claude/settings.json, which then is the sub-agent's). Under the install's agents/ the common patterns cover the
// first two already; these entries also cover a caller outside it (the two workers: their config dir is
// ~/.marveen-worker{,-fast}/.claude-config). Sub-agent list only.
function callerSettingsEntries(projectDir, configDir) {
  const out = []
  if (projectDir) {
    const dir = resolve(String(projectDir))
    // ...and its project-scope MCP servers (ENVRELAXMCPCFG1104)
    for (const rel of ['.claude/settings.json', '.claude/settings.local.json', '.mcp.json']) out.push({ rel, abs: resolve(dir, rel), caller: true })
  }
  if (configDir) {
    const dir = resolve(String(configDir))
    // ...and its user-scope MCP servers in the config dir's .claude.json (ENVRELAXMCPCFG1104)
    for (const f of ['settings.json', 'settings.local.json', '.claude.json']) out.push({ rel: `${basename(dir)}/${f}`, abs: join(dir, f), caller: true })
  }
  return out
}

const targetCache = new Map()
export function installTargets(root = INSTALL_ROOT, subAgent = false, projectDir = null, configDir = null) {
  const k = resolve(root)
  const ck = `${subAgent ? 'sub' : 'all'}\u0000${k}\u0000${subAgent && projectDir ? resolve(String(projectDir)) : ''}\u0000${subAgent && configDir ? resolve(String(configDir)) : ''}`
  if (!targetCache.has(ck)) {
    const entries = subAgent ? [...PROTECTED_INSTALL_PATHS, ...SUBAGENT_PROTECTED_INSTALL_PATHS, ...callerSettingsEntries(projectDir, configDir)] : PROTECTED_INSTALL_PATHS
    targetCache.set(ck, {
      rootKey: pathKey(k),
      list: entries.map((t) => {
        const abs = t.abs ? t.abs : t.home == null ? resolve(k, t.rel)
          : t.xdg ? resolve(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), t.home) : resolve(homedir(), t.home)
        const key = pathKey(abs)
        // the lexical and the real spelling, segment by segment, for glob words
        const segs = [normalizePathSegments(abs), normalizePathSegments(key[0])]
        return { ...t, abs, key, segs }
      }),
    })
  }
  return targetCache.get(ck)
}

// Which words are resolved at all: anything path-like (a slash, a dotted name,
// a ~), since a symlink under any name can lead into a target (Dani 56096), and
// any word that names a target segment, a glob or an expansion. Inside a
// protected directory every relative word is a candidate.
const PATH_LIKE_RX = /\/|\.\w|^~/
const TARGET_SEGMENT_NAMES = new Set(['settings.json', 'settings.local.json', 'hooks', 'self-pace-gate.mjs',
  'extra-hooks.json', 'autonomy-config.json', 'agent-sender-role-gates.json', 'config-overrides.json', '.owner-slack-target', '.claude', 'scripts', 'store', '.', '..', '~',
  '.env', 'provenance-gate-rules.json', 'outgoing-copy-gate-rules.json', 'credential-gate.json', 'egress-measure-hosts.json', '.fleet-memgate-observe'])
const GLOB_CHAR_RX = /[*?[{]/
// A shell glob does not match a leading-dot name unless its own segment starts with a dot (bash without dotglob,
// zsh without GLOB_DOTS). Without this, a bare `*` in a sub-agent's own directory matched its .mcp.json
// (ENVRELAXMCPCFG1104) and every non-reader command with one was denied: `sqlite3 db "SELECT count(*) ..."`
// (worker-gates.test.ts). Fail closed: a command that names dotglob / globdots / GLOBIGNORE or a zsh `D` glob
// qualifier keeps the old reading. Stated limit: GLOB_DOTS switched on in the user's shell rc is not visible here.
// Only the Bash path sets shellGlob; a file tool's path or an MCP argument is never read this way.
const DOTGLOB_RX = /dotglob|glob_?dots|GLOBIGNORE|\*\([^)\s]*D[^)\s]*\)/i

// A pattern entry against a resolved path key: 'exact' when every segment matches (`*` matches one segment), else null.
function patternExact(key, t) {
  // every nameForms() form of the key against the same form of the pattern (the real path, its case folds)
  for (let i = 0; i < key.length; i++) {
    const K = normalizePathSegments(key[i])
    const T = normalizePathSegments(t.key[i] ?? t.key[0])
    if (K.length === T.length && T.every((seg, x) => seg === '*' ? K[x] !== '' : seg === K[x])) return true
  }
  return false
}
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
  const { list, rootKey } = installTargets(ctx.root, ctx.subAgent === true, ctx.projectDir, ctx.configDir)
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
          const dotRule = ctx.shellGlob === true && ctx.dotglob !== true
          for (let i = 0; i < n && ok; i++) {
            ok = T[i] === '*' && t.pattern ? W[i] !== ''
              : nameForms(W[i]).some((f) => globMatchesName(f, T[i]) && !(dotRule && T[i].startsWith('.') && !f.startsWith('.')))
          }
          if (!ok) continue
          if (W.length === T.length) return 'exact'
          if (W.length > T.length) { if (t.dir) return 'under'; continue }
          if (t.pattern) continue // no ancestor (see the entry)
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
    if (t.pattern) {
      if (patternExact(key, t)) return 'exact'
      continue
    }
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

// A directory named .claude copied or moved INTO an agent directory (ENVRELAXGATE1104): `cp -r /tmp/x/.claude .` in
// agents/<name> lands on its .claude/settings.json without naming it, and agents/<name> itself is not an ancestor (every
// sub-agent works there). So: a directory changer with a source word whose last part is (or globs onto) .claude, and the
// cwd or a word under the install's agents/. A content copy (`cp -r x/. .`, an archive) is not seen: stated limit.
const CLAUDE_DIR_WORD_RX = /\.claude(?:-config)?(?![\w-])|(?:^|[\s/'"])\.[^\s/'"]*[*?[]/i
function claudeDirCopyIn(words, ctx) {
  const vals = words.slice(1).map((w) => w.value).filter((v) => v && !v.startsWith('-'))
  const named = vals.some((v) => {
    const last = normalizePathSegments(v).filter(Boolean).pop() ?? ''
    return nameForms(last).some((f) => f === '.claude' || f === '.claude-config'
      || (f.startsWith('.') && GLOB_CHAR_RX.test(f) && (globMatchesName(f, '.claude') || globMatchesName(f, '.claude-config'))))
  })
  if (!named) return false
  const agentsKey = pathKey(join(ctx.root, 'agents'))
  const inAgents = (p) => !!p && underKey(pathKey(p), agentsKey)
  if (inAgents(ctx.cwd)) return true
  return vals.some((v) => inAgents(v.startsWith('/') || v === '~' || v.startsWith('~/') ? expandHome(v === '~' ? '~/' : v) : (ctx.cwd ? resolve(ctx.cwd, v) : null)))
}

// Programs that write into the CWD when no target directory is named: an
// archive extracted, a patch applied (Dani 56276 2a). The names they create
// come from the archive or the patch, not from the command.
const IMPLICIT_WRITER_RX = /(?:^|[\s;&|(/`"'])(?:tar|bsdtar|gtar|unzip|patch|cpio|7z|7za)(?=\s|$)/
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
const GIT_WORD_RX = /(?:^|[\s;&|(/`"'])git(?=\s|$)/
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

// The directory after a segment (cwdAfterSegment), and one thing it cannot see: a cd joined to the next command by ";" or a
// newline, not "&&", that may FAIL. bash then runs the next command in the old directory, so "cd <dir>; git ..." would
// write the install when <dir> is missing (found while measuring Dani 60251's case 4). A target that does not exist now is
// such a cd: the directory after it is unknown, which the git rule takes as the install. With "&&" a failed cd runs
// nothing after it, and an existing directory is taken as reached. A FILE fails a cd too (Dani 60262: "cd <file> ||
// git ..." runs the git only then), so the test is "a directory", not "exists".
function isDirectory(p) {
  try { return statSync(p).isDirectory() } catch { return false }
}

function moveCwd(own, seg, ctx) {
  cwdAfterSegment(own, ctx)
  const first = shellWords(String(own ?? '').trim())?.[0]?.value
  if (ctx.cwd && seg.sep !== '&&' && (first === 'cd' || first === 'pushd') && !isDirectory(ctx.cwd)) ctx.cwd = null
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
  // A local branch deleted after its worktree is gone (Samu 56807: the fleet could add worktrees but not clean up):
  // allowed, but never a remote-tracking ref (-r, an origin/ or refs/ name) and never the branch the install runs.
  if (sub === 'branch' && args.some((a) => /^-[A-Za-z]*[dD]$|^--delete$/.test(a))) {
    const names = args.filter((a) => !a.startsWith('-'))
    const head = (() => { try { return readFileSync(join(ctx.root, '.git', 'HEAD'), 'utf-8').trim().replace(/^ref: refs\/heads\//, '') } catch { return null } })()
    const bad = !names.length || args.some((a) => /^-[A-Za-z]*r$|^--remotes$/.test(a))
      || names.some((n) => /^(?:origin\/|remotes\/|refs\/)/.test(n) || n === head || /[$`\u0000]/.test(n))
    return bad ? 'deny' : null
  }
  if (sub === 'branch') return listing(/^(?:-a|-r|-v|-vv|-l|--list|--all|--remotes|--show-current|--verbose|--no-color|--color|--contains|--no-contains|--merged|--no-merged|--format=.*|--sort=.*)$/, LIST_ARG) ? null : 'deny'
  if (sub === 'tag') return listing(/^(?:-l|--list|-n\d*|--contains|--no-contains|--points-at|--merged|--no-merged|--sort=.*|--format=.*)$/, LIST_ARG) ? null : 'deny'
  if (sub === 'remote') return args.length === 0 || ['-v', '--verbose', 'show', 'get-url'].includes(args[0]) ? null : 'deny'
  if (sub === 'config') return args.some((a) => /^--(?:get|get-all|get-regexp|get-urlmatch|list)$|^-l$/.test(a)) || ['get', 'list'].includes(args[0]) ? null : 'deny'
  if (sub === 'stash') return ['list', 'show'].includes(args[0]) ? null : 'deny'
  // A worktree is added, moved or removed only OUTSIDE the install (Samu 56807): one inside it would be a second
  // checkout of the tree the install runs.
  if (sub === 'worktree') {
    if (args[0] === 'list' || args[0] === 'prune') return null
    if (!['add', 'remove', 'move'].includes(args[0])) return 'deny'
    const paths = []
    for (let j = 1; j < args.length; j++) {
      if (['-b', '-B', '--reason'].includes(args[j])) { j++; continue }
      if (!args[j].startsWith('-')) paths.push(args[j])
    }
    const where = args[0] === 'add' ? paths.slice(0, 1) : paths
    if (!where.length || where.some((p) => /[$`\u0000]/.test(p))) return 'deny'
    return where.some((p) => underKey(pathKey(resolve(dir ?? ctx.cwd ?? '/', expandHome(p))), rootKey)) ? 'deny' : null
  }
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

// The live command substitutions of a command line, as their inner text: backticks and $(...)
// outside single quotes, $'...' and the body of a heredoc with a quoted tag (those are literal text). The segment
// parser replaces a substitution by an opaque marker, so a git write inside one never reached the git rule (Dani 56844:
// `git update-ref refs/remotes/...` in backticks passed; measured: a flat $(...) too).
export function liveSubstitutions(cmd) {
  const out = []
  const s = String(cmd ?? '')
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c === '\\') { i += 2; continue }
    if (c === "'") { const e = s.indexOf("'", i + 1); i = e < 0 ? s.length : e + 1; continue }
    if (c === '$' && s[i + 1] === "'") {
      let j = i + 2
      while (j < s.length && s[j] !== "'") j += s[j] === '\\' ? 2 : 1
      i = j + 1
      continue
    }
    const here = /^<<-?\s*(['"])([A-Za-z_]\w*)\1/.exec(s.slice(i))
    if (here) {
      const nl = s.indexOf('\n', i)
      const end = nl < 0 ? -1 : s.slice(nl + 1).search(new RegExp(`^[ \\t]*${here[2]}[ \\t]*$`, 'm'))
      i = nl < 0 || end < 0 ? s.length : nl + 1 + end + here[2].length
      continue
    }
    if (c === '`') {
      let j = i + 1
      while (j < s.length && s[j] !== '`') j += s[j] === '\\' ? 2 : 1
      const inner = s.slice(i + 1, j)
      out.push(inner)
      i = j + 1
      continue
    }
    if (c === '$' && s[i + 1] === '(' && s[i + 2] !== '(') {
      let j = i + 2
      let depth = 1
      while (j < s.length && depth > 0) {
        if (s[j] === '\\') { j += 2; continue }
        if (s[j] === "'") { const e = s.indexOf("'", j + 1); j = e < 0 ? s.length : e + 1; continue }
        if (s[j] === '(') depth++
        else if (s[j] === ')') depth--
        j++
      }
      const inner = s.slice(i + 2, j - 1)
      out.push(inner)
      i = j
      continue
    }
    i++
  }
  return out
}

// Every command of a command line whose quoting does not resolve, read roughly: split at the separators, at every
// command substitution's start and end and at every parenthesis (a subshell, a case pattern), the quotes taken off each
// word. Only for the rules that must not be lost there.
const ROUGH_CONTROL = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{', 'time'])
function roughCommands(cmd) {
  const out = []
  for (const seg of splitSegments(cmd)) {
    for (const piece of seg.split(/\$\(|`|\(|\)/)) {
      let words = piece.trim().split(/\s+/).filter(Boolean)
        .map((v) => ({ value: v.replace(/^['"]+|['"]+$/g, ''), dollar: v.includes('$') }))
      while (words.length && ROUGH_CONTROL.has(words[0].value)) words = words.slice(1)
      if (words.length) out.push(words)
    }
  }
  return out
}

const ASSIGN_RX = /^([A-Za-z_]\w*)=/

// A segment's subshell parentheses: the "(" that open one before its command (after a control word too) and the ")"
// that close one after it, counted, and the command between. The word reader cannot split a parenthesis, and a
// segment it could not split passed unjudged: `(git reset --hard)` went through (Bence 57071). A ")" that is not a
// subshell's (a case pattern's) only ends the cwd of an enclosing subshell early: the stricter reading.
export function subshellParts(own) {
  let body = own
  let opens = 0
  for (let m; (m = /^(?:(?:do|then|else|elif|if|while|until|!|\{)\s+|\(\s*)/.exec(body));) {
    if (m[0].startsWith('(')) opens++
    body = body.slice(m[0].length)
  }
  let closes = 0
  for (let m; (m = /(?<!\\)\s*\)$/.exec(body));) {
    closes++
    body = body.slice(0, m.index)
  }
  return { opens, body: body.trim(), closes }
}

// Bash: does the command write a protected install path? true = deny.
export function installFileDeny(command, opts = {}) {
  const cmd = String(command ?? '')
  const ctx0 = { root: opts.root ?? INSTALL_ROOT, cwd: opts.cwd ? resolve(String(opts.cwd)) : null, subAgent: opts.subAgent === true, projectDir: opts.projectDir ?? null, configDir: opts.configDir ?? null, shellGlob: true, dotglob: DOTGLOB_RX.test(cmd) }
  const insideDir = (cwd) => !!cwd && installTargets(ctx0.root, ctx0.subAgent, ctx0.projectDir, ctx0.configDir).list.some((t) => t.dir && underKey(pathKey(cwd), t.key))
  const ctx = { ...ctx0, cwdInsideDir: insideDir(ctx0.cwd) }
  // fast path: nothing in any spelling of the whole command reaches a target,
  // and no program in it writes into the cwd on its own
  // (a .claude source, or a dot-glob that may be one, goes on to the segments: claudeDirCopyIn)
  if (!hitsIn(cmd, ctx).length && !IMPLICIT_WRITER_RX.test(cmd) && !GIT_WORD_RX.test(cmd) && !CLAUDE_DIR_WORD_RX.test(cmd)) return false
  // the git environment that redirects a remote or points git at another repo or work tree, anywhere in a git command
  if (GIT_WORD_RX.test(cmd) && GIT_ENV_RX.test(cmd)) return 'git'
  // the cwd is the install root, a directory on the way to a protected path, or
  // inside a protected directory: an implicit writer there reaches it
  const { list, rootKey } = installTargets(ctx.root, ctx.subAgent, ctx.projectDir, ctx.configDir)
  const cwdReaches = (cwd) => {
    if (!cwd) return false
    const key = pathKey(cwd)
    return underKey(key, rootKey) && list.some((t) => underKey(t.key, key) || (t.dir && underKey(key, t.key)))
  }
  // A flat $(...) naming a protected path is kept as written (not replaced by an
  // opaque marker), so its segment fails to parse below and is denied.
  const segs = shellSegments(cmd, { surface: 'security', projectRoot: ctx.root, keepSubst: (inner) => hitsIn(inner, ctx).length > 0 })
  // A git write or an implicit cwd writer inside a live command substitution: the segments below see only a marker
  // in its place.
  for (const inner of liveSubstitutions(cmd)) {
    for (const words of roughCommands(inner)) {
      const git = gitWords(words)
      if (git && gitDecision(git, ctx) === 'deny') return 'git'
      if (writesIntoCwd(words, commandName(words)) && cwdReaches(ctx.cwd)) return true
    }
  }
  // An unresolved quoting whose only mention is a directory on the way to a protected path, the install root itself
  // most often (`cd <root>; ... "$(cd $d; git remote get-url origin)"`, Marveen 57083). Holds when the rest, read
  // roughly with its cd followed, names no protected path from the cwd each command runs in, and no substitution's own
  // text names one (ancestor too) from any of those cwds. A cd that cannot be followed outside a substitution: no.
  // The git rule and the implicit writer rule run from the followed cwd too, every command of a substitution from each
  // of those cwds (Dani 57368: measured from the caller's cwd, `cd <root>; tar -xf ...; echo "$(date $y)"` passed).
  const writes = (words, cw) => {
    const git = gitWords(words)
    return (git && gitDecision(git, cw) === 'deny') || (writesIntoCwd(words, commandName(words)) && cwdReaches(cw.cwd))
  }
  const ancestorOnlyHolds = (text) => {
    const subs = liveSubstitutions(text)
    let outer = text
    for (const s of subs) outer = outer.split('$(' + s + ')').join(' ').split('`' + s + '`').join(' ')
    const c = { ...ctx }
    const cwds = [c.cwd]
    // Every command is measured from EVERY cwd the reading has passed, the caller's included: the rough reading follows
    // each cd unconditionally (one in a subshell, or after || / &&, may not run, Dani 57400), so a cd followed wrongly
    // can only make it stricter.
    for (const words of roughCommands(outer)) {
      c.cwdInsideDir = insideDir(c.cwd)
      const line = words.map((w) => w.value).join(' ')
      for (const cwd of cwds) {
        const at = { ...ctx, cwd, cwdInsideDir: insideDir(cwd) }
        if (hitsIn(line, at).some((h) => h.kind !== 'ancestor') || writes(words, at)) return false
      }
      if (!['cd', 'pushd', 'popd'].includes(words[0].value)) continue
      cwdAfterSegment(line, c)
      if (!c.cwd) return false
      if (!cwds.includes(c.cwd)) cwds.push(c.cwd)
    }
    return !subs.some((s) => cwds.some((cwd) => {
      const at = { ...ctx, cwd, cwdInsideDir: insideDir(cwd) }
      return hitsIn(s, at).length || roughCommands(s).some((words) => writes(words, at))
    }))
  }
  if (!segs) {
    // The quoting does not resolve: a command substitution with quotes or an expansion inside, most often a plain reader
    // (`echo "$(git log -1 --format='%ad' $c)"`, Dani 56794). A protected path anywhere in it: fail closed. Otherwise
    // the git and the implicit-writer rules still run on a rough reading of every command in it, so a write hidden in
    // a substitution is not lost.
    const hits = hitsIn(cmd, ctx)
    if (hits.some((h) => h.kind !== 'ancestor') || (hits.length && !ancestorOnlyHolds(cmd))) return true
    for (const words of roughCommands(cmd)) {
      const git = gitWords(words)
      if (git && gitDecision(git, ctx) === 'deny') return 'git'
      if (writesIntoCwd(words, commandName(words)) && cwdReaches(ctx.cwd)) return true
    }
    return false
  }
  const tainted = new Set()
  // A subshell's cd ends with it: the cwd before its "(" comes back after its ")".
  const cwdStack = []
  let closing = 0
  for (const seg of segs) {
    for (; closing > 0; closing--) if (cwdStack.length) ctx.cwd = cwdStack.pop()
    const sub = subshellParts(seg.own)
    for (let k = 0; k < sub.opens; k++) cwdStack.push(ctx.cwd)
    closing = sub.closes
    const own = sub.body
    const view = { ...seg, own, text: [own, ...seg.bodies].join('\n') }
    ctx.cwdInsideDir = insideDir(ctx.cwd)
    const rawHits = hitsIn(view.text, ctx)
    const usesTainted = [...tainted].some((n) => new RegExp(`\\$\\{?${n}(?!\\w)`).test(own))
    const words = shellWords(own)
    // A segment the word reader still cannot split (a case pattern, an arithmetic group): its git commands are read
    // roughly, so they reach the git rule.
    if (!words) {
      for (const rough of roughCommands(own)) {
        const g = gitWords(rough)
        if (g && gitDecision(g, ctx) === 'deny') return 'git'
      }
    }
    const name = words ? commandName(words) : ''
    if (words && words.length && DIR_CHANGERS.has(name) && claudeDirCopyIn(words, ctx)) return true
    const git = words && gitWords(words)
    if (git) {
      const g = gitDecision(git, ctx)
      if (g === 'deny') return 'git'
      if (g === 'allow') continue
    }
    if (!rawHits.length && !usesTainted) {
      if (words && words.length && writesIntoCwd(words, name) && cwdReaches(ctx.cwd)) return true
      moveCwd(own, seg, ctx)
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
    if (!hits.length && !usesTainted) { moveCwd(own, seg, ctx); continue } // only message data names it
    if (READERS.has(name) || isReadOnlyFsCommand(words, name)) {
      // ...but not as the file list of a pipe into a program that acts on it (xargs rm)
      const next = segs[segs.indexOf(seg) + 1]
      if ((seg.sep === '|' || seg.sep === '|&') && next) {
        const nw = shellWords(next.own)
        const nn = nw ? commandName(nw) : ''
        if (!nw || !(READERS.has(nn) || isReadOnlyFsCommand(nw, nn))) return true
      }
      moveCwd(own, seg, ctx)
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
  const ctx = { root: opts.root ?? INSTALL_ROOT, cwd: opts.cwd ? resolve(String(opts.cwd)) : process.cwd(), subAgent: opts.subAgent === true, projectDir: opts.projectDir ?? null, configDir: opts.configDir ?? null }
  const c = classifyWord(raw, ctx)
  return c === 'exact' || c === 'under' || c === 'unresolved' ? 'install-file' : null
}

// `claude mcp add|add-json|add-from-claude-desktop|remove` (ENVRELAXMCPCFG1104, Dani 68088, Samu 68092): the CLI
// writes an MCP server list itself, so no path appears in the command. A sub-agent may not run it, for any --scope;
// the main agent may. The invocation is found by the child-claude guard's own parser (a `claude` at a segment's start,
// after env assignments and wrappers). Not seen (stated limit, Dani 68129): a `claude` not at a segment's start --
// started from a script, inside `bash -c`/`sh -c`, through `xargs`, as `$(which claude)` or from a variable
// (`C=claude; $C`) -- or as `npx @anthropic-ai/claude-code`. The same class holds for the other text gates; the
// shell-code recursion is separate, wider work.
const CLAUDE_MCP_WRITE_SUBS = new Set(['add', 'add-json', 'add-from-claude-desktop', 'remove'])
export function claudeMcpListWrite(command) {
  return claudeInvocations(String(command ?? '')).some((args) => {
    const i = args.indexOf('mcp')
    return i >= 0 && CLAUDE_MCP_WRITE_SUBS.has(args[i + 1])
  })
}

function decide(toolName, toolInput, opts = {}) {
  const name = String(toolName ?? '')
  // A deny that only the sub-agent list gives gets its own message (ENVRELAXGATE1104).
  const subOnly = () => opts.subAgent === true
  if (name === 'Write' || name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit') {
    const r = fileToolDeny(toolInput, opts)
    if (r === 'install-file' && subOnly() && !fileToolDeny(toolInput, { ...opts, subAgent: false })) return { deny: true, reason: 'subagent-file' }
    return r ? { deny: true, reason: r } : { deny: false }
  }
  if (name === 'Bash') {
    const command = String(toolInput?.command ?? '')
    if (subOnly() && claudeMcpListWrite(command)) return { deny: true, reason: 'subagent-file' }
    if (scheduleSurfaceDeny(command, { surface: 'security', projectRoot: opts.root ?? INSTALL_ROOT })) return { deny: true, reason: 'db' }
    const file = installFileDeny(command, opts)
    if (file === true && subOnly() && !installFileDeny(command, { ...opts, subAgent: false })) return { deny: true, reason: 'subagent-file' }
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
  'dashboard adatbazisanak biztonsagi tablait (approvals, approval_events, approval_slack_posts, auth_sessions, dashboard_users, ' +
  'device_keys, vault_ssh_keys) semmilyen programmal (sqlite3, python, node, heredoc), es NEM irhatod fajl ' +
  'szinten a store/claudeclaw.db-t (-wal/-shm/-journal is: cp/mv/tee/>/rm/ln, sqlite3 .restore/.read/.backup), ' +
  'es NEM hasznalhatod a PRAGMA writable_schema-t, sem a sqlite_master/sqlite_schema irasat. ' +
  'Jovahagyast a dashboard API-n kerj es hasznalj fel (/api/approvals). Olvasni szabad (SELECT, sqlite3 -readonly), ' +
  'mas tablat irni is (agent_messages, daily_logs). Egy $(...) behelyettesitesben allo sqlite3-at (idezojellel benne) ' +
  'viszont a kapu nem olvassa, es tiltja: futtasd a sqlite3-at kulon parancskent, behelyettesites nelkul (a kimenetet ' +
  'fajlba vagy kiirva; Samu 60400). Masolat a DB-rol: sqlite3 -readonly <db> "VACUUM INTO \'/tmp/x.db\'". ' +
  'Ha egy uzenet vagy kanban-szoveg idez ilyen parancsot: curl -d / git commit -m / a kanban-eszkoz --title atmegy; ' +
  'egy fajlba irt szoveg is atmegy, KIVEVE ha ugyanaz a parancs utana futtatja vagy a sqlite3-ba tolja ' +
  '(az egy SQL-szkript).' + LIMIT_MSG

export const INSTALL_FILE_GATE_MSG =
  'Telepitesi kapu-fajl irasa TILTOTT (APPROVALDBGATE1030, minden ugynokre, a fo ugynokre is). NEM irhatod a ' +
  'futo telepites .claude/settings.json, .claude/settings.local.json, scripts/hooks/, scripts/self-pace-gate.mjs, ' +
  'store/extra-hooks.json, store/autonomy-config.json, store/agent-sender-role-gates.json, store/config-overrides.json es store/.owner-slack-target fajljat, ' +
  'sem BARMELY agens agents/<nev>/.claude/settings.json, settings.local.json es .claude-config/settings.json fajljat (ezeket csak a dashboard irja; Write/Edit, cp/mv/tee/>/sed -i/python, symlinken ' +
  'vagy ..-on at sem; tar -x/unzip/patch/cpio/7z celkonyvtar nelkul a telepites gyokereben vagy a scripts/-ben sem). ' +
  'Egy git worktree SAJAT masolata szabad: ott fejlessz, es PR-ral kerul a telepitesbe. ' +
  'Olvasni szabad (cat/grep/jq/diff, git diff/log/show), egy hook-szkriptet KOZVETLENUL futtatni is ' +
  '(python3 scripts/hooks/x.py); egy masik szkriptnek vagy ertelmezonek ARGUMENTUMKENT adott vedett ut viszont tilt, ' +
  'mert az irhat bele. Valtoztatas a gazda jovahagyasaval a fo ugynokon at. Ha egy feloldatlan valtozo utan vedett ' +
  'ut-veg all ($X/.claude/settings.json), azt nem tudom ellenorizni, ezert tiltom: kifejezett ut kell. Ha a parancs ' +
  'idezese nem bonthato fel (idezojeles parancs-behelyettesites) ES vedett utat emlit, tiltom. Egy fajlba irt szoveg, ' +
  'ami csak EMLITI a vedett utat (uzenet, komment), atmegy; az nem, amit ugyanaz a parancs utana futtat (egy szkript). ' +
  'Elrontott telepites helyreallitasa: docs/db-write-gate.md, "Vesz-helyreallitas" szakasz.' + LIMIT_MSG

export const SUBAGENT_FILE_GATE_MSG =
  'Telepites .env / kapu-szabalyfajl irasa TILTOTT (ENVRELAXGATE1104, sub-agensre). NEM irhatod a futo telepites ' +
  '.env fajljat (SUDO_AGENTS, MAIN_AGENT_ID es a kapuk lazito kapcsoloi innen jonnek), sem a store/provenance-gate-rules.json, ' +
  'store/outgoing-copy-gate-rules.json, store/credential-gate.json, store/egress-measure-hosts.json es ' +
  'store/.fleet-memgate-observe fajlt, sem a SAJAT projekt-konyvtarad .claude/settings.json es settings.local.json fajljat, sem a SAJAT CLAUDE_CONFIG_DIR settings.json es settings.local.json fajljat, sem a ~/.claude/settings.json es settings.local.json fajlt ' +
  '(ott elnek a kapu-hookjaid), sem a fo agens izolalt config-konyvtaranak (.channels-config) egyetlen valodi fajljat (settings.json, settings.local.json, .claude.json, plugins/*.json), ' +
  'sem egy MCP-szerverlistat (ENVRELAXMCPCFG1104: egy oda irt szerver a kovetkezo indulaskor parancskent fut): ' +
  'barmely agens agents/<nev>/.mcp.json es .claude-config/.claude.json fajljat, a SAJAT CLAUDE_CONFIG_DIR .claude.json-jat, ' +
  'a telepites .mcp.json fajljat es a ~/.claude.json-t, a `claude mcp add|add-json|remove` paranccsal sem (barmely --scope); ' +
  'amit ez a kapu NEM lat (limit): egy plugin sajat szerverlistajat (a plugin-mappa .mcp.json-ja, plugin.json mcpServers) es egy nem a szegmens elejen allo claude-ot: szkriptbol, bash -c / sh -c-bol, xargs-szal, $(which claude)-dal, valtozobol (C=claude; $C) vagy npx @anthropic-ai/claude-code alakban inditottat. ' +
  'Mindezt: letrehozni es torolni sem (Write/Edit, cp/mv/rm/tee/>/sed -i/python, symlinken vagy ..-on at sem). ' +
  'Olvasni szabad (cat/grep/sed -n/jq). Egy git worktree SAJAT .env-je szabad. Ha valtoztatas kell, kerd a fo agenst ' +
  '(inter-agent uzenet: melyik kulcs/fajl es miert); o a gazda jovahagyasaval irja.' + LIMIT_MSG

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
  'Fejleszteni worktree-ben kell: egy SAJAT, a telepitesen KIVULI worktree-ben minden git mehet (checkout, fetch, teszt), ' +
  'de a celt LITERALIS abszolut uttal add meg: "git -C /Users/marvin/<worktree> ..." vagy "cd /Users/marvin/<worktree> && git ..." ' +
  '(&&-vel). Valtozo ("-C $W") vagy $(...) eseten a kapu a celt nem ismeri, es a telepitesnek veszi; ugyanigy egy ' +
  ';-vel lancolt cd utan, ha a mappa most nem letezik (bukott cd utan a git a telepitesben futna; APPROVALDBGATE1030, Dani 60251). ' +
  'Elrontott prod fa helyreallitasa: ' + RESCUE_DOC + ', "Vesz-helyreallitas" szakasz ' +
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
    const verdict = await decideInWorker(payload?.tool_name, payload?.tool_input,
      {
        cwd: payload?.cwd,
        subAgent: isSubAgentCaller(process.env.CLAUDE_PROJECT_DIR, INSTALL_ROOT, process.env.CLAUDE_CONFIG_DIR || null),
        projectDir: process.env.CLAUDE_PROJECT_DIR || null,
        // the caller's user-level settings live in its config dir; unset, that is ~/.claude
        configDir: process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
      })
    if (verdict.error) deny(FAIL_CLOSED_MSG(verdict.error.split('\n')[0]))
    if (verdict.deny) {
      deny(verdict.reason === 'git' ? GIT_GATE_MSG : verdict.reason === 'install-file' ? INSTALL_FILE_GATE_MSG
        : verdict.reason === 'subagent-file' ? SUBAGENT_FILE_GATE_MSG : DB_GATE_MSG)
    }
    allow()
  } catch (err) {
    deny(FAIL_CLOSED_MSG(err?.message ?? err))
  }
}
