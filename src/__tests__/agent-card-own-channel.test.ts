// The agent card's Online/Offline dot and the detail header must follow the
// agent's OWN channel (agent-config.json channelProvider, carried on the
// /api/agents summary), not the dashboard-wide provider. The helpers are
// evaluated OUT OF the shipped web/app.js (as activity-display-state.test.ts
// does), so a copy in the test cannot keep passing after the shipped code
// changed.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')
const ROUTES = readFileSync(join(__dirname, '../web/routes/agents.ts'), 'utf-8')

type Agent = Record<string, unknown> | null | undefined

type Helpers = {
  agentIsConnected: (agent: Agent) => boolean
  agentOwnChannelConnected: (agent: Agent) => boolean
}

// Each test picks the dashboard-wide provider via the parameter, the same
// role the real `currentChannelProvider` global plays in app.js.
function helpers(currentChannelProvider: string): Helpers {
  const flag = APP.match(/const AGENT_CHANNEL_FLAG = \{[\s\S]*?\n\}/)
  const isConnected = APP.match(/function agentIsConnected\(agent\) \{[\s\S]*?\n\}/)
  const ownConnected = APP.match(/function agentOwnChannelConnected\(agent\) \{[\s\S]*?\n\}/)
  // A missing piece must fail the test, not quietly produce a stub.
  if (!flag || !isConnected || !ownConnected) throw new Error('channel connected helpers not found in web/app.js')
  const code = `${flag[0]}\n\n${isConnected[0]}\n\n${ownConnected[0]}`
  return new Function('currentChannelProvider', `${code}; return { agentIsConnected, agentOwnChannelConnected }`)(currentChannelProvider)
}

// Call-site lines for `agentOwnChannelConnected(agent)`, ignoring the function
// definition itself (which also contains the literal text).
const ownAgentCalls = APP.split('\n')
  .filter((line) => line.includes('agentOwnChannelConnected(agent)') && !line.trimStart().startsWith('function '))

describe('agent own-channel connected', () => {
  it('a Teams sub-agent is online on its card while the dashboard provider is telegram', () => {
    const { agentIsConnected, agentOwnChannelConnected } = helpers('telegram')
    const agent = { channelProvider: 'teams', hasTelegram: false, hasTeams: true }
    expect(agentOwnChannelConnected(agent)).toBe(true)
    expect(agentIsConnected(agent)).toBe(false)
  })

  it('a Telegram sub-agent is online while the dashboard provider is teams', () => {
    const { agentOwnChannelConnected } = helpers('teams')
    expect(agentOwnChannelConnected({ channelProvider: 'telegram', hasTelegram: true, hasTeams: false })).toBe(true)
  })

  it('the own provider wins even when the answer is offline', () => {
    const { agentOwnChannelConnected } = helpers('telegram')
    expect(agentOwnChannelConnected({ channelProvider: 'slack', hasTelegram: true, hasSlack: false })).toBe(false)
  })

  it('unknown or unset own provider falls back to the dashboard-wide provider', () => {
    const { agentOwnChannelConnected } = helpers('telegram')
    for (const channelProvider of [null, undefined, '', 'none', 'bogus', 'constructor', '__proto__']) {
      expect(agentOwnChannelConnected({ channelProvider, hasTelegram: true })).toBe(true)
      expect(agentOwnChannelConnected({ channelProvider, hasTelegram: false })).toBe(false)
    }
  })

  it('the fallback is the dashboard-wide provider, not hasTelegram', () => {
    // With a non-telegram dashboard provider, falling back to hasTelegram and
    // falling back to the dashboard provider give different answers.
    const { agentOwnChannelConnected } = helpers('teams')
    for (const channelProvider of [null, undefined, '', 'none', 'bogus', 'constructor', '__proto__']) {
      expect(agentOwnChannelConnected({ channelProvider, hasTeams: true, hasTelegram: false })).toBe(true)
      expect(agentOwnChannelConnected({ channelProvider, hasTeams: false, hasTelegram: true })).toBe(false)
    }
  })

  it('every own provider in the table picks its own flag', () => {
    const { agentOwnChannelConnected } = helpers('telegram')
    expect(agentOwnChannelConnected({ channelProvider: 'discord', hasDiscord: true, hasTelegram: false })).toBe(true)
    expect(agentOwnChannelConnected({ channelProvider: 'discord', hasDiscord: false, hasTelegram: true })).toBe(false)
    expect(agentOwnChannelConnected({ channelProvider: 'googlechat', hasGooglechat: true, hasTelegram: false })).toBe(true)
    expect(agentOwnChannelConnected({ channelProvider: 'googlechat', hasGooglechat: false, hasTelegram: true })).toBe(false)
  })

  it('the Channel tab check keeps its old answers (a googlechat dashboard still reads hasTelegram)', () => {
    const { agentIsConnected, agentOwnChannelConnected } = helpers('googlechat')
    expect(agentIsConnected({ hasGooglechat: true, hasTelegram: false })).toBe(false)
    expect(agentIsConnected({ hasGooglechat: false, hasTelegram: true })).toBe(true)
    // no own provider -> the same answer as the Channel tab
    expect(agentOwnChannelConnected({ hasGooglechat: true, hasTelegram: false })).toBe(false)
    const tg = helpers('teams')
    expect(tg.agentIsConnected({ hasTeams: true, hasTelegram: false })).toBe(true)
    expect(tg.agentIsConnected({ hasTeams: false, hasTelegram: true })).toBe(false)
  })

  it('a null agent is disconnected everywhere', () => {
    const { agentIsConnected, agentOwnChannelConnected } = helpers('telegram')
    expect(agentIsConnected(null)).toBe(false)
    expect(agentOwnChannelConnected(null)).toBe(false)
  })
})

describe('agent own-channel wiring', () => {
  it('the card and detail header go through agentOwnChannelConnected, the Channel tab does not', () => {
    // Card render: exactly one call, and it is the line followed by chDotClass.
    expect(ownAgentCalls.length).toBe(1)
    expect(ownAgentCalls[0].trim()).toBe('const chConnected = agentOwnChannelConnected(agent)')
    expect(APP).toMatch(/const chConnected = agentOwnChannelConnected\(agent\)\n\s*const chDotClass/)
    // Detail header: exactly one call, and it feeds agentDetailChStatus.
    expect(APP.split('agentOwnChannelConnected(currentAgent)').length - 1).toBe(1)
    expect(APP).toMatch(/const chConnected = agentOwnChannelConnected\(currentAgent\)\n\s*document\.getElementById\('agentDetailChStatus'\)/)
    // The Channel tab keeps following its provider dropdown on purpose.
    expect(APP).toMatch(/reconnectBtn\.hidden = !\(currentAgent && currentAgent\.running && agentIsConnected\(currentAgent\)\)/)
    expect(APP).toMatch(/function updateChannelTab\(agent\) \{\n  const connected = agentIsConnected\(agent\)/)
  })

  it('the backend summary carries the agent own channelProvider', () => {
    const iface = ROUTES.match(/export interface AgentSummary \{[\s\S]*?\n\}/)
    if (!iface) throw new Error('AgentSummary interface not found in src/web/routes/agents.ts')
    expect(iface[0]).toContain('channelProvider: string | null')
    expect(ROUTES).toContain('channelProvider: readAgentChannelProvider(name),')
  })
})
