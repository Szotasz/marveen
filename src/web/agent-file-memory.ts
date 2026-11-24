// Claude Code's file-based auto-memory of an agent (ISSUE3056FLEETMEM1122, #3056).
//
// Claude Code keys the memory folder by the GIT ROOT of the working directory, not by the agent: inside a git
// checkout with no repo of its own an agent writes to <config>/projects/<root slug>/memory, with a stub .git to
// <config>/projects/<agent slug>/memory (measured CC 2.1.289 / 2.1.284, agent-scaffold.ts). Where an agent's
// `projects` is a link to the shared ~/.claude/projects, its "own" memory is the main agent's, and every agent on
// the same link writes the same folder. So a folder only travels with ONE agent when no other agent, and not the
// main agent, resolves to it; otherwise it is shared, and a per-agent copy would leak the others' memory.
import {
  closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, writeFileSync,
  writeSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { agentDir, listAgentNames } from './agent-config.js'
import { configDirFor } from './main-transcript-root.js'
import { agentIsolatedConfigDir, resolveAgentConfigDir } from './claude-plans.js'

/** Claude Code's project folder name: every character that is not an ASCII letter or digit becomes '-'. */
export function slugOf(path: string): string {
  return path.replace(/[^A-Za-z0-9]/g, '-')
}

/** The folder Claude Code keys the memory by: the first ancestor of the real working dir holding .git, else the dir. */
export function memoryKeyRoot(workingDir: string): string {
  const real = realpathSync(workingDir)
  for (let cur = real; ; cur = dirname(cur)) {
    try {
      lstatSync(join(cur, '.git'))
      return cur
    } catch { /* not here */ }
    if (dirname(cur) === cur) return real
  }
}

/** The real path of `<configDir>/projects/<slug>/memory` when it is a folder there, else null. */
export function memoryDirAt(configDir: string, workingDir: string): string | null {
  try {
    const p = join(configDir, 'projects', slugOf(memoryKeyRoot(workingDir)), 'memory')
    const real = realpathSync(p)
    return lstatSync(real).isDirectory() ? real : null
  } catch {
    return null
  }
}

export interface FileMemory {
  /** The real path of the folder, or null when the agent has none. */
  dir: string | null
  /** True when the main agent or another agent resolves to the same folder. */
  shared: boolean
}

export interface MemoryLocation { workingDir: string; configDir: string | undefined }

/**
 * Every agent's folder, the main agent included, and whether it is shared. `locate` gives the launcher's working dir
 * and config dir (routes/agents.ts resolveTranscriptLocation); an undefined config dir is the host default ~/.claude.
 */
export function fleetFileMemory(names: readonly string[], mainName: string, locate: (name: string) => MemoryLocation, home = homedir()): Map<string, FileMemory> {
  const dirs = new Map<string, string | null>()
  for (const n of new Set([mainName, ...names])) {
    try {
      const l = locate(n)
      dirs.set(n, memoryDirAt(l.configDir ?? join(home, '.claude'), l.workingDir))
    } catch {
      dirs.set(n, null)
    }
  }
  const holders = new Map<string, number>()
  for (const d of dirs.values()) if (d !== null) holders.set(d, (holders.get(d) ?? 0) + 1)
  const main = dirs.get(mainName) ?? null
  const out = new Map<string, FileMemory>()
  for (const [n, d] of dirs) out.set(n, { dir: d, shared: d !== null && (d === main || (holders.get(d) ?? 0) > 1) })
  return out
}

/** The cap (measured 2026-11-23: the shared tree on the owner's install is 511 .md files, 5.48 MB, largest 715 KB). */
export const FILE_MEMORY_LIMITS = Object.freeze({ files: 2048, totalBytes: 24 * 1024 * 1024, fileBytes: 2 * 1024 * 1024 })

export type MemoryFiles = { ok: true; files: Array<{ name: string; bytes: Buffer }> } | { ok: false; reason: 'over_cap' }

/**
 * The plain *.md files directly in `dir` (the folder is flat), read without following a link. Anything else (a link,
 * a subfolder, a .bak copy) is left out. Over the cap: nothing, so a memory is never exported half.
 */
export function readMemoryFiles(dir: string, limits: { files: number; totalBytes: number; fileBytes: number } = FILE_MEMORY_LIMITS): MemoryFiles {
  const files: Array<{ name: string; bytes: Buffer }> = []
  let total = 0
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.md')) continue
    const p = join(dir, name)
    const st = lstatSync(p)
    if (!st.isFile()) continue
    if (st.size > limits.fileBytes || files.length + 1 > limits.files || total + st.size > limits.totalBytes) return { ok: false, reason: 'over_cap' }
    const bytes = readFileSync(p)
    total += bytes.length
    files.push({ name, bytes })
  }
  return { ok: true, files }
}

/** A memory file name an import may write: a plain *.md name, no path, no hidden file. */
export function isMemoryFileName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.md$/.test(name)
}

export interface ImportedMemory { written: string[]; renamed: Array<{ from: string; to: string }>; indexAppended: boolean }

/**
 * Writes imported memory files into `targetDir` and NEVER overwrites: a taken name gets `.imported-<n>.md`; MEMORY.md
 * (the index) is not replaced, its lines are appended under a dated heading naming the source. Files are written with
 * the exclusive flag, so a file created in between is not overwritten either.
 */
export function writeImportedMemory(targetDir: string, files: ReadonlyArray<{ name: string; bytes: Buffer }>, source: string, now: Date,
  io: { mkdir: (p: string) => void; writeExclusive: (p: string, b: Buffer) => boolean; append: (p: string, s: string) => boolean; exists: (p: string) => boolean }): ImportedMemory {
  io.mkdir(targetDir)
  const out: ImportedMemory = { written: [], renamed: [], indexAppended: false }
  // #3086 M2: MEMORY.md LAST, so its links can follow the files that had to take another name.
  const ordered = [...files.filter((f) => f.name !== 'MEMORY.md'), ...files.filter((f) => f.name === 'MEMORY.md')]
  for (const f of ordered) {
    if (!isMemoryFileName(f.name)) continue
    const p = join(targetDir, f.name)
    if (f.name === 'MEMORY.md') {
      // A link to a renamed file points at the import's copy, never at the target's own file of that name.
      let text = f.bytes.toString('utf8')
      for (const r of out.renamed) text = text.split(`(${r.from})`).join(`(${r.to})`)
      // Dani B1 (#3086): `append` refuses anything but a plain file (no link followed); then the index goes beside it.
      if (io.exists(p) && io.append(p, `\n\n## Imported ${now.toISOString().slice(0, 10)} from ${source}\n\n${text.replace(/\n+$/, '')}\n`)) {
        out.indexAppended = true
        continue
      }
      if (io.writeExclusive(p, Buffer.from(text, 'utf8'))) { out.written.push(f.name); continue }
      for (let n = 1; n < 1000; n++) {
        const alt = `MEMORY.imported-${n}.md`
        if (io.writeExclusive(join(targetDir, alt), Buffer.from(text, 'utf8'))) { out.renamed.push({ from: f.name, to: alt }); break }
      }
      continue
    }
    if (io.writeExclusive(p, f.bytes)) { out.written.push(f.name); continue }
    const base = f.name.slice(0, -'.md'.length)
    for (let n = 1; n < 1000; n++) {
      const alt = `${base}.imported-${n}.md`
      if (io.writeExclusive(join(targetDir, alt), f.bytes)) { out.renamed.push({ from: f.name, to: alt }); break }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// The live install's wiring (agent-bundle.ts uses these; the functions above take everything as arguments)
// ---------------------------------------------------------------------------

/** The launcher's working dir and config dir, read only (configDirFor: what the transcript readers use too). */
export function liveLocate(name: string): MemoryLocation {
  return { workingDir: name === MAIN_AGENT_ID ? PROJECT_ROOT : agentDir(name), configDir: configDirFor(name) }
}

/** This install's agents, the main one included. */
export function liveFleetFileMemory(): Map<string, FileMemory> {
  return fleetFileMemory(listAgentNames(), MAIN_AGENT_ID, liveLocate)
}

/**
 * Where an IMPORTED agent's memory goes: the config dir its launcher will use (an explicit claudeConfigDir, else the
 * auto-provisioned agents/<name>/.claude-config; a never-run agent has no `projects` there yet, so the read-only
 * resolver cannot be used), and the slug of the target's own key root.
 */
export function importTargetMemoryDir(name: string, dest: string): string {
  const configDir = resolveAgentConfigDir(name).configDir ?? agentIsolatedConfigDir(name)
  return join(configDir, 'projects', slugOf(memoryKeyRoot(dest)), 'memory')
}

/**
 * True when `target`, resolved through every existing link, is the memory folder of the main agent or of another
 * agent: an import there would write into memory that is not this agent's alone. The part that does not exist yet
 * is appended to its deepest existing ancestor's real path.
 */
export function targetIsShared(target: string, name: string, fleet: Map<string, FileMemory>): boolean {
  let cur = target
  const rest: string[] = []
  while (!existsSync(cur) && dirname(cur) !== cur) { rest.unshift(basename(cur)); cur = dirname(cur) }
  let real: string
  try { real = join(realpathSync(cur), ...rest) } catch { return true }
  for (const [n, fm] of fleet) if (n !== name && fm.dir === real) return true
  return false
}

export const FS_IO = {
  mkdir: (p: string) => { mkdirSync(p, { recursive: true, mode: 0o700 }) },
  writeExclusive: (p: string, b: Buffer): boolean => {
    try { writeFileSync(p, b, { flag: 'wx', mode: 0o600 }); return true } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') return false
      throw err
    }
  },
  /** Appends to a PLAIN file only: O_NOFOLLOW refuses a symlink, fstat refuses anything but a file with one link. */
  append: (p: string, s: string): boolean => {
    let fd: number
    try {
      fd = openSync(p, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
    } catch {
      return false
    }
    try {
      // Dani B1b (#3086): a hard link is a plain file to fstat too; one more name elsewhere (the main agent's index)
      // would take the append out. Only a file with exactly one link is appended to.
      const st = fstatSync(fd)
      if (!st.isFile() || st.nlink !== 1) return false
      writeSync(fd, s)
      return true
    } finally {
      closeSync(fd)
    }
  },
  exists: (p: string) => existsSync(p),
}
