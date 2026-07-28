import { describe, it, expect } from 'vitest'
import {
  MCP_TOOL_REGISTRY,
  MCP_DANGEROUS_TOOLS,
  parseMcpScope,
  buildMcpDenyList,
  type McpScope,
} from '../web/mcp-tool-registry.js'

// Synthetic fixtures -- no real agent names hardcoded.
const FIXTURE_REGISTRY: Record<string, readonly string[]> = {
  'test-server': ['tool-a', 'tool-b', 'tool-c', 'tool-dangerous'],
  'other-server': ['other-a', 'other-b'],
}

describe('parseMcpScope', () => {
  it('returns null when field is undefined (unmanaged)', () => {
    expect(parseMcpScope(undefined)).toBeNull()
  })

  it('returns null when field is null', () => {
    expect(parseMcpScope(null)).toBeNull()
  })

  it('returns null when field is not an object', () => {
    expect(parseMcpScope('*')).toBeNull()
    expect(parseMcpScope(42)).toBeNull()
    expect(parseMcpScope([])).toBeNull()
  })

  it('parses tool list for a server', () => {
    const scope = parseMcpScope({ 'test-server': ['tool-a', 'tool-b'] })
    expect(scope).toEqual({ 'test-server': ['tool-a', 'tool-b'] })
  })

  it('parses wildcard for a server', () => {
    const scope = parseMcpScope({ 'test-server': '*' })
    expect(scope).toEqual({ 'test-server': '*' })
  })

  it('parses empty object (scope defined but no servers = deny all MCP)', () => {
    const scope = parseMcpScope({})
    expect(scope).toEqual({})
  })

  it('silently drops invalid entries (forward-compat)', () => {
    const scope = parseMcpScope({ 'test-server': ['tool-a'], 'bad-server': 123 })
    expect(scope).toEqual({ 'test-server': ['tool-a'] })
  })
})

describe('buildMcpDenyList', () => {
  it('returns empty list when scope is null (unmanaged)', () => {
    const deny = buildMcpDenyList(null, FIXTURE_REGISTRY)
    expect(deny).toHaveLength(0)
  })

  it('denies all registry tools when scope is empty object', () => {
    const deny = buildMcpDenyList({}, FIXTURE_REGISTRY)
    expect(deny).toContain('mcp__test-server__tool-a')
    expect(deny).toContain('mcp__test-server__tool-b')
    expect(deny).toContain('mcp__test-server__tool-dangerous')
    expect(deny).toContain('mcp__other-server__other-a')
  })

  it('scoped agent: only allowed tools escape deny', () => {
    const scope: McpScope = { 'test-server': ['tool-a', 'tool-b'] }
    const deny = buildMcpDenyList(scope, FIXTURE_REGISTRY)
    expect(deny).toContain('mcp__test-server__tool-c')
    expect(deny).toContain('mcp__test-server__tool-dangerous')
    expect(deny).not.toContain('mcp__test-server__tool-a')
    expect(deny).not.toContain('mcp__test-server__tool-b')
  })

  it('wildcard server scope: no deny entries for that server', () => {
    const scope: McpScope = { 'test-server': '*' }
    const deny = buildMcpDenyList(scope, FIXTURE_REGISTRY)
    const testServerDenies = deny.filter(t => t.startsWith('mcp__test-server__'))
    expect(testServerDenies).toHaveLength(0)
  })

  it('wildcard server + other server unlisted: other server fully denied', () => {
    const scope: McpScope = { 'test-server': '*' }
    const deny = buildMcpDenyList(scope, FIXTURE_REGISTRY)
    expect(deny).toContain('mcp__other-server__other-a')
    expect(deny).toContain('mcp__other-server__other-b')
  })

  it('server not in scope but present in registry: all its tools denied', () => {
    const scope: McpScope = { 'test-server': ['tool-a'] }
    const deny = buildMcpDenyList(scope, FIXTURE_REGISTRY)
    expect(deny).toContain('mcp__other-server__other-a')
    expect(deny).toContain('mcp__other-server__other-b')
  })

  it('deny list entries use correct mcp__ prefix format', () => {
    const scope: McpScope = { 'test-server': [] }
    const deny = buildMcpDenyList(scope, FIXTURE_REGISTRY)
    for (const entry of deny.filter(t => t.startsWith('mcp__test-server__'))) {
      expect(entry).toMatch(/^mcp__test-server__tool-[a-z]+$/)
    }
  })
})

describe('MCP_TOOL_REGISTRY', () => {
  it('contains github server', () => {
    expect(MCP_TOOL_REGISTRY).toHaveProperty('github')
    expect(Array.isArray(MCP_TOOL_REGISTRY['github'])).toBe(true)
  })

  it('contains gitlab server', () => {
    expect(MCP_TOOL_REGISTRY).toHaveProperty('gitlab')
    expect(Array.isArray(MCP_TOOL_REGISTRY['gitlab'])).toBe(true)
  })

  it('github tools include read-only and write operations', () => {
    expect(MCP_TOOL_REGISTRY['github']).toContain('list_issues')
    expect(MCP_TOOL_REGISTRY['github']).toContain('push_files')
  })

  it('no duplicate tool names per server', () => {
    for (const [server, tools] of Object.entries(MCP_TOOL_REGISTRY)) {
      const unique = new Set(tools)
      expect(unique.size).toBe(tools.length) // `server` used for label if it fails
      void server
    }
  })
})

describe('MCP_DANGEROUS_TOOLS', () => {
  it('all entries use mcp__ prefix format', () => {
    for (const tool of MCP_DANGEROUS_TOOLS) {
      expect(tool).toMatch(/^mcp__[a-z-]+__[a-z_]+$/)
    }
  })

  it('includes known destructive tools', () => {
    expect(MCP_DANGEROUS_TOOLS).toContain('mcp__github__push_files')
    expect(MCP_DANGEROUS_TOOLS).toContain('mcp__github__merge_pull_request')
    expect(MCP_DANGEROUS_TOOLS).toContain('mcp__gitlab__merge_merge_request')
  })
})
