// Agent package update: the change list, its planId and the decision check (MIOAGENTB4-1122, PR-I4; plan 8.1-8.3, 8.5).
//
// `check` and `apply` compute the SAME change list from three inputs: the installed record's file hashes (O), the new
// verified package (N) and the disk (D). Only the package layer's text files are items (PACKAGE.md, SOUL.md, the skill
// files): the shell, LOCAL.md, the record and the avatar never are (plan 8.3). The disk is read with lstat on every
// path component first, so a link never makes the server read or write outside the agent directory (8.3 "blocked").
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { STORE_DIR } from '../../config.js'
import { logger } from '../../logger.js'
import { canonicalJson } from '../../skill-cli-core.js'
import { atomicWriteFileSync } from '../atomic-write.js'
import { fleetRosterBlock } from '../agent-scaffold.js'
import { SKILL_SCAN_PATTERNS, globalSkillsRoot } from '../skill-quarantine.js'
import { hasLaunchTrace, isBlankBytes, isInstallableName, manifestPathOf, startsWithPackageShell } from './marker.js'
import { TEXT_PATH_RE, compareVersions, type VerifiedPackage } from './verify.js'
import {
  manifestRecordText, mkdirInsideAgentDir, packageShellText, payloadPathToDisk, writeLocalIfAbsent, type PackageManifest,
} from './install.js'

export type UpdateKind = 'upgrade' | 'repair'
export type ItemState = 'clean' | 'current' | 'modified' | 'missing' | 'absent' | 'foreign' | 'blocked'
export type ItemAction = 'write' | 'delete' | 'keep' | 'decide'
export type Choice = 'take-package' | 'keep-mine'
export const BOTH_CHOICES: readonly Choice[] = Object.freeze(['take-package', 'keep-mine'] as const)

export interface ItemTexts {
  disk: string | null
  package: string | null
  diskTruncated: boolean
  diskBinary?: true
}

export interface ChangeItem {
  path: string
  disk: string
  state: ItemState
  action: ItemAction
  installedSha256: string | null
  diskSha256: string | null
  newSha256: string | null
  choices: Choice[] | null
  texts: ItemTexts | null
  /** Plan 8.5: the item belongs to its skill folder's ONE decision (quarantine on). Not part of the planId. */
  folder?: string
}

export interface SkillFolder {
  folder: string
  action: 'decide'
  choices: Choice[]
  paths: string[]
  filePaths: string[]
  mixedWarning: boolean
}

export interface ChangeList {
  name: string
  slug: string
  kind: UpdateKind
  installed: { version: string; payloadSha256: string }
  available: { version: string; payloadSha256: string; minMarveenVersion: string }
  planId: string
  items: ChangeItem[]
  summary: { write: number; delete: number; keep: number; decide: number }
  skillFolders: SkillFolder[]
}

/** Plan 8.2: the disk text in a decide item is at most 256 KiB. */
export const DISK_TEXT_MAX_BYTES = 256 * 1024

const sha256Hex = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')

// ---------------------------------------------------------------------------
// 8.1 Kind
// ---------------------------------------------------------------------------

export type Classified = { ok: true; kind: UpdateKind } | { ok: false; error: 'version_conflict' | 'downgrade_refused' }

/** Plan 8.1: higher = upgrade; equal with the same payload hash = repair; equal otherwise = conflict; lower = refused. */
export function classifyVersion(installed: { version: string; payloadSha256: string }, available: { version: string; payloadSha256: string }): Classified {
  const c = compareVersions(available.version, installed.version)
  if (c > 0) return { ok: true, kind: 'upgrade' }
  if (c < 0) return { ok: false, error: 'downgrade_refused' }
  return available.payloadSha256 === installed.payloadSha256 ? { ok: true, kind: 'repair' } : { ok: false, error: 'version_conflict' }
}

// ---------------------------------------------------------------------------
// The installed record's file hashes (O)
// ---------------------------------------------------------------------------

/** payload path -> sha256 of the record's text files; null when the record's file list is not the contract's shape. */
export function installedFileHashes(m: PackageManifest): Map<string, string> | null {
  const files = m.payload.files
  if (!Array.isArray(files)) return null
  const out = new Map<string, string>()
  for (const f of files) {
    if (f === null || typeof f !== 'object' || Array.isArray(f)) return null
    const { path, sha256 } = f as { path?: unknown; sha256?: unknown }
    if (typeof path !== 'string' || !TEXT_PATH_RE.test(path) || typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return null
    if (out.has(path)) return null
    out.set(path, sha256)
  }
  return out
}

// ---------------------------------------------------------------------------
// The disk (D), read without following a link (8.3 "blocked")
// ---------------------------------------------------------------------------

export type DiskEntry = { kind: 'missing' } | { kind: 'blocked' } | { kind: 'file'; bytes: Buffer }

/**
 * Every component of `diskRel` under `agentDir` is lstat-ed BEFORE the file is read. An existing link, a non-folder
 * parent, a target that is not a plain file, or an unreadable one: blocked. A component that does not exist: missing
 * (IR10: a missing file or a new skill is not blocked).
 */
export function readDiskEntry(agentDir: string, diskRel: string): DiskEntry {
  const parts = diskRel.split('/')
  let cur = agentDir
  for (let i = 0; i < parts.length; i++) {
    cur = join(cur, parts[i])
    let st
    try {
      st = lstatSync(cur)
    } catch (err) {
      return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? { kind: 'missing' } : { kind: 'blocked' }
    }
    if (st.isSymbolicLink()) return { kind: 'blocked' }
    if (i < parts.length - 1 ? !st.isDirectory() : !st.isFile()) return { kind: 'blocked' }
  }
  try {
    return { kind: 'file', bytes: readFileSync(cur) }
  } catch {
    return { kind: 'blocked' }
  }
}

// ---------------------------------------------------------------------------
// 8.3 / 8.5 The items
// ---------------------------------------------------------------------------

/** Plan 8.5 (B2): the ONE function that gives a path's folder key; check and apply both call it, nothing is normalized. */
export function folderKeyOf(path: string): string | null {
  const parts = path.split('/')
  return parts[0] === 'skills' && parts.length >= 3 ? `skills/${parts[1]}/` : null
}

/** The disk text of a decide item (8.2): cut at a code point within 256 KiB; invalid UTF-8 is not decoded at all. */
export function diskTextOf(bytes: Buffer): Pick<ItemTexts, 'disk' | 'diskTruncated' | 'diskBinary'> {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return { disk: null, diskTruncated: false, diskBinary: true }
  }
  if (bytes.length <= DISK_TEXT_MAX_BYTES) return { disk: text, diskTruncated: false }
  let end = DISK_TEXT_MAX_BYTES
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--
  return { disk: bytes.subarray(0, end).toString('utf8'), diskTruncated: true }
}

export interface ItemInput {
  path: string
  /** O: the hash in the installed record, or null. */
  o: string | null
  /** N: the new package's text, or null when the new package does not have the path. */
  n: { sha256: string; text: string } | null
  d: DiskEntry
}

/** Plan 8.3, one row. `quarantine` is quarantineOn() read ONCE by the caller (M30). */
export function itemOf(input: ItemInput, kind: UpdateKind, quarantine: boolean): ChangeItem {
  const { path, o, n } = input
  // D10: an empty PACKAGE.md counts as missing (the agent cannot start without it, 7.4).
  const d: DiskEntry = path === 'CLAUDE.md' && input.d.kind === 'file' && isBlankBytes(input.d.bytes) ? { kind: 'missing' } : input.d
  const dHash = d.kind === 'file' ? sha256Hex(d.bytes) : null
  const base = { path, disk: payloadPathToDisk(path), installedSha256: o, diskSha256: dHash, newSha256: n?.sha256 ?? null }
  if (d.kind === 'blocked') return { ...base, state: 'blocked', action: 'keep', choices: null, texts: null }

  let state: ItemState
  let action: ItemAction
  // `folderRow`: rows 3, 4, 7, 8, 11 (8.5): under skills/ with the quarantine on they go to the folder's decision.
  let folderRow = false
  if (o !== null) {
    if (n !== null && n.sha256 === o) {
      if (dHash === o) { state = 'clean'; action = 'keep' } // 1
      else if (dHash !== null) { state = 'modified'; action = kind === 'repair' ? 'decide' : 'keep' } // 2
      else { state = 'missing'; action = 'decide'; folderRow = true } // 3
    } else if (n !== null) {
      if (dHash === o) { state = 'clean'; action = 'write'; folderRow = true } // 4
      else if (dHash === n.sha256) { state = 'current'; action = 'keep' } // 5
      else if (dHash !== null) { state = 'modified'; action = 'decide' } // 6
      else { state = 'missing'; action = 'decide'; folderRow = true } // 7
    } else {
      if (dHash === o) { state = 'clean'; action = 'delete'; folderRow = true } // 8
      else if (dHash !== null) { state = 'modified'; action = 'decide' } // 9
      else { state = 'absent'; action = 'keep' } // 10
    }
  } else {
    // o === null: the path is new in the package (n !== null by construction).
    if (dHash === null) { state = 'absent'; action = 'write'; folderRow = true } // 11
    else if (dHash === n?.sha256) { state = 'current'; action = 'keep' } // 12
    else { state = 'foreign'; action = 'decide' } // 13
  }

  const folder = quarantine && folderRow ? folderKeyOf(path) : null
  if (folder !== null) return { ...base, state, action: 'decide', choices: null, texts: null, folder }
  if (action !== 'decide') return { ...base, state, action, choices: null, texts: null }
  // Plan 8.3: a missing (or empty) PACKAGE.md, or a missing SOUL.md, cannot be kept missing.
  const required = (path === 'CLAUDE.md' || path === 'SOUL.md') && dHash === null
  const choices: Choice[] = required ? ['take-package'] : [...BOTH_CHOICES]
  const texts: ItemTexts = d.kind === 'file'
    ? { ...diskTextOf(d.bytes), package: n?.text ?? null }
    : { disk: null, package: n?.text ?? null, diskTruncated: false }
  return { ...base, state, action, choices, texts }
}

/** Plan 8.5: the folder decisions, and the per-file decisions that stand in the same folder. */
export function skillFoldersOf(items: readonly ChangeItem[]): SkillFolder[] {
  const keys = [...new Set(items.filter((i) => i.folder !== undefined).map((i) => i.folder as string))].sort()
  return keys.map((folder) => {
    const inFolder = items.filter((i) => folderKeyOf(i.path) === folder)
    return {
      folder,
      action: 'decide' as const,
      choices: [...BOTH_CHOICES],
      paths: inFolder.filter((i) => i.folder === folder).map((i) => i.path),
      filePaths: inFolder.filter((i) => i.folder === undefined && i.action === 'decide').map((i) => i.path),
      mixedWarning: inFolder.some((i) => i.state === 'missing') && inFolder.some((i) => i.state === 'modified'),
    }
  })
}

/** Byte order of the paths (plan 8.2: "a tételek path szerint bájtrendben"). */
const byPathBytes = (a: { path: string }, b: { path: string }): number => Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8'))

/** Plan 8.2: the planId over exactly these fields; nothing else (summary, choices, texts, folder) is in it. */
export function planIdOf(l: Pick<ChangeList, 'name' | 'slug' | 'kind' | 'installed' | 'available' | 'items'>): string {
  const doc = {
    available: l.available,
    installed: l.installed,
    items: [...l.items].sort(byPathBytes).map((i) => ({
      action: i.action, disk: i.disk, diskSha256: i.diskSha256, installedSha256: i.installedSha256, newSha256: i.newSha256,
      path: i.path, state: i.state,
    })),
    kind: l.kind,
    name: l.name,
    slug: l.slug,
  }
  return sha256Hex(Buffer.from(canonicalJson(doc), 'utf8'))
}

export interface ChangeListInput {
  name: string
  agentDir: string
  manifest: PackageManifest
  installedFiles: Map<string, string>
  pkg: VerifiedPackage
  kind: UpdateKind
  quarantine: boolean
  /** The disk reader (a test seam); readDiskEntry by default. */
  read?: (agentDir: string, diskRel: string) => DiskEntry
}

/** Plan 8.2: the change list `check` returns and `apply` recomputes. */
export function computeChangeList(c: ChangeListInput): ChangeList {
  const read = c.read ?? readDiskEntry
  const newFiles = new Map(c.pkg.files.map((f) => [f.path, { sha256: f.sha256, text: f.text }]))
  const paths = [...new Set([...c.installedFiles.keys(), ...newFiles.keys()])]
  const items = paths
    .map((path) => itemOf({ path, o: c.installedFiles.get(path) ?? null, n: newFiles.get(path) ?? null, d: read(c.agentDir, payloadPathToDisk(path)) }, c.kind, c.quarantine))
    .sort(byPathBytes)
  const summary = { write: 0, delete: 0, keep: 0, decide: 0 }
  for (const i of items) summary[i.action]++
  const head = {
    name: c.name,
    slug: c.pkg.slug,
    kind: c.kind,
    installed: { version: c.manifest.payload.version, payloadSha256: c.manifest.payloadSha256 },
    available: { version: c.pkg.version, payloadSha256: c.pkg.payloadSha256, minMarveenVersion: c.pkg.minMarveenVersion },
    items,
  }
  return { ...head, planId: planIdOf(head), summary, skillFolders: skillFoldersOf(items) }
}

// ---------------------------------------------------------------------------
// 6.3 / 8.5 The decisions
// ---------------------------------------------------------------------------

export type ResolvedOp = { item: ChangeItem; op: 'write' | 'delete' | 'keep'; backup: boolean }

export type DecisionCheck =
  | { ok: true; ops: ResolvedOp[]; keptMine: string[] }
  | { ok: false; status: 409; body: { error: 'path_blocked'; paths: string[] } }
  | { ok: false; status: 400; body: { error: 'bad_request' } }
  | { ok: false; status: 409; body: { error: 'decision_required'; paths: string[] } }

const isChoice = (v: unknown): v is Choice => v === 'take-package' || v === 'keep-mine'

/**
 * Plan 6.3 refusal order after the planId matched (IR15): path_blocked, bad_request, decision_required. Every key of
 * the body must EXACTLY equal a computed key (a per-file decide path or a folder key, B2); nothing is normalized.
 */
export function checkDecisions(list: ChangeList, decisions: unknown): DecisionCheck {
  const blocked = list.items.filter((i) => i.state === 'blocked').map((i) => i.path)
  if (blocked.length > 0) return { ok: false, status: 409, body: { error: 'path_blocked', paths: blocked } }
  if (decisions === null || typeof decisions !== 'object' || Array.isArray(decisions)) return { ok: false, status: 400, body: { error: 'bad_request' } }
  const body = decisions as Record<string, unknown>
  const fileItems = new Map(list.items.filter((i) => i.action === 'decide' && i.folder === undefined).map((i) => [i.path, i]))
  const folders = new Set(list.skillFolders.map((f) => f.folder))
  for (const [k, v] of Object.entries(body)) {
    if (!isChoice(v)) return { ok: false, status: 400, body: { error: 'bad_request' } }
    if (folders.has(k)) continue
    const item = fileItems.get(k)
    if (item === undefined || !(item.choices ?? []).includes(v)) return { ok: false, status: 400, body: { error: 'bad_request' } }
  }
  // Samu A: a folder kept as mine holds every file of that folder; a take-package file decision there is a contradiction.
  for (const [k, v] of Object.entries(body)) {
    if (v !== 'take-package' || !fileItems.has(k)) continue
    const f = folderKeyOf(k)
    if (f !== null && body[f] === 'keep-mine') return { ok: false, status: 400, body: { error: 'bad_request' } }
  }
  const missing: string[] = []
  for (const f of folders) if (body[f] === undefined) missing.push(f)
  for (const [p] of fileItems) {
    const f = folderKeyOf(p)
    const heldByFolder = f !== null && folders.has(f) && body[f] === 'keep-mine'
    if (body[p] === undefined && !heldByFolder) missing.push(p)
  }
  if (missing.length > 0) return { ok: false, status: 409, body: { error: 'decision_required', paths: missing.sort() } }

  const ops: ResolvedOp[] = []
  const keptMine: string[] = []
  for (const item of list.items) {
    if (item.action === 'write' || item.action === 'delete' || item.action === 'keep') {
      ops.push({ item, op: item.action, backup: false })
      continue
    }
    // The folder that holds this item's answer: its own folder decision, or (8.5, Samu A) a folder kept as mine.
    const f = folderKeyOf(item.path)
    const heldFolder = item.folder ?? (f !== null && folders.has(f) && body[f] === 'keep-mine' ? f : undefined)
    const take = heldFolder !== undefined ? body[heldFolder] === 'take-package' : body[item.path] === 'take-package'
    if (!take) {
      ops.push({ item, op: 'keep', backup: false })
      // 8.5: a kept folder is listed by its key, its files not one by one.
      const kept = heldFolder ?? item.path
      if (!keptMine.includes(kept)) keptMine.push(kept)
      continue
    }
    // Plan 8.3 "Mentés": the owner's own text (modified, foreign) is saved before it is overwritten or deleted.
    const backup = item.state === 'modified' || item.state === 'foreign'
    ops.push({ item, op: item.newSha256 !== null ? 'write' : 'delete', backup })
  }
  return { ok: true, ops, keptMine }
}

// ---------------------------------------------------------------------------
// 8.4 The interrupted-update trace (D11)
// ---------------------------------------------------------------------------

export function updatingDir(): string {
  return join(STORE_DIR, 'agent-package-updating')
}

export interface UpdatingTrace { from: string; to: string; startedAt: string }

/** The trace of `name`, or null. The name comes from the FILE name with the install marker's check (Samu (1)). */
export function readUpdatingTrace(name: string): UpdatingTrace | null {
  if (!isInstallableName(name)) return null
  try {
    const p = join(updatingDir(), `${name}.json`)
    if (!lstatSync(p).isFile()) return null
    const v = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
    if (typeof v.from !== 'string' || typeof v.to !== 'string' || typeof v.startedAt !== 'string') return null
    return { from: v.from, to: v.to, startedAt: v.startedAt }
  } catch {
    return null
  }
}

/** Server start (Samu (2)): the trace of an agent that no longer exists goes. Returns how many it removed. */
export function removeOrphanUpdatingTraces(agentExists: (name: string) => boolean): number {
  let n = 0
  let names: string[]
  try {
    names = readdirSync(updatingDir())
  } catch {
    return 0
  }
  for (const f of names) {
    if (!f.endsWith('.json')) continue
    const name = f.slice(0, -'.json'.length)
    if (isInstallableName(name) && agentExists(name)) continue
    try {
      unlinkSync(join(updatingDir(), f))
      n++
    } catch (err) {
      logger.warn({ err, file: f }, 'agent package update trace was not removed')
    }
  }
  return n
}

// ---------------------------------------------------------------------------
// 8.4 The repair's shell check (D4)
// ---------------------------------------------------------------------------

export interface ShellRepair { shell: 'missing' | 'ok' | 'broken'; local: 'missing' | 'ok' }

/** Plan 8.4: what the repair would restore; `check` returns it, `apply` acts on the same reading. */
export function shellRepairState(agentDir: string): ShellRepair {
  const shell = readDiskEntry(agentDir, 'CLAUDE.md')
  const local = readDiskEntry(agentDir, 'LOCAL.md')
  return {
    shell: shell.kind === 'missing' ? 'missing' : shell.kind === 'file' && startsWithPackageShell(shell.bytes) ? 'ok' : 'broken',
    local: local.kind === 'missing' ? 'missing' : 'ok',
  }
}

// ---------------------------------------------------------------------------
// 8.4 The apply block
// ---------------------------------------------------------------------------

export interface ApplyInput {
  name: string
  agentDir: string
  list: ChangeList
  ops: ResolvedOp[]
  pkg: VerifiedPackage
  manifest: PackageManifest
  installedFiles: Map<string, string>
  driveFolder: string
  lang: 'hu' | 'en'
  now: Date
}

export type ApplyResult =
  | { ok: true; applied: { write: number; delete: number; keep: number } }
  | { ok: false; status: 409; body: { error: 'path_blocked'; paths: string[] } }
  | { ok: false; status: 409; body: { error: 'plan_changed' } }
  | { ok: false; status: 500; body: { error: 'update_failed' } }

class Stop extends Error {
  constructor(readonly result: Exclude<ApplyResult, { ok: true }>) {
    super('agent package update stopped')
  }
}
const blockedAt = (path: string): Stop => new Stop({ ok: false, status: 409, body: { error: 'path_blocked', paths: [path] } })

/** J4: the real path of `p`'s deepest EXISTING folder (p itself or an ancestor) lies inside the agent's real path. */
function insideAgent(agentReal: string, p: string): boolean {
  let cur = p
  for (;;) {
    try {
      const real = realpathSync(cur)
      return real === agentReal || real.startsWith(agentReal + sep)
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') return false
      const up = dirname(cur)
      if (up === cur) return false
      cur = up
    }
  }
}

/** A real folder (lstat), or absent. A link or a file there stops the backup handling (8.3 "Mentés"). */
function isRealDirOrAbsent(p: string): boolean {
  try {
    return lstatSync(p).isDirectory()
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'ENOENT'
  }
}

/** Folders one component at a time with `mode`, each checked with lstat (no link followed). */
function mkdirChain(base: string, rel: string, mode: number): void {
  let cur = base
  for (const part of rel.split(sep).filter((x) => x !== '')) {
    cur = join(cur, part)
    try { mkdirSync(cur, { mode }) } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err
    }
    if (!lstatSync(cur).isDirectory()) throw new Error('backup folder is not a folder')
  }
}

/** A path under `.package/backup/<key>/` that a backup can have: a package text file's disk path, maybe `.<n>` (M1). */
function isBackupShaped(rel: string): boolean {
  const disk = rel.split(sep).join('/').replace(/\.[0-9]+$/, '')
  if (disk === 'PACKAGE.md') return true
  if (disk.startsWith('.claude/skills/')) return TEXT_PATH_RE.test(disk.slice('.claude/'.length))
  // The rest of the contract's text paths stand at the agent root (SOUL.md); CLAUDE.md there is the shell, never a backup.
  return disk !== 'CLAUDE.md' && !disk.startsWith('skills/') && TEXT_PATH_RE.test(disk)
}

/**
 * IR11 without a recursive delete (Dani B1, #3085): the agent can swap `.package/backup` for a link at any time, so
 * the other targets' backups are walked with lstat (a link is never followed), only backup-shaped plain files are
 * unlinked, the emptied folders go with a non-recursive rmdir, and the folders are checked again before EVERY unlink.
 * A swap that wins a race costs at most one fixed-name file, the bound of the rest of the block.
 */
function dropOtherBackups(agentReal: string, agentDir: string, keep: string): void {
  const pkgDir = join(agentDir, '.package')
  const root = join(pkgDir, 'backup')
  const guard = (parent: string): void => {
    if (!isRealDirOrAbsent(pkgDir) || !isRealDirOrAbsent(root) || !insideAgent(agentReal, parent)) throw blockedAt('.package/backup')
  }
  guard(root)
  let keys: string[]
  try {
    keys = readdirSync(root)
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return
    throw err
  }
  const walk = (dir: string, rel: string): void => {
    guard(dir)
    let st
    try { st = lstatSync(dir) } catch { return }
    if (!st.isDirectory()) return
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      const r = rel === '' ? e : join(rel, e)
      const est = lstatSync(p)
      if (est.isDirectory()) walk(p, r)
      else if (est.isFile() && isBackupShaped(r)) {
        guard(dir)
        unlinkSync(p)
      }
    }
    guard(dirname(dir))
    try { rmdirSync(dir) } catch { /* not empty: it stays */ }
  }
  for (const k of keys) if (k !== keep) walk(join(root, k), '')
}

/** Removes the empty folders under `dir` bottom-up, `dir` itself last; a link or a non-empty folder stays. */
function removeEmptyFolders(agentReal: string, dir: string, item: string): void {
  let entries: string[]
  try {
    if (!lstatSync(dir).isDirectory()) return
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const e of entries) removeEmptyFolders(agentReal, join(dir, e), item)
  if (readdirSync(dir).length > 0) return
  if (!insideAgent(agentReal, dirname(dir))) throw blockedAt(item)
  try { rmdirSync(dir) } catch { /* not empty after all: it stays */ }
}

/**
 * Plan 8.4: ONE synchronous block, run in the skills-dir queue by the route. Order: the trace, the backups of other
 * targets dropped, the writes, the deletes, the emptied package skill folders, the repair's shell and LOCAL.md, the
 * record LAST, the trace removed. No journal: an interrupted run is finished by running check + apply again (8.3
 * rows 5, 10, 12 make the table re-runnable).
 */
export function runApplyBlock(c: ApplyInput): ApplyResult {
  let agentReal: string
  try {
    agentReal = realpathSync(c.agentDir)
  } catch {
    return { ok: false, status: 500, body: { error: 'update_failed' } }
  }
  const tracePath = join(updatingDir(), `${c.name}.json`)
  const backupRoot = join(c.agentDir, '.package', 'backup')
  const backupKey = c.pkg.payloadSha256.slice(0, 16)
  // Plan 8.3: the shell, LOCAL.md and the record are never items; checked on the mapper's OUTPUT, whatever it gave.
  const forbidden = c.ops.find((o) => o.op !== 'keep' && (o.item.disk === 'CLAUDE.md' || o.item.disk === 'LOCAL.md'
    || o.item.disk === '.package' || o.item.disk.startsWith('.package' + sep)))
  if (forbidden !== undefined) return { ok: false, status: 500, body: { error: 'update_failed' } }
  try {
    // The backup folders must be real folders before anything there is deleted (a link would send the delete out).
    if (!isRealDirOrAbsent(join(c.agentDir, '.package')) || !isRealDirOrAbsent(backupRoot)) throw blockedAt('.package/backup')
    mkdirSync(updatingDir(), { recursive: true, mode: 0o700 })
    atomicWriteFileSync(tracePath, JSON.stringify({ from: c.manifest.payload.version, to: c.pkg.version, startedAt: c.now.toISOString() }) + '\n', { mode: 0o600 })
    // IR11: the backups of OTHER targets go; this target's stay (an interrupted run's only copy of a replaced file).
    dropOtherBackups(agentReal, c.agentDir, backupKey)

    const backup = (item: ChangeItem): void => {
      const now = readDiskEntry(c.agentDir, item.disk)
      if (now.kind === 'blocked') throw blockedAt(item.path)
      if (now.kind !== 'file') return
      const dest = join(backupRoot, backupKey, item.disk)
      mkdirChain(c.agentDir, join('.package', 'backup', backupKey, dirname(item.disk)), 0o700)
      if (!insideAgent(agentReal, dirname(dest))) throw blockedAt(item.path)
      // An existing backup is never overwritten (IR11). A repair after a finished upgrade has the SAME target key, so
      // a saved file there may be an OLDER owner text (Samu M1, #3085): the same bytes are saved already; other bytes
      // go under the next free name (<name>.2, <name>.3, ...), so neither owner text is lost.
      for (let n = 1; ; n++) {
        const name = n === 1 ? dest : `${dest}.${n}`
        try {
          writeFileSync(name, now.bytes, { flag: 'wx', mode: 0o600 })
          return
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err
        }
        const there = readDiskEntry(c.agentDir, join('.package', 'backup', backupKey, n === 1 ? item.disk : `${item.disk}.${n}`))
        if (there.kind === 'blocked') throw blockedAt(item.path)
        if (there.kind === 'file' && there.bytes.equals(now.bytes)) return
        if (n >= 1000) throw new Error('too many backups of one file')
      }
    }
    // D2: what the list says stands on the disk must still stand there, else the owner's newer text would be lost.
    const unchanged = (item: ChangeItem): void => {
      const now = readDiskEntry(c.agentDir, item.disk)
      if (now.kind === 'blocked') throw blockedAt(item.path)
      // The same disk hash itemOf used: an empty PACKAGE.md counts as missing (D10).
      const blank = item.path === 'CLAUDE.md' && now.kind === 'file' && isBlankBytes(now.bytes)
      const h = now.kind === 'file' && !blank ? sha256Hex(now.bytes) : null
      if (h !== item.diskSha256) throw new Stop({ ok: false, status: 409, body: { error: 'plan_changed' } })
    }
    const texts = new Map(c.pkg.files.map((f) => [f.path, f.text]))

    for (const o of c.ops.filter((x) => x.op === 'write')) {
      const target = join(c.agentDir, o.item.disk)
      if (o.backup) backup(o.item)
      else unchanged(o.item)
      if (!insideAgent(agentReal, dirname(target))) throw blockedAt(o.item.path)
      mkdirInsideAgentDir(c.agentDir, dirname(target))
      if (!insideAgent(agentReal, dirname(target))) throw blockedAt(o.item.path)
      atomicWriteFileSync(target, Buffer.from(texts.get(o.item.path) as string, 'utf8'), { mode: 0o644 })
    }
    for (const o of c.ops.filter((x) => x.op === 'delete')) {
      const target = join(c.agentDir, o.item.disk)
      if (o.backup) backup(o.item)
      else unchanged(o.item)
      if (!insideAgent(agentReal, dirname(target))) throw blockedAt(o.item.path)
      try { unlinkSync(target) } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err
      }
    }
    // D14: every package skill folder with no file of the new record loses its emptied folders, not only after a delete.
    const newSkills = new Set(c.pkg.files.map((f) => folderKeyOf(f.path)).filter((k): k is string => k !== null))
    const oldSkills = new Set([...c.installedFiles.keys()].map(folderKeyOf).filter((k): k is string => k !== null))
    for (const k of [...oldSkills].filter((x) => !newSkills.has(x)).sort()) {
      removeEmptyFolders(agentReal, join(c.agentDir, '.claude', k), k)
    }
    if (c.list.kind === 'repair') {
      const state = shellRepairState(c.agentDir)
      if (state.shell === 'missing') {
        // v1.2.4: the shell WITH the roster block, in ONE exclusive write (the roster body is built without reading a file).
        const text = packageShellText(c.name, c.driveFolder).trimEnd() + '\n\n' + fleetRosterBlock(c.name) + '\n'
        const shellPath = join(c.agentDir, 'CLAUDE.md')
        if (!insideAgent(agentReal, c.agentDir)) throw blockedAt('CLAUDE.md')
        writeFileSync(shellPath, text, { flag: 'wx', mode: 0o644 })
        // The postcondition (A2): a shell-prefixed CLAUDE.md without the roster marker would look like a fresh install.
        const back = readFileSync(shellPath)
        if (startsWithPackageShell(back) && !hasLaunchTrace(back)) {
          unlinkSync(shellPath)
          throw new Stop({ ok: false, status: 500, body: { error: 'update_failed' } })
        }
      }
      if (state.local === 'missing') writeLocalIfAbsent(c.agentDir, c.lang)
    }
    const recordPath = manifestPathOf(c.agentDir)
    mkdirInsideAgentDir(c.agentDir, dirname(recordPath))
    if (!insideAgent(agentReal, dirname(recordPath))) throw blockedAt('.package/manifest.json')
    atomicWriteFileSync(recordPath, manifestRecordText(c.pkg, c.now.toISOString(), c.manifest.installedAt), { mode: 0o644 })
    try { unlinkSync(tracePath) } catch { /* the next successful apply removes it */ }
  } catch (err) {
    if (err instanceof Stop) return err.result
    logger.warn({ err, name: c.name }, 'agent package update failed in the apply block')
    return { ok: false, status: 500, body: { error: 'update_failed' } }
  }
  const applied = { write: 0, delete: 0, keep: 0 }
  for (const o of c.ops) applied[o.op]++
  return { ok: true, applied }
}

// ---------------------------------------------------------------------------
// 8.2 skillReport for `check` (N10): the scanner's line patterns over the NEW package's skill texts, in memory
// ---------------------------------------------------------------------------

export interface UpdateSkillReport {
  quarantineOn: boolean
  /** True when the quarantine turns this update's skill changes into folder decisions (8.5). */
  quarantineApplies: boolean
  /** Pattern name -> count over the new package's skills; never an excerpt. */
  findings: Record<string, number>
  globalNameCollisions: string[]
}

/** `check` writes nothing (6.2), so the skills are scanned as the verified texts, not as a folder. */
export function updateSkillReport(pkg: VerifiedPackage, quarantine: boolean, skillFolders: readonly SkillFolder[]): UpdateSkillReport {
  const findings: Record<string, number> = {}
  const skills = new Set<string>()
  for (const f of pkg.files) {
    if (!f.path.startsWith('skills/')) continue
    skills.add(f.path.split('/')[1])
    for (const line of f.text.split('\n')) {
      for (const [name, rx] of SKILL_SCAN_PATTERNS) {
        if (new RegExp(rx.source, rx.flags.replace('g', '')).test(line)) findings[name] = (findings[name] ?? 0) + 1
      }
    }
  }
  const globalNameCollisions: string[] = []
  for (const skill of [...skills].sort()) {
    try {
      if (existsSync(join(globalSkillsRoot(), skill))) globalNameCollisions.push(skill)
    } catch { /* the probe is optional (6.1) */ }
  }
  return { quarantineOn: quarantine, quarantineApplies: quarantine && skillFolders.length > 0, findings, globalNameCollisions }
}
