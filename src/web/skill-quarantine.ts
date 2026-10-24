// Skill quarantine (MARVEENGAPS1020 (b)).
//
// A skill is an instruction set that every agent loading it follows, and the
// global root (~/.claude/skills) is loaded by EVERY agent of the fleet. Until
// this module, the two API routes that bring new skill content in went live
// on the spot: POST /api/skills wrote an LLM-generated SKILL.md straight into
// the global root, and POST /api/skills/import unzipped an uploaded archive
// there after structural checks only (path traversal, name clash, symlinks,
// a SKILL.md somewhere). The text, and any script shipped next to it, was never
// looked at. The per-agent twins (/api/agents/:name/skills and .../import) did
// the same into an agent's own root.
//
// Now all four write into a PENDING area outside every skill root:
// <store>/skills-pending/<id>/{meta.json, skill/}. Nothing there is loaded by
// Claude Code (store/ is not a skill root, and no agent's config points at it),
// so a pending skill is inert data. It becomes live only through
// approvePending(), which the dashboard calls after showing the approver the
// full file list and the scan report below, bound to the hash of exactly the
// content that was shown.
//
// What the scan is, and what it is not (Jumanji's SKILLSCAN824 research): no
// text classifier is a security boundary for prompt injection; the published
// evaluations defeat the best of them almost completely. The scan is a TRIAGE
// list for the human in front of the approve button, never an auto-verdict:
// it lists every file (script, binary, executable bit), invisible Unicode
// (zero-width and tag characters a reader cannot see but the model reads), and
// the injection shapes the browser-content hook already names
// (scripts/hooks/browser-content-notice.py), plus a few install/exec shapes
// that a skill has no business carrying. An empty list does not mean safe.
// The load-bearing control is that nothing goes live without that approval.
//
// Not covered here (stated, not hidden):
//   - an agent writing a skill directory directly with its file tools (the
//     same OS user; the fleet's self-learning instructions do exactly that);
//   - the fleet import, the agent-bundle import and the `skill` CLI, which
//     have their own paths;
//   - editing a LIVE skill's SKILL.md through PUT /api/skills/:name;
//   - who approves: since kanban 2c72e07c the approve and reject routes take
//     the owner's session (mayIssueCredentials, the #2163 predicate), not the
//     shared dashboard token every agent holds; the bare token only before the
//     first dashboard login exists. That makes "only a human approves" hold as
//     far as the dashboard can tell a human apart; an agent able to hijack the
//     owner's browser session is outside it (per-agent identity, #1985).

import { createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { MAIN_AGENT_ID, STORE_DIR } from '../config.js'
import { agentDir } from './agent-config.js'
import { atomicWriteFileSync } from './atomic-write.js'

export type SkillTarget = { scope: 'global' } | { scope: 'agent'; agent: string }
export type PendingSource = 'generate' | 'import'

export interface PendingMeta {
  id: string
  name: string
  target: SkillTarget
  source: PendingSource
  createdAt: string
}

export interface ScanFile {
  path: string
  size: number
  kind: 'markdown' | 'script' | 'binary' | 'other'
  executable: boolean
  shebang?: string
  sha256: string
  // The FULL text of a non-binary file (#2088 review: the approver sees every
  // byte the hash binds). Absent for a binary file, which is shown by size
  // and sha256 only, and in the summary listing.
  text?: string
  // An image only: the readable runs between its bytes (#2088 delta 3). A
  // real PNG header with text behind it opens as a picture in the Read tool,
  // but `cat` hands that text to the model, so it is shown and scanned.
  strings?: string
}

export interface ScanFinding {
  file: string
  line: number
  pattern: string
  excerpt: string
}

export interface ScanReport {
  files: ScanFile[]
  findings: ScanFinding[]
  totalBytes: number
  // true when the bounds below stopped the scan: the approver is told the
  // list is incomplete instead of reading a short list as a clean one.
  truncated: boolean
  // true when the findings list hit its cap. Every file is still shown in
  // full, so this alone does not block the approval (#2088 review).
  findingsTruncated: boolean
  // Files the approver cannot read (a native executable, a PDF): their presence
  // makes the skill not approvable from the dashboard.
  unreviewable: string[]
}

export interface PendingSkill extends PendingMeta {
  hash: string
  report: ScanReport
  // false when the scan bounds stopped it: such a skill cannot be shown in
  // full, so it cannot be approved here.
  approvable: boolean
}

export const SKILL_PENDING_DIRNAME = 'skills-pending'
const MAX_FILES = 300
const MAX_BYTES = 8 * 1024 * 1024
const MAX_FINDINGS = 200

export function pendingRoot(): string {
  return join(STORE_DIR, SKILL_PENDING_DIRNAME)
}

export function globalSkillsRoot(): string {
  return join(homedir(), '.claude', 'skills')
}

// The live root a target resolves to. The main agent's own root IS the
// global one (agents-skills.ts skillsRootFor).
// The main agent's own root IS the global one, so a skill queued for it is
// queued as global, and the approver sees "global" (#2088 review: it showed as
// "Agent: <main>" and then went into the root the whole fleet loads).
export function normalizeTarget(target: SkillTarget): SkillTarget {
  return target.scope === 'agent' && target.agent === MAIN_AGENT_ID ? { scope: 'global' } : target
}

export function targetRoot(target: SkillTarget): string {
  if (target.scope === 'global' || target.agent === MAIN_AGENT_ID) return globalSkillsRoot()
  return join(agentDir(target.agent), '.claude', 'skills')
}

const ID_RE = /^[a-z0-9-]{1,80}--[0-9a-f]{12}$/

function newId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'skill'
  return `${slug}--${randomBytes(6).toString('hex')}`
}

function entryDir(id: string): string {
  if (!ID_RE.test(id)) throw new Error('invalid pending id')
  return join(pendingRoot(), id)
}

function sameTarget(a: SkillTarget, b: SkillTarget): boolean {
  if (a.scope !== b.scope) return false
  return a.scope === 'global' || (b.scope === 'agent' && a.agent === b.agent)
}

function readMeta(id: string): PendingMeta | null {
  try {
    const meta = JSON.parse(readFileSync(join(entryDir(id), 'meta.json'), 'utf-8')) as PendingMeta
    return meta && meta.id === id ? meta : null
  } catch { return null }
}

function listIds(): string[] {
  try { return readdirSync(pendingRoot()).filter((f) => ID_RE.test(f)) } catch { return [] }
}

// Why a name cannot be queued for a target: a live skill of that name, or a
// pending one waiting for the same target. null = free.
export function nameConflict(target: SkillTarget, name: string): 'live' | 'pending' | null {
  target = normalizeTarget(target)
  if (existsSync(join(targetRoot(target), name))) return 'live'
  for (const id of listIds()) {
    const m = readMeta(id)
    if (m && m.name === name && sameTarget(m.target, target)) return 'pending'
  }
  return null
}

function writeMeta(dir: string, meta: PendingMeta): void {
  atomicWriteFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2))
}

// A generated skill: one SKILL.md.
export function queueGeneratedSkill(targetIn: SkillTarget, name: string, skillMd: string): PendingMeta {
  const target = normalizeTarget(targetIn)
  const id = newId(name)
  const dir = entryDir(id)
  mkdirSync(join(dir, 'skill'), { recursive: true })
  atomicWriteFileSync(join(dir, 'skill', 'SKILL.md'), skillMd)
  const meta: PendingMeta = { id, name, target, source: 'generate', createdAt: new Date().toISOString() }
  writeMeta(dir, meta)
  return meta
}

// An imported skill directory (already extracted and checked by the caller):
// moved, not copied, so nothing of it stays outside the pending area.
export function queueImportedSkillDir(targetIn: SkillTarget, name: string, srcDir: string): PendingMeta {
  const target = normalizeTarget(targetIn)
  const id = newId(name)
  const dir = entryDir(id)
  mkdirSync(dir, { recursive: true })
  renameSync(srcDir, join(dir, 'skill'))
  const meta: PendingMeta = { id, name, target, source: 'import', createdAt: new Date().toISOString() }
  writeMeta(dir, meta)
  return meta
}

// A scratch directory for extracting an upload, inside the pending area (same
// filesystem, so the queue step is a rename) and never inside a skill root.
export function newExtractDir(): string {
  const dir = join(pendingRoot(), `_extract_${randomBytes(8).toString('hex')}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

// Every regular file under `root`, sorted, with its path relative to root.
function filesUnder(root: string): string[] {
  const out: string[] = []
  const rec = (dir: string) => {
    let names: string[]
    try { names = readdirSync(dir).sort() } catch { return }
    for (const n of names) {
      const abs = join(dir, n)
      let st
      try { st = lstatSync(abs) } catch { continue }
      if (st.isDirectory()) rec(abs)
      else out.push(relative(root, abs).split(sep).join('/'))
    }
  }
  rec(root)
  return out
}

function hasSymlink(root: string): boolean {
  const rec = (dir: string): boolean => {
    let names: string[]
    try { names = readdirSync(dir) } catch { return false }
    for (const n of names) {
      const abs = join(dir, n)
      let st
      try { st = lstatSync(abs) } catch { continue }
      if (st.isSymbolicLink()) return true
      if (st.isDirectory() && rec(abs)) return true
    }
    return false
  }
  return rec(root)
}

// The hash an approval is bound to: the name, target and source the approver
// was shown (meta.json, #2088 review), then every file's relative path and
// bytes, length-framed, in sorted order. A file added, removed or changed, or
// the target or name edited after the approver looked, changes it, and the
// approval no longer applies.
export function skillDirHash(root: string, meta?: Pick<PendingMeta, 'name' | 'target' | 'source'>): string {
  const h = createHash('sha256')
  h.update('marveen-pending-skill-v2\n')
  const metaJson = JSON.stringify(meta ? { name: meta.name, target: meta.target, source: meta.source } : null)
  h.update(`meta\0${Buffer.byteLength(metaJson)}\0${metaJson}`)
  for (const rel of filesUnder(root)) {
    let buf: Buffer
    try { buf = readFileSync(join(root, rel)) } catch { buf = Buffer.from('') }
    h.update(`${rel}\0${buf.length}\0`)
    h.update(buf)
  }
  return h.digest('hex')
}

const SCRIPT_EXT = new Set(['.sh', '.bash', '.zsh', '.py', '.js', '.mjs', '.cjs', '.ts', '.rb', '.pl', '.php', '.ps1', '.bat', '.cmd', '.command', '.applescript', '.scpt'])
const MARKDOWN_EXT = new Set(['.md', '.markdown', '.txt'])
// An image is shown by size and sha256 only: a model opening one gets the
// picture, not instructions hidden in the bytes. Decided by its FIRST BYTES,
// matching its extension, not by the name (#2088 delta 2): a text file named
// assets/logo.png was "binary", never shown nor scanned, yet approvable.
// Anything that is not a real image of its kind is text, shown and scanned.
const jpeg = (b: Buffer) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
const IMAGE_MAGIC: Record<string, (b: Buffer) => boolean> = {
  '.png': (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  '.jpg': jpeg,
  '.jpeg': jpeg,
  '.gif': (b) => /^GIF8[79]a$/.test(b.toString('latin1', 0, 6)),
  '.webp': (b) => b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
  '.bmp': (b) => b.length >= 14 && b.toString('latin1', 0, 2) === 'BM',
  '.ico': (b) => b.length >= 6 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0,
}

// The readable runs of a binary file, as `strings` would print them: at least
// MIN_RUN printable characters (ASCII or valid UTF-8, tab included), one run
// per line. Whatever text hides behind a real image header ends up here.
const MIN_RUN = 8
export function printableRuns(buf: Buffer): string {
  const runs: string[] = []
  let cur = ''
  let chars = 0
  const flush = () => {
    const run = cur.replace(/^\n+|\n+$/g, '')
    if (chars >= MIN_RUN && run) runs.push(run)
    cur = ''; chars = 0
  }
  let i = 0
  while (i < buf.length) {
    const b = buf[i]
    const len = b < 0x80 ? 1 : (b & 0xe0) === 0xc0 ? 2 : (b & 0xf0) === 0xe0 ? 3 : (b & 0xf8) === 0xf0 ? 4 : 0
    let cp = -1
    if (len === 1) cp = b
    else if (len > 1 && i + len <= buf.length) {
      cp = b & (0xff >> (len + 1))
      for (let k = 1; k < len; k++) {
        const c = buf[i + k]
        if ((c & 0xc0) !== 0x80) { cp = -1; break }
        cp = (cp << 6) | (c & 0x3f)
      }
      const min = [0, 0, 0x80, 0x800, 0x10000][len]
      if (cp !== -1 && (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff))) cp = -1
    }
    // A line break stays a line break inside the run (\r\n, \r and \n alike,
    // one per break), so words on separate lines are not glued into one and
    // each line is scanned on its own (#2097 review).
    if (cp === 0x0a || cp === 0x0d) { if (cur && !cur.endsWith('\n')) cur += '\n'; i++; continue }
    // Any other C0 control (NUL, ...) does not end a run, and is not part of
    // it: text spelled out between NUL bytes (UTF-16LE, or "I\0g\0n...") still
    // reads as one run, the way a terminal shows it (#2088 delta 4).
    if (cp >= 0 && cp < 0x20 && cp !== 0x09) { i++; continue }
    const printable = cp === 0x09 || (cp >= 0x20 && cp !== 0x7f && !(cp >= 0x80 && cp <= 0x9f) && cp !== 0x2028 && cp !== 0x2029)
    if (!printable) { flush(); i++; continue }
    cur += String.fromCodePoint(cp)
    chars++
    i += len
  }
  flush()
  return runs.join('\n')
}

// A PDF is NOT an image here: the Read tool hands its text to the model, and
// that text cannot be reviewed in this view, so a PDF blocks the approval,
// whatever its name.
const isPdf = (b: Buffer) => b.toString('latin1', 0, 5) === '%PDF-'

function isNativeExecutable(buf: Buffer): boolean {
  if (buf.length < 4) return false
  if (buf[0] === 0x7f && buf.toString('latin1', 1, 4) === 'ELF') return true
  if (buf[0] === 0x4d && buf[1] === 0x5a) return true // MZ (PE)
  const be = buf.readUInt32BE(0)
  return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(be) // Mach-O / fat
}

// Lossless text for review (#2088 review): a NUL byte made a .md "binary",
// so it was neither shown nor scanned, yet a SKILL.md could tell the model to
// cat it. Every byte now reaches the approver: valid UTF-8 as text, every
// invalid byte as <0xNN>, and control characters (NUL included) as <0xNN>,
// so nothing is dropped or silently replaced with U+FFFD.
export function reviewText(buf: Buffer): { text: string; invalidUtf8: number; controlBytes: number } {
  let out = ''
  let invalidUtf8 = 0
  let controlBytes = 0
  const hex = (b: number) => `<0x${b.toString(16).toUpperCase().padStart(2, '0')}>`
  let i = 0
  while (i < buf.length) {
    const b = buf[i]
    let len = b < 0x80 ? 1 : (b & 0xe0) === 0xc0 ? 2 : (b & 0xf0) === 0xe0 ? 3 : (b & 0xf8) === 0xf0 ? 4 : 0
    let cp = -1
    if (len === 1) cp = b
    else if (len > 1 && i + len <= buf.length) {
      cp = b & (0xff >> (len + 1))
      for (let k = 1; k < len; k++) {
        const c = buf[i + k]
        if ((c & 0xc0) !== 0x80) { cp = -1; break }
        cp = (cp << 6) | (c & 0x3f)
      }
      const min = [0, 0, 0x80, 0x800, 0x10000][len]
      if (cp !== -1 && (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff))) cp = -1
    }
    if (cp === -1) { out += hex(b); invalidUtf8++; i++; continue }
    if ((cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) || cp === 0x7f) { out += hex(cp); controlBytes++ }
    // C1 controls and the line/paragraph separators: valid UTF-8, but they
    // move or hide text the way a raw control byte does. <U+XXXX>, so they
    // do not read as an invalid byte.
    else if ((cp >= 0x80 && cp <= 0x9f) || cp === 0x2028 || cp === 0x2029) { out += `<U+${cp.toString(16).toUpperCase().padStart(4, '0')}>`; controlBytes++ }
    else out += String.fromCodePoint(cp)
    i += len
  }
  return { text: out, invalidUtf8, controlBytes }
}

// Invisible to a reader, read by the model: zero-width, bidi controls, the
// Unicode tag block. Escaped so this source file stays plain ASCII.
const INVISIBLE_RE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]|[\u{E0000}-\u{E007F}]/gu

// The same shapes scripts/hooks/browser-content-notice.py names, plus the
// install/exec and persistence shapes a skill has no reason to carry.
export const SKILL_SCAN_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ['security-tag-forgery', /<\s*\/?\s*(untrusted|trusted-peer|scheduled-task|channel)\b/i],
  ['system-reminder-forgery', /<\s*\/?\s*system-reminder\b/i],
  ['directive-header-forgery', /\[(SYSTEM-DIREKTIVA|CONTEXT-GUARD|CONTEXT-RESTART-GATE|SYSTEM:)/i],
  ['instruction-override', /\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(previous|prior|above|all)\b[^.\n]{0,20}\b(instruction|prompt|rule|direction)/i],
  ['role-reassignment', /\byou are now\b|\bnew (system )?(instructions|prompt)\b|\bact as\b[^.\n]{0,30}\b(admin|root|developer mode)/i],
  ['credential-target', /(~\/\.ssh|id_rsa|\.env\b|CLAUDE_CODE_OAUTH_TOKEN|dashboard-token|\.credentials\.json|api[_-]?key\s*[:=])/i],
  ['exfil-shape', /\b(curl|wget|fetch)\b[^\n]{0,60}https?:\/\//i],
  ['pipe-to-shell', /\|\s*(ba|z)?sh\b|\bbash\s+<\s*\(\s*curl/i],
  ['decode-and-run', /\b(eval|exec)\s*\(\s*(base64|atob|codecs\.decode|bytes\.fromhex)|base64\s+(-d|--decode)[^\n]{0,40}\|\s*(ba|z)?sh/i],
  ['shell-exec', /\bos\.system\s*\(|subprocess\.[a-z_]+\([^)\n]{0,120}shell\s*=\s*True|child_process|\bexecSync\s*\(/],
  ['persistence-target', /(settings(\.local)?\.json|scheduled-tasks|crontab\b|LaunchAgents|\.bashrc|\.zshrc|\.profile\b)/i],
  ['install-hook', /"(pre|post)install"\s*:|\bnpm\s+(i|install)\b|\bpip3?\s+install\b|\bbrew\s+install\b/i],
  ['long-encoded-blob', /[A-Za-z0-9+/]{200,}={0,2}/],
]

function excerpt(line: string, at: number): string {
  const start = Math.max(0, at - 40)
  return line.slice(start, start + 120).replace(INVISIBLE_RE, (c) => `<U+${c.codePointAt(0)!.toString(16).toUpperCase()}>`)
}

export function scanSkillDir(root: string): ScanReport {
  const files: ScanFile[] = []
  const findings: ScanFinding[] = []
  let totalBytes = 0
  let truncated = false
  let findingsTruncated = false
  const unreviewable: string[] = []
  const scanLines = (rel: string, lines: string[]) => {
    for (let i = 0; i < lines.length && findings.length < MAX_FINDINGS; i++) {
      const line = lines[i]
      INVISIBLE_RE.lastIndex = 0
      const inv = INVISIBLE_RE.exec(line)
      if (inv) findings.push({ file: rel, line: i + 1, pattern: 'invisible-unicode', excerpt: excerpt(line, inv.index) })
      for (const [name, rx] of SKILL_SCAN_PATTERNS) {
        const m = rx.exec(line)
        if (m) findings.push({ file: rel, line: i + 1, pattern: name, excerpt: excerpt(line, m.index) })
      }
    }
  }
  for (const rel of filesUnder(root)) {
    if (files.length >= MAX_FILES) { truncated = true; break }
    const abs = join(root, rel)
    let st
    try { st = statSync(abs) } catch { continue }
    totalBytes += st.size
    const dot = rel.lastIndexOf('.')
    const ext = dot > rel.lastIndexOf('/') ? rel.slice(dot).toLowerCase() : ''
    const executable = (st.mode & 0o111) !== 0
    if (totalBytes > MAX_BYTES) {
      truncated = true
      files.push({ path: rel, size: st.size, kind: 'other', executable, sha256: '' })
      break
    }
    let buf: Buffer
    try { buf = readFileSync(abs) } catch { continue }
    const native = isNativeExecutable(buf)
    const pdf = !native && isPdf(buf)
    const image = !native && !pdf && (IMAGE_MAGIC[ext]?.(buf) ?? false)
    const isBinary = native || pdf || image
    const reviewed = isBinary ? null : reviewText(buf)
    const text = reviewed ? reviewed.text : ''
    const nl = text.indexOf('\n')
    const shebang = !isBinary && text.startsWith('#!') ? text.slice(0, nl < 0 ? 80 : Math.min(nl, 80)) : undefined
    const kind: ScanFile['kind'] = isBinary ? 'binary'
      : (SCRIPT_EXT.has(ext) || shebang) ? 'script'
      : MARKDOWN_EXT.has(ext) ? 'markdown' : 'other'
    const sha256 = createHash('sha256').update(buf).digest('hex')
    const strings = image ? printableRuns(buf) : undefined
    files.push({ path: rel, size: st.size, kind, executable, ...(shebang ? { shebang } : {}), sha256, ...(isBinary ? {} : { text }), ...(strings ? { strings } : {}) })
    if (native || pdf) {
      unreviewable.push(rel)
      if (findings.length < MAX_FINDINGS) {
        findings.push(native
          ? { file: rel, line: 0, pattern: 'native-executable', excerpt: 'a compiled program: its content cannot be reviewed here' }
          : { file: rel, line: 0, pattern: 'pdf-document', excerpt: 'a PDF: the model reads its text, which cannot be reviewed here' })
      }
      continue
    }
    if (!reviewed) {
      if (strings) {
        // the readable runs of an image are scanned like text; a run is a line
        const runLines = strings.split('\n')
        if (findings.length < MAX_FINDINGS) findings.push({ file: rel, line: 0, pattern: 'image-text', excerpt: `${runLines.length} line(s) of readable text between the image bytes, shown below the file` })
        scanLines(rel, runLines)
      }
      if (findings.length >= MAX_FINDINGS) findingsTruncated = true
      continue
    }
    if (reviewed.controlBytes && findings.length < MAX_FINDINGS) {
      findings.push({ file: rel, line: 0, pattern: 'control-bytes', excerpt: `${reviewed.controlBytes} control byte(s), shown as <0xNN> or <U+XXXX>` })
    }
    if (reviewed.invalidUtf8 && findings.length < MAX_FINDINGS) {
      findings.push({ file: rel, line: 0, pattern: 'invalid-utf8', excerpt: `${reviewed.invalidUtf8} byte(s) that are not UTF-8, shown as <0xNN>` })
    }
    scanLines(rel, text.split('\n'))
    if (findings.length >= MAX_FINDINGS) findingsTruncated = true
  }
  return { files, findings, totalBytes, truncated, findingsTruncated, unreviewable }
}

// One pending skill with the FULL text of every non-binary file: what the
// approver reads before the button (GET /api/skills/pending/:id).
export function getPending(id: string): PendingSkill | null {
  const meta = readMeta(id)
  if (!meta) return null
  const skillRoot = join(entryDir(id), 'skill')
  const report = scanSkillDir(skillRoot)
  return { ...meta, hash: skillDirHash(skillRoot, meta), report, approvable: !report.truncated && report.unreviewable.length === 0 }
}

// The queue, without file texts (GET /api/skills/pending).
export function listPending(): PendingSkill[] {
  return listIds()
    .map((id) => getPending(id))
    .filter((p): p is PendingSkill => p !== null)
    .map((p) => ({ ...p, report: { ...p.report, files: p.report.files.map(({ text: _t, ...f }) => f) } }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export type ApproveResult =
  | { ok: true; name: string; path: string }
  | { ok: false; status: number; error: string }

// Make a pending skill live. `hash` must be the hash the approver was shown:
// content changed since then is not approved by that click.
export function approvePending(id: string, hash: unknown): ApproveResult {
  let meta: PendingMeta | null
  try { meta = readMeta(id) } catch { meta = null }
  if (!meta) return { ok: false, status: 404, error: 'Pending skill not found' }
  const skillRoot = join(entryDir(id), 'skill')
  const current = skillDirHash(skillRoot, meta)
  if (typeof hash !== 'string' || hash !== current) {
    return { ok: false, status: 409, error: 'The pending skill changed since it was shown (hash mismatch); reload and review it again' }
  }
  // What could not be shown in full cannot be approved from the dashboard.
  const scan = scanSkillDir(skillRoot)
  if (scan.truncated) {
    return { ok: false, status: 409, error: 'The pending skill is over the review bounds and cannot be shown in full; it cannot be approved here' }
  }
  if (scan.unreviewable.length) {
    return { ok: false, status: 409, error: `The pending skill contains a file that cannot be reviewed here (${scan.unreviewable.join(', ')}); it cannot be approved here` }
  }
  // A link planted into the pending dir after the scan would go live with it.
  if (hasSymlink(skillRoot)) return { ok: false, status: 400, error: 'The pending skill contains a symlink; it cannot be approved' }
  const root = targetRoot(meta.target)
  const dest = join(root, meta.name)
  if (!dest.startsWith(root + sep)) return { ok: false, status: 400, error: 'Invalid skill name' }
  if (existsSync(dest)) return { ok: false, status: 409, error: `Skill already exists: ${meta.name}` }
  if (meta.target.scope === 'agent' && meta.target.agent !== MAIN_AGENT_ID && !existsSync(agentDir(meta.target.agent))) {
    return { ok: false, status: 404, error: 'Agent not found' }
  }
  mkdirSync(root, { recursive: true })
  try {
    renameSync(skillRoot, dest)
  } catch {
    // Another filesystem (store/ and ~/.claude on different volumes): copy, then drop the source.
    cpSync(skillRoot, dest, { recursive: true, verbatimSymlinks: true })
    rmSync(skillRoot, { recursive: true, force: true })
  }
  rmSync(entryDir(id), { recursive: true, force: true })
  return { ok: true, name: meta.name, path: dest }
}

export function rejectPending(id: string): boolean {
  let meta: PendingMeta | null
  try { meta = readMeta(id) } catch { meta = null }
  if (!meta) return false
  rmSync(entryDir(id), { recursive: true, force: true })
  return true
}

export type ImportResult =
  | { ok: true; queued: PendingMeta[] }
  | { ok: false; status: number; error: string }

// A top-level directory name of an archive becomes a skill name.
const IMPORT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

// The zip import for both scopes: extract into a scratch dir inside the
// pending area (never into a skill root), keep the structural checks the
// routes had (path traversal, name clash, symlinks, a SKILL.md per skill),
// and queue each skill directory. Loose top-level files are dropped with the
// scratch dir. Nothing of the upload reaches a skill root here.
export function importArchiveToPending(target: SkillTarget, data: Buffer): ImportResult {
  const work = newExtractDir()
  const zip = join(work, 'upload.zip')
  const out = join(work, 'x')
  try {
    mkdirSync(out)
    writeFileSync(zip, data)
    let listing: string
    try {
      listing = execFileSync('unzip', ['-Z1', zip], { timeout: 5000, encoding: 'utf-8' })
    } catch {
      return { ok: false, status: 400, error: 'Failed to read the archive' }
    }
    const entries = listing.split('\n').map((l) => l.trim()).filter(Boolean)
    for (const entry of entries) {
      if (entry.includes('..') || entry.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(entry)) {
        return { ok: false, status: 400, error: 'Invalid skill file: path traversal detected' }
      }
    }
    const topDirs = new Set<string>()
    for (const entry of entries) {
      const parts = entry.split('/')
      if (parts.length > 1 && parts[0]) topDirs.add(parts[0])
    }
    for (const td of topDirs) {
      if (!IMPORT_NAME_RE.test(td)) return { ok: false, status: 400, error: `Invalid skill directory name in archive: ${td}` }
      const clash = nameConflict(target, td)
      if (clash === 'live') return { ok: false, status: 409, error: `Skill already exists: ${td}. Delete it first if you want to overwrite.` }
      if (clash === 'pending') return { ok: false, status: 409, error: `A skill named ${td} is already waiting for approval.` }
    }
    try {
      execFileSync('unzip', ['-o', '-q', zip, '-d', out], { timeout: 10000 })
    } catch {
      return { ok: false, status: 500, error: 'Failed to extract .skill file' }
    }
    if (hasSymlink(out)) return { ok: false, status: 400, error: 'Invalid skill file: symlink entries rejected' }
    const skillDirs = [...topDirs].filter((td) => {
      const p = join(out, td)
      try { return statSync(p).isDirectory() && existsSync(join(p, 'SKILL.md')) } catch { return false }
    })
    if (skillDirs.length === 0) return { ok: false, status: 400, error: 'No valid skill (SKILL.md) found in archive' }
    return { ok: true, queued: skillDirs.map((td) => queueImportedSkillDir(target, td, join(out, td))) }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}
