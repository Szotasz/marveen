import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// MCPOROKLES923 -- owner decision (b): a NEW agent inherits MCP servers only from
// an explicit list (AGENT_INHERITED_MCP_SERVERS), on BOTH inheritance paths:
//   1. agent-scaffold.ts: the project-root .mcp.json copy;
//   2. agent-process.ts: the isolated .claude.json first-seed + gap-fill from the
//      shared ~/.claude.json (measured: google-drive and Filesystem, i.e. the
//      owner's Drive, in all 15 agents' configs).
// Marveen's two controls: (i) an UNLISTED server does not arrive; (ii) a LISTED one
// does -- without (ii) a green run could just mean "we copy nothing any more".
// And the 2026-09-05 scope-collision rule must survive the filter.

const SANDBOX = mkdtempSync(join(tmpdir(), 'mcpinherit-'))
let LIST = ''

vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>()
  return { ...actual, homedir: () => join(SANDBOX, 'home') }
})
vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: join(SANDBOX, 'project'), STORE_DIR: join(SANDBOX, 'project', 'store') }
})
vi.mock('../web/agent-config.js', async (orig) => {
  const actual = await orig<typeof import('../web/agent-config.js')>()
  return { ...actual, agentDir: (name: string) => join(SANDBOX, 'agents', name) }
})
vi.mock('../settings-store.js', async (orig) => {
  const actual = await orig<typeof import('../settings-store.js')>()
  return {
    ...actual,
    getEffectiveSettingValue: (key: string) =>
      key === 'AGENT_INHERITED_MCP_SERVERS' ? LIST : actual.getEffectiveSettingValue(key),
  }
})

const { scaffoldAgentDir } = await import('../web/agent-scaffold.js')
const { ensureIsolatedChannelConfigDir } = await import('../web/agent-process.js')
const { MAIN_AGENT_ID } = await import('../config.js')
const { filterInheritableMcpServers, readInheritableMcpServerNames } = await import('../web/mcp-inheritance.js')
const { logger } = await import('../logger.js')

const def = (cmd: string) => ({ command: 'npx', args: [cmd] })

function resetSandbox(): void {
  rmSync(join(SANDBOX, 'home'), { recursive: true, force: true })
  rmSync(join(SANDBOX, 'agents'), { recursive: true, force: true })
  rmSync(join(SANDBOX, 'project'), { recursive: true, force: true })
  mkdirSync(join(SANDBOX, 'home', '.claude'), { recursive: true })
  writeFileSync(join(SANDBOX, 'home', '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: {} }))
  mkdirSync(join(SANDBOX, 'project', 'store'), { recursive: true })
}
function writeProjectMcp(servers: Record<string, unknown>): void {
  writeFileSync(join(SANDBOX, 'project', '.mcp.json'), JSON.stringify({ mcpServers: servers }))
}
function writeSharedDotClaude(servers: Record<string, unknown>): void {
  writeFileSync(join(SANDBOX, 'home', '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, mcpServers: servers }))
}
function agentMcpServers(name: string): string[] {
  const j = JSON.parse(readFileSync(join(SANDBOX, 'agents', name, '.mcp.json'), 'utf-8')) as { mcpServers: Record<string, unknown> }
  return Object.keys(j.mcpServers).sort()
}
function isolatedServers(name: string): string[] {
  const p = join(SANDBOX, 'agents', name, '.claude-config', '.claude.json')
  const j = JSON.parse(readFileSync(p, 'utf-8')) as { mcpServers?: Record<string, unknown> }
  return Object.keys(j.mcpServers ?? {}).sort()
}

beforeEach(() => { resetSandbox(); LIST = '' })
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }))

describe('the list itself', () => {
  it('parses a comma list, trims, ignores blanks; an empty setting is the narrow default', () => {
    LIST = ' aiam-blog , ,google-drive '
    expect([...readInheritableMcpServerNames()].sort()).toEqual(['aiam-blog', 'google-drive'])
    LIST = ''
    expect(readInheritableMcpServerNames().size).toBe(0)
  })

  it('filter keeps listed, names the rest, never mutates its input', () => {
    const servers = { a: def('a'), b: def('b') }
    const { kept, dropped } = filterInheritableMcpServers(servers, new Set(['a']))
    expect(Object.keys(kept)).toEqual(['a'])
    expect(dropped).toEqual(['b'])
    expect(Object.keys(servers)).toEqual(['a', 'b'])
  })
})

describe('path 1: scaffold copies the project .mcp.json THROUGH the list', () => {
  it('(i) an unlisted server does NOT arrive; (ii) a listed one DOES', () => {
    writeProjectMcp({ 'aiam-blog': def('blog'), gmail: def('gmail') })
    LIST = 'aiam-blog'
    scaffoldAgentDir('uj1')
    expect(agentMcpServers('uj1')).toEqual(['aiam-blog'])
  })

  it('empty list (the default): the new agent gets the valid empty shape, nothing else', () => {
    writeProjectMcp({ 'aiam-blog': def('blog'), gmail: def('gmail') })
    scaffoldAgentDir('uj2')
    expect(agentMcpServers('uj2')).toEqual([])
  })

  it('an existing agent .mcp.json is never rewritten by the scaffold', () => {
    writeProjectMcp({ gmail: def('gmail') })
    mkdirSync(join(SANDBOX, 'agents', 'regi'), { recursive: true })
    writeFileSync(join(SANDBOX, 'agents', 'regi', '.mcp.json'), JSON.stringify({ mcpServers: { sajat: def('own') } }))
    scaffoldAgentDir('regi')
    expect(agentMcpServers('regi')).toEqual(['sajat'])
  })
})

describe('path 2: the isolated .claude.json seed and gap-fill go THROUGH the list', () => {
  it('(i)+(ii) on the FIRST SEED: the Drive/Filesystem shape is stopped, a listed server arrives', () => {
    writeSharedDotClaude({ 'google-drive': def('gdrive'), Filesystem: def('fs'), 'aiam-blog': def('blog') })
    LIST = 'aiam-blog'
    ensureIsolatedChannelConfigDir('uj3', 'telegram')
    expect(isolatedServers('uj3')).toEqual(['aiam-blog'])
  })

  it('(i)+(ii) on the GAP-FILL: a server added later reaches the agent only if listed', () => {
    writeSharedDotClaude({ 'aiam-blog': def('blog') })
    LIST = 'aiam-blog,cortex'
    ensureIsolatedChannelConfigDir('uj4', 'telegram')
    writeSharedDotClaude({ 'aiam-blog': def('blog'), cortex: def('cortex'), gmail: def('gmail') })
    ensureIsolatedChannelConfigDir('uj4', 'telegram')
    expect(isolatedServers('uj4')).toEqual(['aiam-blog', 'cortex'])
  })

  it('additive: an agent that ALREADY has an unlisted server keeps it (existing agents untouched)', () => {
    writeSharedDotClaude({ 'google-drive': def('gdrive') })
    LIST = 'google-drive'
    ensureIsolatedChannelConfigDir('regi2', 'telegram')           // seeded while it was listed
    LIST = ''                                                      // list narrowed afterwards
    writeSharedDotClaude({ 'google-drive': def('gdrive'), gmail: def('gmail') })
    ensureIsolatedChannelConfigDir('regi2', 'telegram')
    expect(isolatedServers('regi2')).toEqual(['google-drive'])     // kept, gmail not added
  })

  it('the main agent is exempt on the GAP-FILL path too', () => {
    writeSharedDotClaude({ 'google-drive': def('gdrive') })
    LIST = ''
    ensureIsolatedChannelConfigDir(MAIN_AGENT_ID, 'telegram')
    writeSharedDotClaude({ 'google-drive': def('gdrive'), gmail: def('gmail') })
    ensureIsolatedChannelConfigDir(MAIN_AGENT_ID, 'telegram')
    expect(isolatedServers(MAIN_AGENT_ID)).toEqual(['gmail', 'google-drive'])
  })

  it('every refusal leaves a trace: the NAMES only, never a definition', () => {
    const spy = vi.spyOn(logger, 'info')
    writeSharedDotClaude({ gmail: { command: 'npx', args: ['gmail'], env: { TOKEN: 'secret-value-xyz' } } })
    LIST = ''
    ensureIsolatedChannelConfigDir('nyom', 'telegram')
    const rows = spy.mock.calls.filter((c) => (c[0] as { event?: string })?.event === 'mcp-not-inherited')
    expect(rows).toHaveLength(1)
    expect(rows[0][0]).toMatchObject({ name: 'nyom', path: 'seed', notInherited: ['gmail'] })
    expect(JSON.stringify(spy.mock.calls)).not.toContain('secret-value-xyz')
    spy.mockRestore()
  })

  it('the main agent is exempt: its config mirrors the operator\'s own ~/.claude.json', () => {
    writeSharedDotClaude({ 'google-drive': def('gdrive'), gmail: def('gmail') })
    LIST = ''
    ensureIsolatedChannelConfigDir(MAIN_AGENT_ID, 'telegram')
    expect(isolatedServers(MAIN_AGENT_ID)).toEqual(['gmail', 'google-drive'])
  })
})

describe('the 2026-09-05 scope-collision rule survives the filter', () => {
  it('a LISTED server the agent defines in its own .mcp.json is still not shadowed (seed)', () => {
    mkdirSync(join(SANDBOX, 'agents', 'cort'), { recursive: true })
    writeFileSync(join(SANDBOX, 'agents', 'cort', '.mcp.json'), JSON.stringify({ mcpServers: { cortex: def('own-cortex') } }))
    writeSharedDotClaude({ cortex: def('router-cortex'), 'aiam-blog': def('blog') })
    LIST = 'cortex,aiam-blog'
    ensureIsolatedChannelConfigDir('cort', 'telegram')
    expect(isolatedServers('cort')).toEqual(['aiam-blog'])
  })

  it('...and on the gap-fill path too', () => {
    mkdirSync(join(SANDBOX, 'agents', 'cort2'), { recursive: true })
    writeFileSync(join(SANDBOX, 'agents', 'cort2', '.mcp.json'), JSON.stringify({ mcpServers: { cortex: def('own-cortex') } }))
    writeSharedDotClaude({ 'aiam-blog': def('blog') })
    LIST = 'cortex,aiam-blog'
    ensureIsolatedChannelConfigDir('cort2', 'telegram')
    writeSharedDotClaude({ 'aiam-blog': def('blog'), cortex: def('router-cortex') })
    ensureIsolatedChannelConfigDir('cort2', 'telegram')
    expect(isolatedServers('cort2')).toEqual(['aiam-blog'])
  })

  // An UNLISTED server the agent also owns at project scope is refused for two
  // reasons; both traces must be left, whichever rule runs first.
  // Rows are scoped to one agent name so a spy left behind by an earlier failing
  // test cannot leak its rows into this one.
  const logRows = (spy: { mock: { calls: unknown[][] } }, agent: string, pred: (o: Record<string, unknown>) => boolean) =>
    spy.mock.calls
      .map((c: unknown[]) => c[0] as Record<string, unknown>)
      .filter((o: Record<string, unknown>) => o && typeof o === 'object' && o.name === agent && pred(o))

  it('unlisted AND project-scoped logs BOTH labels on the seed path', () => {
    mkdirSync(join(SANDBOX, 'agents', 'ket1'), { recursive: true })
    writeFileSync(join(SANDBOX, 'agents', 'ket1', '.mcp.json'), JSON.stringify({ mcpServers: { cortex: def('own-cortex') } }))
    writeSharedDotClaude({ cortex: def('router-cortex') })
    LIST = ''
    const spy = vi.spyOn(logger, 'info')
    ensureIsolatedChannelConfigDir('ket1', 'telegram')
    expect(logRows(spy, 'ket1', (o) => o.event === 'mcp-not-inherited')).toEqual([
      expect.objectContaining({ name: 'ket1', path: 'seed', notInherited: ['cortex'] }),
    ])
    expect(logRows(spy, 'ket1', (o) => Array.isArray(o.dropped))).toEqual([{ name: 'ket1', dropped: ['cortex'] }])
    expect(isolatedServers('ket1')).toEqual([])
    spy.mockRestore()
  })

  it('unlisted AND project-scoped logs BOTH labels on the gap-fill path', () => {
    mkdirSync(join(SANDBOX, 'agents', 'ket2'), { recursive: true })
    writeFileSync(join(SANDBOX, 'agents', 'ket2', '.mcp.json'), JSON.stringify({ mcpServers: { cortex: def('own-cortex') } }))
    writeSharedDotClaude({})
    LIST = ''
    ensureIsolatedChannelConfigDir('ket2', 'telegram')
    writeSharedDotClaude({ cortex: def('router-cortex') })
    const spy = vi.spyOn(logger, 'info')
    ensureIsolatedChannelConfigDir('ket2', 'telegram')
    expect(logRows(spy, 'ket2', (o) => o.event === 'mcp-not-inherited')).toEqual([
      expect.objectContaining({ name: 'ket2', path: 'gap-fill', notInherited: ['cortex'] }),
    ])
    expect(logRows(spy, 'ket2', (o) => Array.isArray(o.shadowed))).toEqual([{ name: 'ket2', shadowed: ['cortex'] }])
    expect(isolatedServers('ket2')).toEqual([])
    spy.mockRestore()
  })

  it('a LISTED project-scoped server logs only the collision, not a list refusal', () => {
    mkdirSync(join(SANDBOX, 'agents', 'ket3'), { recursive: true })
    writeFileSync(join(SANDBOX, 'agents', 'ket3', '.mcp.json'), JSON.stringify({ mcpServers: { cortex: def('own-cortex') } }))
    writeSharedDotClaude({ cortex: def('router-cortex') })
    LIST = 'cortex'
    const spy = vi.spyOn(logger, 'info')
    ensureIsolatedChannelConfigDir('ket3', 'telegram')
    expect(logRows(spy, 'ket3', (o) => o.event === 'mcp-not-inherited')).toEqual([])
    expect(logRows(spy, 'ket3', (o) => Array.isArray(o.dropped))).toEqual([{ name: 'ket3', dropped: ['cortex'] }])
    spy.mockRestore()
  })

  // The other branch must stay silent: both labels on every refusal would be as
  // useless for diagnosis as none. One-condition cases, on both paths.
  it('a LISTED project-scoped server logs only the collision on the gap-fill path too', () => {
    mkdirSync(join(SANDBOX, 'agents', 'ket4'), { recursive: true })
    writeFileSync(join(SANDBOX, 'agents', 'ket4', '.mcp.json'), JSON.stringify({ mcpServers: { cortex: def('own-cortex') } }))
    writeSharedDotClaude({})
    LIST = 'cortex'
    ensureIsolatedChannelConfigDir('ket4', 'telegram')
    writeSharedDotClaude({ cortex: def('router-cortex') })
    const spy = vi.spyOn(logger, 'info')
    ensureIsolatedChannelConfigDir('ket4', 'telegram')
    expect(logRows(spy, 'ket4', (o) => o.event === 'mcp-not-inherited')).toEqual([])
    expect(logRows(spy, 'ket4', (o) => Array.isArray(o.shadowed))).toEqual([{ name: 'ket4', shadowed: ['cortex'] }])
    spy.mockRestore()
  })

  it('an UNLISTED server the agent does not own logs only the list refusal (seed)', () => {
    mkdirSync(join(SANDBOX, 'agents', 'ket5'), { recursive: true })
    writeFileSync(join(SANDBOX, 'agents', 'ket5', '.mcp.json'), JSON.stringify({ mcpServers: { cortex: def('own-cortex') } }))
    writeSharedDotClaude({ gmail: def('gmail') })
    LIST = ''
    const spy = vi.spyOn(logger, 'info')
    ensureIsolatedChannelConfigDir('ket5', 'telegram')
    expect(logRows(spy, 'ket5', (o) => o.event === 'mcp-not-inherited')).toEqual([
      expect.objectContaining({ path: 'seed', notInherited: ['gmail'] }),
    ])
    expect(logRows(spy, 'ket5', (o) => Array.isArray(o.dropped))).toEqual([])
    spy.mockRestore()
  })

  it('an UNLISTED server the agent does not own logs only the list refusal (gap-fill)', () => {
    mkdirSync(join(SANDBOX, 'agents', 'ket6'), { recursive: true })
    writeFileSync(join(SANDBOX, 'agents', 'ket6', '.mcp.json'), JSON.stringify({ mcpServers: { cortex: def('own-cortex') } }))
    writeSharedDotClaude({})
    LIST = ''
    ensureIsolatedChannelConfigDir('ket6', 'telegram')
    writeSharedDotClaude({ gmail: def('gmail') })
    const spy = vi.spyOn(logger, 'info')
    ensureIsolatedChannelConfigDir('ket6', 'telegram')
    expect(logRows(spy, 'ket6', (o) => o.event === 'mcp-not-inherited')).toEqual([
      expect.objectContaining({ path: 'gap-fill', notInherited: ['gmail'] }),
    ])
    expect(logRows(spy, 'ket6', (o) => Array.isArray(o.shadowed))).toEqual([])
    spy.mockRestore()
  })
})
