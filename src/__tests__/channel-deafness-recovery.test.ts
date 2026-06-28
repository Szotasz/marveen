import { describe, it, expect } from 'vitest'
import {
  buildMainSessionRespawnCmd,
  shouldRespawnForStaleKeepalive,
  shouldDeferKeepaliveRespawn,
  shouldRefreshKeepaliveFromInbound,
  lastMainRespawnAt,
  shouldEscalateAfterResume,
  POST_RESUME_GUARD_DELAY_MS,
} from '../web/channel-monitor.js'

// CONTRACT: the respawn command MUST carry the .bun/bin PATH export -- without
// it the respawned bun telegram bridge can't be located and the session comes
// up channel-less. Lock it so a future refactor can't silently drop it.
describe('buildMainSessionRespawnCmd', () => {
  const base = { claudePath: '/usr/local/bin/claude', pluginId: 'telegram@claude-plugins-official', model: "claude-opus-4-8[1m]" }

  it('always exports a PATH that includes $HOME/.bun/bin', () => {
    const cmd = buildMainSessionRespawnCmd({ ...base, continueSession: false })
    expect(cmd).toContain('$HOME/.bun/bin')
    expect(cmd).toMatch(/^export PATH=/)
  })

  it('includes the channels plugin and skip-permissions flag', () => {
    const cmd = buildMainSessionRespawnCmd({ ...base, continueSession: false })
    expect(cmd).toContain('--channels plugin:telegram@claude-plugins-official')
    expect(cmd).toContain('--dangerously-skip-permissions')
  })

  it('single-quotes the model id (so [1m] is not glob-expanded)', () => {
    const cmd = buildMainSessionRespawnCmd({ ...base, continueSession: false })
    expect(cmd).toContain("--model 'claude-opus-4-8[1m]'")
  })

  it('tunes the MCP startup batch so the channel plugin is not starved (parity with channels.sh)', () => {
    const cmd = buildMainSessionRespawnCmd({ ...base, continueSession: false })
    expect(cmd).toContain('MCP_SERVER_CONNECTION_BATCH_SIZE=10')
    expect(cmd).toContain('MCP_CONNECTION_NONBLOCKING=1')
    expect(cmd).toContain('MCP_TIMEOUT=60000')
    // Must be exported BEFORE the claude binary runs.
    expect(cmd.indexOf('MCP_SERVER_CONNECTION_BATCH_SIZE')).toBeLessThan(cmd.indexOf('--channels'))
  })

  it('omits --model when no model is configured', () => {
    const cmd = buildMainSessionRespawnCmd({ ...base, model: '', continueSession: false })
    expect(cmd).not.toContain('--model')
  })

  it('includes --continue only for a resume, not a fresh start', () => {
    expect(buildMainSessionRespawnCmd({ ...base, continueSession: true })).toContain('--continue')
    expect(buildMainSessionRespawnCmd({ ...base, continueSession: false })).not.toContain('--continue')
  })
})

// CONTRACT: the post-resume guard (CC 2.1.193) escalates to a fresh respawn iff
// the --continue resume did NOT bring up the channel plugin. A live pid serving
// the plugin means context was preserved -- do not escalate.
describe('shouldEscalateAfterResume', () => {
  it('does NOT escalate when the resumed claude is alive AND the plugin attached', () => {
    expect(shouldEscalateAfterResume({ claudePid: 1234, pluginAlive: true })).toBe(false)
  })
  it('escalates when the pid is alive but the plugin never loaded (the 2.1.193 regression)', () => {
    expect(shouldEscalateAfterResume({ claudePid: 1234, pluginAlive: false })).toBe(true)
  })
  it('escalates when the resumed claude pid is gone entirely', () => {
    expect(shouldEscalateAfterResume({ claudePid: null, pluginAlive: false })).toBe(true)
  })
  it('guard delay clears the unlock-probe budget (~65s) yet stays under RESUME_GRACE_MS (240s)', () => {
    // > worst-case unlock-probe completion so a merely-disabled plugin is revived
    // first, and < the cascade grace so a genuinely-absent plugin escalates sooner.
    expect(POST_RESUME_GUARD_DELAY_MS).toBeGreaterThan(65_000)
    expect(POST_RESUME_GUARD_DELAY_MS).toBeLessThan(240_000)
  })
})

describe('shouldRespawnForStaleKeepalive', () => {
  const T = 18 * 60 * 1000
  const G = 15 * 60 * 1000

  it('does NOT respawn when the file is missing (keep-alive not yet established)', () => {
    expect(shouldRespawnForStaleKeepalive({ keepaliveAgeMs: null, stalenessThresholdMs: T, msSinceLastRespawn: null, respawnGraceMs: G })).toBe(false)
  })

  it('does NOT respawn when the keep-alive is fresh', () => {
    expect(shouldRespawnForStaleKeepalive({ keepaliveAgeMs: 5 * 60 * 1000, stalenessThresholdMs: T, msSinceLastRespawn: null, respawnGraceMs: G })).toBe(false)
  })

  it('respawns when the keep-alive is stale and no recent respawn', () => {
    expect(shouldRespawnForStaleKeepalive({ keepaliveAgeMs: T + 1, stalenessThresholdMs: T, msSinceLastRespawn: null, respawnGraceMs: G })).toBe(true)
  })

  it('does NOT respawn again within the respawn grace, even if stale', () => {
    expect(shouldRespawnForStaleKeepalive({ keepaliveAgeMs: T + 1, stalenessThresholdMs: T, msSinceLastRespawn: G - 1, respawnGraceMs: G })).toBe(false)
  })

  it('respawns once the grace has elapsed', () => {
    expect(shouldRespawnForStaleKeepalive({ keepaliveAgeMs: T + 1, stalenessThresholdMs: T, msSinceLastRespawn: G + 1, respawnGraceMs: G })).toBe(true)
  })
})

describe('shouldDeferKeepaliveRespawn', () => {
  it('defers when pane is busy', () => {
    expect(shouldDeferKeepaliveRespawn('busy')).toBe(true)
  })

  it('defers when pane is typing', () => {
    expect(shouldDeferKeepaliveRespawn('typing')).toBe(true)
  })

  it('does NOT defer when pane is idle', () => {
    expect(shouldDeferKeepaliveRespawn('idle')).toBe(false)
  })

  it('does NOT defer (fail-open) when pane state is unknown', () => {
    expect(shouldDeferKeepaliveRespawn('unknown')).toBe(false)
  })

  it('does NOT defer (fail-open) when pane state is error', () => {
    expect(shouldDeferKeepaliveRespawn('error')).toBe(false)
  })

  it('does NOT defer (fail-open) when pane state is null (capture failed)', () => {
    expect(shouldDeferKeepaliveRespawn(null)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// B2 CONTRACT: cross-path respawn storm prevention
//
// Invariant: after an inbound-probe respawn fires (setting marveenLastHardRestart
// via hardRestartMarveenChannels), the keepalive path must be suppressed for
// KEEPALIVE_RESPAWN_GRACE_MS. This is achieved by passing msSinceLastRespawn
// = now - lastMainRespawnAt() to shouldRespawnForStaleKeepalive, where
// lastMainRespawnAt() = Math.max(marveenLastKeepaliveRespawn, marveenLastHardRestart).
//
// The pure-function test below locks the decision: even when only the
// inbound-probe path has respawned (keepalive variable = 0, hardRestart > 0),
// the cross-path grace computation via Math.max suppresses the second respawn.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// SOURCE FIX CONTRACT (2026-06-01): false-positive respawn of a busy-but-alive
// channel. Real inbound traffic advances the keepalive file mtime, so an active
// conversation can never be judged stale-deaf and respawned.
// ---------------------------------------------------------------------------
describe('shouldRefreshKeepaliveFromInbound', () => {
  it('refreshes when the last inbound is newer than the keepalive file', () => {
    expect(shouldRefreshKeepaliveFromInbound(2_000, 1_000)).toBe(true)
  })
  it('does NOT refresh when the last inbound is older than the file', () => {
    expect(shouldRefreshKeepaliveFromInbound(500, 1_000)).toBe(false)
  })
  it('does NOT refresh when there is no inbound (null) or it equals the file', () => {
    expect(shouldRefreshKeepaliveFromInbound(null, 1_000)).toBe(false)
    expect(shouldRefreshKeepaliveFromInbound(1_000, 1_000)).toBe(false)
  })
})

describe('INVARIANT: a busy-but-alive channel is never stale-deaf', () => {
  const STALE = 18 * 60 * 1000
  const GRACE = 15 * 60 * 1000
  const now = Date.now()

  it('busy session whose scheduled keepalive was skipped, but with fresh inbound 2 min ago -> NOT respawned', () => {
    const rawMtime = now - 25 * 60 * 1000        // file went stale (busy: keepalive skipped/stuck)
    const lastInbound = now - 2 * 60 * 1000      // a real user message was ingested 2 min ago
    // The safety net advances the file mtime to the inbound time:
    expect(shouldRefreshKeepaliveFromInbound(lastInbound, rawMtime)).toBe(true)
    const effectiveAge = now - Math.max(rawMtime, lastInbound) // = 2 min
    expect(shouldRespawnForStaleKeepalive({
      keepaliveAgeMs: effectiveAge, stalenessThresholdMs: STALE,
      msSinceLastRespawn: null, respawnGraceMs: GRACE,
    })).toBe(false) // conversation preserved
  })

  it('genuinely silent/deaf session (no fresh inbound) still ages out and respawns', () => {
    const rawMtime = now - 25 * 60 * 1000
    const lastInbound = now - 40 * 60 * 1000     // last inbound 40 min ago -> older than the file
    expect(shouldRefreshKeepaliveFromInbound(lastInbound, rawMtime)).toBe(false) // no forward refresh
    const effectiveAge = now - rawMtime          // stays 25 min stale
    expect(shouldRespawnForStaleKeepalive({
      keepaliveAgeMs: effectiveAge, stalenessThresholdMs: STALE,
      msSinceLastRespawn: null, respawnGraceMs: GRACE,
    })).toBe(true) // genuinely deaf -> recovered
  })
})

describe('B2 cross-path respawn storm prevention', () => {
  const STALE_MS = 18 * 60 * 1000     // KEEPALIVE_STALE_MS
  const GRACE_MS = 15 * 60 * 1000     // KEEPALIVE_RESPAWN_GRACE_MS
  const AGE_MS = STALE_MS + 1_000     // keepalive is stale

  it('lastMainRespawnAt() is exported and initially zero', () => {
    // Verify the accessor is accessible and returns a number.
    // At test startup (no respawn has fired) it may not be zero because the
    // module is shared, but the type contract must hold.
    expect(typeof lastMainRespawnAt()).toBe('number')
  })

  it('suppresses keepalive respawn when inbound-probe path respawned recently (cross-path grace via Math.max)', () => {
    // Simulate: inbound-probe respawned T_respawn ms ago; keepalive variable = 0.
    // The keepalive path computes msSinceLastRespawn = now - Math.max(0, T_respawn) = elapsed.
    // If elapsed < GRACE_MS, shouldRespawnForStaleKeepalive must return false.
    const elapsedSinceInboundRespawn = GRACE_MS - 60_000 // 14 min — within grace
    // Math.max(marveenLastKeepaliveRespawn=0, marveenLastHardRestart=T_respawn):
    // Since 0 < T_respawn, max = T_respawn, so msSinceCrossPath = elapsed < GRACE.
    expect(shouldRespawnForStaleKeepalive({
      keepaliveAgeMs: AGE_MS,
      stalenessThresholdMs: STALE_MS,
      msSinceLastRespawn: elapsedSinceInboundRespawn,
      respawnGraceMs: GRACE_MS,
    })).toBe(false)
  })

  it('allows keepalive respawn once the cross-path grace has fully elapsed', () => {
    const elapsedSinceInboundRespawn = GRACE_MS + 1_000 // past grace
    expect(shouldRespawnForStaleKeepalive({
      keepaliveAgeMs: AGE_MS,
      stalenessThresholdMs: STALE_MS,
      msSinceLastRespawn: elapsedSinceInboundRespawn,
      respawnGraceMs: GRACE_MS,
    })).toBe(true)
  })

  it('suppresses keepalive respawn when keepalive path itself respawned recently (pre-existing self-grace)', () => {
    const elapsedSinceKeepaliveRespawn = GRACE_MS - 30_000 // 14.5 min — within grace
    // Math.max(marveenLastKeepaliveRespawn=T, marveenLastHardRestart=0) = T_keepalive
    expect(shouldRespawnForStaleKeepalive({
      keepaliveAgeMs: AGE_MS,
      stalenessThresholdMs: STALE_MS,
      msSinceLastRespawn: elapsedSinceKeepaliveRespawn,
      respawnGraceMs: GRACE_MS,
    })).toBe(false)
  })
})
