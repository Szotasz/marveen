// Contract tests for the kanban 3-level subtask UI wiring (Issue #30).
//
// These are string-grep tests over the frontend source files; they do not
// run in a browser. They guard the wiring between the backend API changes
// and the frontend rendering logic so a future refactor cannot silently
// remove a critical integration point.
//
// What is verified:
//   - subtree endpoint is used (not just /children) in the detail modal
//   - canAddSubtask replaces the old isTask = !card.parent_id check
//   - depth-2 items rendered with kanban-depth-2 class
//   - collapse toggle present in the embedded rendering
//   - PATCH /parent endpoint called on DnD drop
//   - DnD depth guard: subtreeHeightLocal used + target.depth check
//   - buildEmbeddedSubtrees helper defined
//   - CSS classes added for depth-2 and DnD feedback
//
// Fixtures: no real names, tokens, or agent IDs used.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')

const KANBAN_JS = readFileSync(join(ROOT, 'web/modules/kanban.js'), 'utf8')
const STYLE_CSS = readFileSync(join(ROOT, 'web/style.css'), 'utf8')

describe('kanban 3-level UI: detail modal', () => {
  it('uses /subtree endpoint (not only /children) in the detail modal', () => {
    expect(KANBAN_JS).toContain('/subtree')
  })

  it('uses card.depth < 2 for canAddSubtask (not the old !card.parent_id isTask check)', () => {
    expect(KANBAN_JS).toContain('card.depth < 2')
    // The old "isTask = !card.parent_id" pattern with that exact assignment should be gone
    expect(KANBAN_JS).not.toContain('isTask = !card.parent_id')
  })

  it('renders subtask rows recursively (renderSubtaskRow function defined)', () => {
    expect(KANBAN_JS).toContain('renderSubtaskRow')
  })
})

describe('kanban 3-level UI: board embedded rendering', () => {
  it('defines buildEmbeddedSubtrees helper', () => {
    expect(KANBAN_JS).toContain('buildEmbeddedSubtrees')
  })

  it('renders depth-2 items with kanban-depth-2 class', () => {
    expect(KANBAN_JS).toContain('kanban-depth-2')
  })

  it('includes a collapse toggle for grandchildren', () => {
    expect(KANBAN_JS).toContain('kanban-subtask-toggle')
    expect(KANBAN_JS).toContain('kanban-embedded-grandchildren')
  })

  it('has two-pass embeddedSubtaskIds computation (depth-1 then depth-2)', () => {
    // The second pass must embed grandchildren under an already-embedded parent.
    expect(KANBAN_JS).toContain('embeddedSubtaskIds.has(card.parent_id)')
    expect(KANBAN_JS).toMatch(/Pass 2|depth-2/i)
  })
})

describe('kanban 3-level UI: cross-parent DnD', () => {
  it('defines subtreeHeightLocal for DnD depth guard', () => {
    expect(KANBAN_JS).toContain('subtreeHeightLocal')
  })

  it('checks target.depth + 1 + sh > 2 for the DnD depth guard', () => {
    expect(KANBAN_JS).toContain('card.depth + 1 + sh > 2')
  })

  it('calls PATCH /parent on reparent drop', () => {
    expect(KANBAN_JS).toContain('/parent')
    expect(KANBAN_JS).toContain("method: 'PATCH'")
  })

  it('applies drop-target-parent class on valid target', () => {
    expect(KANBAN_JS).toContain('drop-target-parent')
  })

  it('applies drop-target-invalid class on depth-constraint violation', () => {
    expect(KANBAN_JS).toContain('drop-target-invalid')
  })
})

describe('kanban 3-level UI: CSS classes', () => {
  it('defines .kanban-embedded-grandchildren', () => {
    expect(STYLE_CSS).toContain('.kanban-embedded-grandchildren')
  })

  it('has [hidden] override for .kanban-embedded-grandchildren to beat display:flex cascade', () => {
    // Without this rule the collapse toggle sets hidden=true but the element
    // stays visible because display:flex (specificity 0,1,0) overrides the UA
    // [hidden] default (display:none). The attribut selector bumps to 0,2,0.
    expect(STYLE_CSS).toContain('.kanban-embedded-grandchildren[hidden]')
    expect(STYLE_CSS).toMatch(/\.kanban-embedded-grandchildren\[hidden\]\s*\{[^}]*display\s*:\s*none/)
  })

  it('defines .kanban-depth-2 style', () => {
    expect(STYLE_CSS).toContain('.kanban-depth-2')
  })

  it('defines .kanban-subtask-toggle style', () => {
    expect(STYLE_CSS).toContain('.kanban-subtask-toggle')
  })

  it('defines .drop-target-parent style', () => {
    expect(STYLE_CSS).toContain('.drop-target-parent')
  })

  it('defines .drop-target-invalid style', () => {
    expect(STYLE_CSS).toContain('.drop-target-invalid')
  })
})
