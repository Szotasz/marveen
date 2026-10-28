// GLOBAL rm GUARD (vitest `setupFiles`): refuse recursive or forced deletes that are
// not strictly inside the OS temp dir, /tmp or this checkout.
//
// The suite mutates the file system a lot, and a cleanup path built from an empty
// or unset value (join(x, '..') with x === '') collapses to the cwd's parent and
// wipes it (2026-10-24 incident). safeRmTmp covers the callers that opted in; this
// guard covers every other in-process fs.rm*/rmdir* caller (child processes such as
// `rm -rf` and unlink loops are not covered), by replacing the delete functions on the CJS
// `node:fs` object and syncing the builtin ESM exports, so named, default and
// namespace imports all reach the checking wrappers.
//
// Allowed roots are pinned once, at install time, via realpath. A target must be
// STRICTLY below one of them (never the root itself) and never inside the
// checkout's .git. Calls with neither `recursive` nor `force` are passed through
// untouched. There is deliberately no override switch.
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertSafeTmpRoot, isStrictlyInside } from '../helpers/safe-rm-tmp.js'

const MARKER = Symbol.for('test-suite.rm-guard.installed')

const cjsRequire = createRequire(import.meta.url)
const nodeFs = cjsRequire('node:fs') as typeof import('node:fs')
const nodeFsPromises = cjsRequire('node:fs/promises') as typeof import('node:fs/promises')
// Pinned at load: a test that later spies on fs.lstatSync / fs.realpathSync must not blind the guard.
// realpathSync.native is realpath(3): '..' after a symlink follows the link, as the kernel's rm does.
// The JS realpathSync resolves '..' lexically first, so 'link/../x' would be judged as a sibling of
// the link while rm deletes next to the link's target.
const lstat = nodeFs.lstatSync
const realpathNative = nodeFs.realpathSync.native
const isBuffer = Buffer.isBuffer

// Same derivation as global-live-install-gate.ts: from this file's location, never from the environment.
const checkoutRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any

function refuse(shown: unknown, why: string): Error {
  return new Error(`rm-guard: refusing to remove ${JSON.stringify(String(shown))} (${why})`)
}

function realOrNull(p: string): string | null {
  try { return realpathNative(p) } catch { return null }
}

// A root that fails assertSafeTmpRoot (poisoned TMPDIR such as '/' or $HOME) is left
// out, which fails closed: the deletes under it are refused instead of allowed.
function pinRoots(): { roots: string[]; gitDir: string | null } {
  const roots: string[] = []
  for (const candidate of [tmpdir(), '/tmp']) {
    const real = realOrNull(candidate)
    if (real === null) continue
    try { assertSafeTmpRoot(real) } catch { continue }
    roots.push(real)
  }
  const checkout = realOrNull(checkoutRoot)
  if (checkout !== null) roots.push(checkout)
  return { roots, gitDir: checkout === null ? null : join(checkout, '.git') }
}

// Where would the kernel actually delete? The path is NOT lexically normalized
// (a '..' after a symlink must follow the symlink). The nearest existing ancestor
// is realpath'ed; a symlink target itself is judged as the link (realpath(parent) +
// basename), because rm removes the link, not what it points to.
function resolveTarget(raw: string): string {
  const abs = isAbsolute(raw) ? raw : process.cwd() + sep + raw
  const tail: string[] = []
  let cur = abs
  for (;;) {
    let st: import('node:fs').Stats
    try {
      st = lstat(cur)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw refuse(raw, `cannot inspect the path (${code ?? 'unknown error'})`)
      const parent = dirname(cur)
      if (parent === cur) throw refuse(raw, 'no existing ancestor')
      tail.unshift(basename(cur))
      cur = parent
      continue
    }
    const base = basename(cur)
    const isFsRoot = dirname(cur) === cur
    // A symlink is followed when more path components come after it, or when the
    // path ends in a separator (the kernel then resolves the link).
    const followed = st.isSymbolicLink() && (tail.length > 0 || /[\\/]$/.test(raw))
    let resolved: string
    try {
      resolved =
        isFsRoot || base === '.' || base === '..' || !st.isSymbolicLink() || followed
          ? realpathNative(cur)
          : join(realpathNative(dirname(cur)), base)
    } catch (e) {
      throw refuse(raw, `cannot resolve the path (${(e as NodeJS.ErrnoException).code ?? 'unknown error'})`)
    }
    return tail.length > 0 ? join(resolved, ...tail) : resolved
  }
}

function pathToString(p: unknown): string {
  if (typeof p === 'string') return p
  if (isBuffer(p)) return p.toString()
  if (p instanceof URL) return fileURLToPath(p)
  throw refuse(p, 'not a string, Buffer or URL path')
}

function install(): void {
  const { roots, gitDir } = pinRoots()

  const assertAllowed = (rawPath: unknown): void => {
    const raw = pathToString(rawPath)
    if (raw === '') throw refuse(raw, 'empty path')
    const judged = resolveTarget(raw)
    // Lowercase compare for .git: on a case-insensitive file system '.GIT' is the same directory.
    if (gitDir !== null) {
      const lowJudged = judged.toLowerCase()
      const lowGit = gitDir.toLowerCase()
      if (lowJudged === lowGit || isStrictlyInside(lowJudged, lowGit)) throw refuse(raw, `inside the checkout's .git (${judged})`)
    }
    if (roots.some((root) => isStrictlyInside(judged, root))) return
    throw refuse(raw, `${judged} is not strictly inside the temp dir, /tmp or the checkout`)
  }

  const needsCheck = (opts: unknown): boolean =>
    typeof opts === 'object' && opts !== null && Boolean((opts as { recursive?: unknown }).recursive || (opts as { force?: unknown }).force)

  // Sync and callback APIs throw synchronously (a callback must not swallow the refusal);
  // the promise API rejects.
  const guarded = (orig: AnyFn, returnsPromise: boolean): AnyFn =>
    function (this: unknown, ...args: unknown[]) {
      try {
        if (needsCheck(args[1])) assertAllowed(args[0])
      } catch (e) {
        if (returnsPromise) return Promise.reject(e)
        throw e
      }
      return orig.apply(this, args)
    }

  const target = nodeFs as unknown as Record<string | symbol, AnyFn | boolean>
  for (const name of ['rmSync', 'rm', 'rmdirSync', 'rmdir']) {
    target[name] = guarded(target[name] as AnyFn, false)
  }
  const promisesTargets = new Set<Record<string, AnyFn>>([
    nodeFs.promises as unknown as Record<string, AnyFn>,
    nodeFsPromises as unknown as Record<string, AnyFn>,
  ])
  for (const promisesObj of promisesTargets) {
    for (const name of ['rm', 'rmdir']) {
      promisesObj[name] = guarded(promisesObj[name], true)
    }
  }
  Object.defineProperty(nodeFs, MARKER, { value: true, enumerable: false })
  syncBuiltinESMExports()
}

if (!Object.prototype.hasOwnProperty.call(nodeFs, MARKER)) install()
