import { describe, it, expect } from 'vitest'
import {
  renderHeartbeatClaudeMd,
  shouldBootHeartbeatAgent,
  type HeartbeatIdentity,
} from '../web/heartbeat-agent-scaffold.js'

// A fully generic identity -- no real deployment values. The renderer is
// pure, so every operator-specific string in its output must trace back to
// one of these fields.
const ID: HeartbeatIdentity = {
  ownerName: 'Nina',
  botName: 'Helios',
  mainAgentId: 'helios',
  storeDir: '/srv/app/store',
  dashboardOrigin: 'http://localhost:3420',
  calendarAccount: 'nina@example.com',
}

describe('renderHeartbeatClaudeMd', () => {
  it('threads the owner name into the role + hard rules', () => {
    const out = renderHeartbeatClaudeMd(ID)
    expect(out).toContain("across Nina's systems")
    expect(out).toContain('you NEVER contact Nina directly')
  })

  it('names the main agent as the relay target by display name', () => {
    const out = renderHeartbeatClaudeMd(ID)
    expect(out).toContain('hand the result to the main agent (Helios)')
  })

  it('routes the inter-agent message to the main agent id', () => {
    const out = renderHeartbeatClaudeMd(ID)
    expect(out).toContain('"to":"helios"')
    // The sender is always the fixed heartbeat agent id.
    expect(out).toContain('"from":"heartbeat"')
  })

  it('uses the supplied store dir (absolute) for the DB and token paths', () => {
    const out = renderHeartbeatClaudeMd(ID)
    expect(out).toContain('/srv/app/store/claudeclaw.db')
    expect(out).toContain('cat /srv/app/store/.dashboard-token')
  })

  it('uses the supplied dashboard origin for the messages API', () => {
    const out = renderHeartbeatClaudeMd(ID)
    expect(out).toContain('http://localhost:3420/api/messages')
  })

  it('targets the configured calendar account when one is set', () => {
    const out = renderHeartbeatClaudeMd(ID)
    expect(out).toContain('against `nina@example.com`')
  })

  it('falls back to the MCP primary calendar when no account is set', () => {
    const out = renderHeartbeatClaudeMd({ ...ID, calendarAccount: '' })
    expect(out).toContain('your primary calendar')
    // No dangling "against `<empty>`" -- the empty case must not emit a
    // backtick-quoted account at all.
    expect(out).not.toContain('against `')
    // The empty account is the shipped default, so the rendered file must
    // then carry no email address whatsoever.
    expect(out.match(/[\w.+-]+@[\w.-]+/g) ?? []).toEqual([])
  })

  it('emits no email beyond the configured calendar account', () => {
    const out = renderHeartbeatClaudeMd(ID)
    // The configured account is the ONLY address allowed in the output;
    // a previously hardcoded personal address would add a second one.
    const emails = out.match(/[\w.+-]+@[\w.-]+/g) ?? []
    expect(emails).toEqual(['nina@example.com'])
  })

  it('emits no absolute path outside the supplied store dir', () => {
    const out = renderHeartbeatClaudeMd(ID)
    // The generic identity uses /srv/app/store; any leftover home-dir
    // hardcode would surface as a /Users/ or /home/ path.
    expect(out).not.toMatch(/\/Users\//)
    expect(out).not.toMatch(/\/home\//)
  })

  it('carries no upstream default identity beyond the params', () => {
    const out = renderHeartbeatClaudeMd(ID)
    // With a non-default owner/bot, the upstream default names must not
    // leak through from any hardcoded string.
    expect(out).not.toMatch(/Szabolcs|Szabi|Marveen/)
  })

  it('contains no em-dash (project style rule)', () => {
    const out = renderHeartbeatClaudeMd(ID)
    // Build the em-dash (U+2014) via fromCharCode so this source file
    // itself stays em-dash-free.
    expect(out).not.toContain(String.fromCharCode(0x2014))
  })

  it('preserves the no-outbound-channel hard contract', () => {
    const out = renderHeartbeatClaudeMd(ID)
    expect(out).toContain('**NEVER** call `reply` / Telegram / Slack tools.')
    expect(out).toContain('You are headless')
  })

  it('is fully driven by the identity -- distinct configs render distinctly', () => {
    const a = renderHeartbeatClaudeMd(ID)
    const b = renderHeartbeatClaudeMd({
      ownerName: 'Omar',
      botName: 'Atlas',
      mainAgentId: 'atlas',
      storeDir: '/data/store',
      dashboardOrigin: 'http://localhost:9000',
      calendarAccount: '',
    })
    expect(a).not.toBe(b)
    expect(b).toContain("across Omar's systems")
    expect(b).toContain('"to":"atlas"')
    expect(b).toContain('/data/store/claudeclaw.db')
    expect(b).toContain('http://localhost:9000/api/messages')
  })
})

describe('shouldBootHeartbeatAgent', () => {
  it('boots only when respawn-enabled AND agent-enabled', () => {
    expect(shouldBootHeartbeatAgent({ respawnEnabled: true, agentEnabled: true })).toBe(true)
  })

  it('does not boot when the agent is not opted in (default off)', () => {
    expect(shouldBootHeartbeatAgent({ respawnEnabled: true, agentEnabled: false })).toBe(false)
  })

  it('does not boot on a respawn-gated-off host even if opted in', () => {
    expect(shouldBootHeartbeatAgent({ respawnEnabled: false, agentEnabled: true })).toBe(false)
  })

  it('does not boot when both gates are off', () => {
    expect(shouldBootHeartbeatAgent({ respawnEnabled: false, agentEnabled: false })).toBe(false)
  })
})
