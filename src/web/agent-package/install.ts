// Agent package installer: the disk phase (MIOAGENTINSTALL1114, PR-I3; plan 4, 4.1, 4.4, 7.2-7.5).
//
// The install is all or nothing IN PLACE (plan 7.2): the server's own install marker
// (store/agent-package-installing/<slug>.json, marker.ts) is written BEFORE the agent directory, completed with the
// directory's identity right after it is created, and removed as the very last step. While the marker COUNTS, the
// name is hidden from the roster and its start is refused; an interrupted install is set aside at the next server
// start (reapInterruptedPackageInstalls), never deleted. The block is ONE synchronous function with no await, run
// in the skills-dir queue by the route, so no other request, timer or queued job runs inside it.
//
// The code that writes to disk takes a VerifiedPackage only: every text it writes or puts into a config passed the
// verifier's rules. The raw signed payload goes, as bytes, into the package record and nowhere else.
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync,
  symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { join, dirname, isAbsolute, relative, sep } from 'node:path'
import { logger } from '../../logger.js'
import { atomicWriteFileSync } from '../atomic-write.js'
import { writeAgentBase } from '../agent-create.js'
import { ensureFleetRosterSection, fleetBaseRulesBlock } from '../agent-scaffold.js'
import { appendSkillAudit, globalSkillsRoot, quarantineOn, scanSkillDir } from '../skill-quarantine.js'
import {
  AVATAR_PATH_RE, IMPORT_TOKEN_RE, TEXT_PATH_RE, scanManifestText, scanPackageText, MANIFEST_TEXT_MAX_CHARS, VerifiedPackage,
} from './verify.js'
import {
  PACKAGE_SHELL_PREFIX_TEXT, agentsBaseDir, dirIdentityOf, hasLaunchTrace, hasPackageManifestFile, installMarkerState,
  installingDir, isBlankBytes, isInstallableName, leftoversDir, manifestPathOf, markerPathOf, parseMarker,
  startsWithPackageShell, writeHiddenList, type MarkerContent,
} from './marker.js'

// ---------------------------------------------------------------------------
// Payload path -> disk path (plan 4)
// ---------------------------------------------------------------------------

/**
 * The ONE mapping from a payload path to the path under agents/<slug>/ (plan 4): CLAUDE.md is the package layer
 * PACKAGE.md, skills go under .claude/skills/. Every path the contract's two patterns allow maps; anything else throws.
 */
export function payloadPathToDisk(path: string): string {
  if (!TEXT_PATH_RE.test(path) && !AVATAR_PATH_RE.test(path)) throw new Error('not a package path')
  if (path === 'CLAUDE.md') return 'PACKAGE.md'
  if (path.startsWith('skills/')) return join('.claude', path)
  return path
}

// ---------------------------------------------------------------------------
// The local layer placeholder (plan 4, S16)
// ---------------------------------------------------------------------------

/** The contract's fixed placeholder texts (Mira 77478, 77485): one paragraph, no heading line, LF at the end. */
export const LOCAL_MD_TEXT = Object.freeze({
  hu: 'Ez a fájl az ügynök helyi, csak rád szabott részét tartalmazza. Az ügynök az első beszélgetésben tölti ki, és a csomag frissítései soha nem írják felül. Kézzel is szerkesztheted.\n',
  en: 'This file holds the local part of this agent that is tailored to you. The agent fills it in during your first conversation, and package updates never overwrite it. You can also edit it by hand.\n',
})

/** Writes LOCAL.md only when there is none (`wx`): an existing one is never overwritten. True when it wrote. */
export function writeLocalIfAbsent(dir: string, lang: 'hu' | 'en'): boolean {
  try {
    writeFileSync(join(dir, 'LOCAL.md'), LOCAL_MD_TEXT[lang], { flag: 'wx', mode: 0o644 })
    return true
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === 'EEXIST') return false
    throw err
  }
}

/** The shell CLAUDE.md of a package agent (plan 4, 4.3, 7.5): the prefix, then the fleet base rules block. */
export function packageShellText(name: string, driveFolder: string): string {
  return PACKAGE_SHELL_PREFIX_TEXT + '\n' + fleetBaseRulesBlock(name, driveFolder) + '\n'
}

// ---------------------------------------------------------------------------
// The package record (plan 4.1)
// ---------------------------------------------------------------------------

export interface PackageManifest {
  schema: 1
  payloadSha256: string
  kid: string
  installedAt: string
  updatedAt: string
  payload: Record<string, unknown> & { slug: string; version: string }
}

export type ManifestRead = { state: 'none' } | { state: 'ok'; manifest: PackageManifest } | { state: 'unreadable' }

/** Plan 4.1: none (no file), ok, or unreadable (corrupt JSON, unknown schema, wrong shape). */
export function readPackageManifest(dir: string): ManifestRead {
  let text: string
  try {
    if (!lstatSync(manifestPathOf(dir)).isFile()) return { state: 'unreadable' }
    text = readFileSync(manifestPathOf(dir), 'utf8')
  } catch (err) {
    return (err as { code?: unknown } | null)?.code === 'ENOENT' ? { state: 'none' } : { state: 'unreadable' }
  }
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return { state: 'unreadable' }
  }
  const o = v as Record<string, unknown>
  if (v === null || typeof v !== 'object' || Array.isArray(v) || o.schema !== 1 || typeof o.payloadSha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(o.payloadSha256) || typeof o.kid !== 'string' || typeof o.installedAt !== 'string'
    || typeof o.updatedAt !== 'string') return { state: 'unreadable' }
  const p = o.payload as Record<string, unknown> | null
  if (p === null || typeof p !== 'object' || Array.isArray(p) || typeof p.slug !== 'string' || typeof p.version !== 'string') {
    return { state: 'unreadable' }
  }
  return { state: 'ok', manifest: o as unknown as PackageManifest }
}

/**
 * The record's bytes. The payload is the signed payload exactly as signed: this is the ONE caller of
 * unverifiedPayloadBytes (plan 4.1, mutant 55); nothing shown or written into a file the CLI reads comes from it.
 */
export function manifestRecordText(pkg: VerifiedPackage, at: string): string {
  const payload = Buffer.from(pkg.unverifiedPayloadBytes()).toString('utf8')
  const head = JSON.stringify({ schema: 1, payloadSha256: pkg.payloadSha256, kid: pkg.kid, installedAt: at, updatedAt: at })
  return head.slice(0, -1) + ',"payload":' + payload + '}\n'
}

/**
 * Plan 4.2 (getAgentSummary): a package agent's description for the dashboard, from the record's payload, cut to 200
 * characters like the CLAUDE.md path; null when the agent has no readable record. The text is shown, so it must pass
 * the manifest text rules again (the record is a file anyone with the user's rights can edit): '' when it does not.
 */
export function packageDescription(dir: string): string | null {
  const r = readPackageManifest(dir)
  if (r.state !== 'ok') return null
  const d = r.manifest.payload.description
  if (typeof d !== 'string' || scanManifestText(d, MANIFEST_TEXT_MAX_CHARS.description) !== null) return ''
  return Array.from(d).slice(0, 200).join('')
}

/** Plan 4.2: the summary's package field, {slug, version} from a readable record, else null. */
export function packageSummaryField(dir: string): { slug: string; version: string } | null {
  const r = readPackageManifest(dir)
  return r.state === 'ok' ? { slug: r.manifest.payload.slug, version: r.manifest.payload.version } : null
}

// ---------------------------------------------------------------------------
// Time stamps and owner notices (plan 7.3, 7.5)
// ---------------------------------------------------------------------------

/** `YYYYMMDDTHHMMSSmmmZ`, UTC (plan 7.5). */
export function stampOf(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace('.', '')
}

/** `base`, or `base-2`, `base-3`, ... when it is taken. */
function freePath(base: string, suffix = ''): string {
  let p = base + suffix
  for (let i = 2; existsSync(p) || isLink(p); i++) p = `${base}-${i}${suffix}`
  return p
}

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

export type PendingNoticeKind = 'set_aside' | 'set_aside_failed' | 'orphan_marker' | 'bad_marker' | 'marker_blocked' | 'fallback_refused' | 'fallback_scan_finding' | 'start_scan_finding'

export function pendingNoticesDir(): string {
  return join(leftoversDir(), 'pending-notices')
}

/**
 * Plan 7.3 (Samu v1.2.1/6): a notice the owner must see is first written to a file, and only sent later
 * (flushPendingPackageNotices), so it is not lost when the alert path is not up yet or the send fails.
 */
export function writePendingNotice(kind: PendingNoticeKind, name: string, path: string, now: Date): void {
  try {
    mkdirSync(pendingNoticesDir(), { recursive: true, mode: 0o700 })
    const file = freePath(join(pendingNoticesDir(), `${stampOf(now)}-${name}`), '.json')
    atomicWriteFileSync(file, JSON.stringify({ kind, name, path, at: now.toISOString() }) + '\n', { mode: 0o600 })
  } catch (err) {
    logger.error({ err, kind, name, path }, 'agent package owner notice could not be stored')
  }
}

/** The owner-facing text of a notice. No at-sign after white space (names are slugs, paths are ours). */
export function noticeText(n: { kind: string; name: string; path: string }): string {
  switch (n.kind) {
    case 'set_aside':
      return `Agent package install of "${n.name}" was interrupted. The unfinished folder was moved aside to ${n.path}. Nothing of yours was in it; install the package again.`
    case 'set_aside_failed':
      return `Agent package install of "${n.name}" failed, and its unfinished folder could not be moved aside: ${n.path}. The name stays blocked until the folder is removed; the next server start tries again.`
    case 'orphan_marker':
      return `Agent package "${n.name}": a leftover install marker was removed. The install had finished: the agent is ready to use, nothing needs to be deleted or installed again. Folder: ${n.path}`
    case 'bad_marker':
      return `Agent package installer: a malformed install marker was moved aside to ${n.path}. No agent folder was touched.`
    case 'marker_blocked':
      return `Agent package installer: ${n.path} is not a regular file, so it was left alone, and installing "${n.name}" stays blocked until it is removed.`
    case 'fallback_refused':
      return `Agent "${n.name}" could not be started from its fallback folder: its package files are missing or its shell is broken (${n.path}). Start it again from the dashboard to see the reason.`
    case 'fallback_scan_finding':
      return `Agent "${n.name}" started from its fallback folder, and its combined instructions contain text the package rules would refuse. The agent is running; check its PACKAGE.md and LOCAL.md (${n.path}).`
    case 'start_scan_finding':
      return `Agent "${n.name}" started, and its combined instructions contain text the package rules would refuse. The agent is running; check its PACKAGE.md and LOCAL.md (${n.path}).`
    default:
      return `Agent package installer notice for "${n.name}": ${n.path}`
  }
}

/**
 * Plan 7.3: sends every stored notice with `send` (the owner alert path: notifyOwner, src/notify.ts), and removes a
 * notice file ONLY after its send succeeded. A failed send leaves it for the next run. Returns how many were sent.
 */
export async function flushPendingPackageNotices(send: (text: string) => Promise<boolean>): Promise<number> {
  let files: string[]
  try {
    files = readdirSync(pendingNoticesDir()).filter((f) => f.endsWith('.json')).sort()
  } catch {
    return 0
  }
  let sent = 0
  for (const f of files) {
    const p = join(pendingNoticesDir(), f)
    let n: { kind: string; name: string; path: string }
    try {
      if (!lstatSync(p).isFile()) continue
      const v = JSON.parse(readFileSync(p, 'utf8'))
      if (typeof v?.kind !== 'string' || typeof v?.name !== 'string' || typeof v?.path !== 'string') continue
      n = v
    } catch {
      continue
    }
    let ok = false
    try {
      ok = await send(noticeText(n))
    } catch {
      ok = false
    }
    if (!ok) continue
    try {
      unlinkSync(p)
      sent++
    } catch (err) {
      logger.warn({ err, file: p }, 'agent package owner notice sent but its file could not be removed')
    }
  }
  return sent
}

// ---------------------------------------------------------------------------
// Setting a folder aside (plan 7.2)
// ---------------------------------------------------------------------------

/**
 * Moves `agents/<name>` aside with ONE rename (atomic: never half moved) to store/agent-package-leftovers/, THEN
 * removes the marker, and stores an owner notice either way. Returns the new path, or null when the rename failed
 * (the marker then stays: the folder stays hidden and unstartable, and the next try comes at the next request or
 * server start).
 */
export function setAside(name: string, now: Date): string | null {
  const dir = join(agentsBaseDir(), name)
  let target: string
  try {
    mkdirSync(leftoversDir(), { recursive: true, mode: 0o700 })
    target = freePath(join(leftoversDir(), `${name}.${stampOf(now)}`))
    renameSync(dir, target)
  } catch (err) {
    logger.error({ err, name, dir }, 'agent package: the unfinished install folder could not be moved aside')
    writePendingNotice('set_aside_failed', name, dir, now)
    return null
  }
  removeMarker(name)
  logger.warn({ name, from: dir, to: target }, 'agent package: an unfinished install folder was moved aside')
  writePendingNotice('set_aside', name, target, now)
  return target
}

function removeMarker(name: string): void {
  try {
    unlinkSync(markerPathOf(name))
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code !== 'ENOENT') throw err
  }
}

// ---------------------------------------------------------------------------
// The install block (plan 7.2); every step is its own exported function, so a test can stop after any of them
// ---------------------------------------------------------------------------

export interface InstallContext {
  name: string
  pkg: VerifiedPackage
  model: string
  driveFolder: string
  lang: 'hu' | 'en'
  now: Date
}

export const agentDirOf = (name: string): string => join(agentsBaseDir(), name)

/** Step 1: the marker, exclusively, without an inode. Throws EEXIST when a marker stands. */
export function step1WriteMarker(c: InstallContext): void {
  mkdirSync(agentsBaseDir(), { recursive: true })
  mkdirSync(installingDir(), { recursive: true, mode: 0o700 })
  const m: MarkerContent = { slug: c.name, version: c.pkg.version, startedAt: c.now.toISOString(), pid: process.pid }
  writeFileSync(markerPathOf(c.name), JSON.stringify(m) + '\n', { flag: 'wx', mode: 0o600 })
}

/** Step 2: the agent directory, exclusively (never recursive into an existing one). Throws EEXIST. */
export function step2Mkdir(c: InstallContext): void {
  mkdirSync(agentDirOf(c.name), { mode: 0o755 })
}

/** Step 3: the real path is where it should be (J4), then the marker gets the directory's identity. */
export function step3Identity(c: InstallContext): void {
  const dir = agentDirOf(c.name)
  const expected = join(realpathSync(agentsBaseDir()), c.name)
  if (realpathSync(dir) !== expected) throw new Error('agent directory is not where it was created')
  const m: MarkerContent = { slug: c.name, version: c.pkg.version, startedAt: c.now.toISOString(), pid: process.pid, ...dirIdentityOf(dir) }
  atomicWriteFileSync(markerPathOf(c.name), JSON.stringify(m) + '\n', { mode: 0o600 })
}

/** Step 3/b: the shell CLAUDE.md, exclusively, without the fleet-roster block: the FIRST file of the folder. */
export function step3bShell(c: InstallContext): void {
  writeFileSync(join(agentDirOf(c.name), 'CLAUDE.md'), packageShellText(c.name, c.driveFolder), { flag: 'wx', mode: 0o644 })
}

/** Step 4: the agent base (writeAgentBase); the display name is the verified one (D10), cut for display. */
export function step4Base(c: InstallContext): void {
  writeAgentBase(c.name, { model: c.model, profileId: 'default', customProvider: null, displayName: displayNameOf(c.pkg) })
}

/** Plan 6.1: the verified display name, at most 60 characters (it is already one line without control characters). */
export function displayNameOf(pkg: VerifiedPackage): string | undefined {
  const d = Array.from(pkg.displayName).slice(0, 60).join('')
  return d.length > 0 ? d : undefined
}

/**
 * The package files with their disk paths and bytes. S18 (3): the bytes that will be written are scanned again
 * here, ALL of them before the first write, so a refusal leaves nothing on disk.
 */
export function packageDiskFiles(pkg: VerifiedPackage): Array<{ path: string; bytes: Buffer }> {
  const out = pkg.files.map((f) => ({ path: payloadPathToDisk(f.path), bytes: Buffer.from(f.text, 'utf8') }))
  for (const f of out) {
    if (scanPackageText(f.bytes) !== null) throw new Error('assembled package text refused by the text rules')
  }
  const avatar = pkg.avatarBytes()
  if (pkg.avatar !== null && avatar !== null) out.push({ path: payloadPathToDisk(pkg.avatar.path), bytes: Buffer.from(avatar) })
  return out
}

/**
 * PRI3HARDEN1118: a recursive mkdir follows a symlink standing on its path, so a same-user process could swap a
 * folder for a link between step 2 and the write and send the package files elsewhere (e.g. into the global skills
 * root, past the quarantine). Each folder component is made on its own and checked with lstat, so a link already
 * standing on the path stops the write. This narrows the window, it does not close it: a swap between the lstat and
 * the write is still possible (Node has no openat/O_NOFOLLOW-per-component here).
 */
function mkdirInsideAgentDir(dir: string, folder: string): void {
  const rel = relative(dir, folder)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('package folder resolves outside the agent directory')
  let cur = dir
  for (const part of rel.split(sep).filter((x) => x !== '')) {
    cur = join(cur, part)
    try { mkdirSync(cur, { mode: 0o755 }) } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err
    }
    // One component at a time: a link (or anything but a plain folder) found here stops the write.
    if (!lstatSync(cur).isDirectory()) throw new Error('package folder resolves outside the agent directory')
  }
}

/** Step 5: the package files (0644; folders 0755). */
export function step5Files(c: InstallContext): void {
  const dir = agentDirOf(c.name)
  for (const f of packageDiskFiles(c.pkg)) {
    const p = join(dir, f.path)
    mkdirInsideAgentDir(dir, dirname(p))
    atomicWriteFileSync(p, f.bytes, { mode: 0o644 })
  }
}

/** Step 6: LOCAL.md, only if absent. */
export function step6Local(c: InstallContext): void {
  writeLocalIfAbsent(agentDirOf(c.name), c.lang)
}

/** Step 7: the package record. */
export function step7Manifest(c: InstallContext): void {
  const p = manifestPathOf(agentDirOf(c.name))
  mkdirInsideAgentDir(agentDirOf(c.name), dirname(p))
  atomicWriteFileSync(p, manifestRecordText(c.pkg, c.now.toISOString()), { mode: 0o644 })
}

/** Step 7/b (A1): the fleet-roster block, and the postcondition that it stands (the writer returns silently on a read error). */
export function step7bRoster(c: InstallContext): void {
  ensureFleetRosterSection(c.name)
  const text = readFileSync(join(agentDirOf(c.name), 'CLAUDE.md'))
  if (!hasLaunchTrace(text)) throw new Error('fleet-roster block missing after the install wrote it')
}

/** Step 8: removing the marker. THIS is the commit. */
export function step8Commit(c: InstallContext): void {
  removeMarker(c.name)
}

export type InstallBlockResult =
  | { ok: true }
  | { ok: false; kind: 'marker_exists' }
  | { ok: false; kind: 'dir_exists' }
  | { ok: false; kind: 'failed' }

/** The steps 3/b to 7/b, in order; a test swaps none of them, it stops after one or makes one throw. */
export const BODY_STEPS: ReadonlyArray<(c: InstallContext) => void> = Object.freeze([
  step3bShell, step4Base, step5Files, step6Local, step7Manifest, step7bRoster,
])

/**
 * Plan 7.2: the install block, synchronous. Never deletes a non-empty folder: a failure after the folder was
 * created and filled sets it aside. The hidden list is rewritten after step 1 and at the end, best effort, outside
 * the try (its failure changes no result).
 */
export function runInstallBlock(c: InstallContext): InstallBlockResult {
  try {
    step1WriteMarker(c)
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === 'EEXIST') return { ok: false, kind: 'marker_exists' }
    logger.error({ err, name: c.name }, 'agent package install: the marker could not be written')
    return { ok: false, kind: 'failed' }
  }
  writeHiddenListBestEffort()
  try {
    return runAfterMarker(c)
  } finally {
    writeHiddenListBestEffort()
  }
}

function runAfterMarker(c: InstallContext): InstallBlockResult {
  try {
    step2Mkdir(c)
  } catch (err) {
    removeMarkerQuietly(c.name)
    if ((err as { code?: unknown } | null)?.code === 'EEXIST') return { ok: false, kind: 'dir_exists' }
    logger.error({ err, name: c.name }, 'agent package install: the agent folder could not be created')
    return { ok: false, kind: 'failed' }
  }
  try {
    step3Identity(c)
  } catch (err) {
    logger.error({ err, name: c.name }, 'agent package install: the new folder could not be checked')
    try { rmdirSync(agentDirOf(c.name)) } catch { /* not empty or gone: the reaper decides */ }
    removeMarkerQuietly(c.name)
    return { ok: false, kind: 'failed' }
  }
  try {
    for (const step of BODY_STEPS) step(c)
  } catch (err) {
    logger.error({ err, name: c.name }, 'agent package install failed; the unfinished folder is set aside')
    setAside(c.name, c.now)
    return { ok: false, kind: 'failed' }
  }
  try {
    step8Commit(c)
  } catch (err) {
    // The folder is complete and carries the launch trace: the marker no longer counts, the reaper removes it.
    logger.error({ err, name: c.name }, 'agent package install: the marker could not be removed after a complete install')
  }
  return { ok: true }
}

function removeMarkerQuietly(name: string): void {
  try { removeMarker(name) } catch (err) { logger.error({ err, name }, 'agent package install: the marker could not be removed') }
}

function writeHiddenListBestEffort(): void {
  try { writeHiddenList() } catch (err) { logger.error({ err }, 'agent package hidden list could not be written') }
}

// ---------------------------------------------------------------------------
// The package skills and the quarantine (plan 6.1, N10)
// ---------------------------------------------------------------------------

export interface SkillReport {
  quarantineOn: boolean
  /** Always false at install (N10): the package's skills are not held, whatever the switch says. */
  quarantineApplies: false
  /** Pattern name -> count over all the package's skills; never an excerpt. */
  findings: Record<string, number>
  /** The package skills whose name a global skill already has (a folder probe per skill). */
  globalNameCollisions: string[]
}

/**
 * N10 (Samu on Dani's review): the existing scanner runs in REPORTING mode on the installed skills of `name`: one
 * audit line per skill (store/skills-audit.jsonl, event package_install_scanned, source agent-package) and the
 * counts in the install answer. Nothing is refused for it. Best effort per skill.
 */
export function packageSkillReport(name: string, pkg: VerifiedPackage, now: Date): SkillReport {
  const skills = [...new Set(pkg.files.filter((f) => f.path.startsWith('skills/')).map((f) => f.path.split('/')[1]))].sort()
  const findings: Record<string, number> = {}
  const globalNameCollisions: string[] = []
  for (const skill of skills) {
    try {
      const r = scanSkillDir(join(agentDirOf(name), '.claude', 'skills', skill))
      const counts: Record<string, number> = {}
      for (const f of r.findings) counts[f.pattern] = (counts[f.pattern] ?? 0) + 1
      for (const [k, v] of Object.entries(counts)) findings[k] = (findings[k] ?? 0) + v
      appendSkillAudit({
        at: now.toISOString(), event: 'package_install_scanned', id: `${name}/${skill}`, name: skill, source: 'agent-package',
        target: { scope: 'agent', agent: name }, proposedBy: null, hash: null, replaces: false, findings: counts,
        findingsTruncated: r.findingsTruncated,
      })
    } catch (err) {
      logger.warn({ err, name, skill }, 'agent package install: the skill scan did not run')
    }
    try {
      if (existsSync(join(globalSkillsRoot(), skill))) globalNameCollisions.push(skill)
    } catch { /* the probe is optional (6.1) */ }
  }
  return { quarantineOn: quarantineOn(), quarantineApplies: false, findings, globalNameCollisions }
}

// ---------------------------------------------------------------------------
// The reaper (plan 7.3)
// ---------------------------------------------------------------------------

/** The tmp name atomicWriteFileSync leaves for `<slug>.json` (`<file>.<pid>.<ms>.<hex>.tmp`). */
const MARKER_TMP_RE = /^([a-z0-9-]+)\.json\.[0-9]+\.[0-9]+\.[0-9a-f]+\.tmp$/

export interface ReapSummary {
  setAside: number
  removedMarkers: number
  badMarkers: number
  blocked: number
}

/**
 * Plan 7.3: walks the markers folder (never agents/ itself), and for each marker decides with installMarkerState:
 * an interrupted install's folder is set aside, an orphan marker is removed, a bad marker is moved to
 * leftovers/bad-markers, a link or folder in a marker's place is left alone with an owner notice. Writes the
 * hidden list at the end. `only` limits it to one name (the install request's own name, plan 6.1 step 4).
 */
export function reapInterruptedPackageInstalls(opts: { only?: string; now?: () => Date } = {}): ReapSummary {
  const now = (opts.now ?? (() => new Date()))()
  const sum: ReapSummary = { setAside: 0, removedMarkers: 0, badMarkers: 0, blocked: 0 }
  let entries: string[]
  try {
    entries = readdirSync(installingDir())
  } catch {
    entries = []
  }
  if (opts.only !== undefined) entries = entries.filter((e) => e === `${opts.only}.json`)
  for (const e of entries.sort()) {
    try {
      reapEntry(e, now, sum)
    } catch (err) {
      logger.error({ err, entry: e }, 'agent package reaper: an entry could not be handled')
    }
  }
  writeHiddenListBestEffort()
  return sum
}

function reapEntry(entry: string, now: Date, sum: ReapSummary): void {
  const path = join(installingDir(), entry)
  const st = lstatSync(path)
  const tmp = MARKER_TMP_RE.exec(entry)
  if (tmp !== null && isInstallableName(tmp[1]) && st.isFile()) {
    unlinkSync(path)
    return
  }
  const name = entry.endsWith('.json') ? entry.slice(0, -'.json'.length) : entry
  if (!st.isFile()) {
    // D17: a link or a folder in a marker's place is never touched; the owner hears about it.
    logger.error({ entry }, 'agent package reaper: a non-file stands in the markers folder; left alone')
    writePendingNotice('marker_blocked', isInstallableName(name) ? name : 'unknown', path, now)
    sum.blocked++
    return
  }
  let content: MarkerContent | null = null
  if (entry.endsWith('.json') && isInstallableName(name)) {
    try {
      content = parseMarker(readFileSync(path, 'utf8'), name)
    } catch {
      content = null
    }
  }
  if (content === null) {
    // 0. (J2, Samu v1.2.1/7): a bad marker is moved aside; nothing under agents/ is touched.
    const badDir = join(leftoversDir(), 'bad-markers')
    mkdirSync(badDir, { recursive: true, mode: 0o700 })
    const target = freePath(join(badDir, `${stampOf(now)}-${entry}`))
    renameSync(path, target)
    logger.warn({ entry, to: target }, 'agent package reaper: a malformed install marker was moved aside')
    writePendingNotice('bad_marker', isInstallableName(name) ? name : 'unknown', target, now)
    sum.badMarkers++
    return
  }
  const dir = join(agentsBaseDir(), name)
  let dst
  try {
    dst = lstatSync(dir)
  } catch {
    dst = null
  }
  const dropMarker = () => { removeMarker(name); sum.removedMarkers++ }
  if (content.ino === undefined) {
    if (dst === null) return dropMarker()
    if (dst.isDirectory() && !dst.isSymbolicLink() && readdirSync(dir).length === 0) {
      rmdirSync(dir)
      return dropMarker()
    }
    logger.warn({ name }, 'agent package reaper: an inode-less marker stood beside a non-empty folder; the folder is left alone')
    return dropMarker()
  }
  if (dst === null) return dropMarker()
  const state = installMarkerState(name)
  if (state.kind === 'valid') {
    if (setAside(name, now) !== null) sum.setAside++
    return
  }
  if (state.kind === 'invalid' && (state.why === 'launch_trace' || state.why === 'not_installer_dir')) {
    dropMarker()
    writePendingNotice('orphan_marker', name, dir, now)
    return
  }
  logger.warn({ name, state }, 'agent package reaper: an orphan marker (another folder stands under the name) was removed; the folder is left alone')
  dropMarker()
}

// ---------------------------------------------------------------------------
// The start guard (plan 7.4)
// ---------------------------------------------------------------------------

export const REFUSAL_INSTALL_INCOMPLETE = 'Package install incomplete'
export const REFUSAL_FILES_MISSING = 'Package files missing: run a package repair'
export const REFUSAL_SHELL_BROKEN = 'Package shell broken: CLAUDE.md must start with the PACKAGE.md and LOCAL.md import lines'

/** The CLAUDE.md bytes when it is a regular file that can be read, else null. */
function regularFileBytes(p: string): Buffer | null {
  try {
    if (!lstatSync(p).isFile()) return null
    return readFileSync(p)
  } catch {
    return null
  }
}

/**
 * Plan 7.4: the three refusals of a package agent's start, in order; null when it may start.
 *  1. a VALID install marker stands for the name;
 *  2. the CLAUDE.md starts with the shell, but PACKAGE.md is missing, a link, not a regular file, unreadable or empty;
 *  3. the manifest file exists and is not empty, but the CLAUDE.md is not a regular file starting with the shell.
 */
export function packageStartRefusal(name: string, dir: string): string | null {
  if (installMarkerState(name).kind === 'valid') return REFUSAL_INSTALL_INCOMPLETE
  const claude = regularFileBytes(join(dir, 'CLAUDE.md'))
  const shell = claude !== null && startsWithPackageShell(claude)
  if (shell) {
    const pkg = regularFileBytes(join(dir, 'PACKAGE.md'))
    if (pkg === null || isBlankBytes(pkg)) return REFUSAL_FILES_MISSING
    return null
  }
  if (hasPackageManifestFile(dir)) return REFUSAL_SHELL_BROKEN
  return null
}

/**
 * The package layer and the local layer, joined exactly as the EPERM fallback expands them, scanned in REPORT mode:
 * a finding is logged and the owner told, the start goes on. Both start paths run it, so they behave alike (Samu
 * 81355, PRI3HARDEN1118 point 2); blocking stays with PACKAGE.md at install. The owner is told once per agent and
 * finding (Dani 80640): the last told finding is kept in a stamp, a clean start removes it, a different finding is
 * told again. One stamp for both paths, so a fallback after a normal start does not tell the same finding twice.
 */
/**
 * Whether a LOCAL.md import target stays inside the agent's own folder (Samu 81392). Only a relative path without a
 * `..` segment, not absolute, not `~`, whose real location (the file, or its nearest existing ancestor) is inside the
 * folder's real path: a symlink inside the folder that points out is not local. Anything that cannot be told is not.
 */
function isAgentLocalImport(dir: string, target: string): boolean {
  if (target === '' || isAbsolute(target) || target.startsWith('~') || target.split(/[\\/]/).includes('..')) return false
  let root: string
  try { root = realpathSync(dir) } catch { return false }
  let p = join(dir, target)
  for (;;) {
    try {
      const real = realpathSync(p)
      return real === root || real.startsWith(root + sep)
    } catch { /* not there yet: check the nearest existing ancestor */ }
    const up = dirname(p)
    if (up === p) return false
    p = up
  }
}

function reportLayerFinding(name: string, dir: string, pkg: string, local: string, kind: 'fallback_scan_finding' | 'start_scan_finding'): void {
  // LOCAL.md is written by the owner AND by the agent itself, and an import there is attached at the next start
  // with no Read gate or hook seeing it (Dani 81388). So only an import that stays inside the agent's folder is
  // silent; an absolute, ~ or .. one, or one leaving through a symlink, is reported (Samu 81392). The silent ones
  // are neutralized in LOCAL.md only, so every other finding there, and an import in PACKAGE.md, is still seen (the
  // import rule ranks high, so skipping its finding would hide a later one). The regex is the verifier's own.
  const localImport = new RegExp(`${IMPORT_TOKEN_RE.source}(\\S*)`, 'gu')
  const localForScan = local.replace(localImport, (m: string, target: string) => (isAgentLocalImport(dir, target) ? `_${target}` : m))
  const finding = scanPackageText(Buffer.from(`\n${pkg}\n\n\n${localForScan}\n`, 'utf8'))
  const stamp = join(leftoversDir(), 'layer-scan-noticed', `${name}.txt`)
  if (finding === null) {
    try { unlinkSync(stamp) } catch { /* none */ }
    return
  }
  logger.warn({ name, kind, reason: finding.reason, rule: finding.rule }, 'package start: PACKAGE.md + LOCAL.md have a package text rule finding; starting anyway (report only)')
  const key = `${finding.reason}:${finding.rule}`
  let told: string | null = null
  try { told = readFileSync(stamp, 'utf8') } catch { /* never told */ }
  if (told === key) return
  writePendingNotice(kind, name, dir, new Date())
  try {
    mkdirSync(dirname(stamp), { recursive: true, mode: 0o700 })
    atomicWriteFileSync(stamp, key, { mode: 0o600 })
  } catch (err) {
    logger.warn({ err, name }, 'package start: the finding notice stamp could not be stored; the next start tells again')
  }
}

/** The normal start path's report scan (see reportLayerFinding). A package agent only; never throws. */
export function reportPackageLayersAtStart(name: string, dir: string): void {
  try {
    const claude = regularFileBytes(join(dir, 'CLAUDE.md'))
    if (claude === null || !startsWithPackageShell(claude)) return
    const pkg = regularFileBytes(join(dir, 'PACKAGE.md'))
    if (pkg === null) return
    const local = regularFileBytes(join(dir, 'LOCAL.md'))
    reportLayerFinding(name, dir, pkg.toString('utf8'), local === null ? '' : local.toString('utf8'), 'start_scan_finding')
  } catch (err) {
    logger.warn({ err, name }, 'package start: the report scan failed; starting anyway')
  }
}

// ---------------------------------------------------------------------------
// The EPERM fallback (plan 4.4)
// ---------------------------------------------------------------------------

/**
 * Plan 4.4 (Samu 77251, variant B): prepares the CLAUDE.md of the /tmp fallback folder of a channel start. A package
 * agent (its CLAUDE.md starts with the shell: the SHELL decides, not the manifest) gets a REAL file in which the two
 * import lines are replaced by the two files' text (an import from /tmp would be external and silently not load,
 * M24), 0600 in a 0700 folder, plus a LOCAL.md link so the agent's writes land in the real file. Any other agent gets
 * the CLAUDE.md link it always got. EVERY agent (#2878, changing the plan's N13 "the non-package branch is unchanged")
 * also gets its project-level settings, hooks and skills linked in (linkFallbackProjectConfig): the fallback session runs
 * from /tmp and would otherwise start without them. 'refused' when the guard refuses, the expansion fails or an existing
 * settings file cannot be linked: the caller does not start then.
 */
/** The agent's project-level Claude Code files the fallback session must see from its /tmp cwd. */
export const FALLBACK_PROJECT_LINKS = ['settings.json', 'settings.local.json', 'hooks', 'skills'] as const

/**
 * The fallback session runs from the /tmp folder, so Claude Code would not see the agent's project-level settings and
 * skills there (#2878 C-path, measured: the package skill did not load). Each one that exists in the agent's .claude
 * folder is linked under <fallbackCwd>/.claude/ (0700); a missing source gets no link (no dangling link). The hooks
 * folder too: CLAUDE_PROJECT_DIR is the /tmp folder in that session, so a project hook written as
 * "$CLAUDE_PROJECT_DIR/.claude/hooks/x.sh" would fail with exit 127, a non-blocking error, and the owner's own gate
 * would drop out silently (C-path re-run, measured). Returns false when an existing settings file or hooks folder could
 * not be linked, or a project hook names another path under $CLAUDE_PROJECT_DIR that the fallback folder cannot
 * resolve (unresolvedProjectDirHookPaths): the session would then start without the agent's project settings or
 * gates, so the caller does not start it (fail closed, with the owner's fallback_refused notice).
 */
export function linkFallbackProjectConfig(dir: string, fallbackCwd: string): boolean {
  const target = join(fallbackCwd, '.claude')
  try { mkdirSync(target, { mode: 0o700 }) } catch { /* exists: checked below */ }
  try { chmodSync(target, 0o700) } catch { return false }
  let ok = true
  for (const name of FALLBACK_PROJECT_LINKS) {
    const src = join(dir, '.claude', name)
    if (!existsSync(src)) continue // existsSync follows links: a missing or dangling source gets no link
    try {
      symlinkSync(src, join(target, name))
    } catch (err) {
      logger.error({ err, src }, 'EPERM fallback: a project-level Claude Code file could not be linked into the fallback folder')
      if (name !== 'skills') ok = false
    }
  }
  const unresolved = unresolvedProjectDirHookPaths(dir, fallbackCwd)
  if (unresolved.length > 0) {
    logger.error({ paths: unresolved }, 'EPERM fallback: a project hook names a path under $CLAUDE_PROJECT_DIR that the fallback folder does not have; not started')
    ok = false
  }
  return ok
}

/** "$CLAUDE_PROJECT_DIR/x", "${CLAUDE_PROJECT_DIR}/x", "$CLAUDE_PROJECT_DIR"/x: the path after the variable. */
const PROJECT_DIR_PATH = /\$(?:\{CLAUDE_PROJECT_DIR\}|CLAUDE_PROJECT_DIR)"?(\/[^\s"'`;|&<>()]+)/g

/**
 * FALLBACKPROJDIR1118: in the fallback session CLAUDE_PROJECT_DIR is the /tmp folder, which has only the links made
 * above. A hook command naming another path under it (e.g. "$CLAUDE_PROJECT_DIR/scripts/x.sh") fails there with
 * exit 127, a non-blocking error for most hook events, so the owner's gate would drop out silently. Returns those
 * paths that exist in the agent dir but not from the fallback folder; a path missing from the agent dir too is the
 * hook's own fault and is the same on the normal path, so it does not count.
 */
export function unresolvedProjectDirHookPaths(dir: string, fallbackCwd: string): string[] {
  const out: string[] = []
  for (const file of ['settings.json', 'settings.local.json']) {
    let hooks: unknown
    try {
      hooks = (JSON.parse(readFileSync(join(dir, '.claude', file), 'utf8')) as { hooks?: unknown }).hooks
    } catch { continue } // missing or unreadable: there is no hook of this file to check
    if (typeof hooks !== 'object' || hooks === null) continue
    for (const groups of Object.values(hooks)) {
      if (!Array.isArray(groups)) continue
      for (const group of groups) {
        const list = (group as { hooks?: unknown })?.hooks
        if (!Array.isArray(list)) continue
        for (const h of list) {
          const cmd = (h as { command?: unknown })?.command
          if (typeof cmd !== 'string') continue
          for (const m of cmd.matchAll(PROJECT_DIR_PATH)) {
            const rel = m[1]
            if (existsSync(join(dir, rel)) && !existsSync(join(fallbackCwd, rel)) && !out.includes(rel)) out.push(rel)
          }
        }
      }
    }
  }
  return out
}

export function prepareFallbackClaudeMd(name: string, dir: string, fallbackCwd: string): 'expanded' | 'linked' | 'refused' {
  const agentClaudeMd = join(dir, 'CLAUDE.md')
  const claude = regularFileBytes(agentClaudeMd)
  if (claude === null || !startsWithPackageShell(claude)) {
    if (existsSync(agentClaudeMd)) {
      try { symlinkSync(agentClaudeMd, join(fallbackCwd, 'CLAUDE.md')) } catch { /* degrade to context-less */ }
    }
    if (!linkFallbackProjectConfig(dir, fallbackCwd)) {
      writePendingNotice('fallback_refused', name, dir, new Date())
      return 'refused'
    }
    return 'linked'
  }
  const refusal = packageStartRefusal(name, dir)
  if (refusal !== null) {
    logger.error({ name, refusal }, 'EPERM fallback refused for a package agent: not started')
    writePendingNotice('fallback_refused', name, dir, new Date())
    return 'refused'
  }
  try {
    const pkg = readFileSync(join(dir, 'PACKAGE.md'), 'utf8')
    let local = ''
    const localBytes = regularFileBytes(join(dir, 'LOCAL.md'))
    if (localBytes === null) {
      logger.warn({ name }, 'EPERM fallback: LOCAL.md is missing; the local layer is empty in the fallback')
    } else {
      local = localBytes.toString('utf8')
      // 4.4 point 12: the same predicate as S10. An import the owner wrote into the local layer is external from
      // /tmp and silently does not load.
      if (scanPackageText(localBytes)?.reason === 'forbidden_import_token') {
        logger.warn({ name }, 'EPERM fallback: LOCAL.md has an import line; it does not load from the fallback folder')
      }
    }
    const rest = claude.toString('utf8').slice(PACKAGE_SHELL_PREFIX_TEXT.length)
    const expanded = `\n${pkg}\n\n\n${local}\n${rest}`
    // Report only (#2878 review): the expanded text joins the package layer with the local layer, which no package
    // rule has seen. A finding is logged and the owner told; the start goes on, as on the normal path, which loads
    // the same texts through the two import lines.
    // Only the two layers are scanned (#2878 C-path): the shell rest is the product's own generated text (its
    // sections carry an at-sign after white space, e.g. "[Uzenet @..."), which would raise a false notice on every
    // fallback. The layers are scanned joined exactly as they stand in the expanded file, so a shape formed across
    // their boundary is still seen.
    reportLayerFinding(name, dir, pkg, local, 'fallback_scan_finding')
    chmodSync(fallbackCwd, 0o700)
    const target = join(fallbackCwd, 'CLAUDE.md')
    writeFileSync(target, expanded, { mode: 0o600, flag: 'wx' })
    chmodSync(target, 0o600)
    try { symlinkSync(join(dir, 'LOCAL.md'), join(fallbackCwd, 'LOCAL.md')) } catch { /* the write link is best effort */ }
    if (!linkFallbackProjectConfig(dir, fallbackCwd)) {
      writePendingNotice('fallback_refused', name, dir, new Date())
      return 'refused'
    }
    return 'expanded'
  } catch (err) {
    logger.error({ err, name }, 'EPERM fallback: the package agent CLAUDE.md could not be expanded; not started')
    writePendingNotice('fallback_refused', name, dir, new Date())
    return 'refused'
  }
}

/**
 * Plan 7.2 (layout, IR8, D5): true when agents/ (its real path; its parent while it does not exist yet) and the
 * store are on one device, so a set-aside is one rename. A failed stat counts as a different device (refused).
 */
export function sameDeviceLayout(storeDir: string, stat: (p: string) => { dev: number | bigint } = (p) => lstatSync(realpathSync(p))): boolean {
  try {
    const agents = existsSync(agentsBaseDir()) ? agentsBaseDir() : dirname(agentsBaseDir())
    return String(stat(agents).dev) === String(stat(storeDir).dev)
  } catch {
    return false
  }
}
