import { existsSync, statSync, mkdirSync, rmSync, lstatSync, renameSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join, resolve, isAbsolute, basename, posix } from 'node:path'
import { execSync, execFileSync, spawn } from 'node:child_process'
import { PROJECT_ROOT } from '../config.js'
import { logger } from '../logger.js'
import { readFileOr } from './agent-config.js'
import { atomicWriteFileSync } from './atomic-write.js'

const SETTINGS_PATH = join(PROJECT_ROOT, 'store', 'dashboard-settings.json')
const GITHUB_REPOS_DIR = join(PROJECT_ROOT, 'store', 'github-repos')

interface GitHubRepo {
  url: string
  name: string
  path: string
  installedAt: string
  envVars?: Record<string, string>  // env key -> vault secret id
  // Operator's choice for npm lifecycle scripts; updates follow it. Missing
  // means the repo was installed before the choice existed, by a plain
  // `npm install` that ran every install script.
  runScripts?: boolean
  // With scripts off: the full set of install scripts last offered (root
  // hooks, binding.gyp, node_modules/<name>); an update offers again only
  // when the current set differs. Not stored after a failed npm run;
  // cleared once a scripted install completed (until then a scripted
  // update still rebuilds).
  scriptsSkipped?: string[]
}

interface DashboardSettings {
  externalProjectPaths?: string[]
  githubRepos?: GitHubRepo[]
}

function read(): DashboardSettings {
  try { return JSON.parse(readFileOr(SETTINGS_PATH, '{}')) }
  catch { return {} }
}

function write(s: DashboardSettings): void {
  atomicWriteFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2) + '\n')
}

export function getExternalProjectPaths(): string[] {
  return read().externalProjectPaths || []
}

export function addExternalProjectPath(raw: string): { paths: string[], error?: string } {
  if (!raw || !isAbsolute(raw)) return { paths: getExternalProjectPaths(), error: 'Absolute path required' }
  const p = resolve(raw)
  if (!existsSync(p) || !statSync(p).isDirectory()) return { paths: getExternalProjectPaths(), error: 'Directory does not exist' }
  const s = read()
  const list = s.externalProjectPaths || []
  if (list.includes(p)) return { paths: list }
  list.push(p)
  s.externalProjectPaths = list
  write(s)
  return { paths: list }
}

export function removeExternalProjectPath(raw: string): string[] {
  const p = resolve(raw)
  const s = read()
  s.externalProjectPaths = (s.externalProjectPaths || []).filter(x => x !== p)
  write(s)
  return s.externalProjectPaths
}

// --- GitHub repo management ---

const GITHUB_URL_RE = /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/.*)?$/

function parseGitHubUrl(url: string): { owner: string, repo: string } | null {
  const m = url.match(GITHUB_URL_RE)
  if (!m) return null
  return { owner: m[1], repo: m[2] }
}

// npm arguments for installing a cloned connector repo. By default the
// lifecycle scripts (preinstall/install/postinstall/prepare) of the repo and
// of every dependency are skipped: they would run third-party code on the
// host before the operator has looked at the repo. Only a real boolean `true`
// turns them back on. `--omit=dev` is the non-deprecated spelling of
// `--production` (npm 7+), same dependency selection.
//
// The pinned keys below are config values that, when set by a file npm reads
// (the repo's own .npmrc is set aside, see withRepoNpmrcSetAside, but the
// user/global files are read too), turn an install into code execution or a
// write outside the repo. CLI values beat every config file:
//   git          executable npm spawns for git dependencies (`git=./x.sh`)
//   global,      `global=true` / `location=global` install the repo globally
//   location     and link its bins into the global bin directory
//   node-options NODE_OPTIONS (e.g. `--require`) for processes npm spawns
// and the keys that would make the installed tree differ from the lockfile
// the resolve pass wrote and validated (see runConnectorNpmInstall):
//   package-lock   false ignores the lockfile and re-resolves on install
//   install-strategy, global-style, legacy-bundling
//                  node_modules layout (the deprecated two override the
//                  first, so all three are pinned to the default layout)
//   install-links  true packs file: deps instead of linking them
//   dry-run        true makes the resolve pass write no lockfile
// Registry, auth, proxy and resolution policy (before, legacy-peer-deps,
// workspaces, ...) are left to the operator: both passes get the same
// values, so the validated tree is the installed tree.
export const CONNECTOR_NPM_PINNED_ARGS = [
  '--git=git', '--global=false', '--location=project', '--node-options=',
  '--package-lock=true', '--install-strategy=hoisted', '--global-style=false', '--legacy-bundling=false',
  '--install-links=false', '--dry-run=false',
]

// The real install. The opt-in states ignore-scripts explicitly too, so an
// operator `ignore-scripts=true` cannot silently turn the ticked box off.
export function connectorInstallArgs(opts: { runScripts?: boolean } = {}): string[] {
  const scripts = opts.runScripts === true ? '--ignore-scripts=false' : '--ignore-scripts'
  return ['install', '--omit=dev', scripts, ...CONNECTOR_NPM_PINNED_ARGS, '--package-lock-only=false']
}

// Lifecycle hooks npm runs for the root package on a local `npm install`.
const ROOT_INSTALL_HOOKS = ['preinstall', 'install', 'postinstall', 'preprepare', 'prepare', 'postprepare']
const MAX_SKIPPED_LISTED = 20

// What an install with `--ignore-scripts` did not run: root hooks declared in
// package.json, the implicit `node-gyp rebuild` of a root binding.gyp, the
// same hooks of workspace packages (as `<path>: <hook>`; a scripted install
// runs them every time, like the root's), and dependencies npm marked
// `hasInstallScript` in its hidden lockfile (node_modules/.package-lock.json),
// as `node_modules/<name>` for the names a rebuild can pass to npm. Inputs are
// parsed JSON or anything else (unreadable files), never trusted to have a
// shape. The full list is stored; only what is shown is cut short
// (skippedForDisplay).
export function skippedInstallScripts(input: { pkg: unknown, hasBindingGyp: boolean, hiddenLock: unknown, workspaces?: Record<string, unknown> }): string[] {
  const hooks = (pkg: unknown) => {
    const scripts = (pkg as { scripts?: unknown } | null)?.scripts
    if (!scripts || typeof scripts !== 'object') return []
    return ROOT_INSTALL_HOOKS.filter(h => { const v = (scripts as Record<string, unknown>)[h]; return typeof v === 'string' && v.trim() })
  }
  const out = hooks(input.pkg)
  if (input.hasBindingGyp) out.push('binding.gyp')
  for (const [path, pkg] of Object.entries(input.workspaces || {}).sort(([a], [b]) => a.localeCompare(b))) {
    for (const h of hooks(pkg)) out.push(`${path}: ${h}`)
  }
  return [...out, ...rebuildTargets(input.hiddenLock).names.map(n => `node_modules/${n}`)]
}

// Which dirs are workspaces is npm's call (its pattern rules are not
// re-implemented here): after the default install, `npm query .workspace`
// lists them; `location` is the path relative to the repo.
export function connectorWorkspaceQueryArgs(): string[] {
  return ['query', '.workspace', '--json', '--ignore-scripts', ...CONNECTOR_NPM_PINNED_ARGS]
}

// Workspace paths from `npm query .workspace --json` output, kept inside the
// repo; null when the output is not such a list.
export function parseWorkspaceQuery(stdout: string): string[] | null {
  let items: unknown
  try { items = JSON.parse(stdout) } catch { return null }
  if (!Array.isArray(items)) return null
  const out = new Set<string>()
  for (const it of items) {
    const loc = (it as { location?: unknown } | null)?.location
    if (typeof loc === 'string' && loc && !lockPathLeavesRepo(loc)) out.add(loc)
  }
  return [...out].sort()
}

export function skippedForDisplay(list: string[]): string[] {
  if (list.length <= MAX_SKIPPED_LISTED) return list
  return [...list.slice(0, MAX_SKIPPED_LISTED), `+${list.length - MAX_SKIPPED_LISTED} more`]
}

export function sameSkippedSet(a: string[] = [], b: string[] = []): boolean {
  return [...a].sort().join('\0') === [...b].sort().join('\0')
}

function readJsonOrNull(path: string): unknown {
  try { return JSON.parse(readFileOr(path, 'null')) } catch { return null }
}

function detectSkippedInstallScripts(dir: string, workspaces: string[]): string[] {
  return skippedInstallScripts({
    pkg: readJsonOrNull(join(dir, 'package.json')),
    hasBindingGyp: existsSync(join(dir, 'binding.gyp')),
    hiddenLock: readJsonOrNull(join(dir, 'node_modules', '.package-lock.json')),
    workspaces: Object.fromEntries(workspaces.map(p => [p, readJsonOrNull(join(dir, p, 'package.json'))])),
  })
}

// Runs `fn` with the repo's own `.npmrc` (project config) moved aside, and
// puts it back afterwards. npm has no flag to skip the project config file,
// and that file can set any key (git, global, userconfig, registry, ...), so
// it is not consulted at all. Fails closed: if the file exists and cannot be
// moved, `fn` is not run.
export function withRepoNpmrcSetAside<T>(dir: string, fn: () => T): T {
  const npmrc = join(dir, '.npmrc')
  try { lstatSync(npmrc) } catch { return fn() }
  const aside = join(dir, `.npmrc.set-aside-${process.pid}-${randomBytes(4).toString('hex')}`)
  try {
    renameSync(npmrc, aside)
  } catch (err: any) {
    throw new NpmInstallRefused(`could not set the repository .npmrc aside: ${err.message}`)
  }
  try {
    return fn()
  } finally {
    try { renameSync(aside, npmrc) } catch (err: any) {
      logger.warn({ err: err.message, dir }, 'could not restore the repository .npmrc after npm install')
    }
  }
}

// npm was deliberately not run (not an npm failure).
export class NpmInstallRefused extends Error {}

// Before npm touches anything, a repo is refused when:
// - git tracks any symlink (mode 120000), wherever it points: npm treats a
//   link's target as part of the project and can write through it (a
//   `file:./link` dependency, a workspace, node_modules entries, even
//   package-lock.json itself). Decided from git's index, nothing resolved.
// - the dependency tree npm resolves leaves the repo. npm is the parser:
//   a first `npm install --package-lock-only` pass writes the lockfile
//   without creating node_modules or links, and every package location in
//   it must stay inside the repo (keys, link targets, `file:` sources).
//   This covers the repo's own package.json and workspaces as well as specs
//   inside fetched dependencies and a yarn.lock npm picked up.
// The path checks are lexical, which is exact because no committed link is
// left that could redirect them.

// Paths `git ls-files -s -z` lists, optionally only those with `mode`.
export function trackedPaths(lsFilesStage: string, mode?: string): string[] {
  const out: string[] = []
  for (const rec of lsFilesStage.split('\0')) {
    const tab = rec.indexOf('\t')
    if (tab >= 0 && (!mode || rec.slice(0, tab).split(' ')[0] === mode)) out.push(rec.slice(tab + 1))
  }
  return out
}

export function trackedSymlinkPaths(lsFilesStage: string): string[] {
  return trackedPaths(lsFilesStage, '120000')
}

function gitStage(repoDir: string): string {
  try {
    return String(execFileSync('git', ['ls-files', '-s', '-z'], { cwd: repoDir, encoding: 'utf-8', stdio: 'pipe', timeout: 60000 }))
  } catch (err: any) {
    throw new NpmInstallRefused(`could not list the files git tracks: ${err.message}`)
  }
}

function trackedSymlinkRefusal(stage: string): string | undefined {
  const links = trackedSymlinkPaths(stage)
  if (links.length === 0) return undefined
  return `the repository contains symlinks (${links.slice(0, 3).join(', ')}${links.length > 3 ? ', ...' : ''})`
}

// True when the lockfile path `p` (relative to the repo root, as npm writes
// it) leaves the repo.
export function lockPathLeavesRepo(p: string): boolean {
  const q = p.replace(/\\/g, '/')
  if (q.startsWith('/') || q.startsWith('~') || /^[a-zA-Z]:/.test(q)) return true
  const n = posix.normalize(q)
  return n === '..' || n.startsWith('../')
}

// Package locations of a v2+ lockfile (any with a `packages` map; npm 12
// may write v4) that leave the repo: an entry key, the target of a link
// entry, or a `file:` source. Returns
// null when the content is not such a lockfile (refused by the caller).
export function lockfileEscapes(lock: unknown): string[] | null {
  const packages = (lock as { packages?: unknown } | null)?.packages
  if (!packages || typeof packages !== 'object' || Array.isArray(packages)) return null
  const out: string[] = []
  for (const [key, e] of Object.entries(packages as Record<string, any>)) {
    if (!e || typeof e !== 'object') return null
    if (key && lockPathLeavesRepo(key)) { out.push(key); continue }
    const resolved = e.resolved
    if (e.link === true && (typeof resolved !== 'string' || lockPathLeavesRepo(resolved))) out.push(`${key} -> ${resolved}`)
    else if (typeof resolved === 'string' && /^file:/i.test(resolved) && lockPathLeavesRepo(resolved.slice(5))) out.push(`${key} -> ${resolved}`)
  }
  return out
}

const LOCKFILES = ['npm-shrinkwrap.json', 'package-lock.json', join('node_modules', '.package-lock.json')]

// Validates every lockfile present after the --package-lock-only pass.
// A missing or unreadable lockfile refuses too.
export function lockfileRefusalReason(repoDir: string): string | undefined {
  if (!existsSync(join(repoDir, 'package-lock.json')) && !existsSync(join(repoDir, 'npm-shrinkwrap.json'))) {
    return 'npm did not write a lockfile'
  }
  const out: string[] = []
  for (const name of LOCKFILES) {
    const file = join(repoDir, name)
    if (!existsSync(file)) continue
    let escapes: string[] | null
    try { escapes = lockfileEscapes(JSON.parse(readFileOr(file, ''))) } catch { escapes = null }
    if (escapes === null) return `could not read ${name}`
    for (const x of escapes) out.push(`${name}: ${x}`)
  }
  if (out.length === 0) return undefined
  return `the resolved dependency tree points outside the repository (${out.slice(0, 3).join(', ')}${out.length > 3 ? ', ...' : ''})`
}

// Request-body validation for the `runScripts` opt-in: absent means "not
// specified", a boolean is taken as is, anything else is rejected so that a
// truthy string like "false" can never enable script execution.
export function parseRunScriptsFlag(v: unknown): { value?: boolean, error?: string } {
  if (v === undefined) return {}
  if (typeof v === 'boolean') return { value: v }
  return { error: 'runScripts must be a boolean' }
}

// The resolve pass: never runs scripts. --save=true: with save=false in the
// operator's npm config npm would write no lockfile, and the committed one
// would be validated instead.
export function connectorLockOnlyArgs(): string[] {
  return ['install', '--omit=dev', '--ignore-scripts', ...CONNECTOR_NPM_PINNED_ARGS, '--package-lock-only', '--save=true']
}

// npm only builds packages an install adds or changes, so dependencies
// installed earlier with scripts skipped stay unbuilt when the opt-in is
// turned on later. They are rebuilt by name: a bare `npm rebuild` would run
// the root's install hooks a second time (the scripted install ran them).
// Names come from npm's hidden lockfile (`hasInstallScript`). npm parses
// each argument with npm-package-arg, which reads some valid names as
// something else (an unscoped name ending in .tgz/.tar/.tar.gz is a file
// spec) and would fail the whole rebuild; so only names it reads as a plain
// registry name are passed (rules from npm-package-arg 14 and
// validate-npm-package-name 8: url-safe, no leading dot/underscore/hyphen,
// not node_modules/favicon.ico), which also keeps them from being flags.
// The rest is reported as skipped (left unbuilt).
export function isPlainPackageName(name: string): boolean {
  const m = /^(@[A-Za-z0-9~][\w.~-]*\/)?([A-Za-z0-9~][\w.~-]*)$/.exec(name)
  if (!m) return false
  if (!m[1] && /[.](?:tgz|tar\.gz|tar)$/i.test(name)) return false
  return !['node_modules', 'favicon.ico'].includes(name.toLowerCase())
}

export function rebuildTargets(hiddenLock: unknown): { names: string[], skipped: string[] } {
  const packages = (hiddenLock as { packages?: unknown } | null)?.packages
  const names = new Set<string>()
  const skipped = new Set<string>()
  if (packages && typeof packages === 'object') {
    for (const [key, e] of Object.entries(packages as Record<string, any>)) {
      const i = key.lastIndexOf('node_modules/')
      if (i < 0 || e?.hasInstallScript !== true) continue
      const name = key.slice(i + 'node_modules/'.length)
      if (isPlainPackageName(name)) names.add(name)
      else skipped.add(key)
    }
  }
  return { names: [...names].sort(), skipped: [...skipped].sort() }
}

export function connectorRebuildArgs(names: string[]): string[] {
  return ['rebuild', '--ignore-scripts=false', ...CONNECTOR_NPM_PINNED_ARGS, ...names]
}

// The root lockfiles git can see. npm rewrites a stale committed one (a
// plain install did that before this change too), and the resolve pass
// writes one even where a plain install would not (repo .npmrc
// package-lock=false, operator save=false); left behind, a modified tracked
// or a new untracked one makes a later `git pull --ff-only` fail as soon as
// upstream changes it. So after npm, whatever happened, tracked ones are
// restored from git and ones this run created are removed (validation has
// already read what npm wrote). node_modules and its hidden lockfile stay.
// "Tracked" is an exact path match against the index (root files only).
const GIT_LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json']

function restoreGitLockfiles(cwd: string, before: Array<{ name: string, tracked: boolean, existed: boolean }>): void {
  for (const f of before) {
    try {
      if (f.tracked) execFileSync('git', ['checkout', '--', f.name], { cwd, encoding: 'utf-8', stdio: 'pipe', timeout: 60000 })
      else if (!f.existed) rmSync(join(cwd, f.name), { force: true })
    } catch (err: any) {
      logger.warn({ err: err.message, cwd, file: f.name }, 'could not restore the lockfile after npm install')
    }
  }
}

// Returns the workspace paths npm reported after a default install (scripts
// off), for the skipped-scripts report; [] otherwise.
function runConnectorNpmInstall(cwd: string, runScripts: boolean, timeout: number, opts: { rebuild?: boolean, onInstalled?: () => void } = {}): string[] {
  const stage = gitStage(cwd)
  const refusal = trackedSymlinkRefusal(stage)
  if (refusal) throw new NpmInstallRefused(refusal)
  const tracked = trackedPaths(stage)
  const before = GIT_LOCKFILES.map(name => ({ name, tracked: tracked.includes(name), existed: existsSync(join(cwd, name)) }))
  try {
    return npmPasses(cwd, runScripts, timeout, opts)
  } finally {
    restoreGitLockfiles(cwd, before)
  }
}

function npmPasses(cwd: string, runScripts: boolean, timeout: number, opts: { rebuild?: boolean, onInstalled?: () => void }): string[] {
  const npm = (args: string[]) => String(execFileSync('npm', args, { cwd, timeout, encoding: 'utf-8', stdio: 'pipe' }))
  return withRepoNpmrcSetAside(cwd, () => {
    npm(connectorLockOnlyArgs())
    const lockRefusal = lockfileRefusalReason(cwd)
    // The resolve pass rewrites the hidden lockfile to the new ideal tree;
    // left in place, the real install would trust it over the package dirs
    // on disk and skip changed versions ("up to date"). npm rebuilds it.
    rmSync(join(cwd, 'node_modules', '.package-lock.json'), { force: true })
    if (lockRefusal) throw new NpmInstallRefused(lockRefusal)
    npm(connectorInstallArgs({ runScripts }))
    opts.onInstalled?.()
    if (runScripts && opts.rebuild) {
      const { names, skipped } = rebuildTargets(readJsonOrNull(join(cwd, 'node_modules', '.package-lock.json')))
      if (skipped.length > 0) logger.warn({ cwd, skipped }, 'not rebuilt: npm would not read these as package names')
      if (names.length > 0) npm(connectorRebuildArgs(names))
    }
    if (runScripts) return []
    let workspaces: string[] | null = null
    try { workspaces = parseWorkspaceQuery(npm(connectorWorkspaceQueryArgs())) } catch { /* reported below */ }
    if (workspaces === null) logger.warn({ cwd }, 'npm query .workspace failed: workspace install hooks not listed')
    return workspaces ?? []
  })
}

function npmFailureText(err: any): string {
  const raw = String(err?.stderr || err?.stdout || err?.message || 'unknown error').trim()
  return raw.length > 500 ? '...' + raw.slice(-500) : raw
}

export function getGitHubRepos(): GitHubRepo[] {
  return read().githubRepos || []
}

export interface GitHubInstallProgress {
  stage: 'cloning' | 'installing' | 'done' | 'error'
  message: string
}

export function detectRequiredEnvVars(repoPath: string): string[] {
  const mcpJsonPath = join(repoPath, '.mcp.json')
  if (!existsSync(mcpJsonPath)) return []
  try {
    const parsed = JSON.parse(readFileOr(mcpJsonPath, '{}'))
    const servers = parsed.mcpServers || {}
    const vars = new Set<string>()
    for (const cfg of Object.values(servers) as any[]) {
      for (const key of Object.keys(cfg?.env || {})) vars.add(key)
    }
    return [...vars]
  } catch { return [] }
}

export async function installGitHubRepo(
  url: string,
  envVars?: Record<string, string>,
  onProgress?: (p: GitHubInstallProgress) => void,
  opts: { runScripts?: boolean } = {},
): Promise<{ repo: GitHubRepo, requiredEnvVars?: string[], installWarning?: string, scriptsSkipped?: string[], error?: never } | { repo?: never, requiredEnvVars?: string[], installWarning?: never, scriptsSkipped?: never, error: string }> {
  const runScripts = opts.runScripts === true
  const parsed = parseGitHubUrl(url)
  if (!parsed) return { error: 'Invalid GitHub URL' }

  const repoName = `${parsed.owner}--${parsed.repo}`
  const targetDir = join(GITHUB_REPOS_DIR, repoName)

  if (existsSync(targetDir)) {
    const existing = getGitHubRepos().find(r => r.name === repoName)
    if (existing) return { error: `Already installed: ${repoName}` }
    rmSync(targetDir, { recursive: true, force: true })
  }

  mkdirSync(GITHUB_REPOS_DIR, { recursive: true })

  const cloneUrl = `https://github.com/${parsed.owner}/${parsed.repo}.git`

  onProgress?.({ stage: 'cloning', message: `Cloning ${parsed.owner}/${parsed.repo}...` })
  try {
    execSync(`git clone --depth 1 ${cloneUrl} ${targetDir}`, {
      timeout: 120000,
      stdio: 'pipe',
      encoding: 'utf-8',
    })
  } catch (err: any) {
    rmSync(targetDir, { recursive: true, force: true })
    return { error: `Clone failed: ${err.stderr || err.message}` }
  }

  let installWarning: string | undefined
  let refused = false
  let workspaces: string[] = []
  let scriptsSkipped: string[] = []
  const hasPackageJson = existsSync(join(targetDir, 'package.json'))
  if (hasPackageJson) {
    onProgress?.({ stage: 'installing', message: 'Running npm install...' })
    try {
      workspaces = runConnectorNpmInstall(targetDir, runScripts, 180000)
    } catch (err: any) {
      logger.warn({ err: err.message }, 'npm install failed for GitHub repo, continuing anyway')
      refused = err instanceof NpmInstallRefused
      installWarning = refused ? `npm install not run: ${err.message}` : `npm install failed: ${npmFailureText(err)}`
    }
    // Not when npm was refused: offering (and persisting) the opt-in there
    // would run scripts on a later update once the refusal reason is gone.
    if (!runScripts && !refused) scriptsSkipped = detectSkippedInstallScripts(targetDir, workspaces)
  }

  const requiredEnvVars = detectRequiredEnvVars(targetDir)

  const repo: GitHubRepo = {
    url,
    name: repoName,
    path: targetDir,
    installedAt: new Date().toISOString(),
    envVars: envVars || undefined,
    runScripts,
    // Only an install that completed counts as "reported": after a failure
    // the UI shows the error instead, and the next update offers the list.
    ...(scriptsSkipped.length > 0 && !installWarning ? { scriptsSkipped } : {}),
  }

  const s = read()
  const repos = s.githubRepos || []
  repos.push(repo)
  s.githubRepos = repos
  const paths = s.externalProjectPaths || []
  if (!paths.includes(targetDir)) {
    paths.push(targetDir)
    s.externalProjectPaths = paths
  }
  write(s)

  onProgress?.({ stage: 'done', message: `Installed ${repoName}` })
  return {
    repo,
    requiredEnvVars: requiredEnvVars.length > 0 ? requiredEnvVars : undefined,
    ...(installWarning ? { installWarning } : {}),
    ...(scriptsSkipped.length > 0 ? { scriptsSkipped: skippedForDisplay(scriptsSkipped) } : {}),
  }
}

export function removeGitHubRepo(name: string): { ok: boolean, error?: string } {
  const s = read()
  const repos = s.githubRepos || []
  const idx = repos.findIndex(r => r.name === name)
  if (idx === -1) return { ok: false, error: 'Repo not found' }

  const repo = repos[idx]
  if (existsSync(repo.path)) {
    rmSync(repo.path, { recursive: true, force: true })
  }

  repos.splice(idx, 1)
  s.githubRepos = repos
  s.externalProjectPaths = (s.externalProjectPaths || []).filter(p => p !== repo.path)
  write(s)
  return { ok: true }
}

// `opts.runScripts` (a real boolean) overrides and persists the per-repo
// choice; when absent the update follows the stored one (missing on repos
// installed before the choice existed: scripts skipped from now on).
// `scriptsSkipped` (cut for display) lists the install scripts that may not
// have run, so the caller can offer the opt-in; returned only when that set
// differs from the one stored (offered) last time.
export function updateGitHubRepo(name: string, opts: { runScripts?: boolean } = {}): { ok: boolean, error?: string, scriptsSkipped?: string[] } {
  const s = read()
  const repos = s.githubRepos || []
  const repo = repos.find(r => r.name === name)
  if (!repo) return { ok: false, error: 'Repo not found' }
  if (!existsSync(repo.path)) return { ok: false, error: 'Directory missing' }

  // Turning the opt-in on rebuilds every dependency with an install script
  // after the scripted install (npm only builds what an install adds or
  // changes; rebuilding a built one is harmless). Still pending if the last
  // scripted install did not complete (stored list kept); the list is
  // cleared as soon as it did, so a failing rebuild is reported once and
  // not repeated by every later update.
  const known = repo.scriptsSkipped || []
  const rebuild = repo.runScripts !== true || known.length > 0
  if (typeof opts.runScripts === 'boolean' && repo.runScripts !== opts.runScripts) {
    repo.runScripts = opts.runScripts
    s.githubRepos = repos
    write(s)
  }
  const runScripts = repo.runScripts === true

  try {
    execSync('git pull --ff-only 2>&1', { cwd: repo.path, timeout: 60000, encoding: 'utf-8', stdio: 'pipe' })
    if (existsSync(join(repo.path, 'package.json'))) {
      const workspaces = runConnectorNpmInstall(repo.path, runScripts, 120000, {
        rebuild,
        onInstalled: () => {
          if (!runScripts || !repo.scriptsSkipped) return
          repo.scriptsSkipped = undefined
          s.githubRepos = repos
          write(s)
        },
      })
      // Scripts off: offer the opt-in only when the set differs from the
      // one stored (offered) last time.
      if (!runScripts) {
        const detected = detectSkippedInstallScripts(repo.path, workspaces)
        if (!sameSkippedSet(detected, known)) {
          repo.scriptsSkipped = detected.length > 0 ? detected : undefined
          s.githubRepos = repos
          write(s)
          if (detected.length > 0) {
            return { ok: true, scriptsSkipped: skippedForDisplay(detected) }
          }
        }
      }
    }
    return { ok: true }
  } catch (err: any) {
    if (err instanceof NpmInstallRefused) return { ok: false, error: `pulled, but npm install not run: ${err.message}` }
    return { ok: false, error: err.stderr || err.message }
  }
}
