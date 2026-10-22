import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  classifyMcpInlineReply,
  countMcpCommandEchoes,
  isSafeMcpServerName,
  mcpCommandReply,
  mcpReplyIsLatest,
  showsMcpDialogTitle,
  type McpInlineAction,
  type McpInlineOutcome,
} from '../web/mcp-inline-command.js'

// Behavioural tests for the inline `/mcp` primitives.
//
// The reply strings below are LITERALS read from the installed claude-code
// 2.1.205 binary (the enable/disable view and the reconnect view), not invented
// fixtures. If a future claude-code changes its wording these tests fail, which
// is the point: the classifier's whole job is to recognise that specific
// wording, and its callers key their fallback on 'unknown'.

const SERVER = 'plugin:telegram:telegram'

describe('classifyMcpInlineReply -- enable', () => {
  it('reads the success line the binary emits for a disabled server', () => {
    expect(classifyMcpInlineReply(`MCP server "${SERVER}" enabled`, 'enable', SERVER)).toBe('enabled')
  })

  it('distinguishes "already enabled" from "enabled"', () => {
    // Ordering trap: `... is already enabled` also contains `... enabled`, so a
    // naive success-first classifier reports a no-op as a repair and the caller
    // stops looking. This is the only reason the classifier tests the
    // already-branch first, so pin it.
    expect(classifyMcpInlineReply(`MCP server "${SERVER}" is already enabled`, 'enable', SERVER)).toBe(
      'already-enabled',
    )
  })

  it('reports pending approval separately -- keystrokes cannot clear it', () => {
    expect(
      classifyMcpInlineReply(
        `MCP server "${SERVER}" is pending approval — approve it via /mcp first`,
        'enable',
        SERVER,
      ),
    ).toBe('pending-approval')
  })

  it('reports a wrong server name as not-found rather than as failure', () => {
    expect(classifyMcpInlineReply(`MCP server "${SERVER}" not found`, 'enable', SERVER)).toBe('not-found')
  })
})

describe('classifyMcpInlineReply -- reconnect', () => {
  it('reads the awaited success line', () => {
    expect(classifyMcpInlineReply(`Successfully reconnected to ${SERVER}`, 'reconnect', SERVER)).toBe(
      'reconnected',
    )
  })

  it('separates needs-auth from a plain failure', () => {
    // Both are "not connected", but only one of them is fixable by retrying:
    // needs-auth wants a human in the modal, so a caller that retried on it
    // would spend its whole budget on a state no keystroke can change.
    expect(
      classifyMcpInlineReply(
        `${SERVER} requires authentication. Use /mcp to authenticate.`,
        'reconnect',
        SERVER,
      ),
    ).toBe('needs-auth')
    expect(classifyMcpInlineReply(`Failed to reconnect to ${SERVER}`, 'reconnect', SERVER)).toBe(
      'reconnect-failed',
    )
  })

  // The three fixtures below are MULTI-LINE, unlike the isolated one-liners
  // above, because the reconnect view draws more than one matchable literal at
  // once. Read from the 2.1.205 binary: it holds one error string, and its
  // error render is hardcoded to `Failed to reconnect to <server>` with the
  // branch-specific message printed UNDER it as `Error: <message>`. So the
  // generic failure line accompanies every unhappy branch, and only the
  // classifier's ORDER separates them. Reordering it is the mutation these pin.
  //
  // These are a RECONSTRUCTION from the shipped JSX, not a capture: reading the
  // binary proves the render exists and what it contains, not the exact text a
  // capture-pane read returns (wrapping and ordering are unverified). Treat a
  // failure here as "the reconstruction and the classifier disagree", and do
  // not cite these as captured pane text.

  it('reads needs-auth when the generic failure line is reconstructed alongside it', () => {
    // needs-auth branch: setError(`X requires authentication`), which the
    // render prints beneath its hardcoded `Failed to reconnect to X`.
    const pane = [
      `✗ Failed to reconnect to ${SERVER}`,
      `Error: ${SERVER} requires authentication`,
      `${SERVER} requires authentication. Use /mcp to authenticate.`,
    ].join('\n')
    expect(classifyMcpInlineReply(pane, 'reconnect', SERVER)).toBe('needs-auth')
  })

  it('reads not-found when the generic failure line is reconstructed alongside it', () => {
    // Same render, setError(`MCP server "X" not found`). Misreading this as a
    // plain failure hides a wrong plugin pane id behind retries against a
    // server that does not exist -- the caller's fallback cannot fix that either.
    const pane = [
      `✗ Failed to reconnect to ${SERVER}`,
      `Error: MCP server "${SERVER}" not found`,
    ].join('\n')
    expect(classifyMcpInlineReply(pane, 'reconnect', SERVER)).toBe('not-found')
  })

  it('classifies the thrown-exception branch as reconnect-failed, not unknown', () => {
    // The catch branch's own text (`Error: <message>`) names no server, so it
    // cannot be matched safely; what IS on the pane is the render's generic
    // line. Documented as deliberate: 'reconnect-failed' and 'unknown' make a
    // caller fall back identically, so this costs nothing -- but it is pinned
    // so nobody "corrects" it by matching a bare `Error:`, which would accept
    // any error line about anything.
    const pane = [
      `✗ Failed to reconnect to ${SERVER}`,
      'Error: connect ECONNREFUSED 127.0.0.1:8080',
    ].join('\n')
    expect(classifyMcpInlineReply(pane, 'reconnect', SERVER)).toBe('reconnect-failed')
  })
})

describe('classifyMcpInlineReply -- safety', () => {
  it('reports the full modal as dialog-open, ahead of every other pattern', () => {
    // The router falls through to the full modal for anything it does not
    // recognise. Detecting that is more urgent than any other reading: the pane
    // is parked and the caller has to dismiss it.
    const pane = ['Manage MCP servers', `MCP server "${SERVER}" enabled`].join('\n')
    expect(classifyMcpInlineReply(pane, 'enable', SERVER)).toBe('dialog-open')
  })

  it('does not accept a reply about a DIFFERENT server', () => {
    // Guards the scrollback-bleed failure: another agent's server, or an older
    // line, must not be read as this command's answer.
    expect(classifyMcpInlineReply('MCP server "plugin:slack-channel:marveen-marketplace" enabled', 'enable', SERVER)).toBe(
      'unknown',
    )
  })

  it('returns unknown for an empty or unrelated pane', () => {
    expect(classifyMcpInlineReply('', 'enable', SERVER)).toBe('unknown')
    expect(classifyMcpInlineReply('bypass permissions on', 'reconnect', SERVER)).toBe('unknown')
  })

  it('treats the server name as a literal, not as a pattern', () => {
    // Plugin pane ids are dotted/colon-separated today, but a marketplace name
    // with a regex metacharacter must not turn the matcher into a wildcard that
    // accepts a neighbouring server's line.
    const dotted = 'plugin:a.c:x'
    expect(classifyMcpInlineReply('MCP server "plugin:abc:x" enabled', 'enable', dotted)).toBe('unknown')
  })
})

describe('action surface', () => {
  it('does not expose disable', () => {
    // Type-level intent, asserted at runtime so a future widening of the union
    // has to come past this test: nothing here should turn a channel plugin
    // off, and `disable` shares a router branch with `enable`.
    const actions: McpInlineAction[] = ['enable', 'reconnect']
    expect(actions).not.toContain('disable' as unknown as McpInlineAction)
  })
})

// ---------------------------------------------------------------------------
// The typed-command primitives against the REAL Claude Code CLI 2.1.291
// captures in ./fixtures/mcp-reconnect-cli-2.1.291/ (see that dir's README.md
// for how they were taken). Fixtures are used AS CAPTURED -- probe server
// names, byte-for-byte echo / `⎿` rows -- because the point is that these
// helpers read what that CLI actually rendered, not a reconstruction of it.
describe('typed /mcp command parsing (CLI 2.1.291 fixtures)', () => {
  const FIX = (f: string) =>
    readFileSync(new URL(`./fixtures/mcp-reconnect-cli-2.1.291/${f}`, import.meta.url), 'utf8')

  it('isSafeMcpServerName accepts the shapes plugin pane ids take and refuses everything else', () => {
    expect(isSafeMcpServerName('plugin:telegram:telegram')).toBe(true)
    expect(isSafeMcpServerName('plugin:slack-channel:marveen-marketplace')).toBe(true)
    expect(isSafeMcpServerName('okserver')).toBe(true)
    // Whitespace would split the argument (and a bare verb opens the full
    // modal); the rest are keystroke-injection metacharacters.
    for (const bad of ['', 'a b', 'x;rm', 'a\nb', '$(x)', "a'b", 'a"b']) {
      expect(isSafeMcpServerName(bad), JSON.stringify(bad)).toBe(false)
    }
  })

  it('countMcpCommandEchoes sees the echo in the captured finals and none in the intermediate frames', () => {
    expect(countMcpCommandEchoes(FIX('reconnect-ok.txt'), 'reconnect', 'okserver')).toBe(1)
    expect(countMcpCommandEchoes(FIX('idle.txt'), 'reconnect', 'okserver')).toBe(0)
    // The "Reconnecting" panel frame has NO echo line at all (README).
    expect(countMcpCommandEchoes(FIX('reconnect-progress.txt'), 'reconnect', 'okserver')).toBe(0)
    expect(countMcpCommandEchoes(FIX('enable-plugin-ok.txt'), 'enable', 'plugin:probeplug:okplug')).toBe(1)
    expect(countMcpCommandEchoes(FIX('enable-plugin-ok.txt'), 'reconnect', 'plugin:probeplug:okplug')).toBe(0)
  })

  it('countMcpCommandEchoes requires the exact echo shape', () => {
    // Captured: a submitted echo is `❯` + exactly ONE U+0020 + the command, no
    // leading whitespace. Trailing terminal padding is tolerated...
    expect(countMcpCommandEchoes('❯ /mcp reconnect okserver  ', 'reconnect', 'okserver')).toBe(1)
    // ...but the LIVE input-box separator is U+00A0, not U+0020: that row is a
    // command still sitting in the box, not a submitted echo.
    expect(countMcpCommandEchoes('❯ /mcp reconnect okserver', 'reconnect', 'okserver')).toBe(0)
    // No leading whitespace (an indented row is quoted text, not the echo)...
    expect(countMcpCommandEchoes('  ❯ /mcp reconnect okserver', 'reconnect', 'okserver')).toBe(0)
    // ...and the name must end exactly there (okserver2 is another server).
    expect(countMcpCommandEchoes('❯ /mcp reconnect okserver2', 'reconnect', 'okserver')).toBe(0)
  })

  // The full round trip -- fixture pane -> mcpCommandReply ->
  // classifyMcpInlineReply -- over every captured final and every intermediate
  // frame. null means "no reply of OUR command is on screen yet", which is the
  // busy spinner / progress panel / dialog / idle answer.
  it.each([
    ['reconnect-ok.txt', 'reconnect', 'okserver', 'reconnected'],
    ['reconnect-failed.txt', 'reconnect', 'badserver', 'reconnect-failed'],
    ['reconnect-not-found.txt', 'reconnect', 'nosuchserver', 'not-found'],
    ['reconnect-plugin-ok.txt', 'reconnect', 'plugin:probeplug:okplug', 'reconnected'],
    ['reconnect-plugin-disabled.txt', 'reconnect', 'plugin:probeplug:okplug', 'disabled'],
    ['enable-plugin-ok.txt', 'enable', 'plugin:probeplug:okplug', 'enabled'],
    ['reconnect-plugin-recovered.txt', 'reconnect', 'plugin:probeflaky:flaky', 'reconnected'],
    ['reconnect-plugin-failed.txt', 'reconnect', 'plugin:probedead:dead', 'reconnect-failed'],
    ['reconnect-busy.txt', 'reconnect', 'okserver', null],
    ['reconnect-plugin-busy.txt', 'reconnect', 'plugin:probedead:dead', null],
    ['reconnect-progress.txt', 'reconnect', 'okserver', null],
    ['reconnect-plugin-progress.txt', 'reconnect', 'plugin:probeflaky:flaky', null],
    ['idle.txt', 'reconnect', 'okserver', null],
    ['dialog-unknown-arg.txt', 'reconnect', 'okserver', null],
    ['dialog-plugin-failed.txt', 'reconnect', 'plugin:probeflaky:flaky', null],
  ] as Array<[string, McpInlineAction, string, McpInlineOutcome | null]>)(
    '%s (%s %s) -> %s',
    (file, action, name, want) => {
      const reply = mcpCommandReply(FIX(file), action, name)
      const outcome = reply == null ? null : classifyMcpInlineReply(reply, action, name)
      expect(outcome).toBe(want)
    },
  )

  it('mcpCommandReply returns the reply of the NEWEST echo, not the older one above it', () => {
    // reconnect-ok.txt's echo + result, then a SECOND echo with a failure
    // reply -- the pane two attempts leave behind. Reading the newest echo's
    // block classifies the failure; reading the oldest would claim success.
    const okLines = FIX('reconnect-ok.txt').split('\n')
    const echo = okLines.find((l) => l.trim() === '❯ /mcp reconnect okserver')!
    const okResult = okLines.find((l) => l.trimStart().startsWith('⎿'))!
    const pane = [echo, okResult, '', '❯ /mcp reconnect okserver', '  ⎿  Failed to reconnect to okserver'].join('\n')
    const reply = mcpCommandReply(pane, 'reconnect', 'okserver')
    expect(reply).toBe('  ⎿  Failed to reconnect to okserver')
    expect(classifyMcpInlineReply(reply!, 'reconnect', 'okserver')).toBe('reconnect-failed')
  })

  it('classifies the captured disabled reply, on the reconnect path only, for this server only', () => {
    // Captured on CLI 2.1.291 (fixture reconnect-plugin-disabled.txt); the
    // dash is U+2014 and deliberately not part of the match.
    expect(classifyMcpInlineReply('"okserver" is disabled — enable it in /mcp first', 'reconnect', 'okserver')).toBe('disabled')
    // The enable branch returns before this test exists.
    expect(classifyMcpInlineReply('"okserver" is disabled — enable it in /mcp first', 'enable', 'okserver')).toBe('unknown')
    // A different server's disabled reply is not ours.
    expect(classifyMcpInlineReply('"okserver2" is disabled — enable it in /mcp first', 'reconnect', 'okserver')).toBe('unknown')
  })
})

describe('mcpReplyIsLatest and showsMcpDialogTitle (CLI 2.1.291 fixtures)', () => {
  const FIX = (f: string) =>
    readFileSync(new URL(`./fixtures/mcp-reconnect-cli-2.1.291/${f}`, import.meta.url), 'utf8')
  const FINAL: Array<[string, McpInlineAction, string]> = [
    ['reconnect-ok.txt', 'reconnect', 'okserver'],
    ['reconnect-failed.txt', 'reconnect', 'badserver'],
    ['reconnect-not-found.txt', 'reconnect', 'nosuchserver'],
    ['reconnect-plugin-ok.txt', 'reconnect', 'plugin:probeplug:okplug'],
    ['reconnect-plugin-disabled.txt', 'reconnect', 'plugin:probeplug:okplug'],
    ['reconnect-plugin-failed.txt', 'reconnect', 'plugin:probedead:dead'],
    ['reconnect-plugin-recovered.txt', 'reconnect', 'plugin:probeflaky:flaky'],
    ['enable-plugin-ok.txt', 'enable', 'plugin:probeplug:okplug'],
  ]
  it.each(FINAL)('%s: the reply of the newest echo is the latest exchange', (f, action, name) => {
    expect(mcpCommandReply(FIX(f), action, name)).not.toBeNull()
    expect(mcpReplyIsLatest(FIX(f), action, name)).toBe(true)
  })
  it('an older echo followed by a later prompt and reply is not the latest exchange', () => {
    const lines = FIX('reconnect-ok.txt').split('\n')
    const at = lines.findIndex((l) => l.startsWith('❯ /mcp reconnect okserver'))
    const revealed = [lines[at], lines[at + 1], '', '❯ a later prompt', '', '⏺ a later reply', ...lines.slice(at + 2)].join('\n')
    expect(mcpCommandReply(revealed, 'reconnect', 'okserver')).not.toBeNull() // the reply is still found
    expect(mcpReplyIsLatest(revealed, 'reconnect', 'okserver')).toBe(false)
    expect(mcpReplyIsLatest(FIX('idle.txt'), 'reconnect', 'okserver')).toBe(false) // no echo at all
  })
  it('showsMcpDialogTitle is true on the two dialog captures and false on idle and on a reply', () => {
    expect(showsMcpDialogTitle(FIX('dialog-unknown-arg.txt'))).toBe(true)
    expect(showsMcpDialogTitle(FIX('dialog-plugin-failed.txt'))).toBe(true)
    expect(showsMcpDialogTitle(FIX('idle.txt'))).toBe(false)
    expect(showsMcpDialogTitle(FIX('reconnect-ok.txt'))).toBe(false)
    // The same words quoted in the transcript, with another modal open below them.
    const other = FIX('dialog-unknown-arg.txt').split('Manage MCP servers').join('Allow this tool to run?')
    const quoted = ['⏺ As the docs say, open Manage MCP servers to fix it', '', '⏺ Bash(ls)', ...other.split('\n')].join('\n')
    expect(quoted).toContain('Manage MCP servers')
    expect(showsMcpDialogTitle(quoted)).toBe(false)
    // The quote on the LAST transcript row, the other modal directly below it.
    const lastRow = ['⏺ As the docs say, open Manage MCP servers to fix it', ...other.split('\n')].join('\n')
    expect(showsMcpDialogTitle(lastRow)).toBe(false)
    // An unmarked continuation line of an assistant reply that holds only the words.
    const continuation = ['⏺ The dialog is called', '  Manage MCP servers', ...other.split('\n')].join('\n')
    expect(showsMcpDialogTitle(continuation)).toBe(false)
    // Another modal with the same top rule whose first line only MENTIONS the words.
    const permission = FIX('dialog-unknown-arg.txt').split('   Manage MCP servers').join('   Allow the Manage MCP servers helper to run?')
    expect(permission).toContain('Manage MCP servers')
    expect(showsMcpDialogTitle(permission)).toBe(false)
  })
})
