import { describe, it, expect, vi, beforeEach } from 'vitest'

// All dependency mocks must be hoisted so they are in scope when the module
// under test is first imported. Keep mock factories pure (no closures over
// let variables at this level -- define them inside the factory or use
// vi.fn() references that tests override with mockReturnValue).

const mockSessionExistsOnHost = vi.fn<(host: string | null, session: string) => boolean>()
const mockStartAgentProcess = vi.fn<(name: string) => { ok: boolean; error?: string }>()
const mockRestartAgentProcess = vi.fn<(name: string) => { ok: boolean; error?: string }>()
const mockCapturePane = vi.fn<(session: string) => string | null>()
const mockDetectPaneState = vi.fn<(pane: string) => string>()
const mockGetDesiredAgents = vi.fn<() => Set<string>>()
const mockAddDesiredAgent = vi.fn<(name: string) => void>()
const mockReadAllAutoRestartConfigs = vi.fn<() => Record<string, { enabled: boolean }>>()
const mockListAgentNames = vi.fn<() => string[]>()

vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => `agent-${name}`,
  sessionExistsOnHost: (...args: [string | null, string]) => mockSessionExistsOnHost(...args),
  startAgentProcess: (name: string) => mockStartAgentProcess(name),
  restartAgentProcess: (name: string) => mockRestartAgentProcess(name),
  capturePane: (session: string) => mockCapturePane(session),
}))

vi.mock('../web/agent-desired-state.js', () => ({
  getDesiredAgents: () => mockGetDesiredAgents(),
  addDesiredAgent: (name: string) => mockAddDesiredAgent(name),
}))

vi.mock('../web/auto-restart-store.js', () => ({
  readAllAutoRestartConfigs: () => mockReadAllAutoRestartConfigs(),
}))

vi.mock('../web/agent-config.js', () => ({
  listAgentNames: () => mockListAgentNames(),
}))

vi.mock('../pane-state.js', () => ({
  detectPaneState: (pane: string) => mockDetectPaneState(pane),
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

import {
  tmuxSessionExists,
  probeAgentLiveness,
  reconcileAgentsOnStartup,
  flushRunningStateToDesired,
} from '../web/startup-reconciliation.js'

beforeEach(() => {
  vi.clearAllMocks()
  mockGetDesiredAgents.mockReturnValue(new Set())
  mockReadAllAutoRestartConfigs.mockReturnValue({})
  mockListAgentNames.mockReturnValue([])
  mockSessionExistsOnHost.mockReturnValue(false)
  mockCapturePane.mockReturnValue(null)
  mockDetectPaneState.mockReturnValue('idle')
  mockStartAgentProcess.mockReturnValue({ ok: true })
  mockRestartAgentProcess.mockReturnValue({ ok: true })
  mockAddDesiredAgent.mockReturnValue(undefined)
})

// ── tmuxSessionExists ────────────────────────────────────────────────────────

describe('tmuxSessionExists', () => {
  it('returns true when sessionExistsOnHost returns true', () => {
    mockSessionExistsOnHost.mockReturnValue(true)
    expect(tmuxSessionExists('agent-alpha')).toBe(true)
    expect(mockSessionExistsOnHost).toHaveBeenCalledWith(null, 'agent-alpha')
  })

  it('returns false when sessionExistsOnHost returns false', () => {
    mockSessionExistsOnHost.mockReturnValue(false)
    expect(tmuxSessionExists('agent-alpha')).toBe(false)
  })
})

// ── probeAgentLiveness ───────────────────────────────────────────────────────

describe('probeAgentLiveness', () => {
  it('returns stale when capturePane returns null', () => {
    mockCapturePane.mockReturnValue(null)
    expect(probeAgentLiveness('agent-a')).toBe('stale')
  })

  it('returns stale when capturePane returns empty string', () => {
    mockCapturePane.mockReturnValue('   ')
    expect(probeAgentLiveness('agent-a')).toBe('stale')
  })

  it.each(['idle', 'busy', 'typing'] as const)(
    'returns live for pane state %s',
    (state) => {
      mockCapturePane.mockReturnValue('some pane content')
      mockDetectPaneState.mockReturnValue(state)
      expect(probeAgentLiveness('agent-a')).toBe('live')
    },
  )

  it.each(['unknown', 'error'] as const)(
    'returns stale for pane state %s',
    (state) => {
      mockCapturePane.mockReturnValue('some pane content')
      mockDetectPaneState.mockReturnValue(state)
      expect(probeAgentLiveness('agent-a')).toBe('stale')
    },
  )

  it('passes the correct session name to capturePane', () => {
    mockCapturePane.mockReturnValue('pane')
    mockDetectPaneState.mockReturnValue('idle')
    probeAgentLiveness('agent-b')
    expect(mockCapturePane).toHaveBeenCalledWith('agent-agent-b')
  })
})

// ── reconcileAgentsOnStartup ─────────────────────────────────────────────────

describe('reconcileAgentsOnStartup', () => {
  it('skips without calling start when no desired agents and no autoRestart configs', async () => {
    mockGetDesiredAgents.mockReturnValue(new Set())
    mockReadAllAutoRestartConfigs.mockReturnValue({})
    await reconcileAgentsOnStartup()
    expect(mockStartAgentProcess).not.toHaveBeenCalled()
    expect(mockRestartAgentProcess).not.toHaveBeenCalled()
  })

  it('reconnects a live existing session without launching a new one', async () => {
    mockGetDesiredAgents.mockReturnValue(new Set(['agent-a']))
    mockSessionExistsOnHost.mockReturnValue(true)
    mockCapturePane.mockReturnValue('pane content')
    mockDetectPaneState.mockReturnValue('idle')

    await reconcileAgentsOnStartup()

    expect(mockStartAgentProcess).not.toHaveBeenCalled()
    expect(mockRestartAgentProcess).not.toHaveBeenCalled()
  })

  it('calls addDesiredAgent for a reconnected session not already in desired set', async () => {
    // Agent with autoRestart but not in desired set; session is alive and live.
    mockGetDesiredAgents.mockReturnValue(new Set())
    mockReadAllAutoRestartConfigs.mockReturnValue({ 'agent-a': { enabled: true } })
    mockSessionExistsOnHost.mockReturnValue(true)
    mockCapturePane.mockReturnValue('pane content')
    mockDetectPaneState.mockReturnValue('busy')

    await reconcileAgentsOnStartup()

    expect(mockAddDesiredAgent).toHaveBeenCalledWith('agent-a')
    expect(mockStartAgentProcess).not.toHaveBeenCalled()
  })

  it('restarts a stale session (session exists but CC not responsive)', async () => {
    mockGetDesiredAgents.mockReturnValue(new Set(['agent-a']))
    mockSessionExistsOnHost.mockReturnValue(true)
    mockCapturePane.mockReturnValue('pane content')
    mockDetectPaneState.mockReturnValue('unknown')

    await reconcileAgentsOnStartup()

    expect(mockRestartAgentProcess).toHaveBeenCalledWith('agent-a')
    expect(mockStartAgentProcess).not.toHaveBeenCalled()
  })

  it('launches a desired agent whose session is gone', async () => {
    mockGetDesiredAgents.mockReturnValue(new Set(['agent-a']))
    mockSessionExistsOnHost.mockReturnValue(false)

    await reconcileAgentsOnStartup()

    expect(mockStartAgentProcess).toHaveBeenCalledWith('agent-a')
    expect(mockRestartAgentProcess).not.toHaveBeenCalled()
  })

  it('launches an autoRestart-enabled agent whose session is gone', async () => {
    mockGetDesiredAgents.mockReturnValue(new Set())
    mockReadAllAutoRestartConfigs.mockReturnValue({ 'agent-b': { enabled: true } })
    mockSessionExistsOnHost.mockReturnValue(false)

    await reconcileAgentsOnStartup()

    expect(mockStartAgentProcess).toHaveBeenCalledWith('agent-b')
  })

  it('skips an agent that is not desired and has no autoRestart', async () => {
    mockGetDesiredAgents.mockReturnValue(new Set())
    mockReadAllAutoRestartConfigs.mockReturnValue({ 'agent-c': { enabled: false } })
    mockSessionExistsOnHost.mockReturnValue(false)

    await reconcileAgentsOnStartup()

    expect(mockStartAgentProcess).not.toHaveBeenCalled()
  })

  it('handles startAgentProcess "already running" race gracefully', async () => {
    mockGetDesiredAgents.mockReturnValue(new Set(['agent-a']))
    mockSessionExistsOnHost.mockReturnValue(false)
    mockStartAgentProcess.mockReturnValue({ ok: false, error: 'Agent is already running' })

    await expect(reconcileAgentsOnStartup()).resolves.not.toThrow()
  })

  it('handles a throwing startAgentProcess without propagating', async () => {
    mockGetDesiredAgents.mockReturnValue(new Set(['agent-a']))
    mockSessionExistsOnHost.mockReturnValue(false)
    mockStartAgentProcess.mockImplementation(() => { throw new Error('tmux failed') })

    await expect(reconcileAgentsOnStartup()).resolves.not.toThrow()
  })

  it('processes multiple agents independently', async () => {
    mockGetDesiredAgents.mockReturnValue(new Set(['agent-a', 'agent-b']))
    // agent-a: session alive + live -> reconnect
    // agent-b: session gone -> launch
    mockSessionExistsOnHost.mockImplementation((_host, session) => session === 'agent-agent-a')
    mockCapturePane.mockReturnValue('pane')
    mockDetectPaneState.mockReturnValue('idle')

    await reconcileAgentsOnStartup()

    expect(mockStartAgentProcess).toHaveBeenCalledWith('agent-b')
    expect(mockStartAgentProcess).not.toHaveBeenCalledWith('agent-a')
    expect(mockRestartAgentProcess).not.toHaveBeenCalled()
  })
})

// ── flushRunningStateToDesired ───────────────────────────────────────────────

describe('flushRunningStateToDesired', () => {
  it('adds a running agent that is absent from desired set', () => {
    mockListAgentNames.mockReturnValue(['agent-a'])
    mockGetDesiredAgents.mockReturnValue(new Set())
    mockSessionExistsOnHost.mockReturnValue(true)

    flushRunningStateToDesired()

    expect(mockAddDesiredAgent).toHaveBeenCalledWith('agent-a')
  })

  it('does not add an already-desired running agent', () => {
    mockListAgentNames.mockReturnValue(['agent-a'])
    mockGetDesiredAgents.mockReturnValue(new Set(['agent-a']))
    mockSessionExistsOnHost.mockReturnValue(true)

    flushRunningStateToDesired()

    expect(mockAddDesiredAgent).not.toHaveBeenCalled()
  })

  it('does not add a stopped agent', () => {
    mockListAgentNames.mockReturnValue(['agent-a'])
    mockGetDesiredAgents.mockReturnValue(new Set())
    mockSessionExistsOnHost.mockReturnValue(false)

    flushRunningStateToDesired()

    expect(mockAddDesiredAgent).not.toHaveBeenCalled()
  })

  it('does not throw if sessionExistsOnHost throws', () => {
    mockListAgentNames.mockReturnValue(['agent-a'])
    mockGetDesiredAgents.mockReturnValue(new Set())
    mockSessionExistsOnHost.mockImplementation(() => { throw new Error('tmux error') })

    expect(() => flushRunningStateToDesired()).not.toThrow()
  })

  it('handles multiple agents correctly', () => {
    mockListAgentNames.mockReturnValue(['agent-a', 'agent-b', 'agent-c'])
    mockGetDesiredAgents.mockReturnValue(new Set(['agent-b']))
    // agent-a: running, not desired -> add
    // agent-b: running, already desired -> skip
    // agent-c: stopped -> skip
    mockSessionExistsOnHost.mockImplementation((_host, session) => session !== 'agent-agent-c')

    flushRunningStateToDesired()

    expect(mockAddDesiredAgent).toHaveBeenCalledWith('agent-a')
    expect(mockAddDesiredAgent).not.toHaveBeenCalledWith('agent-b')
    expect(mockAddDesiredAgent).not.toHaveBeenCalledWith('agent-c')
  })
})
