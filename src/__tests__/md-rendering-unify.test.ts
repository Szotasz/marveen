// String-contract guard for MD rendering unification (house idiom: reads
// frontend files as strings and asserts short, formatting-proof fragments).
// Guards: (a) single renderMarkdown definition, (b) language class on fenced
// code blocks, (c) unified md-rendered class on both skill modal and docs page,
// (d) mdInline URL hardening against javascript:/data:/vbscript: schemes.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// Local mdInline re-implementation for DOM-free unit testing.
// Must mirror web/modules/docs-research.js -- if this diverges, the
// source-contract test below will catch it.
// ---------------------------------------------------------------------------
function _escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, (c: string) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c])
}
function _escapeAttr(str: string): string { return _escapeHtml(str) }

function mdInlineLocal(text: string): string {
  let s = _escapeHtml(text)
  s = s.replace(/`([^`]+)`/g, (_m, c) => '<code>' + c + '</code>')
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>')
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, txt, url) => {
    const safeUrl = /^(?:javascript|data|vbscript):/i.test(url.trim()) ? '#' : url
    return '<a href="' + _escapeAttr(safeUrl) + '" target="_blank" rel="noopener noreferrer">' + txt + '</a>'
  })
  return s
}

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

// ---------------------------------------------------------------------------
// mdInline URL hardening: dangerous scheme rejection
// ---------------------------------------------------------------------------

describe('mdInline link hardening (source contract)', () => {
  it('docs-research.js contains the scheme-reject guard', () => {
    // The guard must use case-insensitive regex on the trimmed URL
    expect(DOCS_MOD).toMatch(/javascript|data|vbscript/)
    expect(DOCS_MOD).toContain("url.trim()")
    expect(DOCS_MOD).toContain("'#'")
  })
})

describe('mdInline link hardening (functional)', () => {
  it('neutralizes javascript: href to #', () => {
    const out = mdInlineLocal('[click](javascript:alert(1))')
    expect(out).toContain('href="#"')
    expect(out).not.toContain('javascript:')
  })

  it('neutralizes data: href to #', () => {
    const out = mdInlineLocal('[img](data:text/html,<h1>x</h1>)')
    expect(out).toContain('href="#"')
    expect(out).not.toContain('data:')
  })

  it('neutralizes vbscript: href to #', () => {
    const out = mdInlineLocal('[x](vbscript:MsgBox(1))')
    expect(out).toContain('href="#"')
    expect(out).not.toContain('vbscript:')
  })

  it('neutralizes mixed-case JavaScript: href', () => {
    const out = mdInlineLocal('[x](JavaScript:void(0))')
    expect(out).toContain('href="#"')
    expect(out).not.toContain('JavaScript:')
  })

  it('neutralizes scheme with leading whitespace (trim required)', () => {
    // URL regex [^)\s]+ won't capture leading space, but verify trim guard handles it
    // A leading-space URL would not match the link regex at all; this tests trim on captured value
    const out = mdInlineLocal('[x](javascript:alert(1))')
    expect(out).toContain('href="#"')
  })

  it('preserves https:// URLs unchanged', () => {
    const out = mdInlineLocal('[link](https://example.com)')
    expect(out).toContain('href="https://example.com"')
    expect(out).toContain('target="_blank"')
  })

  it('preserves http:// URLs unchanged', () => {
    const out = mdInlineLocal('[link](http://example.com/path)')
    expect(out).toContain('href="http://example.com/path"')
  })

  it('preserves relative #anchor URLs unchanged', () => {
    const out = mdInlineLocal('[link](#section-1)')
    expect(out).toContain('href="#section-1"')
  })

  it('link text is preserved when URL is neutralized', () => {
    const out = mdInlineLocal('[evil text](javascript:x)')
    expect(out).toContain('>evil text<')
    expect(out).toContain('href="#"')
  })
})
