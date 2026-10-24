import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

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
const mockCaptureParkedInputView = vi.fn<(session: string) => string | null>()
// Lets a single test swap the provider mock's pluginPaneId; vi.mock factories
// run lazily, so they read this at call time.
const mockPluginPaneIdOverride = { value: null as string | null }
const mockMcpServerNameOverride = { value: null as string | null }
vi.mock('../web/agent-process.js', () => ({
  // The not-ready-path modal clear: false = no modal, so every caller keeps
  // its existing skip/busy behaviour and these fixtures are unaffected.
  clearFeedbackModalAndRecheck: () => false,
  agentSessionName: (name: string) => `agent-${name}`,
  capturePane: (session: string) => mockCapturePane(session),
  captureParkedInputView: (session: string) => mockCaptureParkedInputView(session),
}))

vi.mock('../web/main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: 'marveen-channels',
}))

vi.mock('../channel-provider.js', () => ({
  getProvider: (type: string) => ({
    pluginId: type === 'slack'
      ? 'slack-channel@marveen-marketplace'
      : 'telegram@claude-plugins-official',
    pluginPaneId: mockPluginPaneIdOverride.value ?? (type === 'slack'
      ? 'plugin:slack-channel:marveen-marketplace'
      : 'plugin:telegram:telegram'),
    ...(type === 'slack' ? { mcpServerName: mockMcpServerNameOverride.value ?? 'plugin:slack-channel:slack' } : {}),
  }),
}))

import {
  attemptChannelMcpReconnect,
  resolveAgentSession,
  resolveAgentProviderType,
  paneDiagSignature,
} from '../web/channel-mcp-reconnect.js'
import { logger } from '../logger.js'
import { detectPaneState, detectsBlockingMenu } from '../pane-state.js'
import { mcpCommandReply, showsMcpDialogTitle } from '../web/mcp-inline-command.js'
import { tryAcquireSessionSendLane } from '../web/session-send-lock.js'

describe('paneDiagSignature', () => {
  const PLUGIN_RX = /plugin:telegram:telegram/i

  it('null pane -> capture-failed marker only', () => {
    expect(paneDiagSignature(null, PLUGIN_RX)).toEqual({ paneCaptured: false })
  })

  it('open /mcp menu with the plugin row -> menu and row both seen', () => {
    const pane = [
      'plugin:telegram:telegram',
      '❯ Reconnect',
      '  Disable',
      '',
      '↑/↓ to navigate · Enter to confirm · Esc to cancel',
    ].join('\n')
    const sig = paneDiagSignature(pane, PLUGIN_RX)
    expect(sig.paneCaptured).toBe(true)
    expect(sig.inBlockingMenu).toBe(true)
    expect(sig.sawPluginRow).toBe(true)
    expect(sig.paneNonEmptyLines).toBe(4)
  })

  it('plain conversation pane -> no menu, no plugin row, and NO raw text in the signature', () => {
    const pane = [
      'Szia, ezt a bizalmas mondatot senki nem lathatja a logban.',
      '❯ ',
    ].join('\n')
    const sig = paneDiagSignature(pane, PLUGIN_RX)
    expect(sig.inBlockingMenu).toBe(false)
    expect(sig.sawPluginRow).toBe(false)
    // The redaction contract: nothing from the pane text may leak through.
    expect(JSON.stringify(sig)).not.toContain('bizalmas')
  })

  it('menu open but the plugin row is NOT rendered -> the discriminating case', () => {
    const pane = [
      'Manage MCP servers',
      '❯ some-other-server  connected',
      '',
      '↑/↓ to navigate · Enter to confirm · Esc to cancel',
    ].join('\n')
    const sig = paneDiagSignature(pane, PLUGIN_RX)
    expect(sig.inBlockingMenu).toBe(true)
    expect(sig.sawPluginRow).toBe(false)
  })
})

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

// Pane shapes for the pre-keystroke gate; the REAL pane-state code reads them.
const SEP = '─'.repeat(80)
const FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
const IDLE_EMPTY = ['', SEP, '❯ ', SEP, FOOTER].join('\n')

// A delivery wrap parked, unsubmitted, in an otherwise idle pane.
const PARKED_DELIVERY_WRAP = [
  '',
  SEP,
  '❯ [BATCH: 2 inter-agent messages delivered at once] TEAM MEMBER NOTICE -- the',
  '  next <trusted-peer source="..."> block is a message from an agent in your own',
  '  team. [Message from @peer-agent -- trusted team member, msg_id:12345]:',
  SEP,
  FOOTER,
].join('\n')

const BUSY_MID_TURN = [
  '✢ Combobulating… (52s · ↓ 2.6k tokens · thinking some more)',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt',
].join('\n')

// The /mcp server list modal, shaped like the CLI 2.1.291 capture: the top rule
// (a run of U+2594), the title alone on its line, selectable rows, nav footer.
const MCP_DIALOG = [
  '▔'.repeat(40),
  '   Manage MCP servers',
  '',
  '  ❯ 1. telegram',
  '    2. filesystem',
  '',
  '  ↑/↓ to navigate · Enter to select · Esc to back',
].join('\n')

const sendKeysCalls = () =>
  mockExecFileSync.mock.calls.filter((c) => Array.isArray(c[1]) && c[1].includes('send-keys'))
const mcpKeystrokeCalls = () =>
  mockExecFileSync.mock.calls.filter(
    (c) => Array.isArray(c[1]) && c[1].some((a: unknown) => typeof a === 'string' && a.startsWith('/mcp')),
  )
const escapeCalls = () => sendKeysCalls().filter((c) => Array.isArray(c[1]) && c[1].includes('Escape'))

function resetPaneMocks(): void {
  vi.clearAllMocks()
  mockCapturePane.mockReset()
  mockCaptureParkedInputView.mockReset()
  mockCaptureParkedInputView.mockReturnValue(null)
  mockPluginPaneIdOverride.value = null
  mockMcpServerNameOverride.value = null
}

describe('pane-side gate', () => {
  beforeEach(resetPaneMocks)

  it('defers (sends NO keys) when the pane is actively generating', () => {
    mockCapturePane.mockReturnValueOnce('· Synthesizing… (8s · ↓ 1.2k tokens · esc to interrupt)')

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('Pane busy -- reconnect deferred')
    expect(sendKeysCalls().length).toBe(0)
  })

  it('defers (sends NO keys) while another writer holds the pane send lane', () => {
    mockCapturePane.mockReturnValue(IDLE_EMPTY)
    const release = tryAcquireSessionSendLane('marveen-channels', null)
    expect(release).not.toBeNull() // precondition: this test holds the lane
    try {
      const result = attemptChannelMcpReconnect('marveen')
      expect(result.ok).toBe(false)
      expect(result.message).toMatch(/deferred/)
      expect(sendKeysCalls().length).toBe(0)
    } finally {
      release!()
    }
  })

  it('E1: a failed first capture refuses before any keystroke', () => {
    mockCapturePane.mockReturnValueOnce(null)

    const result = attemptChannelMcpReconnect('marveen')

    expect(result).toEqual({ ok: false, message: 'Pane unreadable -- reconnect refused' })
    expect(sendKeysCalls().length).toBe(0)
  })

  it('E2: parked text in the input box defers with zero keystrokes and no pane text in the log', () => {
    mockCapturePane.mockReturnValue(PARKED_DELIVERY_WRAP)

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/deferred/)
    expect(result.message).toBe('Input box not empty -- reconnect deferred')
    expect(sendKeysCalls().length).toBe(0)
    const logs = JSON.stringify([...vi.mocked(logger.warn).mock.calls, ...vi.mocked(logger.info).mock.calls])
    expect(logs).not.toContain('BATCH')
    expect(logs).not.toContain('peer-agent')
    expect(logs).not.toContain('msg_id:12345')
  })

  it('E3: a busy pane defers with zero keystrokes (so no Escape either)', () => {
    mockCapturePane.mockReturnValue(BUSY_MID_TURN)

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/deferred/)
    expect(sendKeysCalls().length).toBe(0)
  })

  it('E3b: a busy pane that also shows the MCP dialog title gets no Escape from the menu dismiss', () => {
    mockCapturePane.mockReturnValue(['Manage MCP servers', '', BUSY_MID_TURN].join('\n'))

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/deferred/)
    expect(sendKeysCalls().length).toBe(0)
  })

  it('E4a: an open MCP dialog on the first capture is dismissed, then the reconnect proceeds', () => {
    mockCapturePane
      .mockReturnValueOnce(MCP_DIALOG) // gate: /mcp modal already up
      .mockReturnValue(IDLE_EMPTY)     // dismiss re-capture + everything after

    const result = attemptChannelMcpReconnect('marveen')

    // The pane never shows an echo or a result, so the typed command ends in
    // "outcome not observed"; what matters is that the command was typed.
    expect(result.message).toContain('not observed')
    expect(mcpKeystrokeCalls().length).toBeGreaterThan(0)
  })

  it('E4b: dialog first, then an occupied idle pane -> deferred, and no /mcp keystroke', () => {
    mockCapturePane
      .mockReturnValueOnce(MCP_DIALOG)
      .mockReturnValue(PARKED_DELIVERY_WRAP)

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/deferred/)
    expect(mcpKeystrokeCalls().length).toBe(0)
  })

  it('E4c: a dialog that survives the dismiss attempts is refused', () => {
    mockCapturePane.mockReturnValue(MCP_DIALOG)

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(false)
    expect(result.message).toBe('MCP dialog still open -- reconnect refused')
    expect(mcpKeystrokeCalls().length).toBe(0)
  })

  it('E4d: the dismiss stops at the first Escape when it reveals parked text', () => {
    mockCapturePane
      .mockReturnValueOnce(MCP_DIALOG)
      .mockReturnValue(PARKED_DELIVERY_WRAP)

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(false)
    expect(result.message).toBe('Input box not empty -- reconnect deferred')
    expect(escapeCalls().length).toBe(1)
    expect(mcpKeystrokeCalls().length).toBe(0)
  })

  it('E4e: the dismiss stops at the first Escape when the pane has turned busy', () => {
    mockCapturePane
      .mockReturnValueOnce(MCP_DIALOG)
      .mockReturnValue(BUSY_MID_TURN)

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('Pane busy -- reconnect deferred')
    expect(escapeCalls().length).toBe(1)
    expect(mcpKeystrokeCalls().length).toBe(0)
  })

  it('E4f: a dialog that stays open still gets the full Escape budget before the refusal', () => {
    mockCapturePane.mockReturnValue(MCP_DIALOG)

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.message).toBe('MCP dialog still open -- reconnect refused')
    expect(escapeCalls().length).toBe(4)
    expect(mcpKeystrokeCalls().length).toBe(0)
  })

  it('E4g: an unreadable pane after the first Escape stops the dismiss -- no blind Escape', () => {
    mockCapturePane
      .mockReturnValueOnce(MCP_DIALOG)
      .mockReturnValueOnce(null)       // after the first Escape
      .mockReturnValue(MCP_DIALOG)     // the gate's recapture: still open

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(false)
    expect(result.message).toBe('MCP dialog still open -- reconnect refused')
    expect(escapeCalls().length).toBe(1)
    expect(mcpKeystrokeCalls().length).toBe(0)
  })

  it('E4h: a pane that turns busy with the dialog title still on screen gets no second Escape', () => {
    mockCapturePane
      .mockReturnValueOnce(MCP_DIALOG)
      .mockReturnValue(['Manage MCP servers', '', BUSY_MID_TURN].join('\n'))

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('Pane busy -- reconnect deferred')
    expect(escapeCalls().length).toBe(1)
    expect(mcpKeystrokeCalls().length).toBe(0)
  })

  it('E5: on an idle-empty pane the first keystroke is the typed /mcp reconnect -- no leading Escape', () => {
    mockCapturePane.mockReturnValue(IDLE_EMPTY)

    attemptChannelMcpReconnect('marveen')

    const first = sendKeysCalls()[0]
    expect(first?.[1]).toEqual(['send-keys', '-t', '=marveen-channels:', '-l', '/mcp reconnect plugin:telegram:telegram'])
  })

  it('a pane read as typing only because of a dim placeholder proceeds when the dim-stripped view is idle', () => {
    // Precondition: the plain read is 'typing' (placeholder hint in the box).
    const GHOST = ['', SEP, '❯ Try "refactor this"', SEP, FOOTER].join('\n')
    expect(detectPaneState(GHOST)).toBe('typing')
    mockCapturePane.mockReturnValue(GHOST)
    mockCaptureParkedInputView.mockReturnValue(IDLE_EMPTY)

    attemptChannelMcpReconnect('marveen')

    expect(mockCaptureParkedInputView).toHaveBeenCalled()
    expect(mcpKeystrokeCalls().length).toBeGreaterThan(0)
  })

  it('the same typing pane stays deferred when the dim-stripped view is not idle', () => {
    const GHOST = ['', SEP, '❯ Try "refactor this"', SEP, FOOTER].join('\n')
    mockCapturePane.mockReturnValue(GHOST)
    mockCaptureParkedInputView.mockReturnValue(GHOST)

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(false)
    expect(sendKeysCalls().length).toBe(0)
  })
})

// F4 and F5 are dropped: they need a dialog drawn above a live empty box with
// the idle footer still visible to count as a blocking menu, but this repo's
// detectsBlockingMenu returns false whenever the idle footer is present.
describe('dialog title only inside the dialog region', () => {
  beforeEach(resetPaneMocks)

  // A capture of the dialog quoted in a reply: the live prompt is below it.
  const QUOTED_TITLE = [
    '⏺ This is what the stuck pane showed:',
    '',
    '  Manage MCP servers',
    '  3 servers',
    '',
    '  It is closed now.',
  ]
  const TITLE_IN_TRANSCRIPT_PARKED = [
    ...QUOTED_TITLE,
    '',
    SEP,
    '❯ please look at the follow-up card when you are free',
    SEP,
    FOOTER,
  ].join('\n')
  const TITLE_IN_TRANSCRIPT_EMPTY_BOX = [...QUOTED_TITLE, '', SEP, '❯ ', SEP, FOOTER].join('\n')
  const DIALOG_TEXT_IN_PARKED_BOX = [
    '⏺ Done.',
    '',
    SEP,
    '❯ the pane showed this:',
    '  Manage MCP servers',
    '  ↑/↓ to navigate · Enter to confirm · Esc to cancel',
    SEP,
    FOOTER,
  ].join('\n')
  const gateEscapes = () => {
    const calls = sendKeysCalls()
    const mcpAt = calls.findIndex((c) => Array.isArray(c[1]) && c[1].includes('-l'))
    return (mcpAt < 0 ? calls : calls.slice(0, mcpAt)).filter((c) => Array.isArray(c[1]) && c[1].includes('Escape'))
  }

  it('F1: the title as transcript text over parked text gets no keystroke at all, and is deferred', () => {
    mockCapturePane.mockReturnValue(TITLE_IN_TRANSCRIPT_PARKED)

    const result = attemptChannelMcpReconnect('marveen')

    expect(sendKeysCalls().length).toBe(0)
    expect(result.ok).toBe(false)
    expect(result.message).toBe('Input box not empty -- reconnect deferred')
  })

  it('F2: the title as transcript text over an empty box does not block the reconnect', () => {
    mockCapturePane.mockReturnValue(TITLE_IN_TRANSCRIPT_EMPTY_BOX)

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.message).not.toBe('MCP dialog still open -- reconnect refused')
    expect(gateEscapes().length).toBe(0)
    expect(mcpKeystrokeCalls().length).toBeGreaterThan(0)
  })

  it('F3: the dialog text inside a parked delivery gets no keystroke at all, and is deferred', () => {
    mockCapturePane.mockReturnValue(DIALOG_TEXT_IN_PARKED_BOX)

    const result = attemptChannelMcpReconnect('marveen')

    expect(sendKeysCalls().length).toBe(0)
    expect(result.message).toBe('Input box not empty -- reconnect deferred')
  })

  it('F6: a dismissed dialog that leaves the title in the transcript over an empty box lets the reconnect proceed', () => {
    mockCapturePane
      .mockReturnValueOnce(MCP_DIALOG)
      .mockReturnValue(TITLE_IN_TRANSCRIPT_EMPTY_BOX)

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.message).not.toBe('MCP dialog still open -- reconnect refused')
    expect(gateEscapes().length).toBe(1)
    expect(mcpKeystrokeCalls().length).toBeGreaterThan(0)
  })

  it('F7: a dismissed dialog that leaves the title in the transcript over parked text stops at one Escape, and is deferred', () => {
    mockCapturePane
      .mockReturnValueOnce(MCP_DIALOG)
      .mockReturnValue(TITLE_IN_TRANSCRIPT_PARKED)

    const result = attemptChannelMcpReconnect('marveen')

    expect(escapeCalls().length).toBe(1)
    expect(result.message).toBe('Input box not empty -- reconnect deferred')
    expect(mcpKeystrokeCalls().length).toBe(0)
  })
})

// Every pane below is a REAL capture from ./fixtures/mcp-reconnect-cli-2.1.291/
// with the probe server names rewritten into this repo's pluginPaneId. Capture
// order per typed command: (the gate's `pre` once), then one baseline capture
// taken just before typing, then the one-second polls.
describe('typed /mcp reconnect', () => {
  const FIX = (f: string) =>
    readFileSync(new URL(`./fixtures/mcp-reconnect-cli-2.1.291/${f}`, import.meta.url), 'utf8')
  const TG = 'plugin:telegram:telegram'
  const PROBE_NAMES = [
    'plugin:probeplug:okplug',
    'plugin:probeflaky:flaky',
    'plugin:probedead:dead',
    'nosuchserver',
    'badserver',
    'okserver',
  ]
  const asName = (s: string, name: string) => PROBE_NAMES.reduce((acc, n) => acc.split(n).join(name), s)
  const asTg = (f: string) => asName(FIX(f), TG)
  const sendKeys = () => sendKeysCalls()
  const escapes = escapeCalls
  const queue = (...panes: Array<string | null>) => { for (const p of panes) mockCapturePane.mockReturnValueOnce(p) }
  const withBoxText = (pane: string, text: string) => {
    const lines = pane.split('\n')
    let boxAt = -1
    lines.forEach((l, i) => { if (l.trim() === '❯') boxAt = i })
    expect(boxAt).toBeGreaterThanOrEqual(0)
    lines[boxAt] = text
    return lines.join('\n')
  }

  beforeEach(resetPaneMocks)

  it('T1: success submits exactly one typed command and reads the ⎿ result', () => {
    queue(
      asTg('idle.txt'),               // gate pre
      asTg('idle.txt'),               // baseline
      asTg('reconnect-busy.txt'),     // poll 1: echo, no ⎿ yet
      asTg('reconnect-progress.txt'), // poll 2: "Reconnecting" panel, no echo
      asTg('reconnect-ok.txt'),       // poll 3: echo + result
    )

    const result = attemptChannelMcpReconnect('marveen')

    expect(result).toEqual({ ok: true, message: 'Reconnected via /mcp reconnect' })
    expect(sendKeys().map((c) => c[1])).toEqual([
      ['send-keys', '-t', '=marveen-channels:', '-l', `/mcp reconnect ${TG}`],
      ['send-keys', '-t', '=marveen-channels:', 'Enter'],
    ])
    const calls = mockExecFileSync.mock.calls
    const litAt = calls.findIndex((c) => Array.isArray(c[1]) && c[1].includes('-l'))
    const enterAt = calls.findIndex((c) => Array.isArray(c[1]) && c[1].includes('Enter'))
    expect(litAt).toBeGreaterThanOrEqual(0)
    expect(enterAt).toBeGreaterThan(litAt)
    expect(
      calls.slice(litAt + 1, enterAt).some((c) => c[0] === '/bin/sleep' && Array.isArray(c[1]) && c[1][0] === '0.3'),
    ).toBe(true)
    expect(escapes().length).toBe(0)
  })

  // `prev` (an older echo + result on screen) followed by a newer echo and reply
  const stacked = (prev: string, reply: string) => {
    const lines = prev.split('\n')
    const at = lines.findIndex((l) => l.includes('⎿'))
    expect(at).toBeGreaterThanOrEqual(0)
    return [...lines.slice(0, at + 1), `❯ /mcp reconnect ${TG}`, `  ⎿  ${reply}`, ...lines.slice(at + 1)].join('\n')
  }
  const sleepCalls3 = () => mockExecFileSync.mock.calls.filter((c) => c[0] === '/bin/sleep' && Array.isArray(c[1]) && c[1][0] === '3')

  it('T2: a measured failure reports reconnect-failed with no pane text in the log', () => {
    const FAILED = asTg('reconnect-plugin-failed.txt')
    queue(
      asTg('idle.txt'),                          // gate pre
      asTg('idle.txt'),                          // baseline
      asTg('reconnect-plugin-busy.txt'),         // poll: echo, no result yet
      FAILED,                                    // poll: first failure
      FAILED,                                    // retry's own gate
      FAILED,                                    // retry baseline
      stacked(FAILED, `Failed to reconnect to ${TG}`), // retry failure (final)
    )

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('reconnect-failed')
    expect(sendKeys().map((c) => c[1])).toEqual([
      ['send-keys', '-t', '=marveen-channels:', '-l', `/mcp reconnect ${TG}`],
      ['send-keys', '-t', '=marveen-channels:', 'Enter'],
      ['send-keys', '-t', '=marveen-channels:', '-l', `/mcp reconnect ${TG}`],
      ['send-keys', '-t', '=marveen-channels:', 'Enter'],
    ])
    const calls = mockExecFileSync.mock.calls
    const enterAt = calls.findIndex((c) => Array.isArray(c[1]) && c[1].includes('Enter'))
    const sleepAt = calls.findIndex((c, i) => i > enterAt && c[0] === '/bin/sleep' && Array.isArray(c[1]) && c[1][0] === '3')
    const secondTextAt = calls.findIndex((c, i) => i > enterAt && Array.isArray(c[1]) && c[1].includes('-l'))
    expect(sleepAt).toBeGreaterThan(enterAt)
    expect(secondTextAt).toBeGreaterThan(sleepAt)
    expect(escapes().length).toBe(0)
    const warns = JSON.stringify(vi.mocked(logger.warn).mock.calls)
    expect(warns).not.toContain('⎿')
    expect(warns).not.toContain('Failed to reconnect to')
  })

  it('R1: a reconnect that fails once and then succeeds is ok:true', () => {
    const FAILED = asTg('reconnect-plugin-failed.txt')
    queue(
      asTg('idle.txt'),
      asTg('idle.txt'),
      FAILED,
      FAILED,
      FAILED,
      stacked(FAILED, `Successfully reconnected to ${TG}`),
    )

    const result = attemptChannelMcpReconnect('marveen')

    expect(result).toEqual({ ok: true, message: 'Reconnected via /mcp reconnect' })
    expect(sendKeys().length).toBe(4)
  })

  it('R2: the retry is not typed into a pane that turned busy', () => {
    const FAILED = asTg('reconnect-plugin-failed.txt')
    queue(
      asTg('idle.txt'),
      asTg('idle.txt'),
      FAILED,
      asTg('reconnect-plugin-busy.txt'), // the retry's own gate
    )

    const result = attemptChannelMcpReconnect('marveen')

    expect(result).toEqual({ ok: false, message: 'Pane busy -- reconnect deferred to avoid interrupting active work' })
    expect(sendKeys().length).toBe(2)
  })

  it('R3: not-found is not retried', () => {
    queue(asTg('idle.txt'), asTg('idle.txt'), asTg('reconnect-not-found.txt'))

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('not-found')
    expect(sendKeys().length).toBe(2)
    expect(sleepCalls3().length).toBe(0)
  })

  it('R5: a retry that answers disabled is final: no enable round', () => {
    const FAILED = asTg('reconnect-plugin-failed.txt')
    queue(
      asTg('idle.txt'),
      asTg('idle.txt'),
      FAILED,
      FAILED,
      FAILED,
      stacked(FAILED, `"${TG}" is disabled — enable it in /mcp first`),
    )
    mockCapturePane.mockReturnValue(asTg('enable-plugin-ok.txt'))

    const result = attemptChannelMcpReconnect('marveen')

    const typed = sendKeys().map((c) => c[1]).filter((a) => a.includes('-l')).map((a) => a[a.length - 1])
    expect(typed).toEqual([`/mcp reconnect ${TG}`, `/mcp reconnect ${TG}`])
    expect(result).toEqual({ ok: false, message: `/mcp reconnect ${TG}: disabled` })
  })

  it('R4: after /mcp enable, a failed reconnect is retried once too', () => {
    const DISABLED = asTg('reconnect-plugin-disabled.txt')
    const ENABLED = asTg('enable-plugin-ok.txt')
    const FAILED = asTg('reconnect-plugin-failed.txt')
    queue(
      asTg('idle.txt'), asTg('idle.txt'), DISABLED,  // reconnect -> disabled
      DISABLED, DISABLED, ENABLED,                   // enable -> enabled
      ENABLED, ENABLED, FAILED,                      // reconnect -> failed
      FAILED, FAILED, stacked(FAILED, `Successfully reconnected to ${TG}`), // retry -> ok
    )

    const result = attemptChannelMcpReconnect('marveen')

    expect(result).toEqual({ ok: true, message: 'Reconnected via /mcp reconnect' })
    const typed = sendKeys().map((c) => c[1]).filter((a) => a.includes('-l')).map((a) => a[a.length - 1])
    expect(typed).toEqual([
      `/mcp reconnect ${TG}`,
      `/mcp enable ${TG}`,
      `/mcp reconnect ${TG}`,
      `/mcp reconnect ${TG}`,
    ])
  })

  it('T3: not-found is reported as such', () => {
    queue(asTg('idle.txt'), asTg('idle.txt'), asTg('reconnect-not-found.txt'))

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('not-found')
  })

  it('T4: disabled runs /mcp enable and then /mcp reconnect once more', () => {
    queue(
      asTg('idle.txt'),                      // gate pre
      asTg('idle.txt'),                      // baseline (reconnect)
      asTg('reconnect-plugin-disabled.txt'), // poll: "is disabled"
      asTg('reconnect-plugin-disabled.txt'), // the step's own gate
      asTg('reconnect-plugin-disabled.txt'), // baseline (enable)
      asTg('enable-plugin-ok.txt'),          // poll: "enabled"
      asTg('enable-plugin-ok.txt'),          // the step's own gate
      asTg('enable-plugin-ok.txt'),          // baseline (second reconnect)
      asTg('reconnect-plugin-ok.txt'),       // poll: reconnected
    )

    const result = attemptChannelMcpReconnect('marveen')

    expect(result).toEqual({ ok: true, message: 'Reconnected via /mcp reconnect' })
    expect(sendKeys().map((c) => c[1])).toEqual([
      ['send-keys', '-t', '=marveen-channels:', '-l', `/mcp reconnect ${TG}`],
      ['send-keys', '-t', '=marveen-channels:', 'Enter'],
      ['send-keys', '-t', '=marveen-channels:', '-l', `/mcp enable ${TG}`],
      ['send-keys', '-t', '=marveen-channels:', 'Enter'],
      ['send-keys', '-t', '=marveen-channels:', '-l', `/mcp reconnect ${TG}`],
      ['send-keys', '-t', '=marveen-channels:', 'Enter'],
    ])
  })

  it('T4b: a second "disabled" after the enable does not start another enable round', () => {
    queue(
      asTg('idle.txt'),
      asTg('idle.txt'),
      asTg('reconnect-plugin-disabled.txt'),
      asTg('reconnect-plugin-disabled.txt'),
      asTg('reconnect-plugin-disabled.txt'),
      asTg('enable-plugin-ok.txt'),
      asTg('enable-plugin-ok.txt'),
      asTg('enable-plugin-ok.txt'),
      asTg('reconnect-plugin-disabled.txt'),
    )

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('disabled')
    expect(sendKeys().length).toBe(6)
  })

  it('T5: an enable that only says already-enabled stops there', () => {
    const already = asTg('enable-plugin-ok.txt').replace('" enabled', '" is already enabled')
    expect(already).not.toBe(asTg('enable-plugin-ok.txt'))
    queue(
      asTg('idle.txt'),
      asTg('idle.txt'),
      asTg('reconnect-plugin-disabled.txt'),
      asTg('reconnect-plugin-disabled.txt'), // the step's own gate
      asTg('reconnect-plugin-disabled.txt'), // baseline (enable)
      already,
    )

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('already enabled but reported disabled')
    expect(sendKeys().length).toBe(4)
  })

  it('T6: an OLD echo+result still on screen is never read as this attempt\'s result', () => {
    const OLD = asTg('reconnect-plugin-ok.txt')
    mockCapturePane.mockReturnValue(OLD)

    const result = attemptChannelMcpReconnect('marveen')

    // The older echo makes "not observed" ambiguous (ours may have pushed it off
    // screen), so it is not reported as ok.
    expect(result.ok).toBe(false)
    expect(result.message).toBe('Outcome not observed (an identical echo on screen could not be claimed as ours)')
    expect(sendKeys().length).toBe(2)
    expect(escapes().length).toBe(0)
  })

  it('an older echo scrolled off while ours shows a failure: never ok:true', () => {
    // Baseline: one older identical echo with a success. After typing, only ONE
    // echo is visible (the older one scrolled off) and it carries a failure.
    const OLD = asTg('reconnect-plugin-ok.txt')
    const NOW = OLD.replace(/Successfully reconnected to plugin:telegram:telegram/, 'Failed to reconnect to plugin:telegram:telegram')
    expect(NOW).not.toBe(OLD)
    queue(OLD, OLD)
    mockCapturePane.mockReturnValue(NOW)

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(false)
    expect(escapes().length).toBe(0)
  })

  it('a reply of ours that matches no known literal is ok:false, not "not observed"', () => {
    const OK = asTg('reconnect-plugin-ok.txt')
    const ERR = OK.replace(/Successfully reconnected to plugin:telegram:telegram/, 'Error: connect ECONNREFUSED')
    expect(ERR).not.toBe(OK)
    queue(asTg('idle.txt'), asTg('idle.txt'))
    mockCapturePane.mockReturnValue(ERR)

    const result = attemptChannelMcpReconnect('marveen')

    expect(result).toEqual({ ok: false, message: 'Unrecognised reply to /mcp reconnect' })
  })

  it('an unreadable baseline capture types nothing', () => {
    queue(asTg('idle.txt'), null)
    mockCapturePane.mockReturnValue(asTg('reconnect-plugin-ok.txt'))

    const result = attemptChannelMcpReconnect('marveen')

    expect(result).toEqual({ ok: false, message: 'Pane unreadable -- reconnect refused' })
    expect(sendKeys().length).toBe(0)
  })

  it('T7: when the new result joins the old one, the newest echo\'s reply wins', () => {
    const OLD = asTg('reconnect-plugin-ok.txt')
    const at = OLD.split('\n').findIndex((l) => l.includes('Successfully reconnected'))
    expect(at).toBeGreaterThanOrEqual(0)
    const NEW = [
      ...OLD.split('\n').slice(0, at + 1),
      `❯ /mcp reconnect ${TG}`,
      `  ⎿  Failed to reconnect to ${TG}`,
      ...OLD.split('\n').slice(at + 1),
    ].join('\n')
    queue(OLD, OLD, OLD, OLD, NEW) // pre, baseline, two polls, new result
    queue(NEW, NEW, stacked(NEW, `Failed to reconnect to ${TG}`)) // the single retry: gate, baseline, its (final) failure

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('reconnect-failed')
  })

  it('T8: the full dialog opening instead of the command is dismissed, and only after the submit', () => {
    queue(asTg('idle.txt'), asTg('idle.txt'))
    mockCapturePane.mockReturnValue(asTg('dialog-unknown-arg.txt'))

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(false)
    expect(result.message).toBe('MCP dialog opened instead of the command')
    expect(escapes().length).toBeGreaterThan(0)
    const calls = mockExecFileSync.mock.calls
    const enterAt = calls.findIndex((c) => Array.isArray(c[1]) && c[1].includes('Enter'))
    expect(enterAt).toBeGreaterThanOrEqual(0)
    for (const esc of escapes()) expect(calls.indexOf(esc)).toBeGreaterThan(enterAt)
  })

  it('T9: the command left sitting in the input box is reported and never touched again', () => {
    // The LIVE box row is `❯` + U+00A0 (measured); a U+0020 would be an echo line.
    // pre and baseline are idle; every poll then shows the command in the box
    queue(asTg('idle.txt'), asTg('idle.txt'))
    mockCapturePane.mockReturnValue(withBoxText(asTg('idle.txt'), `❯ /mcp reconnect ${TG}`))

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(false)
    expect(result.message).toBe('Command left in the input box')
    expect(sendKeys().length).toBe(2)
    expect(escapes().length).toBe(0)
  })

  it('T10: unreadable captures are waited out, not escaped out of', () => {
    queue(asTg('idle.txt'), asTg('idle.txt'), null, null, asTg('reconnect-ok.txt'))

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(true)
    expect(result.message).toBe('Reconnected via /mcp reconnect')
    expect(escapes().length).toBe(0)
  })

  it('T11: an unsafe server name is refused before anything is typed', () => {
    mockPluginPaneIdOverride.value = 'plugin:telegram:telegram; rm'
    queue(FIX('idle.txt'))

    const result = attemptChannelMcpReconnect('marveen')

    expect(result).toEqual({ ok: false, message: 'Unsafe MCP server name -- reconnect refused' })
    expect(sendKeys().length).toBe(0)
    expect(logger.warn).toHaveBeenCalled()
  })

  it('T12: a sub-agent gets the typed command in its own session', () => {
    queue(
      asTg('idle.txt'),
      asTg('idle.txt'),
      asName(FIX('reconnect-ok.txt'), 'plugin:slack-channel:slack'),
    )

    const result = attemptChannelMcpReconnect('slacker')

    expect(result.ok).toBe(true)
    expect(sendKeys()[0]?.[1]).toEqual([
      'send-keys', '-t', '=agent-slacker:', '-l', '/mcp reconnect plugin:slack-channel:slack',
    ])
  })

  it('S1: a Slack agent types the server name, not the pane id', () => {
    queue(
      asTg('idle.txt'),
      asTg('idle.txt'),
      asName(FIX('reconnect-ok.txt'), 'plugin:slack-channel:slack'),
    )

    const result = attemptChannelMcpReconnect('slacker')

    expect(result.ok).toBe(true)
    expect(JSON.stringify(sendKeys())).not.toContain('marveen-marketplace')
  })

  it('S2: the server name is what the reply is matched against', () => {
    mockCapturePane.mockReset()
    mockCapturePane
      .mockReturnValueOnce(asTg('idle.txt'))
      .mockReturnValueOnce(asTg('idle.txt'))
      .mockReturnValueOnce(asName(FIX('reconnect-ok.txt'), 'plugin:slack-channel:marveen-marketplace'))
      .mockReturnValue(asTg('idle.txt'))

    const result = attemptChannelMcpReconnect('slacker')

    expect(result.ok === true && result.message === 'Reconnected via /mcp reconnect').toBe(false)
  })

  it('S3: an unsafe MCP server name is refused even when the pane id is safe', () => {
    mockMcpServerNameOverride.value = 'plugin:slack-channel:slack; rm'
    queue(FIX('idle.txt'))

    const result = attemptChannelMcpReconnect('slacker')

    expect(result).toEqual({ ok: false, message: 'Unsafe MCP server name -- reconnect refused' })
    expect(sendKeys().length).toBe(0)
  })

  it('T13: a tmux failure surfaces the error and sends no cleanup Escape', () => {
    queue(asTg('idle.txt'), asTg('idle.txt'))
    mockExecFileSync.mockImplementationOnce(() => { throw new Error('tmux gone') })

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(false)
    expect(result.message).toBe('tmux gone')
    expect(escapes().length).toBe(0)
  })

  it('after a tmux error mid-sequence no further key is pressed', () => {
    queue(asTg('idle.txt'), asTg('idle.txt'))
    // First call is the literal text; the settle sleep then fails.
    mockExecFileSync
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => { throw new Error('tmux gone') })

    const result = attemptChannelMcpReconnect('marveen')

    expect(result).toEqual({ ok: false, message: 'tmux gone' })
    expect(sendKeys().map((c) => c[1])).toEqual([
      ['send-keys', '-t', '=marveen-channels:', '-l', `/mcp reconnect ${TG}`],
    ])
  })

  it('T14: disabled, but the pane turned unsafe before the enable step -> deferred, no enable typed', () => {
    queue(
      asTg('idle.txt'),
      asTg('idle.txt'),
      asTg('reconnect-plugin-disabled.txt'),
      withBoxText(asTg('reconnect-plugin-disabled.txt'), '❯ parked text'), // the step's own gate
    )

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/deferred/)
    expect(sendKeys().length).toBe(2)
  })

  it('T14b: disabled, but the pane turned busy before the enable step -> deferred, no enable typed', () => {
    const BUSY = asTg('reconnect-busy.txt')
    expect(detectPaneState(BUSY)).toBe('busy') // precondition: the fixture reads busy
    queue(
      asTg('idle.txt'),
      asTg('idle.txt'),
      asTg('reconnect-plugin-disabled.txt'),
      BUSY, // the enable step's own gate
    )

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('Pane busy -- reconnect deferred')
    expect(sendKeys().length).toBe(2)
  })

  it('T15: enabled, but the pane turned unsafe before the second reconnect -> deferred, no reconnect typed', () => {
    queue(
      asTg('idle.txt'),
      asTg('idle.txt'),
      asTg('reconnect-plugin-disabled.txt'),
      asTg('reconnect-plugin-disabled.txt'), // the step's own gate
      asTg('reconnect-plugin-disabled.txt'), // baseline (enable)
      asTg('enable-plugin-ok.txt'),
      withBoxText(asTg('enable-plugin-ok.txt'), '❯ parked text'), // the step's own gate
    )

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/deferred/)
    expect(sendKeys().map((c) => c[1])).toEqual([
      ['send-keys', '-t', '=marveen-channels:', '-l', `/mcp reconnect ${TG}`],
      ['send-keys', '-t', '=marveen-channels:', 'Enter'],
      ['send-keys', '-t', '=marveen-channels:', '-l', `/mcp enable ${TG}`],
      ['send-keys', '-t', '=marveen-channels:', 'Enter'],
    ])
  })

  it('an older identical echo that comes INTO view while ours is not rendered is not read as ours', () => {
    const OLD_OK = asTg('reconnect-plugin-ok.txt').split('\n')
    const at = OLD_OK.findIndex((l) => l.startsWith('❯ /mcp reconnect ' + TG))
    expect(at).toBeGreaterThanOrEqual(0)
    // The old success at the top, then the later conversation, then the panel (no echo of ours).
    const REVEALED = [OLD_OK[at], OLD_OK[at + 1], '', '❯ a later prompt', '', '⏺ a later reply', ...OLD_OK.slice(at + 2)].join('\n')
    expect(mcpCommandReply(REVEALED, 'reconnect', TG)).not.toBeNull() // the old reply is found, so only the latest check can refuse it
    const FAILED = asTg('reconnect-plugin-failed.txt')
    // first attempt fails; the single retry (gate, baseline, final failure) fails too
    queue(asTg('idle.txt'), asTg('idle.txt'), REVEALED, FAILED, FAILED, FAILED, stacked(FAILED, `Failed to reconnect to ${TG}`))
    mockCapturePane.mockReturnValue(FAILED)

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('reconnect-failed')
  })

  it('a modal other than the /mcp dialog gets no key at all (a permission prompt would be answered)', () => {
    const OTHER = asTg('dialog-unknown-arg.txt').split('Manage MCP servers').join('Allow this tool to run?')
    expect(showsMcpDialogTitle(OTHER)).toBe(false)
    expect(detectsBlockingMenu(OTHER)).toBe(true) // precondition: it still reads as a blocking menu
    mockCapturePane.mockReturnValue(OTHER)

    const result = attemptChannelMcpReconnect('marveen')

    expect(result).toEqual({ ok: false, message: 'A dialog other than /mcp is open -- reconnect refused' })
    expect(mockExecFileSync.mock.calls.filter((c) => Array.isArray(c[1]) && c[1][0] === 'send-keys').length).toBe(0)
  })

  it('the timeout decides on a fresh capture: an unreadable pane gets no Escape', () => {
    queue(asTg('idle.txt'), asTg('idle.txt'))
    for (let i = 0; i < 10; i++) queue(asTg('dialog-unknown-arg.txt')) // every poll
    queue(null) // the timeout's fresh read

    const result = attemptChannelMcpReconnect('marveen')

    expect(result).toEqual({ ok: false, message: 'Pane unreadable after the command -- outcome not observed' })
    expect(escapes().length).toBe(0)
  })

  it('a modal other than /mcp on the timeout\'s fresh read gets no Escape', () => {
    const OTHER = asTg('dialog-unknown-arg.txt').split('Manage MCP servers').join('Allow this tool to run?')
    expect(showsMcpDialogTitle(OTHER)).toBe(false)
    expect(detectsBlockingMenu(OTHER)).toBe(true) // precondition
    queue(asTg('idle.txt'), asTg('idle.txt'))
    for (let i = 0; i < 10; i++) queue(asTg('dialog-unknown-arg.txt')) // every poll
    queue(OTHER) // the timeout's fresh read

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(false)
    expect(escapes().length).toBe(0)
  })

  it('a modal other than /mcp with the /mcp title quoted higher up in the transcript gets no key', () => {
    const OTHER = asTg('dialog-unknown-arg.txt').split('Manage MCP servers').join('Allow this tool to run?')
    const PANE = ['⏺ As the docs say, open Manage MCP servers to fix it', '', '⏺ Bash(ls)', ...OTHER.split('\n')].join('\n')
    expect(detectsBlockingMenu(PANE)).toBe(true) // precondition
    expect(PANE).toContain('Manage MCP servers') // precondition: the title words are on screen
    mockCapturePane.mockReturnValue(PANE)

    const result = attemptChannelMcpReconnect('marveen')

    expect(result).toEqual({ ok: false, message: 'A dialog other than /mcp is open -- reconnect refused' })
    expect(mockExecFileSync.mock.calls.filter((c) => Array.isArray(c[1]) && c[1][0] === 'send-keys').length).toBe(0)
  })

  it('a modal other than /mcp directly under a transcript row that quotes the /mcp title gets no key', () => {
    const OTHER = asTg('dialog-unknown-arg.txt').split('Manage MCP servers').join('Allow this tool to run?')
    const PANE = ['⏺ As the docs say, open Manage MCP servers to fix it', ...OTHER.split('\n')].join('\n')
    expect(detectsBlockingMenu(PANE)).toBe(true) // precondition
    mockCapturePane.mockReturnValue(PANE)

    const result = attemptChannelMcpReconnect('marveen')

    expect(result).toEqual({ ok: false, message: 'A dialog other than /mcp is open -- reconnect refused' })
    expect(mockExecFileSync.mock.calls.filter((c) => Array.isArray(c[1]) && c[1][0] === 'send-keys').length).toBe(0)
  })

  it('our failure reply that a later turn pushed out of the latest exchange is never ok:true', () => {
    const FAILED = asTg('reconnect-plugin-failed.txt').split('\n')
    const at = FAILED.findIndex((l) => l.startsWith('❯ /mcp reconnect ' + TG))
    expect(at).toBeGreaterThanOrEqual(0)
    const LATER = [...FAILED.slice(0, at + 2), '', '⏺ a turn started by an incoming message', ...FAILED.slice(at + 2)].join('\n')
    expect(mcpCommandReply(LATER, 'reconnect', TG)).not.toBeNull() // precondition: our reply is on screen
    queue(asTg('idle.txt'), asTg('idle.txt'))
    mockCapturePane.mockReturnValue(LATER)

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(false)
  })

  it('a dialog-open reply of ours is ok:false even without a blocking menu, and gets no Escape', () => {
    const OK = asTg('reconnect-plugin-ok.txt')
    const DIALOG_REPLY = OK.replace('Successfully reconnected to ' + TG, 'Manage MCP servers')
    expect(DIALOG_REPLY).not.toBe(OK)
    expect(detectsBlockingMenu(DIALOG_REPLY)).toBe(false) // precondition
    queue(asTg('idle.txt'), asTg('idle.txt'))
    mockCapturePane.mockReturnValue(DIALOG_REPLY)

    const result = attemptChannelMcpReconnect('marveen')

    expect(result).toEqual({ ok: false, message: 'MCP dialog opened instead of the command' })
    expect(escapes().length).toBe(0)
  })

  it('T16: a dialog that closes onto an occupied input box costs exactly one Escape', () => {
    const parked = withBoxText(asTg('idle.txt'), '❯ parked text') // the live box form: U+276F + U+00A0
    queue(asTg('idle.txt'), asTg('idle.txt')) // pre, baseline
    for (let i = 0; i < 11; i++) queue(asTg('dialog-unknown-arg.txt')) // every poll + the timeout's fresh read
    mockCapturePane.mockReturnValue(parked) // the box the first Escape reveals

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(false)
    expect(result.message).toBe('MCP dialog opened instead of the command')
    expect(escapes().length).toBe(1)
  })

  it('a final capture that still shows the Reconnecting panel is ok:false (still reconnecting)', () => {
    queue(asTg('idle.txt'), asTg('idle.txt'))
    mockCapturePane.mockReturnValue(asTg('reconnect-progress.txt'))

    const result = attemptChannelMcpReconnect('marveen')

    expect(result).toEqual({ ok: false, message: 'Still reconnecting -- outcome not observed' })
    expect(sendKeys().length).toBe(2)
    expect(escapes().length).toBe(0)
  })

  it('the panel of another server is not ours', () => {
    queue(asTg('idle.txt'), asTg('idle.txt'))
    mockCapturePane.mockReturnValue(asName(FIX('reconnect-progress.txt'), 'plugin:other:other'))

    const result = attemptChannelMcpReconnect('marveen')

    expect(result).toEqual({ ok: true, message: 'Command sent; outcome not observed' })
  })

  it('a panel seen only during the polls, then an idle pane, keeps the old not-observed result', () => {
    queue(asTg('idle.txt'), asTg('idle.txt'))
    for (let i = 0; i < 10; i++) queue(asTg('reconnect-progress.txt'))
    queue(asTg('idle.txt'))

    const result = attemptChannelMcpReconnect('marveen')

    expect(result).toEqual({ ok: true, message: 'Command sent; outcome not observed' })
  })
})
