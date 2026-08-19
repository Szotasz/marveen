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
import { matchesProviderPollerCmd } from './provider-poller-match.js'

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

/**
 * Pure decision: does the parsed `ps` snapshot + bot.pid + alive-predicate
 * prove that the `providerType` channel plugin is alive under `claudePid`?
 *
 * Extracted 1:1 from `hasChannelPluginAlive` for testability (matches the
 * `decideStuckToolCallRecovery` pure-decider pattern used elsewhere). The
 * branching, ordering, and bot.pid + cross-tree fallbacks are preserved
 * verbatim; only the per-provider command-line matching delegates to
 * `matchesProviderPollerCmd` (the path-boundary matcher that closes the
 * multi-plugin masking gap).
 */
export interface PluginAliveContext {
  psOutput: string
  claudePid: number
  providerType: ChannelProviderType
  botPid: number | null
  isPidAlive: (pid: number) => boolean
  agentName?: string
  debugLog?: (event: string, fields: Record<string, unknown>) => void
}

export function decideHasPluginAlive(ctx: PluginAliveContext): boolean {
  const { psOutput, claudePid, providerType, botPid, isPidAlive, agentName, debugLog } = ctx
  const lines = psOutput.split('\n').slice(1)
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
    if (matchesProviderPollerCmd(cmd, providerType)) return true
    for (const k of (childrenOf.get(p) || [])) stack.push(k)
  }

  if (botPid !== null && botPid > 1) {
    if (isPidAlive(botPid)) {
      const cmd = cmdOf.get(botPid) || ''
      if (matchesProviderPollerCmd(cmd, providerType)) {
        debugLog?.('plugin alive via bot.pid (reparented)', { claudePid, orphanPid: botPid, agentName, providerType })
        return true
      }
    }
  }

  if (providerType === 'slack') {
    for (const [pid, cmd] of cmdOf) {
      if (seen.has(pid)) continue
      if (matchesProviderPollerCmd(cmd, providerType) && isPidAlive(pid)) {
        debugLog?.('slack plugin alive via process scan', { claudePid, slackPid: pid, agentName })
        return true
      }
    }
  }

  if (providerType === 'discord') {
    for (const [pid, cmd] of cmdOf) {
      if (seen.has(pid)) continue
      if (matchesProviderPollerCmd(cmd, providerType) && isPidAlive(pid)) {
        debugLog?.('discord plugin alive via process scan', { claudePid, discordPid: pid, agentName })
        return true
      }
    }
  }

  return false
}

// The liveness snapshot (`ps -axww`) normally returns in ~20ms, but on a heavily
// loaded box (fleet-wide cold-boots, the 04:00 rebuild) it can exceed the
// fast-path deadline and THROW. A throw used to mean 'unknown' immediately, which
// spammed the log in bursts at load peaks (measured 2026-07-14+: clusters of
// consecutive failures at 04:02, 08:08, 21:00 -- never a real plugin death). The
// first timeout means "the box is loaded", not "ps is broken", so we retry once
// with a longer deadline before giving up. Only a second failure is a genuine
// "we cannot tell". Kept as a tiny pure wrapper so the retry logic is unit-testable
// without spawning ps.
export const PS_PROBE_TIMEOUT_MS = 5000
export const PS_PROBE_RETRY_TIMEOUT_MS = 12_000
const PS_PROBE_MAX_BUFFER = 8 * 1024 * 1024

export function snapshotProcsWithRetry(
  run: (timeoutMs: number) => string,
  timeouts: readonly [number, number] = [PS_PROBE_TIMEOUT_MS, PS_PROBE_RETRY_TIMEOUT_MS],
): string {
  try {
    return run(timeouts[0])
  } catch (firstErr) {
    logger.debug({ err: firstErr }, 'Channel-plugin liveness probe: ps snapshot timed out, retrying with a longer deadline')
    return run(timeouts[1])
  }
}

// Tri-state liveness verdict. 'unknown' means the PROBE failed (ps timed out on
// a loaded box, the state dir was unreadable, ...) -- not that the plugin is
// down. Collapsing that into 'down' let a hiccup in the monitor's own probe
// hard-restart a healthy agent and destroy its session context, so the caller
// must treat 'unknown' as "no information" and leave the agent alone.
export type PluginLiveness = 'alive' | 'down' | 'unknown'

export function probeChannelPluginLiveness(
  claudePid: number,
  providerType: ChannelProviderType,
  agentName?: string,
): PluginLiveness {
  let psOutput: string
  try {
    // Parity with the reaper's snapshotProcs: `-ww` (never truncate a command,
    // the poller match lives deep in a long path), an 8MB buffer (the default
    // 1MB is only ~3x the measured fleet-wide ps output, and blowing it makes
    // execFileSync THROW) and a fast-path timeout with one longer-deadline retry
    // (see snapshotProcsWithRetry). A probe that throws twice is a probe that
    // knows nothing -- and knowing nothing must NOT restart the agent.
    // Keep the HEADER form (`-o pid,ppid,command`, not `-o pid=,...`):
    // decideHasPluginAlive drops the first line as the header, so a headerless
    // output would silently lose the first process row.
    psOutput = snapshotProcsWithRetry((timeoutMs) =>
      execFileSync('/bin/ps', ['-axww', '-o', 'pid,ppid,command'], {
        timeout: timeoutMs,
        encoding: 'utf-8',
        maxBuffer: PS_PROBE_MAX_BUFFER,
      }),
    )
  } catch (err) {
    logger.warn({ err, claudePid, agentName, providerType }, 'Channel-plugin liveness probe failed (ps, after retry) -- verdict unknown, not restarting')
    return 'unknown'
  }
  try {
    const stateDir = agentName
      ? channelStateDir(providerType, agentDir(agentName))
      : channelStateDir(providerType)
    const pidPath = join(stateDir, 'bot.pid')
    let botPid: number | null = null
    if (existsSync(pidPath)) {
      const parsed = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10)
      if (Number.isFinite(parsed)) botPid = parsed
    }
    const alive = decideHasPluginAlive({
      psOutput,
      claudePid,
      providerType,
      botPid,
      agentName,
      isPidAlive: (pid) => {
        try { process.kill(pid, 0); return true } catch { return false }
      },
      debugLog: (event, fields) => logger.debug(fields, event),
    })
    return alive ? 'alive' : 'down'
  } catch (err) {
    logger.warn({ err, claudePid, agentName, providerType }, 'Channel-plugin liveness probe failed (state dir) -- verdict unknown, not restarting')
    return 'unknown'
  }
}

// Boolean view for callers that only act on a positive verdict (a failed probe
// and a genuinely absent plugin are both "not alive" to them). Anything that
// RESTARTS on the negative answer must use probeChannelPluginLiveness instead,
// so it can distinguish 'down' from 'unknown'.
export function hasChannelPluginAlive(claudePid: number, providerType: ChannelProviderType, agentName?: string): boolean {
  return probeChannelPluginLiveness(claudePid, providerType, agentName) === 'alive'
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

// --- external-respawn attribution (SOAKRESPAWN819) ---
//
// The respawn stamp is a SUPPRESSION contract: five watchers read it to stay
// quiet during the post-respawn grace. That contract makes an externally
// triggered respawn (channels.sh relaunched by the service manager, the
// systemd-timer channel-watchdog, a manual launch) structurally silent in the
// dashboard log -- the evidence of the respawn is consumed to suppress, never
// surfaced. Measured on a live soak box 2026-08-19: 210 service-manager
// restarts at a ~40min cadence, zero dashboard.log lines.
//
// PURE classifier: did the stamp advance, and was the advance ours?
//   'none'     -- no new stamp value since the last one we processed.
//   'self'     -- advanced, but within graceMs of a dashboard-initiated
//                 respawn. channels.sh writes the stamp unconditionally on
//                 EVERY launch, including launches the dashboard itself
//                 initiated (hard restart -> service reload -> channels.sh),
//                 so a second write shortly after our own is part of OUR
//                 restart, not an external actor.
//   'external' -- advanced with no dashboard-initiated respawn nearby: some
//                 other actor recreated the main session. The caller logs
//                 this loudly; false positives are deliberate signal (a manual
//                 operator launch IS an external actor worth a log line).
//
// KNOWN SHADOW (do not read the absence of a warning as absence of external
// respawns): the abs() window means a REAL external respawn landing within
// graceMs (6 min) of a dashboard-initiated one classifies 'self' and is lost.
// On the measured 40-min churn that is a ~15% blind window per cycle, wider
// during an active recovery cascade (several self respawns back to back).
// Deliberate trade-off: shrinking the window would misreport channels.sh's
// own delayed stamp write on OUR launches as external -- a false alarm on
// every dashboard restart is worse than a shadowed edge case. The producer
// mirror (store/channels-respawn.log) still records WHY lines for shadowed
// respawns, so the evidence survives even when this classifier stays quiet.
export type RespawnStampAdvance = 'none' | 'self' | 'external'

export function classifyRespawnStampAdvance(opts: {
  stampMs: number
  lastSeenStampMs: number
  lastSelfRespawnMs: number
  graceMs: number
}): RespawnStampAdvance {
  const { stampMs, lastSeenStampMs, lastSelfRespawnMs, graceMs } = opts
  if (!(stampMs > 0) || stampMs <= lastSeenStampMs) return 'none'
  if (lastSelfRespawnMs > 0 && Math.abs(stampMs - lastSelfRespawnMs) <= graceMs) return 'self'
  return 'external'
}
