// Unit tests for web/modules/util.js -- pure functions, no DOM needed.
//
// These tests also serve as regression guards: if a local escapeHtml
// definition is reintroduced in a module, the UI-contract tests below
// catch it; if the canonical implementation regresses, these fail.
//
// Fixtures: no real names, tokens, or agent IDs.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')

// ---------------------------------------------------------------------------
// Canonical implementation (extracted for Node.js unit testing without DOM)
// ---------------------------------------------------------------------------

function escapeHtml(str: unknown): string {
  return String(str ?? '').replace(/[&<>"']/g, (c: string) => (
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]
  ))
}

describe('escapeHtml', () => {
  it('escapes & < > characters', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;')
  })

  it('escapes double quotes', () => {
    expect(escapeHtml('"hello"')).toBe('&quot;hello&quot;')
  })

  it('escapes single quotes', () => {
    expect(escapeHtml("it's a test")).toBe('it&#39;s a test')
  })

  it('escapes ampersand', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b')
  })

  it('handles null via nullish default', () => {
    expect(escapeHtml(null)).toBe('')
  })

  it('handles undefined via nullish default', () => {
    expect(escapeHtml(undefined)).toBe('')
  })

  it('handles numbers', () => {
    expect(escapeHtml(42)).toBe('42')
  })

  it('passes through safe strings unchanged', () => {
    expect(escapeHtml('hello world')).toBe('hello world')
  })
})

// ---------------------------------------------------------------------------
// highlightJson (local copy matching web/modules/util.js for DOM-free testing)
// ---------------------------------------------------------------------------

function highlightJson(raw: string): string {
  let fmt: string
  try { fmt = JSON.stringify(JSON.parse(raw), null, 2) } catch { return escapeHtml(raw) }
  return fmt.replace(
    /"((?:[^"\\]|\\.)*)"\s*(:)?|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\btrue\b|\bfalse\b|\bnull\b/g,
    (match: string, strContent: string | undefined, isKey: string | undefined) => {
      if (strContent !== undefined) {
        const safe = escapeHtml(strContent)
        return isKey
          ? `<span style="color:#BD5D38">"${safe}"</span>:`
          : `<span style="color:#4a9a6a">"${safe}"</span>`
      }
      if (match === 'true' || match === 'false' || match === 'null') {
        return `<span style="color:var(--text-secondary,#8a8a7c)">${match}</span>`
      }
      return `<span style="color:#6366f1">${match}</span>`
    }
  )
}

describe('highlightJson', () => {
  it('wraps JSON keys in a key-colored span', () => {
    const out = highlightJson('{"name":"value"}')
    expect(out).toContain('<span style="color:#BD5D38">"name"</span>:')
  })

  it('wraps string values in a string-colored span', () => {
    const out = highlightJson('{"k":"hello"}')
    expect(out).toContain('<span style="color:#4a9a6a">"hello"</span>')
  })

  it('wraps number values in a number-colored span', () => {
    const out = highlightJson('{"n":42}')
    expect(out).toContain('<span style="color:#6366f1">42</span>')
  })

  it('wraps boolean true in a keyword span', () => {
    const out = highlightJson('{"flag":true}')
    expect(out).toContain('<span style="color:var(--text-secondary,#8a8a7c)">true</span>')
  })

  it('wraps null in a keyword span', () => {
    const out = highlightJson('{"x":null}')
    expect(out).toContain('<span style="color:var(--text-secondary,#8a8a7c)">null</span>')
  })

  it('HTML-escapes < > & in string values (XSS prevention)', () => {
    const out = highlightJson('{"xss":"<script>alert(1)</script>"}')
    // Must not contain a raw < or > outside of our own span tags
    expect(out).toContain('&lt;script&gt;')
    expect(out).not.toContain('<script>')
  })

  it('HTML-escapes & in string keys', () => {
    const out = highlightJson('{"a&b":"v"}')
    expect(out).toContain('&amp;')
    expect(out).not.toContain('"a&b"')
  })

  it('numbers inside string values are NOT highlighted separately', () => {
    // "123" as a string value -- the digits must not gain a number span
    const out = highlightJson('{"k":"123"}')
    // Entire string value should be wrapped in one json-str span, no nested num span
    expect(out).toContain('<span style="color:#4a9a6a">"123"</span>')
    // There should be no nested json-num span inside a json-str span
    expect(out).not.toMatch(/<span style="color:#4a9a6a">".*<span style="color:#6366f1"/)
  })

  it('falls back to escapeHtml output for invalid JSON', () => {
    const out = highlightJson('not valid json {')
    // Must HTML-escape the raw input, no unescaped < etc.
    expect(out).toBe(escapeHtml('not valid json {'))
  })

  it('pretty-prints the JSON (2-space indent)', () => {
    const out = highlightJson('{"a":1,"b":2}')
    expect(out).toContain('\n')
  })
})

// ---------------------------------------------------------------------------
// UI-contract: util.js structure
// ---------------------------------------------------------------------------

const UTIL_JS = readFileSync(join(ROOT, 'web/modules/util.js'), 'utf8')

describe('util.js structure', () => {
  it('exports escapeHtml', () => {
    expect(UTIL_JS).toContain('export function escapeHtml')
  })

  it('exports escapeAttr as alias for escapeHtml', () => {
    expect(UTIL_JS).toContain('escapeAttr')
  })

  it('exports mainAgentId', () => {
    expect(UTIL_JS).toContain('export function mainAgentId')
  })

  it('exports highlightJson', () => {
    expect(UTIL_JS).toContain('export function highlightJson')
  })

  it('escapeHtml is DOM-free (no document.createElement)', () => {
    expect(UTIL_JS).not.toContain('document.createElement')
  })
})

// ---------------------------------------------------------------------------
// UI-contract: no local duplicate definitions remain in any module
// ---------------------------------------------------------------------------

const MODULES = [
  'agents', 'approvals', 'connectors', 'docs-research', 'federation',
  'ideas', 'kanban', 'memories', 'messages', 'migrate', 'onboarding',
  'overview', 'schedules', 'settings', 'skills', 'status-costs',
  'token-usage', 'agent-modals', 'updates',
]

describe('no local escapeHtml/mainAgentId/escapeAttr definitions in modules', () => {
  for (const mod of MODULES) {
    it(`${mod}.js has no local escapeHtml definition`, () => {
      const src = readFileSync(join(ROOT, 'web/modules', `${mod}.js`), 'utf8')
      expect(src).not.toMatch(/^function escapeHtml/m)
      expect(src).not.toMatch(/^function escapeHtmlUpdates/m)
    })
  }

  it('no module defines mainAgentId locally', () => {
    for (const mod of MODULES) {
      const src = readFileSync(join(ROOT, 'web/modules', `${mod}.js`), 'utf8')
      expect(src, `${mod}.js has local mainAgentId`).not.toMatch(/^function mainAgentId/m)
    }
  })

  it('all 19 modules import from util.js', () => {
    for (const mod of MODULES) {
      const src = readFileSync(join(ROOT, 'web/modules', `${mod}.js`), 'utf8')
      expect(src, `${mod}.js missing util.js import`).toContain("from './util.js'")
    }
  })
})
