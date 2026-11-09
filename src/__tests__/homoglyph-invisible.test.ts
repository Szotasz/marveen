import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Readable } from 'node:stream'

// Two gaps in the warn-only homoglyph gate (GATEHOMOGLIFSWEEP816):
//  1. it saw Cyrillic/Greek look-alikes but not INVISIBLE marks (zero-width
//     space/joiners, soft hyphen, word joiner, BOM, ...), which break a later
//     search exactly the same way and cannot even be noticed by eye;
//  2. the kanban comment POST never returned `homoglyph_warning`, unlike
//     memories / daily-log / messages: the sqlite trigger journals, but the
//     caller that just wrote the comment never heard about it.
// The invisible class is the Unicode-category rule of scripts/lib/hidden_marks.py
// (#1819), so the sending side and the storing side flag the same set.
// Every mark below is built from its code point: a literal would make this
// file a hit for the fleet's own sweeps.

const cp = (n: number) => String.fromCodePoint(n)
const SHY = cp(0x00ad), ZWSP = cp(0x200b), ZWNJ = cp(0x200c), ZWJ = cp(0x200d)
const WJ = cp(0x2060), BOM = cp(0xfeff), NBSP = cp(0x00a0), LSEP = cp(0x2028), NEL = cp(0x0085)
const VS16 = cp(0xfe0f)
const MAN = cp(0x1f468), WOMAN = cp(0x1f469), HEART = cp(0x2764), CYR_E = cp(0x0435)

const getKanbanCard = vi.fn()
const addKanbanComment = vi.fn((_c: string, _a: string, content: string) => ({ id: 1, card_id: 'CARD0001', content }))

vi.mock('../db.js', () => ({
  listKanbanCards: vi.fn(() => []),
  createKanbanCard: vi.fn(),
  updateKanbanCard: vi.fn(),
  deleteKanbanCard: vi.fn(),
  moveKanbanCard: vi.fn(),
  archiveKanbanCard: vi.fn(),
  unarchiveKanbanCard: vi.fn(),
  getKanbanComments: vi.fn(() => []),
  addKanbanComment,
  getKanbanCardEvents: vi.fn(() => []),
  listKanbanProjects: vi.fn(() => []),
  getKanbanCard,
  getChildCards: vi.fn(() => []),
  getDb: vi.fn(),
  createAgentMessage: vi.fn(),
  markKanbanCardDispatched: vi.fn(),
  getKanbanSeqByIdPrefix: vi.fn(() => undefined),
  listLabels: vi.fn(() => []),
  getLabel: vi.fn(),
  createLabel: vi.fn(),
  updateLabel: vi.fn(),
  deleteLabel: vi.fn(),
  addLabelToCard: vi.fn(),
  removeLabelFromCard: vi.fn(),
  getLabelsForAllCards: vi.fn(() => ({})),
  getLabelsForCard: vi.fn(() => []),
  listArchivedKanbanCards: vi.fn(() => []),
  revertIdeaFromKanban: vi.fn(),
  getHeartbeatKanbanSummary: vi.fn(() => ({})),
}))

const { detectHomoglyphs, formatHomoglyphWarning } = await import('../homoglyph.js')
const { tryHandleKanban } = await import('../web/routes/kanban.js')

describe('detectHomoglyphs: the INVISIBLE class', () => {
  it.each([
    ['U+00AD', SHY], ['U+200B', ZWSP], ['U+200C', ZWNJ], ['U+200D', ZWJ],
    ['U+2060', WJ], ['U+FEFF', BOM], ['U+00A0', NBSP], ['U+2028', LSEP], ['U+0085', NEL],
  ])('flags %s inside a word, by code point', (code, mark) => {
    const f = detectHomoglyphs(`a kereses${mark}kulcs megvan`)
    expect(f).toHaveLength(1)
    expect(f[0].script).toBe('INVISIBLE')
    expect(f[0].codepoint).toBe(code)
  })

  it('does not flag tab, newline, carriage return or the ASCII space', () => {
    expect(detectHomoglyphs('sor egy\tketto\r\nharom negy')).toHaveLength(0)
  })

  it('does not flag a ZWJ that joins an emoji sequence, with or without a variation selector', () => {
    expect(detectHomoglyphs(`csalad: ${MAN}${ZWJ}${WOMAN} kesz`)).toHaveLength(0)
    expect(detectHomoglyphs(`${HEART}${VS16}${ZWJ}${MAN}`)).toHaveLength(0)
  })

  it('DOES flag the same joiner between two letters (mutation control for the exception)', () => {
    const f = detectHomoglyphs(`ker${ZWJ}es`)
    expect(f).toHaveLength(1)
    expect(f[0].codepoint).toBe('U+200D')
  })

  it('keeps the UTF-16 index of the mark after an astral character', () => {
    const text = `${MAN} x${ZWSP}y`
    const f = detectHomoglyphs(text)
    expect(f).toHaveLength(1)
    expect(text[f[0].index]).toBe(ZWSP)
  })

  it('reports Cyrillic and invisible findings side by side', () => {
    const scripts = detectHomoglyphs(`m${CYR_E}r${ZWSP}es`).map((x) => x.script)
    expect(scripts).toEqual(['CYRILLIC', 'INVISIBLE'])
  })

  it('the warning cites the code point and never carries the mark itself', () => {
    const w = formatHomoglyphWarning(detectHomoglyphs(`a kereses${ZWSP}kulcs, es meg${BOM} egy`))
    expect(w).toContain('U+200B (INVISIBLE)')
    expect(w).toContain('U+FEFF (INVISIBLE)')
    expect(w).not.toContain(ZWSP)
    expect(w).not.toContain(BOM)
    expect(w).toContain('Saved unchanged')
  })

  it('clean Hungarian text with accents stays silent', () => {
    expect(detectHomoglyphs('árvíztűrő tükörfúrógép, mérése kész – „idézet”')).toHaveLength(0)
  })
})

function postComment(cardId: string, payload: unknown) {
  const req = Readable.from([Buffer.from(JSON.stringify(payload))]) as any
  const captured: { status?: number; body?: string } = {}
  const res: any = {
    writeHead: (status: number) => { captured.status = status; return res },
    end: (chunk?: unknown) => { if (chunk !== undefined) captured.body = String(chunk) },
    setHeader: () => {},
  }
  const path = `/api/kanban/${cardId}/comments`
  return tryHandleKanban({
    req, res, path, method: 'POST',
    url: new URL(`http://localhost${path}`),
  } as any).then(handled => ({ handled, ...captured }))
}

describe('POST /api/kanban/:id/comments returns homoglyph_warning', () => {
  beforeEach(() => {
    getKanbanCard.mockReset()
    getKanbanCard.mockReturnValue({ id: 'CARD0001', title: 'kartya' })
    addKanbanComment.mockClear()
  })

  it('an invisible mark: saved unchanged, 200, and the caller is told', async () => {
    const content = `a kereses${ZWSP}kulcs`
    const out = await postComment('CARD0001', { author: 'enigma', content })
    expect(out.status).toBe(200)
    expect(addKanbanComment).toHaveBeenCalledWith('CARD0001', 'enigma', content)
    const body = JSON.parse(out.body!)
    expect(body.homoglyph_warning).toContain('U+200B (INVISIBLE)')
    expect(body.id).toBe(1)
  })

  it('a Cyrillic look-alike is reported on this route too', async () => {
    const out = await postComment('CARD0001', { author: 'enigma', content: `m${CYR_E}res` })
    expect(JSON.parse(out.body!).homoglyph_warning).toContain('U+0435 (CYRILLIC)')
  })

  it('POZITÍV KONTROLL: a clean comment has no homoglyph_warning field at all', async () => {
    const out = await postComment('CARD0001', { author: 'enigma', content: 'tiszta szöveg, ékezettel' })
    expect(out.status).toBe(200)
    expect(JSON.parse(out.body!)).not.toHaveProperty('homoglyph_warning')
  })
})
