// String-contract guard for MD rendering unification (house idiom: reads
// frontend files as strings and asserts short, formatting-proof fragments).
// Guards: (a) single renderMarkdown definition, (b) language class on fenced
// code blocks, (c) unified md-rendered class on both skill modal and docs page.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP  = readFileSync(join(__dirname, '../../web/app.js'),     'utf-8')
const HTML = readFileSync(join(__dirname, '../../web/index.html'), 'utf-8')
const CSS  = readFileSync(join(__dirname, '../../web/style.css'),  'utf-8')

describe('md rendering unification', () => {
  it('app.js has exactly one renderMarkdown function definition', () => {
    const matches = APP.match(/^function renderMarkdown\b/gm)
    expect(matches).not.toBeNull()
    expect(matches!.length).toBe(1)
  })

  it('renderMarkdown emits language class on fenced code blocks', () => {
    // The fence branch must include class="language-... in its output push
    expect(APP).toContain('class="language-')
    expect(APP).toMatch(/class="language-' \+ escapeHtml\(fence\[1\]\)/)
  })

  it('skill detail container has md-rendered class', () => {
    expect(HTML).toContain('id="skillDetailContent"')
    expect(HTML).toMatch(/class="[^"]*md-rendered[^"]*"\s+id="skillDetailContent"/)
  })

  it('docs page container gets md-rendered class', () => {
    expect(APP).toContain('"docs-rendered markdown-body md-rendered"')
  })

  it('style.css defines .md-rendered with code/pre rules', () => {
    expect(CSS).toContain('.md-rendered code')
    expect(CSS).toContain('.md-rendered pre code')
  })
})
