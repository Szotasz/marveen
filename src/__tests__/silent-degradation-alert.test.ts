import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { shouldAlertSharedConfigCollision } from '../web/agent-process.js'

// H1 silent-degradation hardening. When the fleet OAuth token is missing,
// channel sub-agents fall back to the shared ~/.claude. One agent is fine; two
// or more collide on the single plugin-install slot and silently go deaf. This
// locks the decision that turns that previously WARN-only degradation into a
// loud operator alert -- and, crucially, that a PRESENT token never alerts no
// matter how many channel agents run.

describe('shouldAlertSharedConfigCollision', () => {
  it('alerts when the token is missing and >1 channel sub-agent shares ~/.claude', () => {
    expect(shouldAlertSharedConfigCollision(false, 2)).toBe(true)
    expect(shouldAlertSharedConfigCollision(false, 5)).toBe(true)
  })

  it('does NOT alert for a single channel sub-agent (it owns the shared dir)', () => {
    expect(shouldAlertSharedConfigCollision(false, 1)).toBe(false)
  })

  it('does NOT alert when there are no channel sub-agents', () => {
    expect(shouldAlertSharedConfigCollision(false, 0)).toBe(false)
  })

  it('never alerts when the token is present, regardless of agent count', () => {
    expect(shouldAlertSharedConfigCollision(true, 0)).toBe(false)
    expect(shouldAlertSharedConfigCollision(true, 1)).toBe(false)
    expect(shouldAlertSharedConfigCollision(true, 99)).toBe(false)
  })

  it('threshold is strict (exactly one does not alert, two does)', () => {
    expect(shouldAlertSharedConfigCollision(false, 1)).toBe(false)
    expect(shouldAlertSharedConfigCollision(false, 2)).toBe(true)
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

  it('counts channel sub-agents excluding the main agent', () => {
    expect(SRC).toMatch(/n !== MAIN_AGENT_ID && agentHasChannel\(n\)/)
  })
})
