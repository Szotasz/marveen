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

// Standard install locations probed when `which` cannot resolve a binary. A
// transient PATH gap is the failure this guards against: the 04:00 auto-update
// finalizer restarts the dashboard with only NODE_PIN_DIR prepended to PATH, so
// /opt/homebrew/bin (where `claude` and `tmux` live) is briefly absent and
// `which claude` fails -- even though the binary is present on disk. Probing
// these dirs recovers the real path instead of hard-failing.
// The user-level dirs cover the two most common `claude` install locations
// (native installer -> ~/.local/bin, bun -> ~/.bun/bin) -- exactly the layout
// on bootcamp/AVX-fallback boxes, which would otherwise still hard-fail during
// a PATH gap (#632 follow-up).
const KNOWN_BIN_DIRS = [
  join(homedir(), '.local', 'bin'),
  join(homedir(), '.bun', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
]

// Resolve a binary to an absolute path, or null if it cannot be found on PATH
// or in any known install dir. Never throws for a missing binary (only for an
// invalid name), so callers can decide whether absence is fatal.
export function tryResolveFromPath(name: string): string | null {
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw new Error('Invalid binary name: ' + name)
  try {
    return execSync(`which ${name}`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    for (const dir of KNOWN_BIN_DIRS) {
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
