import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readAllCss } from './css-helper.js'

// Contract test for two dashboard modal CSS regressions reported 2026-06-11:
//   1. "Vibrating terminal modal": `.terminal-modal` had only `max-height: 90vh`
//      (no fixed height), so its height was content-driven. The xterm FitAddon
//      grows the modal as the live pane repaints, which re-runs fit() and makes
//      the modal oscillate (grow to the cap, snap back, grow again -- a loop).
//      Fix: a fixed `height` on `.terminal-modal` so the flex container is stable
//      and xterm scrolls internally instead of resizing the modal.
//   2. "Content sticking out of the modal" (agent-detail "Csapat" tab): the
//      generic `.form-group input { width: 100% }` (meant for text fields) also
//      stretched the auto-delegation checkbox inside its flex label to full
//      width, shoving the adjacent label text past the modal's right edge.
//      Fix: checkbox/radio inputs keep their native size.
// F5 (DS): modal base class extracted to web/css/components/modal.css.
//   Contracts for overlay/panel/close are now pinned against modal.css.
const __dirname = dirname(fileURLToPath(import.meta.url))
const btnCssPath = join(__dirname, '..', '..', 'web', 'css', 'components', 'btn.css')
const modalCssPath = join(__dirname, '..', '..', 'web', 'css', 'components', 'modal.css')
const fieldCssPath = join(__dirname, '..', '..', 'web', 'css', 'components', 'field.css')
// Strip /* ... */ comments so an explanatory comment that *mentions* a property
// is never mistaken for a real declaration.
const css = readAllCss().replace(/\/\*[\s\S]*?\*\//g, '')
const btnCss = readFileSync(btnCssPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const modalCss = readFileSync(modalCssPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const fieldCss = readFileSync(fieldCssPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** Return the body of the first `selector { ... }` block in a CSS string, or null. */
function ruleBodyIn(source: string, selector: string): string | null {
  const idx = source.indexOf(selector)
  if (idx < 0) return null
  const open = source.indexOf('{', idx)
  const close = source.indexOf('}', open)
  if (open < 0 || close < 0) return null
  return source.slice(open + 1, close)
}

/** Return the body of the first `selector { ... }` rule in style.css, or null. */
function ruleBody(selector: string): string | null {
  return ruleBodyIn(css, selector)
}

describe('dashboard modal CSS contract', () => {
  it('the .terminal-modal must have a fixed height, not just max-height (vibration loop guard)', () => {
    const body = ruleBody('.terminal-modal {')
    expect(body, '.terminal-modal rule not found in web/style.css').not.toBeNull()
    // A bare `max-height` lets the xterm FitAddon resize the modal in a loop;
    // a real `height:` declaration pins it.
    expect(body!).toMatch(/(^|[;{\s])height\s*:/)
  })

  it('checkbox/radio inputs in a form-group override the text-field width:100% (overflow guard, F6: moved to field.css)', () => {
    // After F6 migration .form-group block moved to web/css/components/field.css
    const body = ruleBodyIn(fieldCss, '.form-group input[type="checkbox"]')
    expect(
      body,
      'missing `.form-group input[type="checkbox"]` width override in web/css/components/field.css',
    ).not.toBeNull()
    expect(body!).toMatch(/width\s*:\s*auto/i)
  })

  it('.tg-notice[hidden] stays out of layout when hidden', () => {
    const body = ruleBody('.tg-notice[hidden] {')
    expect(body, 'missing .tg-notice[hidden] override in web/style.css').not.toBeNull()
    expect(body!).toMatch(/display\s*:\s*none/i)
  })

  it('.btn[hidden] stays out of layout when hidden (F3: moved to btn.css)', () => {
    // After F3 migration .btn-compact[hidden] -> .btn[hidden] in components/btn.css
    const idx = btnCss.indexOf('.btn[hidden]')
    expect(idx, 'missing .btn[hidden] override in web/css/components/btn.css').toBeGreaterThanOrEqual(0)
    const open = btnCss.indexOf('{', idx)
    const close = btnCss.indexOf('}', open)
    const body = btnCss.slice(open + 1, close)
    expect(body).toMatch(/display\s*:\s*none/i)
  })

  // F5: modal base class extracted to web/css/components/modal.css

  it('.modal-overlay is defined in modal.css with fixed positioning (F5)', () => {
    const body = ruleBodyIn(modalCss, '.modal-overlay {')
    expect(body, '.modal-overlay rule not found in web/css/components/modal.css').not.toBeNull()
    expect(body!).toMatch(/position\s*:\s*fixed/i)
  })

  it('.modal[data-variant="wide"] overrides --_max-w in modal.css (F5: replaces .modal-wide)', () => {
    const body = ruleBodyIn(modalCss, '.modal[data-variant="wide"]')
    expect(body, '.modal[data-variant="wide"] not found in web/css/components/modal.css').not.toBeNull()
    expect(body!).toMatch(/--_max-w\s*:\s*640px/)
  })

  it('.modal-close danger hover is defined in modal.css (F5)', () => {
    const body = ruleBodyIn(modalCss, '.modal-close:hover')
    expect(body, '.modal-close:hover not found in web/css/components/modal.css').not.toBeNull()
    expect(body!).toMatch(/background\s*:\s*var\(--danger\)/i)
  })
})
