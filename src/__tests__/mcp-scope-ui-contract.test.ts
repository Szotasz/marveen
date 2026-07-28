// Contract tests for the MCP scope tab feature.
//
// Guards three surfaces:
//   1. mcp-catalog.json -- tools[] schema integrity
//   2. agents.js -- functions and DOM wiring present
//   3. index.html -- tab button and panel in place
//
// These are static string / JSON checks (no DOM runtime needed), mirroring
// the pattern of agent-modals-ui-contract.test.ts.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '../..')

const AGENTS_JS  = readFileSync(join(root, 'web/modules/agents.js'), 'utf-8')
const INDEX_HTML = readFileSync(join(root, 'web/index.html'), 'utf-8')
const CATALOG    = JSON.parse(readFileSync(join(root, 'mcp-catalog.json'), 'utf-8'))

// ── mcp-catalog.json integrity ───────────────────────────────────────────────

describe('mcp-catalog.json tools[] schema', () => {
  const entriesWithTools = CATALOG.filter((e: { tools?: unknown[] }) => Array.isArray(e.tools))

  it('at least one catalog entry has a tools[] array', () => {
    expect(entriesWithTools.length).toBeGreaterThan(0)
  })

  it('every tool entry has id (string) and dangerous (boolean)', () => {
    const errors: string[] = []
    for (const entry of entriesWithTools) {
      for (const tool of entry.tools) {
        if (typeof tool.id !== 'string' || tool.id === '')
          errors.push(`${entry.id}: tool missing id`)
        if (typeof tool.dangerous !== 'boolean')
          errors.push(`${entry.id}/${tool.id}: dangerous must be boolean`)
        if (typeof tool.label !== 'string' || tool.label === '')
          errors.push(`${entry.id}/${tool.id}: missing label`)
      }
    }
    expect(errors).toEqual([])
  })

  it('github catalog entry has at least 20 tools', () => {
    const gh = CATALOG.find((e: { id: string }) => e.id === 'github')
    expect(gh).toBeDefined()
    expect(gh.tools.length).toBeGreaterThanOrEqual(20)
  })

  it('github has both safe and dangerous tools', () => {
    const gh = CATALOG.find((e: { id: string }) => e.id === 'github')
    const dangerous = gh.tools.filter((t: { dangerous: boolean }) => t.dangerous)
    const safe = gh.tools.filter((t: { dangerous: boolean }) => !t.dangerous)
    expect(dangerous.length).toBeGreaterThan(0)
    expect(safe.length).toBeGreaterThan(0)
  })

  it('tool ids have no spaces or mcp__ prefix (stored without prefix)', () => {
    for (const entry of entriesWithTools) {
      for (const tool of entry.tools) {
        expect(tool.id, `${entry.id}/${tool.id} must not start with mcp__`).not.toMatch(/^mcp__/)
        expect(tool.id, `${entry.id}/${tool.id} must not contain spaces`).not.toMatch(/\s/)
      }
    }
  })

  it('no duplicate tool ids within a single server entry', () => {
    for (const entry of entriesWithTools) {
      const ids = entry.tools.map((t: { id: string }) => t.id)
      const unique = new Set(ids)
      expect(unique.size, `${entry.id} has duplicate tool ids`).toBe(ids.length)
    }
  })
})

// ── agents.js wiring ─────────────────────────────────────────────────────────

describe('agents.js MCP scope wiring', () => {
  it('loadMcpScope function is defined', () => {
    expect(AGENTS_JS).toContain('async function loadMcpScope(')
  })

  it('buildMcpScopeValue function is defined', () => {
    expect(AGENTS_JS).toContain('function buildMcpScopeValue(')
  })

  it('renderMcpServerSection function is defined', () => {
    expect(AGENTS_JS).toContain('function renderMcpServerSection(')
  })

  it('saveMcpScopeBtn click handler is wired', () => {
    expect(AGENTS_JS).toContain("getElementById('saveMcpScopeBtn').addEventListener('click'")
  })

  it('tabMcpScope is handled in switchAgentTab', () => {
    expect(AGENTS_JS).toMatch(/tabMcpScope.*hidden.*tab.*!==.*mcp-scope/)
  })

  it('loadMcpScope is called from openAgentDetail', () => {
    expect(AGENTS_JS).toContain('await loadMcpScope(currentAgent)')
  })

  it('saveMcpScopeBtn is included in Marveen readonly hide list', () => {
    expect(AGENTS_JS).toContain("'saveMcpScopeBtn'")
    // Verify it's in the hideButtonIds array (alongside the known buttons)
    const hideListMatch = AGENTS_JS.match(/const hideButtonIds = \[([^\]]+)\]/)
    expect(hideListMatch).toBeTruthy()
    expect(hideListMatch![1]).toContain('saveMcpScopeBtn')
  })

  it('mcpScope field is sent in the PATCH body', () => {
    expect(AGENTS_JS).toContain('mcpScope: scopeValue')
  })

  it('dangerous-tool confirm gate fires before save', () => {
    // confirm() must appear before the fetch in the save handler
    const saveHandlerStart = AGENTS_JS.indexOf("getElementById('saveMcpScopeBtn').addEventListener('click'")
    const confirmIdx = AGENTS_JS.indexOf("confirm(t('agents.mcp_scope.confirm_dangerous')", saveHandlerStart)
    const fetchIdx = AGENTS_JS.indexOf("fetch(`/api/agents/", saveHandlerStart)
    expect(confirmIdx).toBeGreaterThan(saveHandlerStart)
    expect(confirmIdx).toBeLessThan(fetchIdx)
  })

  it('fetchMcpCatalog uses /api/mcp-catalog endpoint', () => {
    expect(AGENTS_JS).toContain("fetch('/api/mcp-catalog')")
  })

  it('readonly mode auto-filters to list/get/search tool prefixes', () => {
    expect(AGENTS_JS).toContain('MCP_READONLY_PREFIXES')
    expect(AGENTS_JS).toContain("'list_'")
    expect(AGENTS_JS).toContain("'get_'")
    expect(AGENTS_JS).toContain("'search_'")
  })
})

// ── index.html structure ──────────────────────────────────────────────────────

describe('index.html MCP scope tab', () => {
  it('tab button with data-tab="mcp-scope" exists in agentTabNav', () => {
    expect(INDEX_HTML).toContain('data-tab="mcp-scope"')
    expect(INDEX_HTML).toContain('data-i18n="agents.tab.mcp_scope"')
  })

  it('#tabMcpScope panel exists and is hidden by default', () => {
    expect(INDEX_HTML).toContain('id="tabMcpScope"')
    expect(INDEX_HTML).toMatch(/id="tabMcpScope"[^>]*hidden/)
  })

  it('mode preset radios are present with correct values', () => {
    expect(INDEX_HTML).toContain('name="mcpScopeMode" value="full"')
    expect(INDEX_HTML).toContain('name="mcpScopeMode" value="readonly"')
    expect(INDEX_HTML).toContain('name="mcpScopeMode" value="custom"')
  })

  it('#mcpScopeServerList placeholder is present', () => {
    expect(INDEX_HTML).toContain('id="mcpScopeServerList"')
  })

  it('#saveMcpScopeBtn is inside #tabMcpScope', () => {
    const panelStart = INDEX_HTML.indexOf('id="tabMcpScope"')
    const panelEnd = INDEX_HTML.indexOf('<!-- Bottom actions -->', panelStart)
    const saveBtnIdx = INDEX_HTML.indexOf('id="saveMcpScopeBtn"', panelStart)
    expect(saveBtnIdx).toBeGreaterThan(panelStart)
    expect(saveBtnIdx).toBeLessThan(panelEnd)
  })
})
