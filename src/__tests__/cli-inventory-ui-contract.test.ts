// String-contract guard for the CLI tools page (the house idiom of
// federation-ui-contract.test.ts: read the frontend files as strings and
// assert short, formatting-proof fragments). Guards the wiring that has no
// functional test (sidebar link, router hook, page loader, header i18n) and
// the escaping discipline: every field shown comes from a CLI's own manifest,
// help text or README, so none may reach innerHTML unescaped.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const read = (p: string) => readFileSync(join(__dirname, '../..', p), 'utf-8')
const APP = read('web/app.js')
const HTML = read('web/index.html')

function section(src: string, start: string, end: string): string {
  const a = src.indexOf(start)
  const b = src.indexOf(end, a)
  expect(a, start).toBeGreaterThan(-1)
  expect(b, end).toBeGreaterThan(a)
  return src.slice(a, b)
}

describe('CLI tools page wiring', () => {
  it('sidebar: the CLI link sits in the connections group right after MCP', () => {
    expect(APP).toMatch(/key: 'connections',[^\n]*pages: \['connectors', 'clitools', 'federation', 'migrate'\]/)
    const group = HTML.indexOf('data-group="connections"')
    const connectors = HTML.indexOf('data-page="connectors"')
    const clitools = HTML.indexOf('data-page="clitools"')
    const federation = HTML.indexOf('data-page="federation"')
    expect(group).toBeGreaterThan(-1)
    expect(clitools).toBeGreaterThan(connectors)
    expect(federation).toBeGreaterThan(clitools)
  })

  it('page div, modal, router dispatch, nav and header i18n exist', () => {
    expect(HTML).toContain('id="clitoolsPage"')
    expect(HTML).toContain('id="cliToolDetailOverlay"')
    expect(APP).toContain("if (pageId === 'clitools') loadCliTools()")
    expect(APP).toContain("clitools: 'nav.clitools'")
    expect(APP).toContain("clitoolsPage:   { title: 'clitools.page_title',    sub: 'clitools.page_subtitle' }")
    expect(APP).toContain("fetch('/api/cli-inventory' + (refresh ? '?refresh=1' : ''))")
  })

  it('off, not yet made, stale and refused are states of the page, not load errors', () => {
    const code = section(APP, '// --- CLI inventory page ---', 'async function openConnectorDetail(')
    expect(code).toContain("if (res.ok && (data.enabled === false || data.pending === true)) {")
    expect(code).toContain("t(data.enabled === false ? 'clitools.disabled' : 'clitools.pending')")
    expect(code).toContain(": regenSkipped ? t('clitools.regen_skipped') : ''")
    // A refused refresh says why in the house text (ownerSessionText) and keeps the inventory already shown.
    expect(code).toContain('const refusal = ownerSessionText(data)')
    expect(code).toContain('errEl.textContent = refusal')
  })

  it('reuses the MCP page classes instead of new ones', () => {
    const page = section(HTML, 'id="clitoolsPage"', '<!-- === Migration Page === -->')
    for (const cls of ['page-header', 'connector-stats', 'connector-grid', 'info-box']) {
      expect(page, cls).toContain(cls)
    }
    const code = section(APP, '// --- CLI inventory page ---', 'async function openConnectorDetail(')
    for (const cls of ['connector-card', 'connector-status-dot', 'connector-name', 'connector-endpoint',
      'connector-type-badge', 'connector-group-heading', 'connector-scope-grid', 'connector-detail-row', 'stat-card']) {
      expect(code, cls).toContain(cls)
    }
  })
})

describe('CLI tools page escaping', () => {
  const code = section(APP, '// --- CLI inventory page ---', 'async function openConnectorDetail(')

  it('every interpolated tool, command or skill field goes through escapeHtml or mono()', () => {
    // ${tool.x}, ${c.x}, ${s.x}, ${d.x} directly inside a template literal would be raw HTML.
    const raw = code.match(/\$\{\s*(tool|c|s|d)\.[A-Za-z_]+[^}]*\}/g) || []
    expect(raw).toEqual([])
    expect(code).toContain('const mono = (s) => `<span style="font-family:monospace;font-size:12px">${escapeHtml(s)}</span>`')
  })

  it('the README excerpt and the error text are set as text, not HTML', () => {
    expect(code).toContain('readme.textContent = tool.readme_excerpt')
    expect(code).toContain("errEl.textContent = regenError ? t('clitools.regen_error'")
    expect(code).not.toMatch(/innerHTML\s*=\s*tool\./)
  })
})
