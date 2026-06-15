import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { scopeChannelPlugins, ownChannelProviderForScope, CHANNEL_PLUGIN_IDS } from '../web/agent-process.js'

const TG = CHANNEL_PLUGIN_IDS.telegram     // telegram@claude-plugins-official
const SL = CHANNEL_PLUGIN_IDS.slack        // slack-channel@marveen-marketplace
const DI = CHANNEL_PLUGIN_IDS.discord      // discord@claude-plugins-official

// scopeChannelPlugins keys on the EXPLICIT per-agent channelProvider (null when
// unset). This is the crux: a channel-less sub-agent (boni/deeper/iris/zara/samu)
// has channelProvider=null even though resolveAgentProvider would default it to
// telegram -- so it MUST disable telegram. Only an agent that declares its
// channel (e.g. slacker=slack) keeps its own plugin.
describe('scopeChannelPlugins', () => {
  it('channel-less sub-agent (explicit provider null) disables ALL three -- the dup-poller fix', () => {
    const out = scopeChannelPlugins(null)
    expect(out[TG]).toBe(false)
    expect(out[SL]).toBe(false)
    expect(out[DI]).toBe(false)
  })

  it('a channel-less agent that still carried a stale telegram:true gets it forced OFF', () => {
    // The exact respawn regression: a leaked/defaulted telegram:true must not
    // survive for an agent whose explicit provider is null.
    const out = scopeChannelPlugins(null, { [TG]: true })
    expect(out[TG]).toBe(false)
  })

  it('a slack agent (explicit slack) enables ONLY slack, disables telegram + discord', () => {
    const out = scopeChannelPlugins('slack', { [TG]: true })
    expect(out[SL]).toBe(true)
    expect(out[TG]).toBe(false)
    expect(out[DI]).toBe(false)
  })

  it('a telegram agent (explicit telegram) enables ONLY telegram', () => {
    const out = scopeChannelPlugins('telegram')
    expect(out[TG]).toBe(true)
    expect(out[SL]).toBe(false)
    expect(out[DI]).toBe(false)
  })

  it('preserves unrelated (non-channel) plugins untouched', () => {
    const out = scopeChannelPlugins(null, {
      'frontend-design@claude-plugins-official': true,
      [TG]: true,
    })
    expect(out['frontend-design@claude-plugins-official']).toBe(true)
    expect(out[TG]).toBe(false)
  })

  it('an unknown explicit provider disables all (no own plugin to enable)', () => {
    const out = scopeChannelPlugins('mystery')
    expect(out[TG]).toBe(false)
    expect(out[SL]).toBe(false)
    expect(out[DI]).toBe(false)
  })

  it('does not mutate the passed-in object', () => {
    const existing = { [TG]: true }
    scopeChannelPlugins('slack', existing)
    expect(existing[TG]).toBe(true) // unchanged
  })
})

// CATASTROPHE-BRANCH regression guard: the spawn-time plugin scoping must NEVER
// run for the MAIN agent, or scopeChannelPlugins(null) would disable the owner's
// telegram channel (Szabi's primary line). marveen is structurally outside this
// path (not in agents/, launched via channels.sh), but this locks the explicit
// guard so a future refactor cannot regress it.
describe('main-agent telegram channel is protected from spawn-time scoping', () => {
  const SRC = readFileSync(join(__dirname, '../web/agent-process.ts'), 'utf-8')

  it('the spawn-time scoping block is guarded by name !== MAIN_AGENT_ID', () => {
    // The scopeChannelPlugins call must sit inside an `if (name !== MAIN_AGENT_ID)`.
    const callIdx = SRC.indexOf('s.enabledPlugins = scopeChannelPlugins(')
    expect(callIdx).toBeGreaterThan(0)
    // Window spans the guard-open `if`, the settings read, and the explanatory
    // comment block that precedes the call (~600 chars), so keep it generous.
    const before = SRC.slice(Math.max(0, callIdx - 1500), callIdx)
    expect(before).toMatch(/if \(name !== MAIN_AGENT_ID\) \{/)
  })

  it('an explicit telegram provider KEEPS telegram enabled (so a telegram main/agent is never disabled)', () => {
    const out = scopeChannelPlugins('telegram')
    expect(out[TG]).toBe(true)
  })
})

// The spawn-time enable decision must match the --channels launch gate: the
// presence of a REAL own bot token in the agent's own channel .env -- NOT the
// explicit channelProvider config field (null for every sub-agent). This fixes
// the regression that left a legitimately-channelled sub-agent's plugin "truly
// unreachable" (loaded by --channels but disabled in settings -> no bun poller,
// no bot.pid) after any respawn.
describe('ownChannelProviderForScope', () => {
  it('own token + telegram provider -> telegram (plugin stays enabled)', () => {
    expect(ownChannelProviderForScope(true, 'telegram')).toBe('telegram')
  })

  it('own token + slack provider -> slack', () => {
    expect(ownChannelProviderForScope(true, 'slack')).toBe('slack')
  })

  it('NO own token (channel-less / legacy-fallback only) + telegram -> null', () => {
    // A channel-less agent is defaulted to telegram and a legacy token marks
    // hasChannel, but it has no OWN token -> must stay channel-less (dup-poller fix).
    expect(ownChannelProviderForScope(false, 'telegram')).toBeNull()
  })

  it('no own token + null provider -> null', () => {
    expect(ownChannelProviderForScope(false, null)).toBeNull()
  })

  it('own token but null resolved provider -> null (nothing to enable)', () => {
    expect(ownChannelProviderForScope(true, null)).toBeNull()
  })
})

// End-to-end of the spawn-time decision: the own-token gate feeds scopeChannelPlugins.
describe('spawn-time enable decision (ownChannelProviderForScope + scopeChannelPlugins)', () => {
  it('own-token telegram sub-agent KEEPS its plugin enabled (regression fix)', () => {
    const out = scopeChannelPlugins(ownChannelProviderForScope(true, 'telegram'), { [TG]: true })
    expect(out[TG]).toBe(true)
    expect(out[SL]).toBe(false)
    expect(out[DI]).toBe(false)
  })

  it('a stale telegram:true on a token-less agent is still forced OFF', () => {
    const out = scopeChannelPlugins(ownChannelProviderForScope(false, 'telegram'), { [TG]: true })
    expect(out[TG]).toBe(false)
  })

  it('own-token slack sub-agent enables ONLY slack', () => {
    const out = scopeChannelPlugins(ownChannelProviderForScope(true, 'slack'), { [TG]: true })
    expect(out[SL]).toBe(true)
    expect(out[TG]).toBe(false)
    expect(out[DI]).toBe(false)
  })
})

// REGRESSION LOCK: the spawn-time scoping must feed scopeChannelPlugins from the
// own-token gate (ownChannelProviderForScope), NOT from readAgentChannelProvider
// (the explicit channelProvider field, null for every sub-agent), which disabled
// the plugin for legitimately-channelled sub-agents.
describe('spawn-time scoping is gated on the own token, not the explicit provider field', () => {
  const SRC = readFileSync(join(__dirname, '../web/agent-process.ts'), 'utf-8')

  it('the scopeChannelPlugins call argument is ownChannelProviderForScope(...)', () => {
    const callIdx = SRC.indexOf('s.enabledPlugins = scopeChannelPlugins(')
    expect(callIdx).toBeGreaterThan(0)
    const arg = SRC.slice(callIdx, callIdx + 120)
    expect(arg).toMatch(/ownChannelProviderForScope\(/)
    expect(arg).not.toMatch(/readAgentChannelProvider\(/)
  })
})
