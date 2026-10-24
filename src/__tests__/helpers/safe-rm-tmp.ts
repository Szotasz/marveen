import { existsSync, realpathSync, rmSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'

// Recursive cleanup that can only ever delete something STRICTLY inside the
// OS temp dir. A cleanup path built as join(x, '..') with x === '' collapses to
// '..' and wipes the cwd's parent (2026-10-24 incident), so an empty value, a
// path that resolves to the temp dir itself, a path outside it, and a symlink
// inside it that points outside it are all refused with a throw.
export function safeRmTmp(p: string): void {
  if (typeof p !== 'string' || p.trim() === '') throw new Error('safeRmTmp: empty path')
  const abs = resolve(p)
  if (!existsSync(abs)) {
    // Nothing to delete; still refuse lexically-outside paths so a typo is loud.
    try { assertInside(abs, realpathSync(tmpdir()), p) } catch { assertInside(abs, resolve(tmpdir()), p) }
    return
  }
  const real = realpathSync(abs)
  assertInside(real, realpathSync(tmpdir()), p)
  rmSync(real, { recursive: true, force: true })
}

function assertInside(candidate: string, root: string, shown: string): void {
  const rel = relative(root, candidate)
  if (rel === '' || rel === '..' || rel.startsWith('..' + '/') || isAbsolute(rel)) {
    throw new Error(`safeRmTmp: refusing to remove ${JSON.stringify(shown)} (not strictly inside the temp dir)`)
  }
}
