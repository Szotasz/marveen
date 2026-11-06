import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export type PlatformType = 'macos' | 'linux-server' | 'linux-gui'

function detect(): PlatformType {
  const override = process.env['MARVEEN_ENV']
  if (override === 'macos' || override === 'linux-server' || override === 'linux-gui') return override
  if (process.platform === 'darwin') return 'macos'
  if (process.platform === 'linux') {
    const hasDisplay = !!(process.env['DISPLAY'] || process.env['WAYLAND_DISPLAY'] || process.env['XDG_SESSION_TYPE'])
    return hasDisplay ? 'linux-gui' : 'linux-server'
  }
  return 'linux-server'
}

export const PLATFORM: PlatformType = detect()

// Standard install locations probed when `which` cannot resolve a binary: a
// PATH that lacks the dir a binary lives in (a launch with a narrower PATH, a
// launchd plist from an older install) would otherwise hard-fail although the
// binary is on disk. Probing these dirs recovers the real path.
// The user-level dirs cover the two most common `claude` install locations
// (native installer -> ~/.local/bin, bun -> ~/.bun/bin) -- exactly the layout
// on bootcamp/AVX-fallback boxes, which would otherwise still hard-fail during
// a PATH gap (#632 follow-up).
const FIXED_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']

// ISSUE1968BREWPREFIX (#1968): a Homebrew in a custom prefix (~/homebrew, say) keeps tmux and the claude cask in
// <prefix>/bin, which no list here has: the dashboard crash-looped on "Required binary not found on PATH: tmux".
// The prefix is stored nowhere, but every launchd PATH the installer ever wrote starts with node@22's keg,
// <prefix>/opt/node@22/bin (NODE_BIN_DIR), and update.sh never rewrites that plist. So <prefix>/bin is derived from
// the PATH: the first keg entry whose <prefix>/bin exists and is not a dir the list already has. scripts/channels.sh
// applies the same rule to the main session's PATH. Null = nothing to add (the list as before).
export function brewPrefixBin(pathEnv: string | undefined, isDir: (p: string) => boolean = existsSync): string | null {
  for (const dir of (pathEnv ?? '').split(':')) {
    const m = /^(\/.+)\/opt\/node@\d{1,2}\/bin$/.exec(dir)
    if (!m) continue
    const bin = `${m[1]}/bin`
    if (FIXED_BIN_DIRS.includes(bin)) continue
    if (isDir(bin)) return bin
  }
  return null
}

// The probe list, worked out at call time (the PATH can change under a running process). The derived Homebrew bin
// goes right after ~/.local/bin, the same place channels.sh puts it, so both lookups pick the same binary.
export function knownBinDirs(pathEnv: string | undefined = process.env.PATH): string[] {
  const brew = brewPrefixBin(pathEnv)
  return [
    join(homedir(), '.local', 'bin'),
    ...(brew ? [brew] : []),
    join(homedir(), '.bun', 'bin'),
    ...FIXED_BIN_DIRS,
  ]
}

// Resolve a binary to an absolute path, or null if it cannot be found on PATH
// or in any known install dir. Never throws for a missing binary (only for an
// invalid name), so callers can decide whether absence is fatal.
export function tryResolveFromPath(name: string): string | null {
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw new Error('Invalid binary name: ' + name)
  try {
    return execSync(`which ${name}`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    for (const dir of knownBinDirs()) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) return candidate
    }
    return null
  }
}

export function resolveFromPath(name: string): string {
  const resolved = tryResolveFromPath(name)
  if (!resolved) throw new Error(`Required binary not found on PATH: ${name}`)
  return resolved
}

// Lazy, memoised, self-healing binary resolver. Unlike a module-level
// `resolveFromPath(...)` const -- which throws at IMPORT time and takes the whole
// dashboard (and the scheduler that lives in it) down if the binary is
// transiently unresolvable -- this defers resolution to first use. A boot that
// happens during a PATH gap therefore succeeds; only the first actual use of the
// binary can throw, and that call site can handle it.
//
// The resolved path is cached, but RE-VALIDATED with existsSync on every call: a
// cached absolute path can go stale when the binary is moved or its symlink is
// repointed/broken out from under a long-lived process (e.g. an in-place package
// update or a version-manager switch). existsSync follows symlinks, so a dangling
// link or a link to a now-missing target fails the check and we re-resolve -- no
// process restart needed. Still lazy: the FIRST resolve is deferred to first use,
// so boot-time PATH-gap resilience is preserved.
export function makeLazyBinResolver(name: string): () => string {
  let cached: string | null = null
  return () => {
    if (cached !== null && existsSync(cached)) return cached
    cached = resolveFromPath(name)
    return cached
  }
}
