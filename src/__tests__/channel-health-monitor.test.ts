import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
  execSync: vi.fn(),
}))

vi.mock('../platform.js', () => ({
  resolveFromPath: (name: string) => `/usr/local/bin/${name}`,
}))

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('../config.js', () => ({
  MAIN_AGENT_ID: 'marveen',
  CHANNEL_PROVIDER: 'telegram',
  PROJECT_ROOT: '/tmp/test-claudeclaw',
}))

vi.mock('../web/agent-config.js', () => ({
  listAgentNames: () => ['samu'],
  readAgentChannelProvider: () => 'telegram',
  AGENTS_BASE_DIR: '/tmp/test-claudeclaw/agents',
}))

const mockCapturePane = vi.fn<(session: string) => string | null>()
vi.mock('../web/agent-process.js', () => ({
  isAgentRunning: (name: string) => name === 'samu',
  capturePane: (session: string) => mockCapturePane(session),
  agentSessionName: (name: string) => `agent-${name}`,
}))

vi.mock('../web/main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: 'marveen-channels',
}))

const mockReconnect = vi.fn()
vi.mock('../web/channel-mcp-reconnect.js', () => ({
  attemptChannelMcpReconnect: (name: string) => mockReconnect(name),
  resolveAgentSession: (name: string) => name === 'marveen' ? 'marveen-channels' : `agent-${name}`,
  resolveAgentProviderType: () => 'telegram' as const,
}))

vi.mock('../channel-provider.js', () => ({
  getProvider: () => ({
    pluginId: 'telegram@claude-plugins-official',
    pluginPaneId: 'plugin:telegram:telegram',
  }),
}))

import { getChannelHealth, startChannelHealthMonitor } from '../web/channel-health-monitor.js'

describe('getChannelHealth', () => {
  it('returns healthy when no reconnect state exists', () => {
    const health = getChannelHealth('unknown-agent')
    expect(health.healthy).toBe(true)
    expect(health.reconnectAttempts).toBe(0)
    expect(health.lastAttemptAt).toBeNull()
  })
})

describe('startChannelHealthMonitor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns a timer handle', () => {
    const timer = startChannelHealthMonitor()
    expect(timer).toBeDefined()
    clearInterval(timer)
  })

  it('does not reconnect when pane shows no failure', () => {
    const timer = startChannelHealthMonitor()
    mockCapturePane.mockReturnValue('normal pane content with plugin:telegram:telegram active')

    vi.advanceTimersByTime(46_000)

    expect(mockReconnect).not.toHaveBeenCalled()
    clearInterval(timer)
  })

  it('triggers reconnect when pane shows plugin failure', () => {
    mockReconnect.mockReturnValue({ ok: false, message: 'test' })
    const timer = startChannelHealthMonitor()
    mockCapturePane.mockReturnValue(
      'plugin:telegram:telegram  ✘ failed\nsome other output',
    )

    vi.advanceTimersByTime(46_000)

    expect(mockReconnect).toHaveBeenCalled()
    clearInterval(timer)
  })
})
