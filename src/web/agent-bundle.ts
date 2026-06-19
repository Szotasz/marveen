import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  cpSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { agentDir } from './agent-config.js'
import { sanitizeAgentName } from './sanitize.js'
import { atomicWriteFileSync } from './atomic-write.js'

// Portable per-agent export/import bundle.
//
// An "agent" on disk is the directory `agents/<name>/`. This module packs that
// directory into a single self-describing `.tar.gz` so one (or a few) chosen
// agents can be moved to another machine WITHOUT dragging the whole fleet or
// the global SQLite DB (that is what scripts/backup.sh is for). The bundle is
// the unit a user downloads from the dashboard on machine A and uploads on
// machine B.
//
// Two trust levels, selected at export time:
//   - secrets EXCLUDED (default): identity + behaviour only, safe to share.
//   - secrets INCLUDED: also the channel bot tokens (.env) + pairing state, for
//     a confidential move between the operator's own machines.
//
// We shell out to the system `tar` (same choice as scripts/backup.sh) rather
// than add a tar dependency: it is present on every macOS/Linux host the fleet
// runs on, and a staging dir keeps the archive layout identical across bsdtar
// and GNU tar (see the staging note in backup.sh).

export const BUNDLE_SCHEMA_VERSION = 1

export interface BundleManifest {
  schemaVersion: number
  // The sanitized agent name the bundle was exported as. Import re-sanitizes
  // and may override this (rename-on-import), but the original is recorded so
  // the operator can see where it came from.
  agentName: string
  // Whether channel tokens / pairing state were included.
  includesSecrets: boolean
  // Free-form provenance, never trusted for any logic.
  exportedBy?: string
  exportedAt?: string
}

// Files/dirs that make up a portable agent, RELATIVE to agents/<name>/.
// Identity + behaviour, no machine-specific runtime state. These are copied
// regardless of the secrets flag.
const PORTABLE_ENTRIES = [
  'agent-config.json',
  'CLAUDE.md',
  'SOUL.md',
  '.mcp.json',
  'avatar.png',
  'avatar.jpg',
  'avatar.jpeg',
  'avatar.webp',
  '.claude/settings.json',
  '.claude/skills',
  '.claude/hooks',
  'memory',
] as const

// Channel secret files, relative to agents/<name>/. Only copied when the
// operator explicitly opts into a secrets-bearing export. The provider subdir
// (telegram/slack/discord) is discovered at pack time.
const CHANNEL_STATE_ROOT = join('.claude', 'channels')
const CHANNEL_SECRET_FILES = ['.env', 'access.json', 'invites.json'] as const
const CHANNEL_SECRET_DIRS = ['approved'] as const

// agent-config.json keys that are machine-specific and must NOT survive a move
// to another host: a remote agent's ssh host/workdir and a per-agent
// CLAUDE_CONFIG_DIR point at paths/credentials that only exist on the source
// machine. Stripped on import so an imported agent starts as a clean local
// agent the operator can re-point if needed.
const MACHINE_SPECIFIC_CONFIG_KEYS = ['remoteHost', 'remoteWorkdir', 'claudeConfigDir'] as const

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

// Recursively copy a relative entry from <srcRoot> into <dstRoot>, preserving
// its relative path. No-op when the source does not exist (a fresh agent may
// lack SOUL.md, an avatar, skills, etc. -- absence is normal, not an error).
function copyEntryInto(srcRoot: string, dstRoot: string, rel: string): void {
  const src = join(srcRoot, rel)
  if (!existsSync(src)) return
  const dst = join(dstRoot, rel)
  mkdirSync(join(dst, '..'), { recursive: true })
  cpSync(src, dst, { recursive: true })
}

// Stage the portable subset of an agent's source dir into <stageAgentDir>,
// optionally including channel secrets. Returns the list of relative entries
// actually staged. Pure-ish: reads <srcRoot>, writes only the staging dir, and
// never touches AGENTS_BASE_DIR -- so it is hermetically testable against an
// arbitrary source tree. The agentDir() resolution lives in the thin wrappers.
export function stageAgentDirForExport(
  srcRoot: string,
  stageAgentDir: string,
  includeSecrets: boolean,
): string[] {
  if (!existsSync(srcRoot)) throw new Error(`Agent source not found: ${srcRoot}`)
  mkdirSync(stageAgentDir, { recursive: true })

  const staged: string[] = []
  for (const rel of PORTABLE_ENTRIES) {
    if (existsSync(join(srcRoot, rel))) {
      copyEntryInto(srcRoot, stageAgentDir, rel)
      staged.push(rel)
    }
  }

  if (includeSecrets) {
    const channelsRoot = join(srcRoot, CHANNEL_STATE_ROOT)
    if (existsSync(channelsRoot)) {
      for (const provider of readdirSync(channelsRoot)) {
        const providerDir = join(channelsRoot, provider)
        try { if (!statSync(providerDir).isDirectory()) continue } catch { continue }
        for (const f of CHANNEL_SECRET_FILES) {
          const rel = join(CHANNEL_STATE_ROOT, provider, f)
          if (existsSync(join(srcRoot, rel))) { copyEntryInto(srcRoot, stageAgentDir, rel); staged.push(rel) }
        }
        for (const d of CHANNEL_SECRET_DIRS) {
          const rel = join(CHANNEL_STATE_ROOT, provider, d)
          if (existsSync(join(srcRoot, rel))) { copyEntryInto(srcRoot, stageAgentDir, rel); staged.push(rel) }
        }
      }
    }
  }

  return staged
}

// Thin wrapper: resolve the named agent's dir under AGENTS_BASE_DIR, then stage.
export function stageAgentForExport(
  name: string,
  stageAgentDir: string,
  includeSecrets: boolean,
): string[] {
  return stageAgentDirForExport(agentDir(name), stageAgentDir, includeSecrets)
}

// Build a .tar.gz bundle of agent <name> at <outPath>. Returns the manifest
// that was embedded. The archive layout is:
//   manifest.json
//   agent/<portable files...>
export function exportAgentBundle(
  name: string,
  outPath: string,
  opts: { includeSecrets?: boolean; exportedBy?: string; exportedAt?: string } = {},
): BundleManifest {
  const includeSecrets = opts.includeSecrets === true
  const stage = makeTempDir('marveen-agent-export-')
  try {
    const stageAgentDir = join(stage, 'agent')
    stageAgentForExport(name, stageAgentDir, includeSecrets)

    const manifest: BundleManifest = {
      schemaVersion: BUNDLE_SCHEMA_VERSION,
      agentName: name,
      includesSecrets: includeSecrets,
      ...(opts.exportedBy ? { exportedBy: opts.exportedBy } : {}),
      ...(opts.exportedAt ? { exportedAt: opts.exportedAt } : {}),
    }
    writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2))

    // Single plain tar over the staging dir -- identical output on bsdtar and
    // GNU tar (see backup.sh). `-C stage .` keeps names clean (no temp prefix).
    mkdirSync(join(outPath, '..'), { recursive: true })
    execFileSync('tar', ['-czf', outPath, '-C', stage, 'manifest.json', 'agent'])
    return manifest
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

// Parse + validate a bundle's manifest without unpacking the whole thing.
// Throws with an operator-facing message on anything malformed.
export function readBundleManifest(extractedRoot: string): BundleManifest {
  const manifestPath = join(extractedRoot, 'manifest.json')
  if (!existsSync(manifestPath)) {
    throw new Error('Invalid bundle: manifest.json missing (not a Marveen agent bundle?)')
  }
  let parsed: unknown
  try { parsed = JSON.parse(readFileSync(manifestPath, 'utf-8')) } catch {
    throw new Error('Invalid bundle: manifest.json is not valid JSON')
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('Invalid bundle: manifest.json malformed')
  const m = parsed as Record<string, unknown>
  const schemaVersion = typeof m.schemaVersion === 'number' ? m.schemaVersion : 0
  if (schemaVersion > BUNDLE_SCHEMA_VERSION) {
    throw new Error(
      `Bundle schema version ${schemaVersion} is newer than this install supports ` +
      `(max ${BUNDLE_SCHEMA_VERSION}). Update Marveen on this machine first.`,
    )
  }
  const agentName = typeof m.agentName === 'string' ? m.agentName : ''
  if (!agentName) throw new Error('Invalid bundle: manifest.json has no agentName')
  return {
    schemaVersion,
    agentName,
    includesSecrets: m.includesSecrets === true,
    ...(typeof m.exportedBy === 'string' ? { exportedBy: m.exportedBy } : {}),
    ...(typeof m.exportedAt === 'string' ? { exportedAt: m.exportedAt } : {}),
  }
}

// Strip machine-specific fields from a staged agent-config.json in place, so an
// imported agent never inherits the source host's ssh/remote/config-dir paths.
export function sanitizeImportedConfig(stagedAgentDir: string): void {
  const cfgPath = join(stagedAgentDir, 'agent-config.json')
  if (!existsSync(cfgPath)) return
  let cfg: Record<string, unknown>
  try { cfg = JSON.parse(readFileSync(cfgPath, 'utf-8')) } catch { return }
  let changed = false
  for (const key of MACHINE_SPECIFIC_CONFIG_KEYS) {
    if (key in cfg) { delete cfg[key]; changed = true }
  }
  if (changed) atomicWriteFileSync(cfgPath, JSON.stringify(cfg, null, 2))
}

export interface ImportResult {
  name: string
  manifest: BundleManifest
  overwritten: boolean
}

// Import an agent bundle (a .tar.gz buffer or file) into agents/<name>/.
//   - overrideName: install under this name instead of the manifest's
//     (rename-on-import / collision resolution). Re-sanitized.
//   - overwrite: replace an existing agent dir of the same name; without it a
//     name collision throws so the caller can surface a 409.
//   - resolveDest: maps a sanitized name to its install path. Defaults to
//     agentDir() (the real AGENTS_BASE_DIR); overridden in tests to install
//     into a temp tree. safeJoin in agentDir() rejects traversal.
// Returns the final installed name + the bundle manifest.
export function importAgentBundle(
  bundle: Buffer,
  opts: { overrideName?: string; overwrite?: boolean; resolveDest?: (name: string) => string } = {},
): ImportResult {
  const resolveDest = opts.resolveDest ?? agentDir
  const work = makeTempDir('marveen-agent-import-')
  try {
    const bundlePath = join(work, 'bundle.tar.gz')
    writeFileSync(bundlePath, bundle)
    const extractRoot = join(work, 'extracted')
    mkdirSync(extractRoot, { recursive: true })
    // Extract into an isolated dir. tar's own path-traversal guard plus our
    // staged layout (manifest.json + agent/) mean nothing escapes extractRoot.
    try {
      execFileSync('tar', ['-xzf', bundlePath, '-C', extractRoot])
    } catch {
      throw new Error('Invalid bundle: could not extract (not a gzip tar archive?)')
    }

    const manifest = readBundleManifest(extractRoot)
    const stagedAgentDir = join(extractRoot, 'agent')
    if (!existsSync(stagedAgentDir) || !statSync(stagedAgentDir).isDirectory()) {
      throw new Error('Invalid bundle: agent/ directory missing')
    }

    const rawName = (opts.overrideName ?? manifest.agentName).trim()
    const name = sanitizeAgentName(rawName)
    if (!name) throw new Error('Invalid agent name (empty after sanitization)')

    sanitizeImportedConfig(stagedAgentDir)

    const dest = resolveDest(name) // agentDir: safeJoin rejects traversal
    const exists = existsSync(dest)
    if (exists && !opts.overwrite) {
      throw new Error(`Agent "${name}" already exists on this machine`)
    }
    if (exists) rmSync(dest, { recursive: true, force: true })
    mkdirSync(join(dest, '..'), { recursive: true })
    cpSync(stagedAgentDir, dest, { recursive: true })

    return { name, manifest, overwritten: exists }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

// Suggested download filename for a bundle. basename() defends against any odd
// characters in the name (it is already sanitized upstream, but the filename
// goes into a Content-Disposition header).
export function bundleFilename(name: string): string {
  const safe = basename(name).replace(/[^A-Za-z0-9_-]/g, '') || 'agent'
  return `marveen-agent-${safe}.tar.gz`
}
