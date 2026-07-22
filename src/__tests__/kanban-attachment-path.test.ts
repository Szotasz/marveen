import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { verifyAttachmentPath, attachmentKind, safeContentType } from '../web/kanban-attachment-path.js'

// A throwaway mirror: this suite must never touch the live store/ directory.
// (2026-07-22: a test that recursively cleaned a live directory ate a file it did
// not create. Tests get their own temp root, always.)
const ROOT = mkdtempSync(resolve(tmpdir(), 'kanban-att-guard-'))
const OUTSIDE = mkdtempSync(resolve(tmpdir(), 'kanban-att-outside-'))
const SIBLING = `${ROOT}-evil`

const GOOD = `${ROOT}/task-1/158-pic.png`
const SECRET = `${OUTSIDE}/.dashboard-token`
const ESCAPE_LINK = `${ROOT}/task-1/escape.png`
const DIR_IN_ROOT = `${ROOT}/task-1/subdir`

beforeAll(() => {
  mkdirSync(`${ROOT}/task-1`, { recursive: true })
  mkdirSync(DIR_IN_ROOT, { recursive: true })
  mkdirSync(SIBLING, { recursive: true })
  writeFileSync(GOOD, 'PNGBYTES!!')            // 10 bytes
  writeFileSync(SECRET, 'super-secret-token')
  writeFileSync(`${SIBLING}/x.png`, 'nope')
  symlinkSync(SECRET, ESCAPE_LINK)
})
afterAll(() => {
  for (const p of [ROOT, OUTSIDE, SIBLING]) rmSync(p, { recursive: true, force: true })
})

const check = (p: unknown, expectedSize?: number | null) =>
  verifyAttachmentPath(p, { root: ROOT, expectedSize })

describe('attachment path guard: serves only what it should', () => {
  it('accepts a real file inside the mirror', () => {
    const v = check(GOOD)
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.size).toBe(10)
  })
  it('accepts when the row size matches the disk', () => {
    expect(check(GOOD, 10).ok).toBe(true)
  })
})

describe('attachment path guard: refuses everything else', () => {
  it('REFUSES a symlink inside the mirror pointing at a secret outside it', () => {
    // The string prefix matches -- only realpath can catch this one.
    const v = check(ESCAPE_LINK)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toMatch(/outside the attachment mirror/)
  })
  it('REFUSES a traversal spelled through the mirror', () => {
    const v = check(`${ROOT}/task-1/../../${OUTSIDE.split('/').pop()}/.dashboard-token`)
    expect(v.ok).toBe(false)
  })
  it('REFUSES a sibling directory that merely shares the prefix', () => {
    const v = check(`${SIBLING}/x.png`)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toMatch(/outside the attachment mirror/)
  })
  it('REFUSES an absolute path elsewhere on disk', () => {
    expect(check(SECRET).ok).toBe(false)
    expect(check('/etc/hosts').ok).toBe(false)
  })
  it('REFUSES a directory', () => {
    const v = check(DIR_IN_ROOT)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toMatch(/not a regular file/)
  })
  it('REFUSES a file that does not exist (no guessing)', () => {
    const v = check(`${ROOT}/task-1/missing.png`)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toMatch(/does not resolve/)
  })
  it('REFUSES a size mismatch between the row and the disk', () => {
    const v = check(GOOD, 999)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toMatch(/size mismatch/)
  })
  it('REFUSES junk input instead of coercing it', () => {
    for (const bad of [null, undefined, '', 42, {}, []]) {
      expect(check(bad as unknown).ok).toBe(false)
    }
  })
  it('REFUSES everything when the mirror root itself is absent', () => {
    const v = verifyAttachmentPath(GOOD, { root: '/no/such/mirror/anywhere' })
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toMatch(/mirror is not present/)
  })
})

describe('preview + content-type: never hand the browser a type we did not choose', () => {
  it('previews only known raster image types', () => {
    for (const m of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']) {
      expect(attachmentKind(m)).toBe('image')
    }
  })
  it('does NOT preview SVG -- it carries script', () => {
    expect(attachmentKind('image/svg+xml')).toBe('file')
    expect(safeContentType('image/svg+xml')).toBe('application/octet-stream')
  })
  it('does not preview documents or unknown types', () => {
    for (const m of ['application/pdf', 'text/html', 'application/x-sh', '', null, undefined]) {
      expect(attachmentKind(m)).toBe('file')
    }
  })
  it('serves an unrecognised mime as an opaque download', () => {
    expect(safeContentType('text/html')).toBe('application/octet-stream')
    expect(safeContentType('notamimetype')).toBe('application/octet-stream')
    expect(safeContentType('image/png;charset=x"evil')).toBe('application/octet-stream')
  })
  it('is case- and whitespace-tolerant on the good path', () => {
    expect(attachmentKind('  IMAGE/PNG ')).toBe('image')
    expect(safeContentType('  IMAGE/PNG ')).toBe('image/png')
  })
})
