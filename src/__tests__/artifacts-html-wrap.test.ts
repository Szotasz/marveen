// Tests for the HTML fragment re-wrapping logic used in downloadArtifact().
//
// downloadArtifact() lives in web/modules/artifacts.js (browser-only: Blob,
// URL, document). The wrapping predicate and transform are pure and extracted
// here so they can be unit-tested in Node without browser globals.
//
// If the logic in downloadArtifact() changes, update the mirror here too.

import { describe, it, expect } from 'vitest'

// Mirror of the re-wrap logic in web/modules/artifacts.js downloadArtifact().
function wrapHtmlIfFragment(content: string): string {
  const trimmed = content.trimStart()
  const alreadyWrapped = /^<!doctype\b/i.test(trimmed) || /^<html\b/i.test(trimmed)
  return alreadyWrapped
    ? content
    : `<!doctype html>\n<html lang="hu">\n<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>\n<body>\n${content}\n</body>\n</html>`
}

describe('HTML artifact download: wrapHtmlIfFragment', () => {
  it('leaves content untouched when it starts with <!doctype html>', () => {
    const full = '<!doctype html><html><head></head><body><p>hi</p></body></html>'
    expect(wrapHtmlIfFragment(full)).toBe(full)
  })

  it('leaves content untouched when it starts with <html>', () => {
    const full = '<html><body>hello</body></html>'
    expect(wrapHtmlIfFragment(full)).toBe(full)
  })

  it('wraps a bare fragment that has no document skeleton', () => {
    const fragment = '<div>Hello world</div>'
    const result = wrapHtmlIfFragment(fragment)
    expect(result).toMatch(/^<!doctype html>/i)
    expect(result).toContain('<html')
    expect(result).toContain('<body>')
    expect(result).toContain(fragment)
    expect(result).toContain('</body>')
    expect(result).toContain('</html>')
  })

  it('wraps a fragment with leading whitespace', () => {
    const fragment = '  \n<p>Paragraph</p>'
    const result = wrapHtmlIfFragment(fragment)
    expect(result).toMatch(/^<!doctype html>/i)
    expect(result).toContain('<p>Paragraph</p>')
  })

  it('wraps an empty string', () => {
    const result = wrapHtmlIfFragment('')
    expect(result).toMatch(/^<!doctype html>/i)
    expect(result).toContain('<body>')
  })

  it('is case-insensitive for <!DOCTYPE HTML>', () => {
    const full = '<!DOCTYPE HTML><html><body></body></html>'
    expect(wrapHtmlIfFragment(full)).toBe(full)
  })

  it('is case-insensitive for <HTML>', () => {
    const full = '<HTML><body></body></HTML>'
    expect(wrapHtmlIfFragment(full)).toBe(full)
  })

  it('wraps a fragment that only contains a script tag', () => {
    const fragment = '<script>console.log("hi")</script>'
    const result = wrapHtmlIfFragment(fragment)
    expect(result).toMatch(/^<!doctype html>/i)
    expect(result).toContain(fragment)
  })

  it('preserves the exact original content inside the wrapper', () => {
    const fragment = '<table><tr><td>cell</td></tr></table>'
    const result = wrapHtmlIfFragment(fragment)
    expect(result).toContain(fragment)
  })

  it('sets charset and viewport meta in wrapped output', () => {
    const result = wrapHtmlIfFragment('<p>test</p>')
    expect(result).toContain('charset="utf-8"')
    expect(result).toContain('viewport')
  })
})
