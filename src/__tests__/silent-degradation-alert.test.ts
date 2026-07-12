import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  shouldAlertSharedConfigCollision,
  maxSameProviderContenders,
} from '../web/agent-process.js'

// H1 silent-degradation hardening. When the fleet OAuth token is missing,
// channel sub-agents fall back to the shared ~/.claude. One agent per provider
// slot is fine; two or more RUNNING agents on the SAME provider contend for
// that provider's single plugin-install slot. 2026-07-10 refinement: the
// original decision counted CONFIGURED agents across ALL providers and fired
// on macOS where the collision demonstrably does not manifest -- it cried
// wolf. These tests lock the refined decision: running-only, per-provider,
// platform-aware -- and, crucially, that a PRESENT token never alerts.

describe('shouldAlertSharedConfigCollision', () => {
  it('alerts on Linux when the token is missing and >1 same-provider agent runs', () => {
    expect(shouldAlertSharedConfigCollision(false, 2, 'linux')).toBe(true)
    expect(shouldAlertSharedConfigCollision(false, 5, 'linux')).toBe(true)
  })

  it('never alerts on macOS, regardless of count (collision empirically absent there)', () => {
    // 2026-07-10 origin-host verification: three concurrent telegram pollers
    // (main + two sub-agents, own tokens, live bun server.ts each) on the
    // shared ~/.claude -- no eviction, no deaf bot. Keychain auth also removes
    // the Linux credentials-refresh motive.
    expect(shouldAlertSharedConfigCollision(false, 2, 'darwin')).toBe(false)
    expect(shouldAlertSharedConfigCollision(false, 6, 'darwin')).toBe(false)
  })

  it('does NOT alert for a single same-provider agent (it owns the slot)', () => {
    expect(shouldAlertSharedConfigCollision(false, 1, 'linux')).toBe(false)
  })

  it('does NOT alert when there are no channel sub-agents', () => {
    expect(shouldAlertSharedConfigCollision(false, 0, 'linux')).toBe(false)
  })

  it('never alerts when the token is present, regardless of agent count', () => {
    expect(shouldAlertSharedConfigCollision(true, 0, 'linux')).toBe(false)
    expect(shouldAlertSharedConfigCollision(true, 1, 'linux')).toBe(false)
    expect(shouldAlertSharedConfigCollision(true, 99, 'linux')).toBe(false)
  })

  it('threshold is strict (exactly one does not alert, two does) on Linux', () => {
    expect(shouldAlertSharedConfigCollision(false, 1, 'linux')).toBe(false)
    expect(shouldAlertSharedConfigCollision(false, 2, 'linux')).toBe(true)
  })
})

describe('maxSameProviderContenders', () => {
  // The origin-host fleet shape that triggered the false alarm: 6 configured
  // channel sub-agents, but only 2 running on telegram + 1 running on teams.
  const originFleet = [
    { provider: 'telegram', running: true, hasChannel: true }, // boni
    { provider: 'telegram', running: false, hasChannel: true }, // deeper
    { provider: 'telegram', running: false, hasChannel: true }, // iris
    { provider: 'telegram', running: true, hasChannel: true }, // samu
    { provider: 'teams', running: true, hasChannel: true }, // teamer
    { provider: 'telegram', running: false, hasChannel: true }, // zara
  ]

  it('counts only RUNNING agents: 6 configured / 2 running telegram -> 2, not 6', () => {
    expect(maxSameProviderContenders(originFleet)).toBe(2)
  })

  it('with the refined count, the origin fleet does NOT alert on macOS', () => {
    const count = maxSameProviderContenders(originFleet)
    expect(shouldAlertSharedConfigCollision(false, count, 'darwin')).toBe(false)
  })

  it('a real Linux multi-bot collision (2 running same-provider) STILL alerts', () => {
    const linuxFleet = [
      { provider: 'telegram', running: true, hasChannel: true },
      { provider: 'telegram', running: true, hasChannel: true },
      { provider: 'telegram', running: false, hasChannel: true },
    ]
    const count = maxSameProviderContenders(linuxFleet)
    expect(count).toBe(2)
    expect(shouldAlertSharedConfigCollision(false, count, 'linux')).toBe(true)
  })

  it('different providers occupy different slots: telegram + teams do not collide', () => {
    const mixed = [
      { provider: 'telegram', running: true, hasChannel: true },
      { provider: 'teams', running: true, hasChannel: true },
    ]
    expect(maxSameProviderContenders(mixed)).toBe(1)
    expect(shouldAlertSharedConfigCollision(false, maxSameProviderContenders(mixed), 'linux')).toBe(false)
  })

  it('channel-less agents never count, running or not', () => {
    const fleet = [
      { provider: 'telegram', running: true, hasChannel: false },
      { provider: 'telegram', running: true, hasChannel: false },
      { provider: 'telegram', running: true, hasChannel: true },
    ]
    expect(maxSameProviderContenders(fleet)).toBe(1)
  })

  it('empty fleet -> 0', () => {
    expect(maxSameProviderContenders([])).toBe(0)
  })
})

// Source-level contract for the launcher wiring, mirroring the
// isolated-channel-config.test.ts approach: assert the loud-alert path is
// actually wired into the token-absent branch and that it re-arms when the
// token returns.
const SRC = readFileSync(join(__dirname, '../web/agent-process.ts'), 'utf-8')

describe('silent-degradation alert wiring', () => {
  it('routes the alert through notifyChannel (direct Bot API, not the inter-agent relay)', () => {
    expect(SRC).toMatch(/import \{ notifyChannel \} from '\.\.\/notify\.js'/)
    expect(SRC).toMatch(/notifyChannel\(/)
  })

  it('fires the loud alert from the token-ABSENT branch', () => {
    expect(SRC).toMatch(/maybeAlertSharedConfigCollision\(name\)/)
  })

  it('re-arms the one-shot alert when the token reappears', () => {
    expect(SRC).toMatch(/resetSharedConfigCollisionAlert\(\)/)
  })

  it('counts contenders from live run state, excluding the main agent', () => {
    expect(SRC).toMatch(/countSameProviderChannelContenders\(name\)/)
    expect(SRC).toMatch(/\.filter\(\(n\) => n !== MAIN_AGENT_ID\)/)
    expect(SRC).toMatch(/n === startingName \|\| agentRunState\(n\) === 'running'/)
  })

  it('the platform guard is process.platform-based, not host-specific', () => {
    expect(SRC).toMatch(/platform: NodeJS\.Platform = process\.platform/)
    expect(SRC).not.toMatch(/os\.hostname/)
  })
})
