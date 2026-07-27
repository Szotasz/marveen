// String-contract guard for MD rendering unification (house idiom: reads
// frontend files as strings and asserts short, formatting-proof fragments).
// Guards: (a) single renderMarkdown definition, (b) language class on fenced
// code blocks, (c) unified md-rendered class on both skill modal and docs page.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP          = readFileSync(join(__dirname, '../../web/app.js'),                   'utf-8')
// Docs + research viewer extracted to docs-research.js in S-14b modularization.
const DOCS_MOD     = readFileSync(join(__dirname, '../../web/modules/docs-research.js'), 'utf-8')
const SKILLS_MOD   = readFileSync(join(__dirname, '../../web/modules/skills.js'),        'utf-8')
const HTML         = readFileSync(join(__dirname, '../../web/index.html'),               'utf-8')
const CSS          = readFileSync(join(__dirname, '../../web/style.css'),                'utf-8')

describe('md rendering unification', () => {
  it('docs-research.js has exactly one renderMarkdown function definition', () => {
    // renderMarkdown moved from app.js to docs-research.js in S-14b
    const matches = DOCS_MOD.match(/^function renderMarkdown\b/gm)
    expect(matches).not.toBeNull()
    expect(matches!.length).toBe(1)
    // Must no longer exist in app.js
    expect(APP).not.toMatch(/^function renderMarkdown\b/m)
    // …and be exported so other modules can share it.
    expect(DOCS_MOD).toMatch(/export\s*\{\s*renderMarkdown\s*\}/)
  })

  it('skills.js imports renderMarkdown (regression: empty skill content)', () => {
    // skills.js uses renderMarkdown() for the SKILL.md preview. Without an
    // import it throws ReferenceError at click time and the content field
    // stays blank (the #3 modularization left this reference dangling).
    expect(SKILLS_MOD).toMatch(/import\s*\{[^}]*\brenderMarkdown\b[^}]*\}\s*from\s*'\.\/docs-research\.js'/)
    expect(SKILLS_MOD).toContain('renderMarkdown(')
  })

  it('renderMarkdown emits language class on fenced code blocks', () => {
    // The fence branch must include class="language-... in its output push
    expect(DOCS_MOD).toContain('class="language-')
    expect(DOCS_MOD).toMatch(/class="language-' \+ escapeHtml\(fence\[1\]\)/)
  })

  it('skill detail container has md-rendered class', () => {
    expect(HTML).toContain('id="skillDetailContent"')
    expect(HTML).toMatch(/class="[^"]*md-rendered[^"]*"\s+id="skillDetailContent"/)
  })

  it('docs page container gets md-rendered class', () => {
    // openDoc lives in docs-research.js after S-14b
    expect(DOCS_MOD).toContain('"docs-rendered markdown-body md-rendered"')
  })

  it('style.css defines .md-rendered with code/pre rules', () => {
    expect(CSS).toContain('.md-rendered code')
    expect(CSS).toContain('.md-rendered pre code')
  })
})
