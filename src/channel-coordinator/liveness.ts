// Native channel liveness probing, shared by the dashboard's channel-monitor
// and the standalone channel-coordinator.
//
// getClaudePidForSession + hasChannelPluginAlive are extracted VERBATIM from
// channel-monitor.ts (which now imports them here) so both processes use one
// implementation. The coordinator adds a higher-level decision on top:
// decideNativeChannelDown() -- "is the native Telegram plugin currently NOT
// consuming inbound?" -- which gates whether the coordinator should backfill.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { resolveFromPath } from '../platform.js'
import { logger } from '../logger.js'
import { PROJECT_ROOT } from '../config.js'
import { channelStateDir, type ChannelProviderType } from '../channel-provider.js'
import { agentDir } from '../web/agent-config.js'

const TMUX = resolveFromPath('tmux')

// Keep in sync with channel-monitor.ts. The scheduled keepalive refreshes
// store/.channel-keepalive every ~6 min REGARDLESS of inbound traffic, so a
// stale file with a live process means the TUI is wedged (not merely quiet).
export const KEEPALIVE_FILE = join(PROJECT_ROOT, 'store', '.channel-keepalive')
export const KEEPALIVE_STALE_MS = 18 * 60 * 1000
// After any main-session respawn the plugin needs time to come up; never call
// the native "down" inside this window (matches MARVEEN_POST_RESPAWN_GRACE_MS).
export const STARTUP_GRACE_MS = 360_000
export const RESPAWN_STAMP_FILE = join(PROJECT_ROOT, 'store', '.channel-last-respawn')

// --- extracted verbatim from channel-monitor.ts (behavior-preserving) ---

export function getClaudePidForSession(session: string): number | null {
  try {
    const out = execFileSync(TMUX, ['list-panes', '-t', session, '-F', '#{pane_pid}'], { timeout: 3000, encoding: 'utf-8' })
    const panePid = parseInt(out.trim().split('\n')[0], 10)
    if (!panePid) return null
    const cmd = execFileSync('/bin/ps', ['-p', String(panePid), '-o', 'comm='], { timeout: 3000, encoding: 'utf-8' }).trim()
    if (cmd === 'claude' || cmd.endsWith('/claude')) return panePid
    try {
      const child = execFileSync('/usr/bin/pgrep', ['-P', String(panePid), '-x', 'claude'], { timeout: 3000, encoding: 'utf-8' }).trim()
      if (child) return parseInt(child.split('\n')[0], 10)
    } catch { /* none */ }
    return null
  } catch {
    return null
  }
}

export function hasChannelPluginAlive(claudePid: number, providerType: ChannelProviderType, agentName?: string): boolean {
  try {
    const ps = execFileSync('/bin/ps', ['-axo', 'pid,ppid,command'], { timeout: 3000, encoding: 'utf-8' })
    const lines = ps.split('\n').slice(1)
    const childrenOf = new Map<number, number[]>()
    const cmdOf = new Map<number, string>()
    for (const line of lines) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
      if (!m) continue
      const pid = parseInt(m[1], 10)
      const ppid = parseInt(m[2], 10)
      cmdOf.set(pid, m[3])
      const arr = childrenOf.get(ppid) || []
      arr.push(pid)
      childrenOf.set(ppid, arr)
    }

    const stack = [claudePid]
    const seen = new Set<number>()
    while (stack.length) {
      const p = stack.pop()!
      if (seen.has(p)) continue
      seen.add(p)
      const cmd = cmdOf.get(p) || ''
      if (providerType === 'telegram') {
        if (cmd.includes('/telegram/') && cmd.includes('bun')) return true
        if (/\bbun\b/.test(cmd) && cmd.includes('server.ts')) return true
      } else if (providerType === 'discord') {
        if (cmd.includes('discord') && (cmd.includes('node') || cmd.includes('bun'))) return true
      } else {
        if (cmd.includes('slack') && cmd.includes('node')) return true
        if (cmd.includes('slack-channel') && (cmd.includes('bun') || cmd.includes('node'))) return true
      }
      for (const k of (childrenOf.get(p) || [])) stack.push(k)
    }

    const stateDir = agentName
      ? channelStateDir(providerType, agentDir(agentName))
      : channelStateDir(providerType)
    const pidPath = join(stateDir, 'bot.pid')
    if (existsSync(pidPath)) {
      const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10)
      if (pid > 1) {
        try {
          process.kill(pid, 0)
          const cmd = cmdOf.get(pid) || ''
          const isRelevant = providerType === 'telegram'
            ? (cmd.includes('bun') || cmd.includes('server.ts') || cmd.includes('telegram'))
            : providerType === 'discord'
              ? (cmd.includes('discord') && (cmd.includes('node') || cmd.includes('bun')))
              : (cmd.includes('node') || cmd.includes('slack'))
          if (isRelevant) {
            logger.debug({ claudePid, orphanPid: pid, agentName, providerType }, 'Channel plugin alive via bot.pid (reparented)')
            return true
          }
        } catch { /* process gone */ }
      }
    }

    if (providerType === 'slack') {
      for (const [pid, cmd] of cmdOf) {
        if (seen.has(pid)) continue
        if ((cmd.includes('slack') || cmd.includes('socket-mode')) && (cmd.includes('node') || cmd.includes('bun'))) {
          try {
            process.kill(pid, 0)
            logger.debug({ claudePid, slackPid: pid, agentName }, 'Slack plugin alive via process scan')
            return true
          } catch { /* gone */ }
        }
      }
    }

    if (providerType === 'discord') {
      for (const [pid, cmd] of cmdOf) {
        if (seen.has(pid)) continue
        if (cmd.includes('discord') && (cmd.includes('node') || cmd.includes('bun'))) {
          try {
            process.kill(pid, 0)
            logger.debug({ claudePid, discordPid: pid, agentName }, 'Discord plugin alive via process scan')
            return true
          } catch { /* gone */ }
        }
      }
    }

    return false
  } catch {
    return false
  }
}

// --- coordinator-side decision layer ---

export function readRespawnStampMs(): number {
  try {
    const s = parseInt(readFileSync(RESPAWN_STAMP_FILE, 'utf-8').trim(), 10)
    return Number.isFinite(s) && s > 0 ? s * 1000 : 0
  } catch {
    return 0
  }
}

// Age of the keepalive file in ms, or null if missing/unreadable. The scheduled
// keepalive prompt (run inside the marveen-channels TUI) touches this every
// ~6 min; if the TUI is wedged it cannot, so the file ages.
export function readKeepaliveAgeMs(nowMs: number): number | null {
  try {
    return nowMs - statSync(KEEPALIVE_FILE).mtimeMs
  } catch {
    return null
  }
}

export interface NativeStateFacts {
  claudePid: number | null
  pluginAlive: boolean
  keepaliveAgeMs: number | null
  msSinceLastRespawn: number | null
}

// PURE decision: is the native channel currently NOT consuming inbound (so the
// coordinator should backfill)? Conservative -- biased toward "up" (let the
// native own inbound + its typing indicator), because a false "down" only
// causes the coordinator to attempt a poll that 409-yields if native is in fact
// alive. Layers:
//   - startup grace: within STARTUP_GRACE_MS of a respawn the plugin is still
//     coming up; never declare down.
//   - process gone: no claude pid, or no plugin grandchild -> down.
//   - wedged TUI: process alive BUT keepalive stale past KEEPALIVE_STALE_MS ->
//     the scheduled keepalive can't run, so the TUI is stuck (not just quiet).
export function decideNativeChannelDown(f: NativeStateFacts): boolean {
  if (f.msSinceLastRespawn != null && f.msSinceLastRespawn < STARTUP_GRACE_MS) return false
  if (f.claudePid == null) return true
  if (!f.pluginAlive) return true
  if (f.keepaliveAgeMs != null && f.keepaliveAgeMs > KEEPALIVE_STALE_MS) return true
  return false
}

// Side-effecting: gather the live facts for the main channels session and apply
// the pure decision.
export function probeNativeChannelDown(session: string, provider: ChannelProviderType, agentName?: string): boolean {
  const now = Date.now()
  const claudePid = getClaudePidForSession(session)
  const pluginAlive = claudePid != null ? hasChannelPluginAlive(claudePid, provider, agentName) : false
  const respawnMs = readRespawnStampMs()
  return decideNativeChannelDown({
    claudePid,
    pluginAlive,
    keepaliveAgeMs: readKeepaliveAgeMs(now),
    msSinceLastRespawn: respawnMs > 0 ? now - respawnMs : null,
  })
}
