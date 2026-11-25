// Agent package install marker and shell predicates (MIOAGENTINSTALL1114, PR-I3; plan 7.2, 7.5).
//
// A LEAF module: it imports neither agent-config.ts nor agent-scaffold.ts (both import it), and it resolves every
// path inside a function, never at load time (plan 7.5, IR6: a store-dependent import at load time once broke
// three test suites that mock the config in part).
//
// What lives here, because more than one place must decide it the same way:
//  - the shell prefix of a package agent's CLAUDE.md and the ONE predicate that says whether a file starts with it
//    (startsWithPackageShell): the start guard, the editor's 409, the marker validator and the EPERM fallback use
//    it; the watchdog compares the same bytes, read from scripts/lib/package-shell-prefix (a test binds the two);
//  - the empty-file rule (isBlankBytes): the six ASCII white space bytes, nothing else;
//  - the begin marker of the fleet-roster block, the launch trace of the marker rule (agent-scaffold.ts takes it
//    from here);
//  - the install marker (store/agent-package-installing/<name>.json): where it is, when it COUNTS
//    (installMarkerState), the directory identity (sameDirIdentity), and the derived hidden list the watchdog reads
//    (store/agent-package-hidden.json).
import { lstatSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { MAIN_AGENT_ID, PROJECT_ROOT, RESERVED_AGENT_IDS, STORE_DIR } from '../../config.js'
import { logger } from '../../logger.js'
import { atomicWriteFileSync } from '../atomic-write.js'
import { sanitizeAgentName } from '../sanitize.js'
import { SLUG_RE } from './verify.js'

// ---------------------------------------------------------------------------
// The shell (plan 4, 7.5)
// ---------------------------------------------------------------------------

/**
 * The first bytes of a package agent's CLAUDE.md: the package layer import, an empty line, the local layer import,
 * each line ended by LF; no BOM, no CR, no white space at a line's start or end, nothing before it. The watchdog
 * compares a file against scripts/lib/package-shell-prefix, which holds exactly these bytes (pinned by a test).
 */
export const PACKAGE_SHELL_PREFIX_TEXT = '@PACKAGE.md\n\n@LOCAL.md\n'
const PREFIX = Buffer.from(PACKAGE_SHELL_PREFIX_TEXT, 'utf8')

/** A copy of the prefix bytes. */
export function packageShellPrefixBytes(): Buffer {
  return Buffer.from(PREFIX)
}

/** True when `bytes` start with the shell prefix, byte for byte. The one predicate of plan 7.5. */
export function startsWithPackageShell(bytes: Uint8Array): boolean {
  if (bytes.length < PREFIX.length) return false
  for (let i = 0; i < PREFIX.length; i++) if (bytes[i] !== PREFIX[i]) return false
  return true
}

/**
 * Plan 7.5 (Dani C1): a file is empty when it holds no byte other than space, tab, LF, VT, FF and CR; a zero-byte
 * file is empty. On the BYTES, with this explicit class, not trim(): a BOM, a no-break space or U+2028 is content.
 */
export function isBlankBytes(bytes: Uint8Array): boolean {
  for (const b of bytes) if (b !== 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0b && b !== 0x0c && b !== 0x0d) return false
  return true
}

/** The begin marker of the generated fleet-roster block (agent-scaffold.ts writes the block). */
export const FLEET_ROSTER_BEGIN = '<!-- BEGIN GENERATED: fleet-roster (auto-generated, do not edit by hand) -->'

/** The launch trace of plan 7.2 (J1/b): the fleet-roster block's begin marker stands in the CLAUDE.md. */
export function hasLaunchTrace(claudeMd: Uint8Array | string): boolean {
  const text = typeof claudeMd === 'string' ? claudeMd : Buffer.from(claudeMd).toString('utf8')
  return text.includes(FLEET_ROSTER_BEGIN)
}

/** `agents/<name>/.package/manifest.json` */
export function manifestPathOf(dir: string): string {
  return join(dir, '.package', 'manifest.json')
}

/**
 * Plan 7.4 condition 3 and the editor's 409 (Samu C6, Dani B2): the manifest file EXISTS and is NOT EMPTY, whether or
 * not it can be read as a manifest. Fail closed: an entry that is there but is not a regular file (a link, a
 * directory) or cannot be read counts as a non-empty manifest.
 */
export function hasPackageManifestFile(dir: string): boolean {
  const p = manifestPathOf(dir)
  let st
  try {
    st = lstatSync(p)
  } catch (err) {
    return (err as { code?: unknown } | null)?.code !== 'ENOENT'
  }
  if (!st.isFile()) return true
  try {
    return !isBlankBytes(readFileSync(p))
  } catch {
    return true
  }
}

/**
 * A package agent for the carriers (plan 4.2: the agent export refuses it, the fleet exports skip it): its manifest
 * file exists and is not empty, OR its CLAUDE.md starts with the shell. Either way the carriers would move only the
 * shell, and the imported agent would start without its persona.
 */
export function isPackageAgentDir(dir: string): boolean {
  if (hasPackageManifestFile(dir)) return true
  try {
    const p = join(dir, 'CLAUDE.md')
    return lstatSync(p).isFile() && startsWithPackageShell(readFileSync(p))
  } catch {
    return false
  }
}

/** The answer of a carrier that will not move a package agent: what to do instead (plan 4.2). */
export const PACKAGE_AGENT_EXPORT_REFUSAL =
  'This agent comes from an agent package, and an export would carry only its shell: on the new machine, install the package again from the catalog.'

// ---------------------------------------------------------------------------
// Names (plan 6.1 step 2 and 3, 7.2 condition 1)
// ---------------------------------------------------------------------------

/** A name a package may be installed under: the strict slug, sanitizeAgentName's fixed point, and not reserved. */
export function isInstallableName(name: string): boolean {
  return SLUG_RE.test(name) && sanitizeAgentName(name) === name && !isReservedName(name)
}

/** The main agent's id, or an id the message layer or the agents API owns (RESERVED_AGENT_IDS). */
export function isReservedName(name: string): boolean {
  return name === MAIN_AGENT_ID || RESERVED_AGENT_IDS.includes(name)
}

// ---------------------------------------------------------------------------
// Paths (resolved per call)
// ---------------------------------------------------------------------------

export function agentsBaseDir(): string {
  return join(PROJECT_ROOT, 'agents')
}
export function installingDir(): string {
  return join(STORE_DIR, 'agent-package-installing')
}
export function leftoversDir(): string {
  return join(STORE_DIR, 'agent-package-leftovers')
}
export function hiddenListPath(): string {
  return join(STORE_DIR, 'agent-package-hidden.json')
}
export function markerPathOf(name: string): string {
  return join(installingDir(), `${name}.json`)
}

// ---------------------------------------------------------------------------
// The marker (plan 7.2, 7.5)
// ---------------------------------------------------------------------------

/** What the marker file holds. dev, ino and birthtimeNs are decimal strings (from the bigint stat), added at step 3. */
export interface MarkerContent {
  slug: string
  version: string
  startedAt: string
  pid: number
  dev?: string
  ino?: string
  birthtimeNs?: string
}

export type MarkerInvalidWhy =
  | 'bad_name' | 'bad_content' | 'not_regular_file' | 'unreadable' | 'identity_mismatch' | 'not_installer_dir' | 'launch_trace'

export type MarkerState =
  | { kind: 'none' }
  | { kind: 'valid'; phase: 'pre-dir' | 'post-dir' }
  | { kind: 'invalid'; why: MarkerInvalidWhy }

/** The directory identity the marker records. */
export interface DirIdentity {
  dev: string
  ino: string
  birthtimeNs: string
}

/** The fields of a bigint stat sameDirIdentity reads. */
export interface DirStat {
  dev: bigint
  ino: bigint
  birthtimeNs: bigint
  ctimeNs: bigint
  mtimeNs: bigint
}

/**
 * Plan 7.2, "the identity of the directory" (Samu N18/b): dev and ino always; the birth time only where it is
 * reliable, and whether it is reliable is decided NOW, from the stat being compared: not zero, and different from
 * both the change time and the modification time (a file system that reports one of those as the birth time is
 * recognised by the two being equal).
 */
export function sameDirIdentity(marker: DirIdentity, st: DirStat): boolean {
  if (marker.dev !== st.dev.toString() || marker.ino !== st.ino.toString()) return false
  const reliable = st.birthtimeNs !== 0n && st.birthtimeNs !== st.ctimeNs && st.birthtimeNs !== st.mtimeNs
  return !reliable || marker.birthtimeNs === st.birthtimeNs.toString()
}

/** The identity of an existing directory, for the marker (plan 7.2 step 3). */
export function dirIdentityOf(path: string): DirIdentity {
  const st = statSync(path, { bigint: true })
  return { dev: st.dev.toString(), ino: st.ino.toString(), birthtimeNs: st.birthtimeNs.toString() }
}

const DECIMAL_RE = /^(0|[1-9][0-9]*)$/

/** The marker file's content, checked; null when it is not a marker for `name` (J2: the name is the file name's). */
export function parseMarker(text: string, name: string): MarkerContent | null {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return null
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (o.slug !== name || typeof o.version !== 'string' || typeof o.startedAt !== 'string' || typeof o.pid !== 'number') return null
  if (!('ino' in o)) return { slug: name, version: o.version, startedAt: o.startedAt, pid: o.pid }
  // An inode without a device id or a birth time is bad content (plan 7.5).
  for (const k of ['dev', 'ino', 'birthtimeNs'] as const) if (typeof o[k] !== 'string' || !DECIMAL_RE.test(o[k] as string)) return null
  return { slug: name, version: o.version, startedAt: o.startedAt, pid: o.pid, dev: o.dev as string, ino: o.ino as string, birthtimeNs: o.birthtimeNs as string }
}

const loggedInvalid = new Set<string>()
function logInvalidOnce(name: string, why: MarkerInvalidWhy): void {
  const key = `${name}\u0000${why}`
  if (loggedInvalid.has(key)) return
  loggedInvalid.add(key)
  logger.warn({ name, why }, 'agent package install marker does not count: the agent stays visible and startable')
}

/**
 * Plan 7.2: whether the install marker for `name` COUNTS (hides the name and refuses its start). The four consumers
 * (the roster, isKnownAgent, the start guard, and through the hidden list the watchdog) and the startup reaper all
 * call this. A marker that does not count is logged once per name and reason per process, and left where it is.
 */
export function installMarkerState(name: string): MarkerState {
  const state = evaluateMarker(name)
  if (state.kind === 'invalid') logInvalidOnce(name, state.why)
  return state
}

function evaluateMarker(name: string): MarkerState {
  const path = markerPathOf(name)
  let st
  try {
    st = lstatSync(path)
  } catch (err) {
    return (err as { code?: unknown } | null)?.code === 'ENOENT' ? { kind: 'none' } : { kind: 'invalid', why: 'unreadable' }
  }
  if (!isInstallableName(name)) return { kind: 'invalid', why: 'bad_name' }
  if (!st.isFile()) return { kind: 'invalid', why: 'not_regular_file' }
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return { kind: 'invalid', why: 'unreadable' }
  }
  const marker = parseMarker(text, name)
  if (marker === null) return { kind: 'invalid', why: 'bad_content' }
  const dir = join(agentsBaseDir(), name)
  let dst
  try {
    dst = lstatSync(dir)
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code !== 'ENOENT') return { kind: 'invalid', why: 'unreadable' }
    // No directory: an inode-less marker (the install stopped before or while creating it) still counts.
    return marker.ino === undefined ? { kind: 'valid', phase: 'pre-dir' } : { kind: 'invalid', why: 'identity_mismatch' }
  }
  if (!dst.isDirectory()) return { kind: 'invalid', why: marker.ino === undefined ? 'not_installer_dir' : 'identity_mismatch' }
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return { kind: 'invalid', why: 'unreadable' }
  }
  if (marker.ino === undefined) {
    // J1/e: an inode-less marker hides only an EMPTY directory.
    return entries.length === 0 ? { kind: 'valid', phase: 'pre-dir' } : { kind: 'invalid', why: 'not_installer_dir' }
  }
  let bst: DirStat
  try {
    bst = statSync(dir, { bigint: true })
  } catch {
    return { kind: 'invalid', why: 'unreadable' }
  }
  if (!sameDirIdentity({ dev: marker.dev!, ino: marker.ino, birthtimeNs: marker.birthtimeNs! }, bst)) {
    return { kind: 'invalid', why: 'identity_mismatch' }
  }
  // The positive proof (IR9, D9): empty, or a CLAUDE.md that is a regular file starting with the shell...
  if (entries.length === 0) return { kind: 'valid', phase: 'post-dir' }
  const claudeMd = join(dir, 'CLAUDE.md')
  let bytes: Buffer
  try {
    if (!lstatSync(claudeMd).isFile()) return { kind: 'invalid', why: 'not_installer_dir' }
    bytes = readFileSync(claudeMd)
  } catch {
    return { kind: 'invalid', why: 'not_installer_dir' }
  }
  if (!startsWithPackageShell(bytes)) return { kind: 'invalid', why: 'not_installer_dir' }
  // ...and no launch trace (J1/b): a finished install wrote the fleet-roster block at its step 7/b.
  if (hasLaunchTrace(bytes)) return { kind: 'invalid', why: 'launch_trace' }
  return { kind: 'valid', phase: 'post-dir' }
}

/**
 * True when a VALID install marker hides `name` (plan 4.2: listAllAgentNames, isKnownAgent). Any failure of the
 * check itself counts as not hidden: a marker that cannot be evaluated never hides an agent.
 */
export function isHiddenByInstallMarker(name: string): boolean {
  try {
    return installMarkerState(name).kind === 'valid'
  } catch {
    return false
  }
}

/** The names a marker file stands for (`<name>.json` in the markers folder), sorted; [] when there is no folder. */
export function markerNames(): string[] {
  let names: string[]
  try {
    names = readdirSync(installingDir())
  } catch {
    return []
  }
  return names.filter((n) => n.endsWith('.json') && n.length > '.json'.length).map((n) => n.slice(0, -'.json'.length)).sort()
}

/**
 * Plan 7.2 (J1/f): writes store/agent-package-hidden.json, the array of names with a VALID marker, atomically, 0600.
 * The watchdog reads only this list. Written even when it is empty, so a missing file is always abnormal.
 * Best effort: a failure is a log line and changes no install result. Returns the list written, or null.
 */
export function writeHiddenList(): string[] | null {
  const hidden = markerNames().filter((n) => installMarkerState(n).kind === 'valid')
  try {
    atomicWriteFileSync(hiddenListPath(), JSON.stringify(hidden) + '\n', { mode: 0o600 })
    return hidden
  } catch (err) {
    logger.error({ err }, 'agent package hidden list could not be written')
    return null
  }
}
