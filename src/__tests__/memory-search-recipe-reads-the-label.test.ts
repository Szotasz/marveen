// The memory-search endpoint is deliberately forgiving: when no real term
// matches, it drops those terms and answers with whatever the leftover filler
// words pulled in. That answer is byte-indistinguishable from a real hit in the
// BODY. #1374 added the label that tells the two apart, and it rides a response
// header -- `X-Memory-Search: strict=...; relaxed=...; hits=...`.
//
// Every agent instruction file we generate carries a copy of the search recipe.
// The copies read the body only (`curl -s`), so an agent following the
// documented path gets the rescued near-misses with no way to know. Measured on
// the host on 2026-09-17 against the live endpoint: `q=xyzzy-sosem-letezett-
// minta-42` answered `relaxed=true` with 50 rows, while the same query with
// `strict=1` answered `relaxed=false` with 0.
//
// So the pin is not "the recipe mentions a header somewhere": it is that each
// place which hands a caller the search command ALSO hands them the two things
// that make the answer readable -- a way to see the header, and the word
// `relaxed`. A recipe that shows the command without the label is the exact
// state this test exists to keep from coming back.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')

// `curl`: the surface hands out the raw search URL and dumps the headers itself. `helper`: the surface
// calls scripts/marveen-api.sh, whose memory-search verb prints the X-Memory-Search line first (and
// takes --strict); the main agent's template moved there so no token sits on a curl argv.
const SURFACES: Array<{ label: string; path: string; recipe: 'curl' | 'helper' }> = [
  { label: 'agent-scaffold (generated per-agent CLAUDE.md)', path: join(ROOT, 'src', 'web', 'agent-scaffold.ts'), recipe: 'curl' },
  { label: 'templates/CLAUDE.md.template (new install)', path: join(ROOT, 'templates', 'CLAUDE.md.template'), recipe: 'helper' },
]

describe.each(SURFACES)('memory-search recipe in $label', ({ path, recipe }) => {
  const src = readFileSync(path, 'utf-8')

  // Guard the guard: if the recipe ever moves out of this file, the assertions
  // below would pass vacuously on a file that no longer documents anything.
  it('still documents a memory search', () => {
    expect(src).toMatch(recipe === 'curl' ? /\/api\/memories\?[^"'\n]*q=/ : /marveen-api\.sh memory-search \S/)
  })

  // The bound is what makes this an assertion about the RECIPE rather than
  // about the file: a `-D` anywhere else in a 2000-line source would otherwise
  // satisfy it. The window is wide enough for a shell line continuation, which
  // is how the template writes the same command.
  it('shows the label at all (curl: dumps the response headers; helper: its first output line)', () => {
    expect(src).toMatch(
      recipe === 'curl'
        ? /curl[\s\S]{0,200}?-D [\s\S]{0,200}?\/api\/memories\?[^"'\n]*q=/
        : /marveen-api\.sh memory-search [^\n]*\n[\s\S]{0,400}?X-Memory-Search/,
    )
  })

  it('tells the reader to look at X-Memory-Search', () => {
    expect(src.toLowerCase()).toContain('x-memory-search')
  })

  // Named for what it measures: both labels are SPELLED OUT, so a reader meets
  // the two values rather than only the header name. It does NOT measure that
  // the surrounding prose is correct -- replacing the explanation with word
  // soup keeps this green, which is why the review asked for the rename.
  it('spells out both label values, relaxed=true and relaxed=false', () => {
    expect(src).toContain('relaxed=true')
    expect(src).toContain('relaxed=false')
  })

  // REMOVED, not lost: there used to be an assertion here that the recipe warns
  // the tier filter runs after the limit and therefore truncates. #1384 pushed
  // the filter down into the search SQL, so the warning became false and the
  // text it pinned is gone from both surfaces. Measured on merged develop
  // against a copy of the owner store: q=billingo&category=warm now answers 39
  // rows at limit=50 and 39 at limit=200 -- converged, where before it was 9
  // and 39. The PROPERTY that replaced the warning is pinned by
  // memory-search-tier-goes-into-the-query.test.ts, which is where a regression
  // would show up. A deleted assertion with no trace is how the reason gets
  // lost, so this comment stays.

  it('points at the strict form for an absence claim', () => {
    expect(src).toContain(recipe === 'curl' ? 'strict=1' : '--strict')
  })
})
