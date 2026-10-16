// VIDEOREVIEW1002: the video review tool (owner request 2026-10-02). The owner
// clicks a moment (and optionally a point or a box) on a video, writes a note,
// and the configured video agent gets the review file to work from.
//
// THE MAIN RISK IS LOCAL FILE ACCESS. These routes read video files and write a
// review file on the dashboard host, from a path the browser sends. Every
// path therefore goes through resolveUnderRoot(): it is taken RELATIVE to one
// configured root, absolute paths, NUL bytes and `..` segments are refused up
// front, and the REALPATH of the result (symlinks resolved) must still be under
// the realpath of the root. A symlink inside the root that points outside is
// refused the same way. Nothing here ever touches a path that failed that test.
//
// Config (both empty by default: a stock install has no video agent, and a
// hard-coded agent name or path would leak into every install):
//   VIDEO_REVIEW_ROOT   the folder the videos live in; absolute, or relative to
//                       the project root (e.g. agents/<video-agent>/deliverables)
//   VIDEO_REVIEW_AGENT  the fleet agent "Send" queues the review for

import { existsSync, readdirSync, readFileSync, realpathSync, statSync, lstatSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve, sep, basename } from 'node:path'
import { randomBytes } from 'node:crypto'

export const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.webm'])
export const VIDEO_MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
}

/** The configured root as a realpath, or null when unset or not a directory. */
export function resolveReviewRoot(configured: string | undefined, projectRoot: string): string | null {
  const raw = (configured ?? '').trim()
  if (!raw) return null
  const abs = isAbsolute(raw) ? raw : resolve(projectRoot, raw)
  try {
    const real = realpathSync(abs)
    return statSync(real).isDirectory() ? real : null
  } catch {
    return null
  }
}

export type ResolveResult =
  | { ok: true; abs: string; rel: string }
  | { ok: false; status: 400 | 403 | 404; error: string }

function inside(rootReal: string, candidate: string): boolean {
  return candidate === rootReal || candidate.startsWith(rootReal + sep)
}

/**
 * Resolve a browser-supplied RELATIVE path under the root.
 * mustExist: the file itself must exist (reads). Otherwise only its parent
 * directory must exist (the review file is created next to the video); the
 * file, if it exists, must also resolve inside the root.
 */
export function resolveUnderRoot(rootReal: string, rel: unknown, opts: { mustExist: boolean }): ResolveResult {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 1024) {
    return { ok: false, status: 400, error: 'path_invalid' }
  }
  if (rel.includes('\0') || isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.startsWith('\\')) {
    return { ok: false, status: 400, error: 'path_must_be_relative' }
  }
  if (rel.split(/[\\/]+/).some((seg) => seg === '..')) {
    return { ok: false, status: 400, error: 'path_traversal' }
  }
  const joined = resolve(rootReal, rel)
  if (!inside(rootReal, joined)) return { ok: false, status: 403, error: 'path_outside_root' }

  let real: string
  if (existsSync(joined)) {
    try { real = realpathSync(joined) } catch { return { ok: false, status: 404, error: 'not_found' } }
  } else {
    if (opts.mustExist) return { ok: false, status: 404, error: 'not_found' }
    let parentReal: string
    try { parentReal = realpathSync(dirname(joined)) } catch { return { ok: false, status: 404, error: 'parent_not_found' } }
    real = join(parentReal, basename(joined))
  }
  if (!inside(rootReal, real)) return { ok: false, status: 403, error: 'path_outside_root' }
  return { ok: true, abs: real, rel: relative(rootReal, real).split(sep).join('/') }
}

export interface VideoEntry {
  path: string        // relative to the root, '/'-separated
  size: number
  mtimeMs: number
  hasReview: boolean
}

/**
 * Videos under the root, newest first. Symlinks are not followed at all (a
 * listing never leaves the root), depth and count are capped.
 */
export function listVideos(rootReal: string, opts: { maxDepth?: number; maxEntries?: number } = {}): VideoEntry[] {
  const maxDepth = opts.maxDepth ?? 4
  const maxEntries = opts.maxEntries ?? 2000
  const out: VideoEntry[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth || out.length >= maxEntries) return
    let names: string[]
    try { names = readdirSync(dir) } catch { return }
    for (const name of names) {
      if (out.length >= maxEntries) return
      if (name.startsWith('.')) continue
      const p = join(dir, name)
      let st
      try { st = lstatSync(p) } catch { continue }
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) { walk(p, depth + 1); continue }
      if (!st.isFile() || !VIDEO_EXTENSIONS.has(extname(name).toLowerCase())) continue
      out.push({
        path: relative(rootReal, p).split(sep).join('/'),
        size: st.size,
        mtimeMs: st.mtimeMs,
        hasReview: existsSync(reviewPathFor(p)),
      })
    }
  }
  walk(rootReal, 0)
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/** The review file sits next to the video: `<video>.review.json`. */
export function reviewPathFor(videoAbs: string): string {
  return `${videoAbs}.review.json`
}

export interface ReviewNote {
  id: string
  t: number                 // seconds
  version: string           // which video the note is on (relative path)
  text: string
  status: 'open' | 'done'
  x?: number; y?: number    // a point, 0..1 of the frame
  w?: number; h?: number    // with w/h: a box from (x, y)
}

export interface ReviewFile {
  video: string             // relative path of the reviewed video
  compare?: string          // relative path of the other version, if any
  fps: number
  notes: ReviewNote[]
  updatedAt?: string
}

const MAX_NOTES = 500
const MAX_TEXT = 2000

function unit(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) throw new Error('coord_out_of_range')
  return Math.round(v * 10000) / 10000
}

/** Validate and normalise a review body from the browser. Throws on bad input. */
export function validateReview(body: unknown): ReviewFile {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('review_not_object')
  const b = body as Record<string, unknown>
  if (typeof b.video !== 'string' || !b.video) throw new Error('review_video_missing')
  if (b.compare !== undefined && b.compare !== null && typeof b.compare !== 'string') throw new Error('review_compare_invalid')
  const fps = typeof b.fps === 'number' && Number.isFinite(b.fps) && b.fps >= 1 && b.fps <= 240 ? b.fps : 25
  if (!Array.isArray(b.notes) || b.notes.length > MAX_NOTES) throw new Error('review_notes_invalid')
  const notes: ReviewNote[] = b.notes.map((raw, i) => {
    if (!raw || typeof raw !== 'object') throw new Error(`note_${i}_invalid`)
    const n = raw as Record<string, unknown>
    if (typeof n.t !== 'number' || !Number.isFinite(n.t) || n.t < 0 || n.t > 24 * 3600) throw new Error(`note_${i}_time`)
    if (typeof n.text !== 'string' || n.text.length > MAX_TEXT) throw new Error(`note_${i}_text`)
    if (typeof n.version !== 'string' || n.version.length > 1024) throw new Error(`note_${i}_version`)
    const note: ReviewNote = {
      id: typeof n.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(n.id) ? n.id : randomBytes(6).toString('hex'),
      t: Math.round(n.t * 1000) / 1000,
      version: n.version,
      text: n.text,
      status: n.status === 'done' ? 'done' : 'open',
    }
    const x = unit(n.x), y = unit(n.y), w = unit(n.w), h = unit(n.h)
    if (x !== undefined && y !== undefined) {
      note.x = x; note.y = y
      if (w !== undefined && h !== undefined) { note.w = w; note.h = h }
    }
    return note
  })
  return {
    video: b.video,
    ...(typeof b.compare === 'string' && b.compare ? { compare: b.compare } : {}),
    fps,
    notes: notes.sort((a, b2) => a.t - b2.t),
  }
}

export function readReview(videoAbs: string): ReviewFile | null {
  try {
    return validateReview(JSON.parse(readFileSync(reviewPathFor(videoAbs), 'utf8')))
  } catch {
    return null
  }
}

/**
 * Short-lived, single-file tickets for <video src>. The dashboard frontend
 * authenticates with a bearer header, which a <video> element cannot send.
 * A ticket is minted by an authenticated API call for ONE resolved file and
 * works only for that file, only until it expires; the dashboard token never
 * appears in a URL.
 */
export class FileTickets {
  private readonly map = new Map<string, { abs: string; exp: number }>()
  constructor(private readonly ttlMs = 2 * 3600_000, private readonly max = 500) {}

  mint(abs: string, now = Date.now()): string {
    this.sweep(now)
    if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) this.map.delete(oldest)
    }
    const t = randomBytes(24).toString('base64url')
    this.map.set(t, { abs, exp: now + this.ttlMs })
    return t
  }

  /** The file the ticket was minted for, or null (unknown or expired). */
  resolve(ticket: unknown, now = Date.now()): string | null {
    if (typeof ticket !== 'string' || ticket.length < 20 || ticket.length > 64) return null
    const e = this.map.get(ticket)
    if (!e) return null
    if (e.exp <= now) { this.map.delete(ticket); return null }
    return e.abs
  }

  private sweep(now: number): void {
    for (const [k, v] of this.map) if (v.exp <= now) this.map.delete(k)
  }
}

/** Parse a single `bytes=a-b` range against a file size. null = no/invalid range. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return null
  const [, a, b] = m
  let start: number, end: number
  if (a === '' && b === '') return null
  if (a === '') {
    const suffix = Number(b)
    if (suffix === 0) return 'unsatisfiable'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(a)
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1)
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return 'unsatisfiable'
  return { start, end }
}
