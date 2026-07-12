import { describe, it, expect } from 'vitest'
import {
  deriveProcessPattern,
  collectSubtreeCmdlines,
  decideMcpPrecheck,
} from '../web/schedule-mcp-precheck.js'
import { parseRequires } from '../web/scheduled-tasks-io.js'

// MCP manifest pre-check (Roitman 22.5): requires.mcp_servers parsing, ps
// pattern derivation, session-subtree collection and the pure block/fail-open
// decision. The scenario mirrors the 2026-07-08 incident: gmail-readonly dead
// in the target session while its siblings live.

describe('parseRequires (task-config requires.mcp_servers)', () => {
  it('elfogadja a string-tömböt', () => {
    expect(parseRequires({ mcp_servers: ['gmail-readonly', 'gcalendar'] }))
      .toEqual({ mcp_servers: ['gmail-readonly', 'gcalendar'] })
  })

  it('hibás alakot csendben eldob (nem tömbszerű, üres, nem-string elemek)', () => {
    expect(parseRequires(undefined)).toBeUndefined()
    expect(parseRequires({ mcp_servers: 'gmail' as unknown as string[] })).toBeUndefined()
    expect(parseRequires({ mcp_servers: [] })).toBeUndefined()
    expect(parseRequires({ mcp_servers: [42, '', '  '] as unknown as string[] })).toBeUndefined()
    expect(parseRequires({ mcp_servers: [42, 'gmail-readonly'] as unknown as string[] }))
      .toEqual({ mcp_servers: ['gmail-readonly'] })
  })
})

describe('deriveProcessPattern', () => {
  it('a script-path arg a megkülönböztető minta (az interpreter közös)', () => {
    expect(deriveProcessPattern({ command: 'node', args: ['/Users/x/gmail-mcp-readonly/dist/index.js'] }))
      .toBe('/Users/x/gmail-mcp-readonly/dist/index.js')
  })

  it('bare binárisnál command + első arg', () => {
    expect(deriveProcessPattern({ command: 'garmin-mcp', args: [] })).toBe('garmin-mcp')
    expect(deriveProcessPattern({ command: 'npx', args: ['ollama-mcp'] })).toBe('npx ollama-mcp')
  })

  it('command nélkül nincs minta (fail-open jelzés)', () => {
    expect(deriveProcessPattern({})).toBeNull()
  })
})

describe('collectSubtreeCmdlines', () => {
  const PS = [
    '  PID  PPID COMMAND',
    '    1     0 /sbin/launchd',
    '  100     1 tmux server',
    '  200   100 claude',
    '  201   200 node /Users/x/gmail-mcp-readonly/dist/index.js',
    '  202   200 npm exec ollama-mcp',
    '  203   202 node /Users/x/.npm/_npx/abc/node_modules/.bin/ollama-mcp',
    '  900     1 node /Users/x/gmail-mcp-readonly/dist/index.js',
  ].join('\n')

  it('csak a gyökér alatti részfát gyűjti (idegen session gmail-je nem számít)', () => {
    const cmds = collectSubtreeCmdlines(PS, 200)
    expect(cmds).toContain('claude')
    expect(cmds).toContain('node /Users/x/gmail-mcp-readonly/dist/index.js')
    expect(cmds).toContain('node /Users/x/.npm/_npx/abc/node_modules/.bin/ollama-mcp')
    expect(cmds).not.toContain('/sbin/launchd')
    // PID 900 is another session's gmail: same cmdline string exists once via
    // 201; removing 201 must make it invisible even though 900 lives.
    const without201 = PS.split('\n').filter((l) => !l.includes(' 201 ')).join('\n')
    expect(collectSubtreeCmdlines(without201, 200)).not.toContain('node /Users/x/gmail-mcp-readonly/dist/index.js')
  })
})

describe('decideMcpPrecheck (pure block / fail-open)', () => {
  const patterns = {
    'gmail-readonly': '/Users/x/gmail-mcp-readonly/dist/index.js',
    'ollama': 'npx ollama-mcp',
  }

  it('halott kötelező szerver -> blokkol és megnevezi (2026-07-08 eset)', () => {
    const cmdlines = ['claude', 'npm exec ollama-mcp', 'npx ollama-mcp']
    const r = decideMcpPrecheck(['gmail-readonly', 'ollama'], patterns, cmdlines)
    expect(r.ok).toBe(false)
    expect(r.missing).toEqual(['gmail-readonly'])
  })

  it('minden él -> ok', () => {
    const cmdlines = ['claude', 'node /Users/x/gmail-mcp-readonly/dist/index.js', 'npx ollama-mcp']
    expect(decideMcpPrecheck(['gmail-readonly', 'ollama'], patterns, cmdlines).ok).toBe(true)
  })

  it('ismeretlen szervernév -> fail-open (unknown-ban jelezve, nem blokkol)', () => {
    const r = decideMcpPrecheck(['nonexistent-server'], patterns, ['claude'])
    expect(r.ok).toBe(true)
    expect(r.unknown).toEqual(['nonexistent-server'])
  })
})
