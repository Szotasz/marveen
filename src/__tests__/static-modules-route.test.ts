import { describe, it, expect } from 'vitest'
import { rewriteIndexHtml, MODULE_FILENAME_PATTERN } from '../web/routes/static.js'

// ── rewriteIndexHtml: cache-bust regex ──────────────────────────────────────

describe('rewriteIndexHtml: app.js cache-busting', () => {
  const css = '1a2b3c'
  const app = 'deadbeef'
  const brand = 'Marveen'

  it('injects ?v= into a plain <script src="/app.js">', () => {
    const html = '<script src="/app.js"></script>'
    const out = rewriteIndexHtml(html, app, css, brand)
    expect(out).toContain(`/app.js?v=${app}`)
    expect(out).not.toContain('src="/app.js"')
  })

  it('injects ?v= into <script type="module" src="/app.js"> (S-1 POC regression)', () => {
    const html = '<script type="module" src="/app.js"></script>'
    const out = rewriteIndexHtml(html, app, css, brand)
    expect(out).toContain(`/app.js?v=${app}`)
    // The type="module" attribute must be preserved
    expect(out).toContain('type="module"')
    expect(out).not.toContain('src="/app.js"')
  })

  it('handles arbitrary attributes between <script and src= (e.g. defer, crossorigin)', () => {
    const html = '<script defer crossorigin="anonymous" src="/app.js"></script>'
    const out = rewriteIndexHtml(html, app, css, brand)
    expect(out).toContain(`/app.js?v=${app}`)
    expect(out).toContain('defer')
  })

  it('injects ?v= into style.css independently of app.js', () => {
    const html = '<link rel="stylesheet" href="/style.css">'
    const out = rewriteIndexHtml(html, app, css, brand)
    expect(out).toContain(`/style.css?v=${css}`)
    expect(out).not.toContain('href="/style.css"')
  })

  it('does not match an unversioned URL that already has a ?v= token', () => {
    // A script tag with a different src must not be rewritten
    const html = '<script src="/other.js"></script>'
    const out = rewriteIndexHtml(html, app, css, brand)
    expect(out).toBe(html)
  })

  it('bakes the brand name into apple-mobile-web-app-title', () => {
    const html = '<meta name="apple-mobile-web-app-title" content="OldBrand">'
    const out = rewriteIndexHtml(html, app, css, 'NewBrand')
    expect(out).toContain('content="NewBrand"')
    expect(out).not.toContain('OldBrand')
  })

  it('escapes HTML special chars in brand name', () => {
    const html = '<meta name="apple-mobile-web-app-title" content="X">'
    const out = rewriteIndexHtml(html, app, css, 'A&B<C>"D')
    expect(out).toContain('A&amp;B&lt;C&gt;&quot;D')
  })
})

// ── MODULE_FILENAME_PATTERN: path-traversal guard ───────────────────────────

describe('MODULE_FILENAME_PATTERN: path-traversal guard', () => {
  const allow = ['toast.js', 'i18n.js', 'app-core.js', 'kanban_dnd.js', 'my-module123.js']
  const deny = [
    '../secret.js',
    '../../etc/passwd',
    'toast.js/../../secret',
    'toast.ts',
    'toast.mjs',
    '.js',
    'toast.js.map',
    'toast',
    '',
    'a/b.js',
    '%2e%2e/secret.js',
    'toast.JS',            // case-sensitive: uppercase extension not accepted
  ]

  for (const name of allow) {
    it(`allows "${name}"`, () => {
      expect(MODULE_FILENAME_PATTERN.test(name)).toBe(true)
    })
  }

  for (const name of deny) {
    it(`rejects "${name}"`, () => {
      expect(MODULE_FILENAME_PATTERN.test(name)).toBe(false)
    })
  }
})
