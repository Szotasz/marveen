// Card 3ddb2b1d (#572): the memory list shows a short title line instead of
// the first 120 characters. The function lives in web/app.js (no bundler), so
// the test lifts that one block out of the file and runs it in a sandbox.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const src = readFileSync(new URL('../../web/app.js', import.meta.url), 'utf8')
const start = src.indexOf('const MEM_TITLE_MAX')
const end = src.indexOf('function renderMemories(')
const sandbox: any = {}
runInNewContext(src.slice(start, end) + '\nthis.memTitleParts = memTitleParts', sandbox)
const parts = (s: string) => sandbox.memTitleParts(s) as { title: string; rest: string }

describe('memTitleParts', () => {
  it('the block was found', () => {
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
  })

  it('takes the HEADER: segment as the title and the rest as the snippet', () => {
    expect(parts('ELSZAMOLAS MODJA (2026-08-22, a gazda megerositette): havonta egyszer, CSV-ben.'))
      .toEqual({ title: 'ELSZAMOLAS MODJA (2026-08-22, a gazda megerositette)', rest: 'havonta egyszer, CSV-ben.' })
  })

  it('takes the first sentence', () => {
    expect(parts('A Dream Engine bucket 1 lekerdezese keveset lat. A masodik mondat mar a reszlet.').title)
      .toBe('A Dream Engine bucket 1 lekerdezese keveset lat')
  })

  it('drops a leading FELULIRJA <id> marker (the chain chip says it)', () => {
    expect(parts('FELULIRJA 1345: #558 modproba rejtett ugynok. Meres fut.').title).toBe('#558 modproba rejtett ugynok')
    expect(parts('FELÜLÍRJA az 1327-est: 6 kor kesz es IMAP-on visszamerve. Kovetkezo lepes.').title)
      .toBe('6 kor kesz es IMAP-on visszamerve')
  })

  it('a date or status alone is not a title: the next segment joins it', () => {
    expect(parts('2026-10-03 16:02: Roxy 7608 -> #418 borito KESZ. Reszletek.').title)
      .toBe('2026-10-03 16:02: Roxy 7608 -> #418 borito KESZ')
    expect(parts('LEZARVA 2026-09-09 03:3x: A 095d4e04 kartya DONE. Tobb.').title)
      .toBe('LEZARVA 2026-09-09 03:3x: A 095d4e04 kartya DONE')
  })

  it('does not split on a time or a decimal', () => {
    expect(parts('Mentes 06:30-kor lefutott rendben, 3.5 GB. Utana semmi.').title)
      .toBe('Mentes 06:30-kor lefutott rendben, 3.5 GB')
  })

  it('clips a long first segment at a word boundary, and the snippet then starts from the top', () => {
    const long = 'Ez egy nagyon hosszu elso mondat amiben nincs semmilyen irasjel es ezert a cimet szohataron kell levagni mert kulonben tul hosszu lenne'
    const p = parts(long)
    expect(p.title.length).toBeLessThanOrEqual(91)
    expect(p.title.endsWith('…')).toBe(true)
    expect(p.title).not.toMatch(/\s…$/)
    expect(p.rest.startsWith('Ez egy nagyon')).toBe(true)
  })

  it('only the first line is the title source', () => {
    expect(parts('Rovid cim\nmasodik sor, ami nem cim').title).toBe('Rovid cim')
  })

  it('a one-sentence memory has no snippet', () => {
    expect(parts('Csak egy mondat')).toEqual({ title: 'Csak egy mondat', rest: '' })
  })
})

describe('memTitleParts, shapes found on the owner store', () => {
  it('a time inside the FELULIRJA marker does not end it', () => {
    expect(parts('FELULIRJA a 20:35-os allapotot. 2026-10-15 20:36 BST: a plugin MUKODIK. Lezarva.').title)
      .toBe('2026-10-15 20:36 BST: a plugin MUKODIK')
  })
  it('no trailing period when the first line ends the segment', () => {
    expect(parts('JOSHUA MAYO CSATORNA (Gabor kerte, 2026-08-25).\nAtiratok: ...').title).toBe('JOSHUA MAYO CSATORNA (Gabor kerte, 2026-08-25)')
  })
})
