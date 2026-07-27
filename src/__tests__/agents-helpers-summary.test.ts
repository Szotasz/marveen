import { describe, it, expect, vi } from 'vitest'

vi.mock('../channel-provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../channel-provider.js')>()
  return {
    ...actual,
    channelStateDir: vi.fn().mockReturnValue('/tmp/channel-state'),
    readChannelToken: vi.fn().mockReturnValue(null),
  }
})
vi.mock('../vault.js', () => ({
  getSecret: vi.fn().mockReturnValue(null),
}))
vi.mock('../telegram.js', () => ({
  readAgentTelegramConfig: vi.fn().mockReturnValue({ hasTelegram: false }),
  readAgentDiscordConfig: vi.fn().mockReturnValue({ hasDiscord: false }),
  readAgentGooglechatConfig: vi.fn().mockReturnValue({ hasGooglechat: false }),
  readAgentTeamsConfig: vi.fn().mockReturnValue({ hasTeams: false }),
}))
vi.mock('../agent-process.js', () => ({
  agentRunState: vi.fn().mockReturnValue('stopped'),
  getAgentRunningSince: vi.fn().mockReturnValue(null),
  agentSessionName: vi.fn().mockImplementation((n: string) => `agent-${n}`),
  capturePane: vi.fn().mockReturnValue(null),
}))
vi.mock('../reauth-detect.js', () => ({
  detectReauthNeeded: vi.fn().mockReturnValue({ needsReauth: false }),
}))
vi.mock('../auto-restart-store.js', () => ({
  readAutoRestartConfig: vi.fn().mockReturnValue({ enabled: false, maxRestarts: 5 }),
}))
vi.mock('../active-model.js', () => ({
  readActiveModelFromProjectDir: vi.fn().mockReturnValue(null),
  readContextTokensFromProjectDir: vi.fn().mockReturnValue(null),
}))
vi.mock('../claude-plans.js', () => ({
  resolveAgentConfigDir: vi.fn().mockReturnValue({ configDir: null }),
}))
vi.mock('../agent-team.js', () => ({
  readAgentTeam: vi.fn().mockReturnValue({ members: [], reportsTo: null }),
}))
vi.mock('../web/remote-status-cache.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/remote-status-cache.js')>()
  return actual
})
vi.mock('../web/agent-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/agent-config.js')>()
  return {
    ...actual,
    agentDir: vi.fn().mockReturnValue('/tmp/fake-agent'),
    agentConfigRoot: vi.fn().mockReturnValue('/tmp/fake-agent-config'),
    readFileOr: vi.fn().mockReturnValue(''),
    readAgentModel: vi.fn().mockReturnValue('claude-sonnet-4-6'),
    readAgentDisplayName: vi.fn().mockReturnValue('Test Agent'),
    readAgentAuthMode: vi.fn().mockReturnValue('oauth'),
    readAgentSecurityProfile: vi.fn().mockReturnValue('default'),
    readAgentClaudePlan: vi.fn().mockReturnValue(null),
    readAgentMemoryIsolation: vi.fn().mockReturnValue(false),
    readAgentRemoteConfig: vi.fn().mockReturnValue({ host: null, workdir: null }),
    readAgentRemoteHost: vi.fn().mockReturnValue(null),
    findAvatarForAgent: vi.fn().mockReturnValue(null),
    extractDescriptionFromClaudeMd: vi.fn().mockReturnValue('A test agent'),
    listAgentNames: vi.fn().mockReturnValue(['rick', 'dave']),
    isKnownAgent: vi.fn().mockReturnValue(true),
  }
})

import { getAgentSummary, getAgentDetail, listAgentSummaries } from '../web/routes/agents-helpers.js'

describe('getAgentSummary', () => {
  it('returns a valid AgentSummary with expected structure', () => {
    const summary = getAgentSummary('rick')
    expect(summary).toBeDefined()
    expect(summary.name).toBe('rick')
    expect(typeof summary.running).toBe('boolean')
    expect(['stopped', 'running', 'unreachable']).toContain(summary.runState)
    expect(typeof summary.hasTelegram).toBe('boolean')
    expect(typeof summary.hasDiscord).toBe('boolean')
    expect(typeof summary.hasGooglechat).toBe('boolean')
    expect(typeof summary.hasTeams).toBe('boolean')
    expect(summary.needsReauth).toBe(false)
  })

  it('returns displayName from readAgentDisplayName', () => {
    const summary = getAgentSummary('rick')
    expect(summary.displayName).toBe('Test Agent')
  })

  it('returns model from readAgentModel', () => {
    const summary = getAgentSummary('rick')
    expect(summary.model).toBe('claude-sonnet-4-6')
  })

  it('returns status=draft when claudeMd and soulMd are empty', () => {
    const summary = getAgentSummary('rick')
    expect(summary.status).toBe('draft')
  })

  it('returns hasAvatar:false when findAvatarForAgent returns null', () => {
    const summary = getAgentSummary('rick')
    expect(summary.hasAvatar).toBe(false)
  })

  it('returns remoteHost:null for local agent', () => {
    const summary = getAgentSummary('rick')
    expect(summary.remoteHost).toBeNull()
    expect(summary.remoteWorkdir).toBeNull()
  })

  it('returns claudePlan:null when not set', () => {
    const summary = getAgentSummary('rick')
    expect(summary.claudePlan).toBeNull()
  })
})

describe('getAgentDetail', () => {
  it('returns AgentDetail extending AgentSummary', () => {
    const detail = getAgentDetail('rick')
    expect(detail).toBeDefined()
    expect(detail.name).toBe('rick')
    // AgentDetail-specific fields
    expect(detail.claudeMd).toBeDefined()
    expect(detail.soulMd).toBeDefined()
    expect(detail.mcpJson).toBeDefined()
    expect(Array.isArray(detail.skills)).toBe(true)
    expect(typeof detail.memoryIsolation).toBe('boolean')
    expect(typeof detail.hasApiKey).toBe('boolean')
  })

  it('returns empty skills array when skills dir does not exist', () => {
    const detail = getAgentDetail('rick')
    expect(detail.skills).toEqual([])
  })

  it('returns hasApiKey:false when no secret set', () => {
    const detail = getAgentDetail('rick')
    expect(detail.hasApiKey).toBe(false)
  })

  it('includes all AgentSummary fields', () => {
    const detail = getAgentDetail('dave')
    expect(typeof detail.running).toBe('boolean')
    expect(['stopped', 'running', 'unreachable']).toContain(detail.runState)
    expect(detail.autoRestart).toBeDefined()
  })
})

describe('listAgentSummaries', () => {
  it('returns an array of summaries for all agents', () => {
    const summaries = listAgentSummaries()
    expect(Array.isArray(summaries)).toBe(true)
    expect(summaries.length).toBe(2)
    expect(summaries[0].name).toBe('rick')
    expect(summaries[1].name).toBe('dave')
  })

  it('each summary has required fields', () => {
    const summaries = listAgentSummaries()
    for (const s of summaries) {
      expect(s.name).toBeTruthy()
      expect(typeof s.running).toBe('boolean')
      expect(typeof s.hasTelegram).toBe('boolean')
    }
  })
})
