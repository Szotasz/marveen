// Refuse memory saves that repeat one of the saver's own memories. Pure
// comparison logic only -- no DB access, no I/O: the route feeds in the
// candidate rows it fetched and gets back the matches, so the matching itself
// stays unit-testable and the route stays the only place that talks to SQLite.

// Canonical form for the EXACT comparison: NFC (so decomposed accented letters
// equal their precomposed twins), one case, single-spaced, no edges.
export function normalizeMemoryText(s: string): string {
  return s.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim()
}

// Distinct word-tokens of a text. Letters/digits/underscore only: punctuation
// and whitespace separate tokens, and the set (not the sequence) is what the
// similarity check compares, so word order does not matter.
export function memoryTokenSet(s: string): Set<string> {
  return new Set(s.normalize('NFC').toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])
}

export interface DedupCandidate { id: number; content: string; category: string; created_at: number }
export interface DuplicateMatch {
  id: number
  match: 'exact' | 'similar'
  similarity: number
  category: string
  created_at: number
  preview: string
}

export const DUPLICATE_JACCARD_MIN = 0.8
export const DUPLICATE_MIN_TOKENS = 5
// How many of the saver's newest rows the route compares in JS. The comparison
// is synchronous and linear (measured ~0.15-0.2 ms per ~2 KB row), so it is
// bounded; a verbatim repeat of an older row is still found by an SQL equality.
export const DEDUP_RECENT_LIMIT = 200

export function findDuplicateMemories(content: string, candidates: DedupCandidate[]): DuplicateMatch[] {
  const wanted = normalizeMemoryText(content)
  // Computed once, not once per candidate.
  const wantedTokens = memoryTokenSet(content)
  const matches: DuplicateMatch[] = []
  for (const c of candidates) {
    if (normalizeMemoryText(c.content) === wanted) {
      matches.push({ id: c.id, match: 'exact', similarity: 1, category: c.category, created_at: c.created_at, preview: c.content.slice(0, 120) })
      continue
    }
    const tokens = memoryTokenSet(c.content)
    // Short texts are not similar-duplicates: a handful of shared words says
    // nothing (and "deploy done" vs "deploy not done" must not collide).
    if (wantedTokens.size < DUPLICATE_MIN_TOKENS || tokens.size < DUPLICATE_MIN_TOKENS) continue
    // Exact size bound: Jaccard <= min/max, so an unbalanced pair can never
    // reach the threshold -- skip the intersection work entirely.
    if (Math.min(wantedTokens.size, tokens.size) / Math.max(wantedTokens.size, tokens.size) < DUPLICATE_JACCARD_MIN) continue
    let intersection = 0
    for (const t of tokens) if (wantedTokens.has(t)) intersection++
    const union = wantedTokens.size + tokens.size - intersection
    if (intersection / union >= DUPLICATE_JACCARD_MIN) {
      matches.push({
        id: c.id, match: 'similar',
        similarity: Math.round((intersection / union) * 100) / 100,
        category: c.category, created_at: c.created_at, preview: c.content.slice(0, 120),
      })
    }
  }
  // Exact repeats first (they are the certain ones), then the more similar,
  // then the newer row -- capped at 3 so the 409 stays readable.
  matches.sort((a, b) =>
    a.match === b.match
      ? (b.similarity - a.similarity) || (b.id - a.id)
      : a.match === 'exact' ? -1 : 1)
  return matches.slice(0, 3)
}
