/**
 * MEMKULCSHOMOGLIF1009.
 *
 * The warn-only homoglyph check on POST /api/memories read `data.content` and
 * nothing else, so `keywords` -- the other durable column on the same row --
 * went in unchecked. The two fields do not carry the same risk:
 *
 *   content:  a Cyrillic lookalike is COSMETIC. The sentence still reads, the
 *             row still comes back, and a later sweep still finds the character.
 *   keywords: a Cyrillic lookalike is FUNCTIONAL. That column is the search
 *             surface, so the corrupted word removes the single query path that
 *             led through it, while every other keyword on the row keeps
 *             matching -- the loss reads as "no such memory", not as a bug.
 *
 * Measured on the live dashboard 2026-10-09: searching the clean
 * spelling of the corrupted word missed the row; searching a clean co-keyword
 * from the same row returned it. The gate stood on one path, and the damage was
 * on the other.
 *
 * Cyrillic characters below are built from codepoints on purpose: a literal
 * would make this file a hit for the fleet's own homoglyph sweep.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { Readable } from 'node:stream'
import { initDatabase, saveAgentMemory } from '../db.js'
import { tryHandleMemories } from '../web/routes/memories.js'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, MAIN_AGENT_ID: 'agent-a', ALLOWED_CHAT_ID: 'test-chat', OLLAMA_URL: '' }
})

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

const CYR_E = String.fromCodePoint(0x0435) // looks like 'e'

function call(path: string, method: string, payload: unknown): Promise<{ handled: boolean; body: any }> {
  const req = Readable.from([Buffer.from(JSON.stringify(payload))]) as any
  let responseBody = ''
  const res = {
    writeHead: () => {},
    end: (body?: string) => { responseBody = body || '' },
    setHeader: () => {},
  }
  const ctx: RouteContext = {
    req, res: res as any, path, method, url: new URL(`http://localhost:3420${path}`),
  }
  return tryHandleMemories(ctx).then((handled) => ({
    handled, body: responseBody ? JSON.parse(responseBody) : null,
  }))
}

const postMemory = (payload: unknown) => call('/api/memories', 'POST', payload)
const patchMemory = (id: number, payload: unknown) => call(`/api/memories/${id}`, 'PATCH', payload)

beforeAll(() => { initDatabase(':memory:') })
afterAll(() => { vi.restoreAllMocks() })

describe('POST /api/memories -- homoglyph warning covers keywords', () => {
  it('warns about a Cyrillic lookalike in keywords even when the content is clean', async () => {
    const { handled, body } = await postMemory({
      agent_id: 'agent-a',
      content: 'a kor eredmenye rendben, tiszta szoveg',
      category: 'cold',
      keywords: `mer${CYR_E}se, nevezo`,
    })
    expect(handled).toBe(true)
    expect(body.ok).toBe(true)
    expect(body.homoglyph_warning).toContain('[keywords]')
    expect(body.homoglyph_warning).toContain('U+0435')
    // the raw character never rides the warning -- it would be the next scan's hit
    expect(body.homoglyph_warning).not.toContain(CYR_E)
    // warn-only: the row is saved, never rejected or rewritten
    expect(body.id).toBeGreaterThan(0)
  })

  it('still warns about the content field, and names which field it found', async () => {
    const { body } = await postMemory({
      agent_id: 'agent-a',
      content: `a fej mer${CYR_E}se kesz`,
      category: 'cold',
      keywords: 'tiszta, kulcsszo',
    })
    expect(body.homoglyph_warning).toContain('[content]')
    expect(body.homoglyph_warning).not.toContain('[keywords]')
  })

  it('names both fields when both are corrupted', async () => {
    const { body } = await postMemory({
      agent_id: 'agent-a',
      content: `a fej mer${CYR_E}se kesz`,
      category: 'cold',
      keywords: `mer${CYR_E}se`,
      // same body as an earlier case: without this the dedup check answers
      // `duplicate` and nothing is saved, so there is no warning to read
      allow_duplicate: true,
    })
    expect(body.homoglyph_warning).toContain('[content]')
    expect(body.homoglyph_warning).toContain('[keywords]')
  })

  it('clean content and clean keywords carry no warning at all', async () => {
    const { body } = await postMemory({
      agent_id: 'agent-a',
      content: 'árvíztűrő tükörfúrógép, mérése kész',
      category: 'cold',
      keywords: 'mérése, nevező',
    })
    expect(body.ok).toBe(true)
    expect(body).not.toHaveProperty('homoglyph_warning')
  })

  it('a missing keywords field is not a hit -- the check must not read undefined as text', async () => {
    const { body } = await postMemory({
      agent_id: 'agent-a',
      content: 'tiszta tartalom kulcsszavak nelkul',
      category: 'cold',
    })
    expect(body.ok).toBe(true)
    expect(body).not.toHaveProperty('homoglyph_warning')
  })
})

/**
 * The PATCH path had no check at all, and it is not the rare path: tier moves
 * and keyword repairs all go through it. Measured 2026-10-09 on the
 * a sub-agent's rows -- two text-writing PATCHes passed unchecked that day,
 * one of them the repair OF a contaminated keyword. A slip inside a repair is
 * the worst place for the gate to be absent, because the author believes they
 * just cleaned the row.
 */
describe('PUT/PATCH /api/memories/:id -- the same check on the update path', () => {
  let rowId = 0
  beforeAll(() => {
    rowId = saveAgentMemory('agent-a', 'eredeti tiszta tartalom', 'hot', 'eredeti, kulcsszo').id
  })

  it('warns when the PATCH writes a corrupted keyword', async () => {
    const { body } = await patchMemory(rowId, { keywords: `mer${CYR_E}se, javitva`, updated_by: 'agent-a' })
    expect(body.ok).toBe(true)
    expect(body.homoglyph_warning).toContain('[keywords]')
    expect(body.homoglyph_warning).toContain('U+0435')
  })

  it('warns when the PATCH writes corrupted content', async () => {
    const { body } = await patchMemory(rowId, { content: `a fej mer${CYR_E}se kesz` })
    expect(body.homoglyph_warning).toContain('[content]')
  })

  it('a clean PATCH stays a plain ok', async () => {
    const { body } = await patchMemory(rowId, { content: 'tiszta javitas', keywords: 'tiszta' })
    expect(body.ok).toBe(true)
    expect(body).not.toHaveProperty('homoglyph_warning')
  })

  it('a category-only move reports nothing -- not even a character already in the stored row', async () => {
    // the row is carrying a Cyrillic letter from the second case above; the
    // caller of a tier move did not write it, so warning here would be noise
    // about someone else's text, on the one path the fleet uses most.
    const { body } = await patchMemory(rowId, { category: 'cold' })
    expect(body.ok).toBe(true)
    expect(body).not.toHaveProperty('homoglyph_warning')
  })

  it('a missing row is still a 404, with no warning invented for it', async () => {
    const { body } = await patchMemory(999999, { content: `mer${CYR_E}se` })
    expect(body).not.toHaveProperty('homoglyph_warning')
    expect(body.error).toBe('Memory not found')
  })
})
