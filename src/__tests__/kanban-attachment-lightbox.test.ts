import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')
const HTML = readFileSync(join(__dirname, '../../web/index.html'), 'utf-8')
const CSS = readFileSync(join(__dirname, '../../web/style.css'), 'utf-8')
const HU = readFileSync(join(__dirname, '../../web/lang/hu.js'), 'utf-8')
const EN = readFileSync(join(__dirname, '../../web/lang/en.js'), 'utf-8')

// Same house idiom as the other frontend guards: assert short, formatting-proof
// fragments. No DOM environment exists here (see kanban-attachment-xss.test.ts for
// the full reasoning) so these are contracts, not behavioural assertions.
describe('detail view: attachments are shown when the card is opened', () => {
  it('the detail modal has a container and the renderer fills it', () => {
    expect(HTML).toContain('id="cardDetailAttachments"')
    expect(APP).toMatch(/async function renderDetailAttachments\(card\)/)
    expect(APP).toContain('renderDetailAttachments(card)')
  })

  it('builds nodes with textContent, never innerHTML, for caller-written text', () => {
    const fn = APP.slice(APP.indexOf('async function renderDetailAttachments'), APP.indexOf('async function showCardDetail'))
    // The filename is written by whoever uploaded the file -- it must never be parsed as markup.
    expect(fn).toContain('cap.textContent = a.name')
    expect(fn).toContain('nm.textContent = a.name')
    expect(fn).not.toMatch(/innerHTML\s*[+]?=\s*[^']*a\.name/)
  })

  it('images come from a blob URL, never from an <img src> pointing at the API', () => {
    const fn = APP.slice(APP.indexOf('async function renderDetailAttachments'), APP.indexOf('async function showCardDetail'))
    expect(fn).toContain('await attachmentBlobUrl(a.id)')
    expect(fn).not.toMatch(/src\s*=\s*['"`]\/api\//)
  })

  it('only image/* becomes a preview; other types download on click', () => {
    const fn = APP.slice(APP.indexOf('async function renderDetailAttachments'), APP.indexOf('async function showCardDetail'))
    expect(fn).toContain("a.kind === 'image'")
    expect(fn).toContain('link.download = a.name')
  })
})

describe('lightbox: big picture, nothing else', () => {
  it('exists in the markup and starts hidden', () => {
    expect(HTML).toContain('id="attLightbox"')
    expect(HTML).toMatch(/id="attLightbox"[^>]*hidden/)
    expect(CSS).toContain('.lightbox-overlay[hidden] { display: none; }')
  })

  it('opens only from an image attachment', () => {
    const fn = APP.slice(APP.indexOf('async function renderDetailAttachments'), APP.indexOf('async function showCardDetail'))
    const imageBranch = fn.slice(fn.indexOf("a.kind === 'image'"), fn.indexOf('} else {'))
    expect(imageBranch).toContain('openAttachmentLightbox(url')
    // The non-image branch must NOT open it.
    const fileBranch = fn.slice(fn.indexOf('} else {'))
    expect(fileBranch).not.toContain('openAttachmentLightbox')
  })

  it('the caption and alt use textContent / plain assignment, not markup', () => {
    const fn = APP.slice(APP.indexOf('function openAttachmentLightbox'), APP.indexOf('function closeAttachmentLightbox'))
    expect(fn).toContain('cap.textContent = name')
    expect(fn).toContain('img.alt = name')
    // Assert on code, not prose: the word appears in an explanatory comment, so
    // check that nothing is ASSIGNED to innerHTML rather than that the string is absent.
    expect(fn).not.toMatch(/\.innerHTML\s*[+]?=/)
  })

  it('closes on Escape and on a backdrop click -- but not on a click on the picture', () => {
    expect(APP).toMatch(/e\.key === 'Escape'\)\s*closeAttachmentLightbox\(\)/)
    // `e.target === box` is what limits it to the backdrop.
    expect(APP).toContain('e.target === box) closeAttachmentLightbox()')
  })

  it('was NOT given gallery navigation, zoom or a download button', () => {
    // Zsolt asked for a big picture and said "that's it". Guard against scope drift.
    const region = APP.slice(APP.indexOf('function openAttachmentLightbox'), APP.indexOf('function releaseAttachmentBlobs'))
    for (const forbidden of ['zoom', 'rotate', 'nextImage', 'prevImage', 'gallery']) {
      expect(region.toLowerCase()).not.toContain(forbidden)
    }
  })
})

describe('blob lifetime: freed where they actually become garbage', () => {
  it('the board reload releases every cached blob URL', () => {
    expect(APP).toContain('function releaseAttachmentBlobs()')
    expect(APP).toContain('URL.revokeObjectURL(url)')
    // Released just before the card list is replaced -- that is when the old <img>
    // elements holding those URLs are discarded.
    const idx = APP.indexOf('releaseAttachmentBlobs()\n    kanbanCards = await cardsRes.json()')
    expect(idx).toBeGreaterThan(-1)
  })

  it('closing the lightbox does NOT revoke -- the thumbnail still uses that URL', () => {
    const fn = APP.slice(APP.indexOf('function closeAttachmentLightbox'), APP.indexOf("document.addEventListener('keydown'"))
    expect(fn).not.toContain('revokeObjectURL')
    expect(fn).toContain("img.removeAttribute('src')")
  })
})

describe('i18n: the new strings exist in both languages', () => {
  for (const key of ['kanban.modal.attachments_title', 'kanban.modal.attachment_open']) {
    it(`${key} is translated in hu and en`, () => {
      expect(HU).toContain(`'${key}'`)
      expect(EN).toContain(`'${key}'`)
    })
  }
})
