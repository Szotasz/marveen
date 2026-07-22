import { realpathSync, statSync } from 'node:fs'
import { sep } from 'node:path'

/**
 * Path guard for serving a mirrored Kanban attachment over HTTP.
 *
 * WHY THIS IS THE FIRST FILE WRITTEN: the serving endpoint reads a file off disk
 * and streams it to an HTTP caller. An endpoint that can be steered at an arbitrary
 * path is file disclosure -- and worse than the agent-facing helpers we hardened
 * earlier, because those need an agent while this needs only a request. So the
 * guard exists (and is tested) before anything can call it.
 *
 * The endpoint therefore takes an ATTACHMENT ID and never a path: the path comes
 * from the DB row. This guard is the second line -- it assumes the row itself could
 * be wrong (bad migration, hand-edited DB, a future writer with a bug) and re-checks
 * from scratch.
 */

export const MIRROR_ROOT = '/Users/macmini/marveen/store/kanban-attachments'

export type PathVerdict =
  | { ok: true; path: string; size: number }
  | { ok: false; reason: string }

/**
 * Resolve first, check second. `realpath` collapses `..` AND follows symlinks, so a
 * link planted inside the mirror that points at ../.dashboard-token is judged on
 * where it really lands, not on how it is spelled.
 *
 * The root comparison includes the trailing separator: without it a sibling
 * directory named `kanban-attachments-evil/` shares the prefix and passes. That is
 * not hypothetical -- the same mistake was measured and fixed twice today
 * (bridge attachment endpoint, agent read gate).
 */
export function verifyAttachmentPath(
  candidate: unknown,
  opts: { root?: string; expectedSize?: number | null } = {},
): PathVerdict {
  const root = opts.root ?? MIRROR_ROOT
  if (typeof candidate !== 'string' || candidate === '') {
    return { ok: false, reason: 'no path on the attachment row' }
  }

  let resolvedRoot: string
  try {
    resolvedRoot = realpathSync(root)
  } catch {
    // The mirror does not exist yet (nothing has been downloaded). Nothing can be
    // inside it, so there is nothing to serve -- refuse rather than fall through.
    return { ok: false, reason: 'attachment mirror is not present' }
  }

  let resolved: string
  try {
    resolved = realpathSync(candidate)
  } catch {
    // Missing file or dangling symlink. No exception, no guessing.
    return { ok: false, reason: 'file does not resolve' }
  }

  if (!resolved.startsWith(resolvedRoot + sep)) {
    return { ok: false, reason: 'resolved path is outside the attachment mirror' }
  }

  let st
  try {
    st = statSync(resolved)
  } catch {
    return { ok: false, reason: 'file cannot be stat-ed' }
  }
  if (!st.isFile()) return { ok: false, reason: 'not a regular file' }

  // Re-check the size against what the row claims. A mismatch means the row and the
  // disk disagree; serving either one would be asserting something we cannot back up.
  const expected = opts.expectedSize
  if (expected != null && Number.isFinite(expected) && st.size !== expected) {
    return { ok: false, reason: `size mismatch (row ${expected}, disk ${st.size})` }
  }

  return { ok: true, path: resolved, size: st.size }
}

/**
 * Only these render as an inline preview. Everything else gets an icon and a
 * download button -- we never ask a browser to interpret a file type we did not
 * choose. `image/svg+xml` is deliberately absent: SVG carries script.
 */
const PREVIEWABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'])

export function attachmentKind(mime: unknown): 'image' | 'file' {
  return PREVIEWABLE.has(String(mime ?? '').toLowerCase().trim()) ? 'image' : 'file'
}

/**
 * Content-Type we are willing to echo back. The stored mime originates from an
 * upload, so it is caller-controlled text: anything we do not recognise is served
 * as an opaque download instead of being handed to the browser as a type to trust.
 */
export function safeContentType(mime: unknown): string {
  const m = String(mime ?? '').toLowerCase().trim()
  return PREVIEWABLE.has(m) ? m : 'application/octet-stream'
}
