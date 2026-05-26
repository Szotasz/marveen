import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockExecFileSync = vi.fn()
vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
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
  readAgentChannelProvider: (name: string) => name === 'slacker' ? 'slack' : '',
  AGENTS_BASE_DIR: '/tmp/test-claudeclaw/agents',
}))

const mockCapturePane = vi.fn<(session: string) => string | null>()
vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => `agent-${name}`,
  capturePane: (session: string) => mockCapturePane(session),
}))

vi.mock('../web/main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: 'marveen-channels',
}))

vi.mock('../channel-provider.js', () => ({
  getProvider: (type: string) => ({
    pluginId: type === 'slack'
      ? 'slack-channel@marveen-marketplace'
      : 'telegram@claude-plugins-official',
    pluginPaneId: type === 'slack'
      ? 'plugin:slack-channel:marveen-marketplace'
      : 'plugin:telegram:telegram',
  }),
}))

import {
  attemptChannelMcpReconnect,
  resolveAgentSession,
  resolveAgentProviderType,
} from '../web/channel-mcp-reconnect.js'

describe('resolveAgentSession', () => {
  it('returns main channels session for main agent', () => {
    expect(resolveAgentSession('marveen')).toBe('marveen-channels')
  })

  it('returns agent-NAME for sub-agents', () => {
    expect(resolveAgentSession('samu')).toBe('agent-samu')
    expect(resolveAgentSession('zara')).toBe('agent-zara')
  })
})

describe('resolveAgentProviderType', () => {
  it('returns configured provider for agent with explicit config', () => {
    expect(resolveAgentProviderType('slacker')).toBe('slack')
  })

  it('falls back to CHANNEL_PROVIDER for unconfigured agents', () => {
    expect(resolveAgentProviderType('samu')).toBe('telegram')
  })
})

describe('attemptChannelMcpReconnect', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns ok:true when plugin submenu is found on first Up', () => {
    mockCapturePane
      .mockReturnValueOnce('/mcp menu content')
      .mockReturnValueOnce('some content with plugin:telegram:telegram listed')

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(true)
    expect(result.message).toContain('Up x1')
    expect(mockExecFileSync).toHaveBeenCalledWith(
      '/usr/local/bin/tmux',
      ['send-keys', '-t', 'marveen-channels', '/mcp', 'Enter'],
      expect.any(Object),
    )
  })

  it('returns ok:true when plugin found on third Up', () => {
    mockCapturePane
      .mockReturnValueOnce('/mcp menu')
      .mockReturnValueOnce('no match')
      .mockReturnValueOnce('no match')
      .mockReturnValueOnce('plugin:telegram:telegram here')

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(true)
    expect(result.message).toContain('Up x3')
  })

  it('returns ok:false when capture fails after /mcp', () => {
    mockCapturePane.mockReturnValueOnce(null)

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('capture')
  })

  it('returns ok:false when plugin not found within max attempts', () => {
    mockCapturePane.mockReturnValueOnce('/mcp menu')
    for (let i = 0; i < 8; i++) {
      mockCapturePane.mockReturnValueOnce('no match here')
    }

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('not found')
  })

  it('uses correct session for sub-agents', () => {
    mockCapturePane
      .mockReturnValueOnce('/mcp')
      .mockReturnValueOnce('plugin:slack-channel:marveen-marketplace found')

    attemptChannelMcpReconnect('slacker')

    expect(mockExecFileSync).toHaveBeenCalledWith(
      '/usr/local/bin/tmux',
      ['send-keys', '-t', 'agent-slacker', 'Escape'],
      expect.any(Object),
    )
  })

  it('sends Escape on error to clean up menu state', () => {
    mockExecFileSync.mockImplementationOnce(() => { /* Escape */ })
    mockExecFileSync.mockImplementationOnce(() => { /* sleep */ })
    mockExecFileSync.mockImplementationOnce(() => { throw new Error('tmux dead') })

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(false)
    const escapeCalls = mockExecFileSync.mock.calls.filter(
      (c) => Array.isArray(c[1]) && c[1].includes('Escape'),
    )
    expect(escapeCalls.length).toBeGreaterThan(0)
  })
})
