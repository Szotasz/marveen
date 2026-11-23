// PORTRECLAIM1123: which holder of the dashboard's port the startup may stop.
//
// On EADDRINUSE the dashboard reclaims its port from a predecessor that has not exited yet (a launchd restart races
// the dying process). It used to stop ANY same-user node/tsx process on the port. Measured 2026-11-23: a dashboard
// started from a worktree on port 3421 sent SIGTERM to the live CRM (another node service on that port) and took it
// down for about 40 seconds. Now only this install's own dashboard is a victim: a process whose command line runs
// <PROJECT_ROOT>/dist/index.js or <PROJECT_ROOT>/src/index.ts, named absolutely or relative to its working
// directory. Anything else on the port is left alone, and the startup reports the foreign holder instead.

import { execFileSync } from 'node:child_process'
import { readlinkSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { runLsof } from './lsof.js'

export interface PortHolderInfo {
  /** The owner's uid, or null when it could not be read. */
  uid: number | null
  /** The full command line (ps -o command=). */
  command: string
  /** The working directory, or null when it could not be read. */
  cwd: string | null
}

/** The entry points a dashboard of this install runs (package.json "start" and "dev"). */
const ENTRY_POINTS = ['dist/index.js', 'src/index.ts']

/**
 * True only for this install's own dashboard: same uid, and a command line that runs one of its entry points, either
 * by absolute path or by a relative path from a working directory that is the install root. Unknown is false: a
 * holder that cannot be identified is never stopped.
 */
export function isOwnDashboardProcess(info: PortHolderInfo, projectRoot: string, myUid: number | null): boolean {
  if (myUid !== null && info.uid !== myUid) return false
  const root = resolve(projectRoot)
  for (const entry of ENTRY_POINTS) {
    const abs = resolve(root, entry)
    // Bounded by whitespace or the end, so <root>/dist/index.js.bak or <root>-old/dist/index.js do not count.
    const absRx = new RegExp(`(^|\\s)${escapeRx(abs)}(\\s|$)`)
    if (absRx.test(info.command)) return true
    const relRx = new RegExp(`(^|\\s)(\\./)?${escapeRx(entry)}(\\s|$)`)
    if (relRx.test(info.command) && info.cwd !== null && isAbsolute(info.cwd) && resolve(info.cwd) === root) return true
  }
  return false
}

function escapeRx(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Read a port holder's uid, command line and working directory. Fields that cannot be read stay null / empty. */
export function readPortHolder(pid: number): PortHolderInfo {
  const ps = (field: string): string => {
    try {
      return execFileSync('/bin/ps', ['-p', String(pid), '-o', `${field}=`], { timeout: 2000, encoding: 'utf-8' }).trim()
    } catch {
      return ''
    }
  }
  const uidRaw = parseInt(ps('uid'), 10)
  return { uid: Number.isFinite(uidRaw) ? uidRaw : null, command: ps('command'), cwd: readCwd(pid) }
}

function readCwd(pid: number): string | null {
  if (process.platform === 'linux') {
    try { return readlinkSync(`/proc/${pid}/cwd`) } catch { return null }
  }
  // lsof -Fn prints the fields one per line; the cwd's name is the line starting with 'n'.
  const out = runLsof(['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], 3000) ?? ''
  const line = out.split('\n').find((l) => l.startsWith('n'))
  return line ? line.slice(1) : null
}
