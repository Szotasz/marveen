import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { scopeChannelPlugins, CHANNEL_PLUGIN_IDS } from '../web/agent-process.js'

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
    const before = SRC.slice(Math.max(0, callIdx - 700), callIdx)
    expect(before).toMatch(/if \(name !== MAIN_AGENT_ID\) \{/)
  })

  it('an explicit telegram provider KEEPS telegram enabled (so a telegram main/agent is never disabled)', () => {
    const out = scopeChannelPlugins('telegram')
    expect(out[TG]).toBe(true)
  })
})
