import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { safeContentType, attachmentKind } from '../web/kanban-attachment-path.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')
const ROUTE = readFileSync(join(__dirname, '../web/routes/kanban.ts'), 'utf-8')

// The filename is written by whoever uploaded the file. On 2026-07-22 that string
// was an attack surface twice in one day -- header injection on the PHP bridge and
// prompt injection in the dispatch text. On a web page it is XSS.
const HOSTILE = '<img src=x onerror=alert(1)>.png'

// HONEST LIMIT, stated rather than glossed over: there is no DOM environment in
// this project (no jsdom/happy-dom) and one test does not justify adding one. So
// the browser half is proved as a SOURCE CONTRACT -- every attachment-derived value
// provably passes through escapeHtml, and escapeHtml provably uses the
// textContent->innerHTML idiom -- while the server half below is proved functionally.
describe('attachment XSS: the browser half (source contract)', () => {
  const block = APP.slice(
    APP.indexOf('let attachmentsHtml'),
    APP.indexOf('attachmentsHtml = `<div class="kanban-card-attachments">') + 200,
  )

  it('the attachment render block exists (guards against a silent refactor)', () => {
    expect(block.length).toBeGreaterThan(200)
    expect(block).toContain('kanban-card-attachments')
  })

  it('NEVER interpolates a raw attachment field -- name and id always go through escapeHtml', () => {
    // Any `${a.<field>}` that is not wrapped in escapeHtml(...) is a finding.
    const raw = [...block.matchAll(/\$\{\s*(a\.[A-Za-z_]+)\s*\}/g)].map((m) => m[1])
    expect(raw).toEqual([])
    // And the values that DO appear are the escaped/derived ones.
    expect(block).toContain('escapeHtml(a.name ?? \'\')')
    expect(block).toContain('escapeHtml(a.id)')
  })

  it('the size is derived, never echoed as caller text', () => {
    // formatAttachmentSize coerces to Number and returns a fixed shape, so a hostile
    // "size" cannot carry markup even before escaping.
    expect(block).toContain('formatAttachmentSize(a.size)')
    expect(APP).toMatch(/function formatAttachmentSize\(n\)\s*\{[\s\S]*?Number\(n\)/)
  })

  it('escapeHtml uses the textContent->innerHTML idiom AND encodes quotes', () => {
    const start = APP.indexOf('function escapeHtml(str)')
    const fn = APP.slice(start, APP.indexOf('\n}', start))
    expect(fn).toContain('d.textContent = str')
    expect(fn).toContain('d.innerHTML')
    // Quote encoding matters because the name lands in title="..." and alt="..."
    expect(fn).toContain("replace(/\"/g, '&quot;')")
    expect(fn).toContain("replace(/'/g, '&#39;')")
  })

  it('the image tile builds its src from a blob, never from caller text', () => {
    // data-att-src carries only the attachment ID; hydrateCardAttachments swaps in a
    // blob URL. No caller-controlled string ever reaches an src attribute.
    expect(block).toContain('data-att-src="${escapeHtml(a.id)}"')
    expect(block).not.toMatch(/src="\$\{[^}]*a\.(name|path)/)
    expect(APP).toContain('URL.createObjectURL')
  })

  it('the frontend never receives a filesystem path to render', () => {
    // The API deliberately omits `path`; if that regressed, the UI could start
    // showing (or worse, requesting) real paths.
    expect(ROUTE).toContain('kind: attachmentKind(a.mime)')
    const embed = ROUTE.slice(ROUTE.indexOf('attachments: (attByCard.get'), ROUTE.indexOf('json(res, cards)'))
    expect(embed).not.toContain('path')
  })
})

describe('attachment XSS: the server half (functional)', () => {
  it('a hostile filename never reaches a response header', () => {
    // The download endpoint sets Content-Disposition to a constant. Nothing derived
    // from original_name is put in any header -- that is what the PHP bridge had to
    // be hardened for, and here we simply do not do it.
    const handler = ROUTE.slice(
      ROUTE.indexOf("const attachmentMatch = path.match"),
      ROUTE.indexOf('createReadStream(verdict.path)'),
    )
    expect(handler).toContain("'Content-Disposition': 'inline'")
    expect(handler).not.toMatch(/Content-Disposition[^\n]*original_name/)
    expect(handler).not.toMatch(/filename/i)
  })

  it('refuses to echo a hostile MIME back as a content type', () => {
    expect(safeContentType('text/html')).toBe('application/octet-stream')
    expect(safeContentType('image/svg+xml')).toBe('application/octet-stream')
    expect(safeContentType('<script>')).toBe('application/octet-stream')
  })

  it('never previews a file just because its NAME looks like an image', () => {
    // kind comes from the MIME, not the extension -- so HOSTILE (".png" in the name,
    // no image mime) is a plain file and gets no <img> tile at all.
    expect(attachmentKind('text/html')).toBe('file')
    expect(HOSTILE.endsWith('.png')).toBe(true)     // the name says image...
    expect(attachmentKind(null)).toBe('file')       // ...the type decides, and says no
  })

  it('sends nosniff so the browser cannot re-interpret the bytes', () => {
    expect(ROUTE).toContain("'X-Content-Type-Options': 'nosniff'")
  })
})
