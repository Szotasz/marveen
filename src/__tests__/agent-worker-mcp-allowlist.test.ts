// WORKERMCPSEND1104: a background worker gets only the MCP server its prompts use. The worker's .claude.json is built
// from the host's ~/.claude.json: the user-scope servers go, and of the project scope only the allowlisted mail
// server stays (the heartbeat reads mail through it). An unknown server drops out, and its NAME is logged.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildWorkerClaudeJson, filterWorkerMcpServers, WORKER_MAIL_MCP_PACKAGES } from '../web/agent-worker.js'

const ROOT = join(__dirname, '..', '..')
const PROJECT = '/srv/install'
const HOME = '/srv/worker-home'

// The shape measured on this install (2026-11-04): four user-scope servers, two project-scope ones.
function hostJson(): Record<string, any> {
  return {
    hasCompletedOnboarding: false,
    mcpServers: {
      Filesystem: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/'] },
      gitnexus: { type: 'stdio', command: 'gitnexus', args: ['mcp'] },
      'google-drive': { type: 'stdio', command: 'npx', args: ['-y', '@piotr-agier/google-drive-mcp'] },
      meshy: { type: 'stdio', command: 'npx', args: ['-y', '@meshy-ai/meshy-mcp-server'] },
    },
    projects: {
      [PROJECT]: {
        allowedTools: [],
        mcpServers: {
          'server-gmail-autoauth-mcp': { type: 'stdio', command: 'npx', args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'] },
          'server-google-calendar-mcp': { type: 'stdio', command: 'npx', args: ['-y', '@cocal/google-calendar-mcp'] },
        },
      },
      '/elsewhere': { mcpServers: { other: { command: 'x' } } },
    },
  }
}

describe('buildWorkerClaudeJson', () => {
  it('the worker ends up with exactly one MCP server: the allowlisted mail server', () => {
    const parsed = hostJson()
    const r = buildWorkerClaudeJson(parsed, PROJECT, [HOME, '/private' + HOME])
    expect(parsed.mcpServers).toEqual({})
    for (const k of [HOME, '/private' + HOME]) {
      expect(Object.keys(parsed.projects[k].mcpServers)).toEqual(['server-gmail-autoauth-mcp'])
      expect(parsed.projects[k]).toMatchObject({ hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, projectOnboardingSeenCount: 1, allowedTools: [] })
    }
    expect(r.droppedUser.sort()).toEqual(['Filesystem', 'gitnexus', 'google-drive', 'meshy'])
    expect(r.droppedProject).toEqual(['server-google-calendar-mcp'])
    expect(parsed.hasCompletedOnboarding).toBe(true)
  })

  it('the host project entry itself is left as it was (only the worker keys get the filtered copy)', () => {
    const parsed = hostJson()
    buildWorkerClaudeJson(parsed, PROJECT, [HOME])
    expect(Object.keys(parsed.projects[PROJECT].mcpServers)).toEqual(['server-gmail-autoauth-mcp', 'server-google-calendar-mcp'])
  })

  it('no project entry, no user servers: an empty, trusted worker entry', () => {
    const parsed: Record<string, any> = {}
    expect(buildWorkerClaudeJson(parsed, PROJECT, [HOME])).toEqual({ droppedUser: [], droppedProject: [] })
    expect(parsed.mcpServers).toEqual({})
    expect(parsed.projects[HOME].mcpServers).toEqual({})
  })
})

describe('filterWorkerMcpServers (fail-closed)', () => {
  const gmail = (args: unknown[], extra: Record<string, unknown> = {}) => ({ x: { command: 'npx', args, ...extra } })

  it('an unknown server drops out, under any name', () => {
    expect(filterWorkerMcpServers({ gmail: { command: 'npx', args: ['-y', '@someone/mail-mcp'] } })).toEqual({ kept: {}, dropped: ['gmail'] })
  })

  it('the exact shape is kept: npx, only -y/--yes, the package with an optional @version, nothing after', () => {
    for (const args of [
      ['-y', '@gongrzhe/server-gmail-autoauth-mcp'],
      ['-y', '@gongrzhe/server-gmail-autoauth-mcp@1.1.11'],
      ['--yes', '@gongrzhe/server-gmail-autoauth-mcp'],
      ['-y', '--yes', '@gongrzhe/server-gmail-autoauth-mcp'],
      ['@gongrzhe/server-gmail-autoauth-mcp'],
    ]) expect(Object.keys(filterWorkerMcpServers(gmail(args)).kept), JSON.stringify(args)).toEqual(['x'])
  })

  it('the host\'s resolved npx path counts as npx; another path or command does not', () => {
    const npx = '/opt/homebrew/bin/npx'
    const at = (command: string) => ({ x: { command, args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'] } })
    expect(Object.keys(filterWorkerMcpServers(at(npx), npx).kept)).toEqual(['x'])
    expect(filterWorkerMcpServers(at(npx)).dropped).toEqual(['x'])
    expect(filterWorkerMcpServers(at('/tmp/evil/npx'), npx).dropped).toEqual(['x'])
    expect(filterWorkerMcpServers(at('node'), npx).dropped).toEqual(['x'])
    expect(filterWorkerMcpServers({ x: { command: '@gongrzhe/server-gmail-autoauth-mcp' } }, npx).dropped).toEqual(['x'])
  })

  it('Dani\'s #2499 review: a shell or another package that merely NAMES the mail package drops out', () => {
    expect(filterWorkerMcpServers({ x: { command: '/bin/sh', args: ['-c', 'anything', '@gongrzhe/server-gmail-autoauth-mcp'] } }).dropped).toEqual(['x'])
    expect(filterWorkerMcpServers(gmail(['-y', 'some-other-mcp', '@gongrzhe/server-gmail-autoauth-mcp'])).dropped).toEqual(['x'])
    expect(filterWorkerMcpServers(gmail(['-y', '@gongrzhe/server-gmail-autoauth-mcp', '--extra'])).dropped).toEqual(['x'])
    expect(filterWorkerMcpServers(gmail(['-p', 'x', '@gongrzhe/server-gmail-autoauth-mcp'])).dropped).toEqual(['x'])
    // a flag other than -y/--yes right before the package changes what npx runs
    expect(filterWorkerMcpServers(gmail(['--prefix=/tmp/x', '@gongrzhe/server-gmail-autoauth-mcp'])).dropped).toEqual(['x'])
    expect(filterWorkerMcpServers(gmail(['-y', '--registry=https://x.test', '@gongrzhe/server-gmail-autoauth-mcp'])).dropped).toEqual(['x'])
    expect(filterWorkerMcpServers(gmail(['-y', 7, '@gongrzhe/server-gmail-autoauth-mcp'])).dropped).toEqual(['x'])
    expect(filterWorkerMcpServers({ x: { command: 'npx', args: '@gongrzhe/server-gmail-autoauth-mcp' } }).dropped).toEqual(['x'])
  })

  it('a look-alike or an embedded mention is not the package', () => {
    for (const args of [
      ['-y', '@gongrzhe/server-gmail-autoauth-mcp-evil'],
      ['-y', 'evil@gongrzhe/server-gmail-autoauth-mcp'],
      ['-y', '/tmp/@gongrzhe/server-gmail-autoauth-mcp/x.js'],
      ['-y', 'other', '--note=@gongrzhe/server-gmail-autoauth-mcp'],
      // only ONE trailing @version comes off: anything after a second @ is not that package
      ['-y', '@gongrzhe/server-gmail-autoauth-mcp@1.0@other'],
    ]) expect(filterWorkerMcpServers(gmail(args)).dropped, JSON.stringify(args)).toEqual(['x'])
  })

  it('a url (http/sse) server or a malformed entry drops out', () => {
    expect(filterWorkerMcpServers(gmail(['@gongrzhe/server-gmail-autoauth-mcp'], { type: 'http' })).dropped).toEqual(['x'])
    expect(filterWorkerMcpServers(gmail(['@gongrzhe/server-gmail-autoauth-mcp'], { url: 'https://x.test' })).dropped).toEqual(['x'])
    expect(filterWorkerMcpServers({ a: null, b: 'str', c: [], d: { args: ['@gongrzhe/server-gmail-autoauth-mcp'] } }).dropped).toEqual(['a', 'b', 'c', 'd'])
    expect(filterWorkerMcpServers({ x: { command: 'npx' } }).dropped).toEqual(['x'])
    expect(filterWorkerMcpServers(null)).toEqual({ kept: {}, dropped: [] })
    expect(filterWorkerMcpServers([])).toEqual({ kept: {}, dropped: [] })
  })

  it('the allowlist is exactly the mail server the heartbeat reads', () => {
    expect([...WORKER_MAIL_MCP_PACKAGES]).toEqual(['@gongrzhe/server-gmail-autoauth-mcp'])
  })
})

describe('wiring (static)', () => {
  it('ensureWorkerCwd builds the worker .claude.json through buildWorkerClaudeJson and logs the dropped names', () => {
    const src = readFileSync(join(ROOT, 'src', 'web', 'agent-worker.ts'), 'utf-8')
    const body = src.slice(src.indexOf('export function ensureWorkerCwd'))
    expect(body).toContain("buildWorkerClaudeJson(parsed, PROJECT_ROOT, keys, tryResolveFromPath('npx'))")
    expect(body).toContain('droppedUser, droppedProject')
    // the old unfiltered mirror is gone
    expect(src).not.toMatch(/const trusted = \{ \.\.\.base, hasTrustDialogAccepted/)
  })
})
