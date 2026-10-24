import { existsSync, realpathSync, rmSync } from 'node:fs'
import * as nodePath from 'node:path'
import { tmpdir, userInfo } from 'node:os'

type PathModule = Pick<typeof nodePath, 'isAbsolute' | 'relative' | 'resolve' | 'parse' | 'sep'>

export interface TmpRootEnv {
  platform?: NodeJS.Platform
  home?: string
  pathMod?: PathModule
}

// True when `candidate` is strictly below `root`. Uses relative() + isAbsolute()
// instead of a hardcoded '/' so it also holds for Windows paths (a different
// drive yields an absolute relative path, '..\\x' starts with '..' + sep).
export function isStrictlyInside(candidate: string, root: string, pathMod: PathModule = nodePath): boolean {
  const rel = pathMod.relative(root, candidate)
  if (rel === '' || pathMod.isAbsolute(rel)) return false
  const first = rel.split(/[\\/]/)[0]
  return first !== '..'
}

// The temp root comes from the TMPDIR env var, so it is not trusted: a poisoned
// TMPDIR ('/', $HOME, a parent of $HOME) would turn "strictly inside the temp
// dir" into "anywhere". Throws unless the (already realpath'ed) root is a
// plausible per-user temp location.
export function assertSafeTmpRoot(root: string, env: TmpRootEnv = {}): void {
  const platform = env.platform ?? process.platform
  const pathMod = env.pathMod ?? nodePath
  // The account's real home from the user database, not $HOME: tests point $HOME at a
  // throwaway dir under the temp root, which would make every temp root look like its ancestor.
  const home = env.home ?? userInfo().homedir
  const bad = (why: string): never => {
    throw new Error(`safeRmTmp: unsafe temp root ${JSON.stringify(root)} (${why})`)
  }
  if (typeof root !== 'string' || root.trim() === '') bad('empty')
  const r = pathMod.resolve(root)
  if (pathMod.parse(r).root === r) bad('filesystem root')
  if (home) {
    const h = pathMod.resolve(home)
    if (r === h) bad('equals $HOME')
    if (pathMod.relative(r, h) !== '' && isStrictlyInside(h, r, pathMod)) bad('ancestor of $HOME')
  }
  if (platform === 'darwin') {
    const underVarFolders = isStrictlyInside(r, '/private/var/folders', pathMod)
    const atOrUnderPrivTmp = r === '/private/tmp' || isStrictlyInside(r, '/private/tmp', pathMod)
    if (!underVarFolders && !atOrUnderPrivTmp) bad('not under /private/var/folders or /private/tmp')
  }
}

// Recursive cleanup that can only ever delete something STRICTLY inside the
// OS temp dir. A cleanup path built as join(x, '..') with x === '' collapses to
// '..' and wipes the cwd's parent (2026-10-24 incident), so an empty value, a
// path that resolves to the temp dir itself, a path outside it, a symlink
// inside it that points outside it, and an implausible temp root itself
// (see assertSafeTmpRoot) are all refused with a throw.
export function safeRmTmp(p: string): void {
  if (typeof p !== 'string' || p.trim() === '') throw new Error('safeRmTmp: empty path')
  const abs = nodePath.resolve(p)
  let root: string
  try { root = realpathSync(tmpdir()) } catch { root = nodePath.resolve(tmpdir()) }
  assertSafeTmpRoot(root)
  if (!existsSync(abs)) {
    // Nothing to delete; still refuse lexically-outside paths so a typo is loud.
    try { assertInside(abs, root, p) } catch (e) {
      // the path may be spelled through a symlinked alias of the temp dir (/var -> /private/var)
      if (!isStrictlyInside(abs, nodePath.resolve(tmpdir()))) throw e
    }
    return
  }
  const real = realpathSync(abs)
  assertInside(real, root, p)
  rmSync(real, { recursive: true, force: true })
}

function assertInside(candidate: string, root: string, shown: string): void {
  if (!isStrictlyInside(candidate, root)) {
    throw new Error(`safeRmTmp: refusing to remove ${JSON.stringify(shown)} (not strictly inside the temp dir)`)
  }
}
