// Whole-card priority tint: the card background carries the priority colour
// (layered over --bg-card), the left edge stays as a 4px stripe, and card
// aging still recolours that edge. Computed styles were checked in a real
// browser; this pins the CSS contract those results depend on.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CSS = readFileSync(join(ROOT, 'web', 'style.css'), 'utf-8')

// The selector at the start of a line, then optional alignment spaces, then `{`.
function ruleStart(selector: string): number {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp(`^${esc}\\s*\\{`, 'm').exec(CSS)
  return m ? m.index : -1
}

function rule(selector: string): string {
  const i = ruleStart(selector)
  if (i < 0) throw new Error(`rule not found: ${selector}`)
  return CSS.slice(i, CSS.indexOf('}', i) + 1)
}

const tint = (sel: string) => /--card-tint:\s*([^;]+);/.exec(rule(sel))?.[1].trim()

describe('priority tint', () => {
  it('layers the tint over the theme card background and keeps a 4px edge', () => {
    const base = rule('.kanban-card[data-priority]')
    expect(base).toMatch(/background:\s*linear-gradient\(var\(--card-tint\), var\(--card-tint\)\), var\(--bg-card\)/)
    expect(base).toMatch(/border-left:\s*4px solid var\(--card-edge\)/)
  })

  it('tints only urgent and high strongly; normal stays transparent', () => {
    expect(tint('.kanban-card[data-priority="urgent"]')).toMatch(/^rgba\(/)
    expect(tint('.kanban-card[data-priority="high"]')).toMatch(/^rgba\(/)
    expect(tint('.kanban-card[data-priority="normal"]')).toBe('transparent')
    expect(rule('.kanban-card[data-priority="low"] .kanban-card-title')).toContain('var(--text-dim)')
  })

  it('has stronger dark-theme tints for the tinted levels', () => {
    for (const p of ['urgent', 'high', 'low']) {
      expect(tint(`[data-theme="dark"] .kanban-card[data-priority="${p}"]`)).toMatch(/^rgba\(/)
    }
  })
})

describe('card aging edge', () => {
  it('recolours the edge, and comes AFTER the priority block (same specificity)', () => {
    const aging = rule('.kanban-card[data-aging]')
    expect(aging).toMatch(/border-left-color:\s*var\(--card-aging-color\)/)
    expect(ruleStart('.kanban-card[data-aging]')).toBeGreaterThan(ruleStart('.kanban-card[data-priority]'))
  })
})
