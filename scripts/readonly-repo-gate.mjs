#!/usr/bin/env node
// PreToolUse hard-gate: a worker may READ the project repos but never WRITE them.
//
// Why a hook and not a permissions deny-list. The two permission modes each
// fail one half of the requirement:
//
//   - strict:     path denies are enforced, but Claude Code prompts on things
//                 an allow-list cannot pre-approve (notably the `cd X && git …`
//                 compound, which trips the cd-guard). An UNATTENDED worker
//                 cannot answer a prompt, so it simply hangs -- observed twice
//                 on davinci-ocura and vermeer-ocura.
//   - permissive: nothing prompts, but the launcher passes
//                 --dangerously-skip-permissions, which BYPASSES allow/deny.
//                 A `Write(/home/ubuntu/projects/**)` deny is then decorative.
//
// Hooks run regardless of permission mode. So the worker runs permissive (never
// hangs) and this gate provides the actual enforcement.
//
// Scope comes from READONLY_REPO_ROOTS (colon-separated). The default is
// <home>/projects, derived at runtime -- a shipped script must not carry one
// install's absolute home path.
//
// This file ships the gate only. Wiring it into an agent's settings belongs
// with the (still open) decision on read-only worker profiles.
//
// What this gate is and is not: a static reading of the command string. It
// knows the common write verbs and resolves their targets, but it is not a
// sandbox -- an interpreter (`python3 -c`, `node -e`, `npx rimraf`) or a verb
// it does not list reaches the disk without it seeing a target.

import { readFileSync, realpathSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { resolve, join, dirname, relative, isAbsolute, sep } from 'node:path'

const HOME = homedir()

const ROOTS_RAW = (process.env.READONLY_REPO_ROOTS || join(HOME, 'projects'))
  .split(':').map(s => s.trim()).filter(Boolean).map(r => resolve(r))
// A root reached through a symlink must still count as the root, so compare
// against both the configured spelling and the physical path.
const ROOTS = [...new Set(ROOTS_RAW.flatMap(r => {
  try { return [r, realpathSync(r)] } catch { return [r] }
}))]

const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit'])

// The rule is "do not change the SOURCE", not "do not touch the filesystem".
// Dependency and build output live inside the repo but are not source: a QA
// worker that cannot run `npm ci` in a fresh worktree is not a QA worker.
// (Learned the hard way: blocking installs pushed a worker onto `npx prisma`,
// which fetched the registry's latest instead of the pinned version and made it
// diagnose a config problem that did not exist.)
const ARTIFACT_SEGMENTS = new Set([
  'node_modules', '.next', 'dist', 'build', 'out', 'coverage', '.turbo',
  '.cache', '.venv', '__pycache__', 'target', '.pytest_cache', '.nuxt',
  '.svelte-kit', '.output', 'tmp', '.parcel-cache',
])

// `~`, `$HOME` and `${HOME}` are the spellings of the home directory a shell
// expands before the command runs. Anything else starting with `$` or holding a
// backtick cannot be known statically.
function expandHome(p) {
  const s = String(p || '')
  if (s === '~' || s === '$HOME' || s === '${HOME}') return HOME
  const m = s.match(/^(~|\$HOME|\$\{HOME\})\/(.*)$/s)
  return m ? `${HOME}/${m[2]}` : s
}

// A path component the shell may still expand into something else: a brace
// list (`{..,x}`), a character class (`[.][.]`), a dot-glob that can match
// `..` (`.*`, `.?`), a variable or a command substitution. Such a component
// is never trusted to name an artifact directory.
function isOpaqueComponent(c) {
  return /[{}\[\]$`]/.test(c) || /^\.[*?]/.test(c)
}

// Resolve like the kernel does, not like the string looks: walk the
// components, follow each existing symlink, and apply `..` to the PHYSICAL
// parent. `dist/../src` is `src`; `node_modules/@ws/core/src`, where the
// workspace package is a symlink back into the repo, is the repo's source.
function physicalPath(p, cwd) {
  let raw = expandHome(p)
  if (!isAbsolute(raw)) {
    if (!cwd) return null
    raw = `${cwd}/${raw}`
  }
  let cur = '/'
  for (const c of raw.split('/')) {
    if (!c || c === '.') continue
    if (c === '..') { cur = dirname(cur); continue }
    const next = join(cur, c)
    try { cur = existsSync(next) ? realpathSync(next) : next } catch { cur = next }
  }
  return cur
}

function rootOf(abs) {
  if (!abs) return null
  return ROOTS.find(r => abs === r || abs.startsWith(r.endsWith(sep) ? r : r + sep)) || null
}

function underRoot(p, cwd = null) {
  return rootOf(physicalPath(p, cwd)) !== null
}

// An artifact TARGET: the resolved path lies under a protected root, one of
// its components BELOW the root is an artifact directory, and no component of
// what was written could still be expanded into something else.
function isArtifactTarget(p, cwd = null) {
  const raw = expandHome(p)
  if (raw.split('/').some(isOpaqueComponent)) return false
  const abs = physicalPath(raw, cwd)
  const root = rootOf(abs)
  if (!root) return false
  return relative(root, abs).split(sep).some(seg => ARTIFACT_SEGMENTS.has(seg))
}

// Package-manager installs are allowed, but ONLY the exact install command
// (maintainer decision on #770, 2026-09-25):
//
//   npm install | npm ci | yarn install | yarn | pnpm install
//
// The match is anchored to the WHOLE segment. An earlier form was a substring
// test, and its yarn branch read `yarn\s+(install)?\b`: the optional group
// plus the word boundary matched `yarn ` + anything, so `yarn add left-pad`
// and `yarn exec rm -rf src` skipped the gate's inspection entirely (found in
// review on #770). Anchoring closes the same hole for every manager at once:
// `npm install evil-pkg`, `npm ci > src/x` and `pnpm install && ...` tail are
// no longer "the install", they are judged like any other segment -- and
// PM_MUTATING_RX below refuses them inside a protected root.
//
// Flags: an install followed ONLY by flags from INSTALL_FLAGS is still the
// exact install (`npm ci --include=dev`, `yarn install --frozen-lockfile`).
// It is an allowlist on purpose: the flags a denylist would have to know about
// are the ones that move where the install writes (`--prefix`, `--cwd`,
// `--modules-folder=src`, `--dir`, `-C`, `-g`), and a flag this list does not
// know simply falls back to normal judgment. Values are restricted to plain
// words, so `--include=dev` passes and `--loglevel=../src` does not.
// Short aliases (`npm i`), env prefixes and other ecosystems (pip, poetry,
// bundle) are deliberately NOT exempt: the decision lists these five.
const INSTALL_RX = /^(npm\s+(install|ci)|yarn(\s+install)?|pnpm\s+install)((\s+\S+)*)$/
const INSTALL_FLAGS = new Set([
  'frozen-lockfile', 'prefer-frozen-lockfile', 'pure-lockfile', 'immutable',
  'prefer-offline', 'offline', 'no-audit', 'no-fund', 'ignore-scripts',
  'foreground-scripts', 'legacy-peer-deps', 'strict-peer-deps', 'production',
  'prod', 'silent', 'verbose', 'no-progress', 'non-interactive', 'check-files',
  'include', 'omit', 'loglevel', 'network-timeout', 'reporter',
])

function isInstallFlag(tok) {
  const m = tok.match(/^--([a-z][a-z-]*)(?:=([A-Za-z0-9_,+-]+))?$/)
  return !!m && INSTALL_FLAGS.has(m[1])
}

function isExactInstall(seg) {
  const m = String(seg || '').trim().match(INSTALL_RX)
  if (!m) return false
  const rest = m[4].trim()
  return rest === '' || rest.split(/\s+/).every(isInstallFlag)
}

// Branch movement is not a source edit -- a QA worker needs it for baseline
// comparison. `git checkout -- <path>` / `git restore <path>` IS a working-tree
// mutation, so those stay blocked. Anchored at the START of the segment: an
// unanchored match let `rm -rf src git checkout main` and
// `rm -rf src # git worktree list` skip the whole segment.
const GIT_SAFE_RX = /^git\s+(checkout|switch)\s+(?!.*(--\s|--\s*$))[^\s-][^\s]*\s*$|^git\s+(switch|checkout)\s+-b\s+[^\s;&|#<>]+\s*$|^git\s+worktree\s+(add|list|prune)\b[^#<>]*$/

// Bash is the wide-open route: a redirect or an in-place edit reaches the repo
// without ever touching the Write tool. Checked per segment so a read command
// in one half of a compound is not judged by the other half.
function splitSegments(cmd) {
  return String(cmd || '').split(/&&|\|\||;|\n|\|/).map(s => s.trim()).filter(Boolean)
}

// Minimal shell word splitter: quotes are removed, their content kept as one
// word. Subshell parentheses are peeled off the word they are glued to.
function shellWords(s) {
  const out = []
  const rx = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g
  let m
  while ((m = rx.exec(s))) {
    let w = m[1] ?? m[2] ?? m[3]
    if (m[3] !== undefined) w = w.replace(/^[({]+|[)}]+$/g, '')
    if (w) out.push(w)
  }
  return out
}

// Flags may come BEFORE the subcommand (`yarn --cwd src add x`,
// `npm --prefix src install x`, `pnpm -C src add x`), so a flag and its value
// are allowed in between. Bare `yarn` with anything but the allowlisted flags
// is an install into wherever those flags point (`yarn --cwd src`).
const PM_MUTATING_RX = /\b(npm|pnpm|yarn)(\s+-\S+(\s+[^-\s]\S*)?)*\s+(install|i|ci|add|remove|rm|uninstall|un|update|up|upgrade|link|unlink|patch|exec|dlx)\b|^yarn(\s+-\S+(\s+[^-\s]\S*)?)+\s*$/

const MUTATING_RX = [
  /\bsed\s+[^|]*-i\b/,                       // in-place edit
  /\b(rm|mv|cp|install|truncate|chmod|chown)\b/,
  /\btee\b/,
  /\bgit\s+(commit|push|reset|restore|clean|rm|mv|apply|stash)\b/,
  /\bgit\s+checkout\s+.*--\s/,
  /\bnpm\s+publish\b/,
  /\b(pnpm|yarn)\s+(add|remove)\b/,
  // Anything but the exact install (which never reaches this list): a package
  // added, removed or upgraded, an install with arguments, or an arbitrary
  // binary run through the manager (`yarn exec`, `yarn dlx`, `pnpm dlx`).
  PM_MUTATING_RX,
  /\bmkdir\b/,
  /\btouch\b/,
]

// `> file` / `>> file` -- capture the target so we only object when it lands in
// a protected root. `2>/dev/null` and friends are not file writes we care about.
const REDIRECT_RX = /(?<!\d)>>?\s*("[^"]+"|'[^']+'|[^\s;|&]+)/g
const ANY_REDIRECT_RX = /\d*(>>?|<)&?\s*("[^"]+"|'[^']+'|[^\s;|&]+)/g

// The words of a mutating segment that may name what it changes. The command
// word itself is not one of them (`./node_modules/.bin/yarn add x` runs a
// binary FROM an artifact directory, it does not target it), nor are leading
// `VAR=value` assignments or redirects (judged separately). Flags are skipped,
// except a `--flag=value` whose value is a path and a glued target-directory
// flag (`-tsrc`, `--target-directory=src`), which name a target themselves.
function targetWords(seg) {
  const words = shellWords(seg.replace(ANY_REDIRECT_RX, ' '))
  let i = 0
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++
  const out = []
  let endOfFlags = false
  for (const w of words.slice(i + 1)) {
    if (!endOfFlags && w === '--') { endOfFlags = true; continue }
    if (!endOfFlags && w.startsWith('--') && w.includes('=')) { out.push(w.slice(w.indexOf('=') + 1)); continue }
    if (!endOfFlags && /^-[A-Za-z]*t./.test(w) && !w.startsWith('--')) { out.push(w.replace(/^-[A-Za-z]*t/, '')); continue }
    if (!endOfFlags && w.startsWith('-') && w !== '-') continue
    out.push(w)
  }
  return out
}

function bashViolation(cmd, sessionCwd = null) {
  // The cwd carries ACROSS segments: `cd /repo && echo x > src/a.ts` puts the
  // redirect in a later segment than the cd, so judging segments in isolation
  // would wave it through. Track it. It also carries across CALLS: the Bash
  // tool's shell keeps its cwd, so `cd /repo` in one call and `yarn add x` in
  // the next must be judged from /repo. The hook payload's `cwd` seeds it.
  let cwd = sessionCwd || null
  const cmdMentionsRoot = ROOTS.some(r => String(cmd || '').includes(r)) ||
    /(^|[\s"'=])(~|\$HOME|\$\{HOME\})\//.test(String(cmd || ''))
  for (const seg of splitSegments(cmd)) {
    const cd = seg.match(/^\(?\s*(?:cd|pushd)(?:\s+-[LP])?(?:\s+("[^"]+"|'[^']+'|[^\s;|&()]+))?\s*$/)
    if (cd) {
      const to = cd[1] ? cd[1].replace(/^["']|["']$/g, '') : HOME
      cwd = physicalPath(to, cwd) || cwd
      continue
    }
    const cwdInRoot = !!cwd && underRoot(cwd)

    if (isExactInstall(seg) || GIT_SAFE_RX.test(seg)) continue

    for (const m of seg.matchAll(REDIRECT_RX)) {
      const target = m[1].replace(/^["']|["']$/g, '')
      if (target === '/dev/null') continue
      if (underRoot(target, cwd) && !isArtifactTarget(target, cwd)) {
        return `átirányítás a repóba: ${physicalPath(target, cwd)}`
      }
    }

    if (!MUTATING_RX.some(rx => rx.test(seg))) continue
    const shown = `módosító parancs a repóban: ${seg.slice(0, 120)}`

    // `... | xargs rm` takes its targets from the pipe, where nothing can be
    // judged per argument: refuse whenever the repo is anywhere in play.
    if (/\bxargs\b/.test(seg) && (cmdMentionsRoot || cwdInRoot)) return shown

    // The artifact exemption is decided PER TARGET, not per segment: every
    // word that resolves into a protected root must be an artifact path.
    // Judging the whole segment let `rm -rf src node_modules/.cache` through,
    // because one artifact word exempted the command that also deletes src.
    const targets = targetWords(seg)
    const inRootTargets = targets.filter(t => underRoot(t, cwd) ||
      (/[$`]/.test(t) && cwdInRoot))
    const touchesRoot = ROOTS.some(r => seg.includes(r)) || cwdInRoot || inRootTargets.length > 0
    if (!touchesRoot) continue
    if (inRootTargets.length === 0) {
      // Every target resolved OUTSIDE the roots (`rm -rf /tmp/x` run from
      // inside a repo) -- unless the segment names a root somewhere the
      // target list could not see it, or has no target at all.
      if (targets.length > 0 && !ROOTS.some(r => seg.includes(r))) continue
      return shown
    }
    if (!inRootTargets.every(t => isArtifactTarget(t, cwd))) return shown
  }
  return null
}

const GATE_MSG = (detail) =>
  `Írás a projekt repóba TILTOTT (readonly-repo-gate). ${detail}. ` +
  'A szereped olvasó: elemzel, tesztelsz, jelentesz -- a kódot nem te módosítod. ' +
  'Ha a feladathoz tényleg írni kellene, azt az orchestratorodnak jelezd, és ő ' +
  'vagy átadja a végrehajtónak, vagy bemásolja amit készítettél. Írni szabadon ' +
  'tudsz a saját agent-mappádba és a /tmp alá -- oda dolgozz.'

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
  try { payload = JSON.parse(readFileSync(0, 'utf-8')) } catch { allow() }

  const tool = payload?.tool_name
  const input = payload?.tool_input || {}

  if (WRITE_TOOLS.has(tool)) {
    const target = input.file_path || input.notebook_path || input.path
    const cwd = payload?.cwd || null
    if (underRoot(target, cwd) && !isArtifactTarget(target, cwd)) deny(GATE_MSG(`${tool} -> ${target}`))
  }

  if (tool === 'Bash') {
    const v = bashViolation(input.command, payload?.cwd)
    if (v) deny(GATE_MSG(v))
  }

  allow()
}

export { bashViolation, underRoot, isArtifactTarget, isExactInstall }
