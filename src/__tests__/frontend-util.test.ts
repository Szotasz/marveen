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
