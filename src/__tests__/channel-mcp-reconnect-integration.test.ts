/**
 * Integration tests for the MCP channel-health detection → spawn → reconnect chain.
 *
 * What is intentionally NOT mocked (tested as real code):
 * - channel-health-monitor.ts  -- detection logic, backoff, spawn decision
 * - channel-mcp-reconnect.ts   -- session resolution, tmux navigation, reconnect flow
 * - channel-provider.ts        -- pluginPaneId derivation (telegram = 'plugin:telegram:telegram')
 * - pane-state.ts              -- idle/busy classification used in the preflight guard
 *
 * What is mocked (system-level edges only):
 * - execFileSync / spawn       -- no real tmux or child processes
 * - capturePane                -- deterministic pane fixture strings
 * - isAgentRunning, listAgentNames -- environment shape
 * - logger, config, platform   -- noise suppression and path-independence
 *
 * Why this is an integration test (and not a duplicate of the unit tests):
 * The unit tests mock `channel-mcp-reconnect.js` inside health-monitor tests,
 * and mock `channel-provider.js` inside reconnect tests. This file removes those
 * seams. Specifically:
 * - `isPluginFailedInPane` uses the real `getProvider().pluginPaneId` string; a
 *   change to that constant without updating the fixture would fail here.
 * - `resolveAgentSession` / `resolveAgentProviderType` used in health-monitor are
 *   the same implementations tested in the reconnect-flow suite -- one source of
 *   truth verified end-to-end.
 * - The reconnect flow tests verify that `checkTelegramTokenBusy` usage is
 *   wired correctly without being intercepted at the provider boundary.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Shared mock handles lifted into hoisted scope so vi.mock factories can
// reference them.
const { mockSpawn, mockExecFileSync, mockCapturePane } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockExecFileSync: vi.fn(),
  mockCapturePane: vi.fn<(session: string) => string | null>(),
}))

vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
  execSync: vi.fn(),
  spawn: mockSpawn,
}))

vi.mock('../platform.js', () => ({
  resolveFromPath: (name: string) => `/usr/local/bin/${name}`,
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../config.js', () => ({
  MAIN_AGENT_ID: 'main-agent',
  CHANNEL_PROVIDER: 'telegram',
  PROJECT_ROOT: '/tmp/test-integration',
}))

vi.mock('../web/agent-config.js', () => ({
  listAgentNames: () => ['agent-a'],
  readAgentChannelProvider: () => '',
  AGENTS_BASE_DIR: '/tmp/test-integration/agents',
}))

vi.mock('../web/agent-process.js', () => ({
  isAgentRunning: (name: string) => name === 'agent-a',
  capturePane: (session: string) => mockCapturePane(session),
  agentSessionName: (name: string) => `agent-${name}`,
}))

vi.mock('../web/main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: 'main-agent-channels',
}))

// Submenu fixtures that match actual Claude Code /mcp rendering.
// The pane format is defined in channel-mcp-reconnect.ts comments and its test
// helpers. These specific strings are also used in the unit test suite.
const SUBMENU_FAILED_TOP = [
  'plugin:telegram:telegram',
  '❯ Reconnect',
  '  Disable',
].join('\n')

const SUBMENU_CONNECTED_TOP = [
  'plugin:telegram:telegram',
  '❯ View tools',
  '  Reconnect',
  '  Disable',
].join('\n')

const SUBMENU_CONNECTED_ON_RECONNECT = [
  'plugin:telegram:telegram',
  '  View tools',
  '❯ Reconnect',
  '  Disable',
].join('\n')

// The real telegram pluginPaneId from channel-provider.ts.
// Used in the pane fixtures below to guarantee the detection path uses the
// same string that getProvider() returns -- this is the integration seam.
const TELEGRAM_PLUGIN_PANE_ID = 'plugin:telegram:telegram'

// ─────────────────────────────────────────────────────────────────────────────
// Suite 1: health-monitor detection layer
// ─────────────────────────────────────────────────────────────────────────────

describe('Integration: health-monitor detection layer', () => {
  let startChannelHealthMonitor: typeof import('../../web/channel-health-monitor.js')['startChannelHealthMonitor']

  beforeEach(async () => {
    // Fresh module state for reconnectState and inFlightReconnects Maps.
    vi.resetModules()
    vi.clearAllMocks()
    vi.useFakeTimers()
    // Minimal fake detached child that health-monitor can .once('exit|error') + .unref() on.
    mockSpawn.mockReturnValue({ once: vi.fn(), unref: vi.fn() })
    const mod = await import('../web/channel-health-monitor.js')
    startChannelHealthMonitor = mod.startChannelHealthMonitor
  })

  afterEach(() => vi.useRealTimers())

  it('triggers spawn with reconnect-cli args when the pane shows plugin failure', () => {
    // The fixture pane must contain BOTH the real pluginPaneId (from getProvider)
    // AND the failure marker matched by PLUGIN_FAILED_RX (/✘\s*(?:failed|error|disconnected)/i).
    // No mock intercepts getProvider here -- the real telegram pluginPaneId is used.
    mockCapturePane.mockReturnValue(
      `${TELEGRAM_PLUGIN_PANE_ID}  ✘ failed\nsome other pane content`,
    )

    const timer = startChannelHealthMonitor()
    vi.advanceTimersByTime(46_000) // past the 45s initial delay

    expect(mockSpawn).toHaveBeenCalled()
    const [, spawnArgs] = mockSpawn.mock.calls[0]
    // The second arg to spawn() is the argv array: [reconnect-cli path, agentName]
    expect(String(spawnArgs[0])).toMatch(/reconnect-cli/)
    // The main agent is checked first in startChannelHealthMonitor.
    expect(spawnArgs[1]).toBe('main-agent')

    clearInterval(timer)
  })

  it('does NOT trigger spawn when the pane is healthy (false-positive protection)', () => {
    // A healthy pane: contains the plugin ID but no failure marker.
    mockCapturePane.mockReturnValue(
      `${TELEGRAM_PLUGIN_PANE_ID}  ✔ connected`,
    )

    const timer = startChannelHealthMonitor()
    vi.advanceTimersByTime(46_000)

    expect(mockSpawn).not.toHaveBeenCalled()

    clearInterval(timer)
  })

  it('does NOT trigger spawn when the plugin ID is absent from the pane', () => {
    // A pane that has the failure marker but belongs to a different plugin.
    mockCapturePane.mockReturnValue('plugin:some-other-plugin  ✘ failed')

    const timer = startChannelHealthMonitor()
    vi.advanceTimersByTime(46_000)

    expect(mockSpawn).not.toHaveBeenCalled()

    clearInterval(timer)
  })

  it('skips a second spawn while a reconnect for the same agent is in flight', () => {
    mockCapturePane.mockReturnValue(
      `${TELEGRAM_PLUGIN_PANE_ID}  ✘ failed`,
    )

    const exitListeners: Array<() => void> = []
    mockSpawn.mockImplementation(() => {
      const child = {
        once: vi.fn((event: string, cb: () => void) => {
          if (event === 'exit') exitListeners.push(cb)
        }),
        unref: vi.fn(),
      }
      return child
    })

    const timer = startChannelHealthMonitor()
    // First tick: spawns for main-agent AND agent-a (both show failed pane).
    vi.advanceTimersByTime(46_000)
    const spawnCountAfterFirstTick = mockSpawn.mock.calls.length
    expect(spawnCountAfterFirstTick).toBeGreaterThanOrEqual(1)

    // Second tick while all children are still in flight: no additional spawns.
    vi.advanceTimersByTime(60_000)
    expect(mockSpawn.mock.calls.length).toBe(spawnCountAfterFirstTick)

    clearInterval(timer)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2: reconnect navigation flow (the reconnect worker's perspective)
// ─────────────────────────────────────────────────────────────────────────────

describe('Integration: reconnect navigation flow', () => {
  let attemptChannelMcpReconnect: typeof import('../../web/channel-mcp-reconnect.js')['attemptChannelMcpReconnect']

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    // Standard preflight: non-busy pane (detectPaneState returns 'unknown', guard passes).
    mockCapturePane.mockReturnValueOnce('idle pane content here')
    const mod = await import('../web/channel-mcp-reconnect.js')
    attemptChannelMcpReconnect = mod.attemptChannelMcpReconnect
  })

  it('succeeds for a failed-state plugin (cursor already on Reconnect)', () => {
    // Sequence:
    // 1. Preflight -- already queued in beforeEach
    // 2. After /mcp send-keys: pane confirms menu opened
    // 3. After first Up: plugin row appears in pane
    // 4. After Enter into submenu: SUBMENU_FAILED_TOP (cursor on Reconnect)
    mockCapturePane
      .mockReturnValueOnce('/mcp menu rendered')
      .mockReturnValueOnce(`${TELEGRAM_PLUGIN_PANE_ID} listed`)
      .mockReturnValueOnce(SUBMENU_FAILED_TOP)

    const result = attemptChannelMcpReconnect('main-agent')

    expect(result.ok).toBe(true)
    expect(result.message).toContain('Reconnect')
    // In failed-state the cursor is already on Reconnect -- no Down key should fire.
    const downCalls = mockExecFileSync.mock.calls.filter(
      (c) => Array.isArray(c[1]) && c[1].includes('Down'),
    )
    expect(downCalls.length).toBe(0)
  })

  it('succeeds for a connected plugin (steps Down onto Reconnect)', () => {
    mockCapturePane
      .mockReturnValueOnce('/mcp menu rendered')
      .mockReturnValueOnce(`${TELEGRAM_PLUGIN_PANE_ID} listed`)
      .mockReturnValueOnce(SUBMENU_CONNECTED_TOP)          // cursor on View tools
      .mockReturnValueOnce(SUBMENU_CONNECTED_ON_RECONNECT) // after Down: cursor on Reconnect

    const result = attemptChannelMcpReconnect('main-agent')

    expect(result.ok).toBe(true)
    expect(result.message).toContain('Reconnect')
    // At least one Down must have been sent to navigate to the Reconnect row.
    const downCalls = mockExecFileSync.mock.calls.filter(
      (c) => Array.isArray(c[1]) && c[1].includes('Down'),
    )
    expect(downCalls.length).toBeGreaterThan(0)
  })

  it('bails without pressing any key when preflight detects a busy pane', () => {
    // mockReset (not clearAllMocks) to flush the beforeEach 'idle' queue entry
    // and replace it with the busy fixture. clearAllMocks calls mockClear which
    // does NOT flush the one-time return-value queue; mockReset does.
    mockCapturePane.mockReset()
    mockCapturePane.mockReturnValueOnce(
      '· Synthesizing… (8s · ↓ 1.2k tokens · esc to interrupt)',
    )

    const result = attemptChannelMcpReconnect('main-agent')

    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/busy/i)
    // Hard assertion: the tmux session was never touched.
    const sendKeyCalls = mockExecFileSync.mock.calls.filter(
      (c) => Array.isArray(c[1]) && c[1].includes('send-keys'),
    )
    expect(sendKeyCalls.length).toBe(0)
  })

  it('returns ok:false without entering a submenu when only unsafe options exist', () => {
    mockCapturePane
      .mockReturnValueOnce('/mcp menu rendered')
      .mockReturnValueOnce(`${TELEGRAM_PLUGIN_PANE_ID} listed`)
      .mockReturnValueOnce([
        'plugin:telegram:telegram',
        '❯ View tools',
        '  Disable',
      ].join('\n')) // No Reconnect or Enable option

    const result = attemptChannelMcpReconnect('main-agent')

    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/No Reconnect\/Enable/i)
    // No Down key may be pressed inside the submenu: we must not scroll
    // the cursor onto Disable and accidentally activate it.
    const downCalls = mockExecFileSync.mock.calls.filter(
      (c) => Array.isArray(c[1]) && c[1].includes('Down'),
    )
    expect(downCalls.length).toBe(0)
  })

  it('uses the correct tmux session for sub-agents', () => {
    mockCapturePane
      .mockReturnValueOnce('/mcp menu')
      .mockReturnValueOnce(`${TELEGRAM_PLUGIN_PANE_ID} found`)
      .mockReturnValueOnce(SUBMENU_FAILED_TOP)

    attemptChannelMcpReconnect('agent-a')

    // The session name for a sub-agent is derived by agentSessionName() ->
    // 'agent-agent-a' (the mock: agentSessionName = name => `agent-${name}`).
    const escapeCalls = mockExecFileSync.mock.calls.filter(
      (c) => Array.isArray(c[1]) && c[1].includes('send-keys'),
    )
    const sessionArgs = escapeCalls.map((c) => (c[1] as string[])[2])
    expect(sessionArgs.every((s) => s === 'agent-agent-a')).toBe(true)
  })
})
