import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

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
const __dirname = dirname(fileURLToPath(import.meta.url))
const cssPath = join(__dirname, '..', '..', 'web', 'style.css')
// Strip /* ... */ comments so an explanatory comment that *mentions* a property
// is never mistaken for a real declaration.
const css = readFileSync(cssPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** Return the body of the first `selector { ... }` rule, or null. */
function ruleBody(selector: string): string | null {
  const idx = css.indexOf(selector)
  if (idx < 0) return null
  const open = css.indexOf('{', idx)
  const close = css.indexOf('}', open)
  if (open < 0 || close < 0) return null
  return css.slice(open + 1, close)
}

describe('dashboard modal CSS contract', () => {
  it('the .terminal-modal must have a fixed height, not just max-height (vibration loop guard)', () => {
    const body = ruleBody('.terminal-modal {')
    expect(body, '.terminal-modal rule not found in web/style.css').not.toBeNull()
    // A bare `max-height` lets the xterm FitAddon resize the modal in a loop;
    // a real `height:` declaration pins it.
    expect(body!).toMatch(/(^|[;{\s])height\s*:/)
  })

  it('checkbox/radio inputs in a form-group override the text-field width:100% (overflow guard)', () => {
    const body = ruleBody('.form-group input[type="checkbox"]')
    expect(
      body,
      'missing `.form-group input[type="checkbox"]` width override in web/style.css',
    ).not.toBeNull()
    expect(body!).toMatch(/width\s*:\s*auto/i)
  })
})
