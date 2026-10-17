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
import { getDb, updateMemory } from './db.js'

export interface SupersedeRef {
  id: number
  partial: boolean
}

// keyword, optional article, optional '#', the id. The id must not run on into
// a time or a decimal ("FELULIRJA a 20:35-os allapotot" names a time, not row 20);
// a colon that ends the marker ("FELULIRJA 1345: ...") is fine.
const REF_RX = /fel[uü]l[ií]rja\s+(?:az?\s+)?#?(\d{1,7})(?!\d)(?![:.,]\d)(\S*)([^\n]{0,60})/gi
// Words that make the reference partial when they follow the id closely.
const PARTIAL_RX = /pont|r[eé]sz|szakasz|bekezd/i

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
    out.push({ id, partial: PARTIAL_RX.test(m[2] + m[3]) })
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

// Card f9242cd3 (#571), the owner's idea b) as written (tg 7982): "the
// replaced old row goes to cold by itself". Done at WRITE time, for the rows
// this memory replaces IN FULL, and only from hot or warm: a shared row stays
// shared (moving it to cold would take it away from every other agent, a
// different decision), a partial reference never moves anything. The move
// goes through updateMemory, so the pre-image is versioned and the caches are
// evicted like any other tier change; updated_by names the replacing row.
export function demoteSupersededRows(newId: number, content: string): number[] {
  const db = getDb()
  const moved: number[] = []
  for (const ref of parseSupersedeRefs(newId, content)) {
    if (ref.partial) continue
    const row = db.prepare('SELECT id, content, category FROM memories WHERE id = ?').get(ref.id) as
      { id: number; content: string; category: string } | undefined
    if (!row || (row.category !== 'hot' && row.category !== 'warm')) continue
    if (updateMemory(row.id, row.content, 'cold', undefined, undefined, `supersede:${newId}`)) moved.push(row.id)
  }
  return moved
}
