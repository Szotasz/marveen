// Card f9242cd3 (#571): the fleet marks a memory that replaces an older one
// with "FELULIRJA <id>" in its text ("FELULIRJA 1244-et", "FELULIRJA a #219-et",
// "felulirja az 1327-est"). Nothing read that marker, so the replaced row kept
// showing up next to its replacement, and the only way to follow the chain was
// to search for the number by hand.
//
// Measured 2026-10-17 on a copy of the owner store: 173 rows carry the word,
// 68 distinct older rows are replaced IN FULL, 42 references are PARTIAL
// ("a 876-os emleket ket ponton", "1120 allapot-reszet", "... 2. pontjat").
// A partial reference is a link, never a replacement: hiding or demoting the
// older row would lose the parts that still stand.
//
// The free-text marker is read for LINKS only (chips on the memory tab, both
// directions). It never hides or moves a row: the explicit replacement is
// POST /api/memories with `supersedes: [ids]` (#2124), which retracts the
// older rows. Free text is too loose to act on (review on PR #2031).
import { getDb } from './db.js'

export interface SupersedeRef {
  id: number
  partial: boolean
}

// keyword, optional article, optional '#', the id. The id must not run on into
// a time, a decimal or a date ("FELULIRJA a 20:35-os allapotot" names a time,
// "felulirja a 08-01 21:36-os" a date, not row 20 or row 8); a colon that ends
// the marker ("FELULIRJA 1345: ...") is fine.
const REF_RX = /fel[uü]l[ií]rja\s+(?:az?\s+)?#?(\d{1,7})(?!\d)(?![:.,-]\d)/gi
// The text after the id that decides full vs partial: up to 60 characters, cut
// at a line break or at the NEXT marker, so one reference's tail never reads
// the next one's words (and a regex tail can no longer swallow that marker).
const TAIL_LEN = 60
const NEXT_MARKER_RX = /fel[uü]l[ií]rja/i
// Words that make the reference partial when they follow the id closely: a
// point, part, section, paragraph, or a single claim, reading or sentence.
const PARTIAL_RX = /pont|r[eé]sz|szakasz|bekezd|[aá]ll[ií]t[aá]s|[eé]rtelmez|mondat/i
// A quoted fragment before the first colon or semicolon ("a 2485-os emlek
// '...' allitasat") names a piece of the row, not the whole row.
const QUOTE_RX = /['"‘’“”„]/

function refTail(content: string, from: number): string {
  let tail = content.slice(from, from + TAIL_LEN)
  const nl = tail.indexOf('\n')
  if (nl >= 0) tail = tail.slice(0, nl)
  const next = tail.search(NEXT_MARKER_RX)
  if (next >= 0) tail = tail.slice(0, next)
  return tail
}

function isPartial(tail: string): boolean {
  if (PARTIAL_RX.test(tail)) return true
  const head = tail.split(/[:;]/, 1)[0]
  return QUOTE_RX.test(head)
}

/** The rows a memory's text says it replaces, oldest-first as written. A
 *  reference to itself or to a NEWER id is not a replacement (an in-place
 *  update note, or a typo) and is dropped. */
export function parseSupersedeRefs(selfId: number, content: string): SupersedeRef[] {
  const out: SupersedeRef[] = []
  const seen = new Set<number>()
  for (const m of content.matchAll(REF_RX)) {
    const id = Number(m[1])
    if (!(id > 0) || id >= selfId || seen.has(id)) continue
    seen.add(id)
    out.push({ id, partial: isPartial(refTail(content, m.index! + m[0].length)) })
  }
  return out
}

export interface Supersessions {
  /** older id -> the NEWEST row that replaces it in full */
  supersededBy: Map<number, number>
  /** newer id -> what it references (full and partial) */
  refs: Map<number, SupersedeRef[]>
}

/** One pass over the rows that carry the keyword. LIKE's '_' matches one
 *  character, so it also finds the accented spelling; ASCII case is ignored
 *  by LIKE already. Only references to rows that still exist count. */
export function getMemorySupersessions(): Supersessions {
  const db = getDb()
  const rows = db
    .prepare("SELECT id, content FROM memories WHERE content LIKE '%fel_l_rja%'")
    .all() as { id: number; content: string }[]
  const exists = db.prepare('SELECT 1 FROM memories WHERE id = ?')
  const supersededBy = new Map<number, number>()
  const refs = new Map<number, SupersedeRef[]>()
  for (const r of rows) {
    const found = parseSupersedeRefs(r.id, r.content).filter(x => exists.get(x.id))
    if (found.length === 0) continue
    refs.set(r.id, found)
    for (const x of found) {
      if (x.partial) continue
      const prev = supersededBy.get(x.id)
      if (prev === undefined || r.id > prev) supersededBy.set(x.id, r.id)
    }
  }
  return { supersededBy, refs }
}
