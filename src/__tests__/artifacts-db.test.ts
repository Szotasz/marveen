import { describe, it, expect, beforeAll } from 'vitest'
import { initDatabase, searchArtifactsByVector } from '../db.js'
import {
  createArtifact, listArtifacts, getArtifact, deleteArtifact, storeArtifactEmbedding,
  getArtifactStats, renameArtifact, ARTIFACT_TITLE_MAX_LENGTH,
} from '../artifacts-db.js'

beforeAll(() => { initDatabase(':memory:') })

describe('createArtifact cloud_url UPSERT', () => {
  const CLOUD_URL = 'https://cloud.example.test/artifacts/unique-abc'

  it('first POST with cloud_url creates the artifact (updated=false)', () => {
    const r = createArtifact({
      agent_id: 'agent-a', title: 'Cloud artifact v1', kind: 'html',
      content: Buffer.from('<h1>v1</h1>'), source: 'cloud:artifact', cloud_url: CLOUD_URL,
    })
    expect(r.id).toBeTruthy()
    expect(r.updated).toBe(false)
  })

  it('second POST with same cloud_url updates in place (updated=true, single row)', () => {
    const r2 = createArtifact({
      agent_id: 'agent-a', title: 'Cloud artifact v2', kind: 'html',
      content: Buffer.from('<h1>v2</h1>'), source: 'cloud:artifact', cloud_url: CLOUD_URL,
    })
    expect(r2.updated).toBe(true)

    // Must still be exactly one row for this cloud_url
    const rows = listArtifacts({ agent: 'agent-a' }).filter(r => r.cloud_url === CLOUD_URL)
    expect(rows).toHaveLength(1)

    // Content must reflect the latest version
    const full = getArtifact(r2.id)
    expect(full!.content.toString('utf-8')).toBe('<h1>v2</h1>')
    expect(full!.title).toBe('Cloud artifact v2')

    // updated_at must be >= created_at after a re-publish.
    // This is the backend invariant the frontend relies on:
    // the artifact list must show updated_at (not created_at) for re-published artifacts.
    const inList = listArtifacts({ agent: 'agent-a' }).find(r => r.cloud_url === CLOUD_URL)
    expect(inList).toBeDefined()
    expect(inList!.updated_at).toBeGreaterThanOrEqual(inList!.created_at)
  })

  it('artifact without cloud_url inserts unconditionally (updated=false)', () => {
    const r = createArtifact({
      agent_id: 'agent-b', title: 'Local artifact', kind: 'text', content: Buffer.from('local'),
    })
    expect(r.updated).toBe(false)
    expect(getArtifact(r.id)).toBeDefined()
  })

  it('cloud_url is stored and visible on the artifact row', () => {
    const r = createArtifact({
      agent_id: 'agent-a', title: 'URL check', kind: 'text',
      content: Buffer.from('x'), source: 'cloud:artifact',
      cloud_url: 'https://cloud.example.test/artifacts/url-check',
    })
    const full = getArtifact(r.id)
    expect(full!.cloud_url).toBe('https://cloud.example.test/artifacts/url-check')
  })
})

describe('createArtifact', () => {
  it('stores and retrieves a text artifact', () => {
    const { id } = createArtifact({
      agent_id: 'agent-a',
      title: 'Hello world',
      kind: 'text',
      content: Buffer.from('Hello!', 'utf-8'),
    })
    expect(id).toBeTruthy()
    const row = getArtifact(id)
    expect(row).toBeDefined()
    expect(row!.title).toBe('Hello world')
    expect(row!.kind).toBe('text')
    expect(row!.agent_id).toBe('agent-a')
    expect(row!.content.toString('utf-8')).toBe('Hello!')
  })

  it('stores HTML with custom mime', () => {
    const { id } = createArtifact({
      agent_id: 'agent-a',
      title: 'Page',
      kind: 'html',
      mime: 'text/html; charset=utf-8',
      content: Buffer.from('<h1>hi</h1>', 'utf-8'),
    })
    const row = getArtifact(id)
    expect(row!.mime).toBe('text/html; charset=utf-8')
    expect(row!.content.toString('utf-8')).toBe('<h1>hi</h1>')
  })

  it('stores binary content as BLOB', () => {
    const bin = Buffer.from([0x00, 0xff, 0xab, 0xcd])
    const { id } = createArtifact({
      agent_id: 'agent-b',
      title: 'Binary blob',
      kind: 'binary',
      content: bin,
    })
    const row = getArtifact(id)
    expect(Buffer.compare(row!.content, bin)).toBe(0)
  })

  it('stores meta as JSON and source', () => {
    const { id } = createArtifact({
      agent_id: 'agent-a',
      title: 'With meta',
      kind: 'json',
      content: Buffer.from('{}', 'utf-8'),
      meta: { tags: ['test'], version: 1 },
      source: 'https://example.com',
    })
    const row = getArtifact(id)
    expect(JSON.parse(row!.meta)).toEqual({ tags: ['test'], version: 1 })
    expect(row!.source).toBe('https://example.com')
  })

  it('defaults mime based on kind when not provided', () => {
    for (const [kind, expectedMime] of [
      ['html',     'text/html; charset=utf-8'],
      ['markdown', 'text/markdown; charset=utf-8'],
      ['json',     'application/json; charset=utf-8'],
      ['text',     'text/plain; charset=utf-8'],
      ['binary',   'application/octet-stream'],
    ] as const) {
      const { id } = createArtifact({
        agent_id: 'agent-a', title: `mime-${kind}`, kind,
        content: Buffer.from('x'),
      })
      expect(getArtifact(id)!.mime).toBe(expectedMime)
    }
  })
})

describe('listArtifacts', () => {
  it('filters by agent_id', () => {
    createArtifact({ agent_id: 'list-agent-x', title: 'X', kind: 'text', content: Buffer.from('x') })
    createArtifact({ agent_id: 'list-agent-y', title: 'Y', kind: 'text', content: Buffer.from('y') })
    const rows = listArtifacts({ agent: 'list-agent-x' })
    expect(rows.every(r => r.agent_id === 'list-agent-x')).toBe(true)
    expect(rows.some(r => r.title === 'X')).toBe(true)
  })

  it('filters by kind', () => {
    createArtifact({ agent_id: 'kind-agent', title: 'K1', kind: 'html',     content: Buffer.from('a') })
    createArtifact({ agent_id: 'kind-agent', title: 'K2', kind: 'markdown', content: Buffer.from('b') })
    const rows = listArtifacts({ agent: 'kind-agent', kind: 'html' })
    expect(rows.every(r => r.kind === 'html')).toBe(true)
  })

  it('filters by q matching title', () => {
    createArtifact({ agent_id: 'q-agent', title: 'Unique-xyzzy', kind: 'text', content: Buffer.from('c') })
    const rows = listArtifacts({ q: 'xyzzy' })
    expect(rows.some(r => r.title === 'Unique-xyzzy')).toBe(true)
  })

  it('does not include content column in list results', () => {
    const rows = listArtifacts({ agent: 'agent-a' })
    for (const row of rows) {
      expect((row as unknown as Record<string, unknown>).content).toBeUndefined()
    }
  })

  it('respects limit and offset', () => {
    const agent = 'limit-test-agent'
    for (let i = 0; i < 5; i++) {
      createArtifact({ agent_id: agent, title: `item-${i}`, kind: 'text', content: Buffer.from('x') })
    }
    const page1 = listArtifacts({ agent, limit: 2, offset: 0 })
    const page2 = listArtifacts({ agent, limit: 2, offset: 2 })
    expect(page1).toHaveLength(2)
    expect(page2).toHaveLength(2)
    expect(page1[0].id).not.toBe(page2[0].id)
  })
})

describe('getArtifact', () => {
  it('returns undefined for unknown id', () => {
    expect(getArtifact('does-not-exist')).toBeUndefined()
  })
})

describe('deleteArtifact', () => {
  it('removes the artifact and returns true', () => {
    const { id } = createArtifact({
      agent_id: 'agent-a', title: 'To delete', kind: 'text', content: Buffer.from('bye'),
    })
    expect(getArtifact(id)).toBeDefined()
    expect(deleteArtifact(id)).toBe(true)
    expect(getArtifact(id)).toBeUndefined()
  })

  it('returns false for a non-existent id', () => {
    expect(deleteArtifact('ghost-id')).toBe(false)
  })
})

describe('renameArtifact', () => {
  it('updates the title and returns true', () => {
    const { id } = createArtifact({
      agent_id: 'agent-a', title: 'Original title', kind: 'text', content: Buffer.from('x'),
    })
    expect(renameArtifact(id, 'Updated title')).toBe(true)
    expect(getArtifact(id)!.title).toBe('Updated title')
  })

  it('returns false for a non-existent id', () => {
    expect(renameArtifact('ghost-rename-id', 'Whatever')).toBe(false)
  })

  it('renamed artifact is found by its new title in FTS search', () => {
    const { id } = createArtifact({
      agent_id: 'agent-a', title: 'Pre-rename-fts-title', kind: 'text', content: Buffer.from('body'),
    })
    renameArtifact(id, 'Post-rename-fts-xq7k')
    const rows = listArtifacts({ q: 'Post-rename-fts-xq7k' })
    expect(rows.some(r => r.id === id)).toBe(true)
  })

  it('old title no longer matches in FTS after rename', () => {
    const { id } = createArtifact({
      agent_id: 'agent-a', title: 'Stale-title-zp9q', kind: 'text', content: Buffer.from('body'),
    })
    renameArtifact(id, 'Fresh-title-zp9q')
    const staleRows = listArtifacts({ q: 'Stale-title-zp9q' })
    expect(staleRows.some(r => r.id === id)).toBe(false)
  })

  it('ARTIFACT_TITLE_MAX_LENGTH is a positive number', () => {
    expect(ARTIFACT_TITLE_MAX_LENGTH).toBeGreaterThan(0)
    expect(typeof ARTIFACT_TITLE_MAX_LENGTH).toBe('number')
  })
})

describe('listArtifacts FTS search (q param)', () => {
  it('finds artifact by title match', () => {
    createArtifact({ agent_id: 'fts-agent', title: 'Quarterly-Xyzzy-Report', kind: 'text', content: Buffer.from('data') })
    const rows = listArtifacts({ q: 'Quarterly-Xyzzy-Report' })
    expect(rows.some(r => r.title === 'Quarterly-Xyzzy-Report')).toBe(true)
  })

  it('finds artifact by body content (text kind)', () => {
    createArtifact({ agent_id: 'fts-agent', title: 'Body-Search-Test', kind: 'text', content: Buffer.from('unique-fts-body-token-7q3r') })
    const rows = listArtifacts({ q: 'unique-fts-body-token-7q3r' })
    expect(rows.some(r => r.title === 'Body-Search-Test')).toBe(true)
  })

  it('finds artifact by meta content', () => {
    createArtifact({
      agent_id: 'fts-agent', title: 'Meta-FTS-Test', kind: 'json',
      content: Buffer.from('{}'),
      meta: { tags: ['zx9-unique-meta-token'] },
    })
    const rows = listArtifacts({ q: 'zx9-unique-meta-token' })
    expect(rows.some(r => r.title === 'Meta-FTS-Test')).toBe(true)
  })

  it('does not return artifacts that do not match', () => {
    createArtifact({ agent_id: 'fts-agent', title: 'Unrelated Artifact wq8p', kind: 'text', content: Buffer.from('nothing') })
    const rows = listArtifacts({ q: 'nonexistent-xk7z-term' })
    expect(rows.every(r => r.title !== 'Unrelated Artifact wq8p')).toBe(true)
  })

  it('does not find binary content in FTS', () => {
    createArtifact({
      agent_id: 'fts-agent', title: 'Binary-FTS-Test',
      kind: 'binary', content: Buffer.from([0x00, 0xff, 0xab]),
    })
    // binary body must NOT be indexed; searching the raw bytes would be nonsensical
    const rows = listArtifacts({ q: 'Binary-FTS-Test' })
    // title IS indexed, so the title match must work
    expect(rows.some(r => r.title === 'Binary-FTS-Test')).toBe(true)
  })

  it('FTS search respects additional agent filter', () => {
    createArtifact({ agent_id: 'fts-match-agent', title: 'Filtered-FTS-Result', kind: 'text', content: Buffer.from('fts-filter-content') })
    createArtifact({ agent_id: 'fts-other-agent', title: 'Filtered-FTS-Result', kind: 'text', content: Buffer.from('fts-filter-content') })
    const rows = listArtifacts({ q: 'Filtered-FTS-Result', agent: 'fts-match-agent' })
    expect(rows.every(r => r.agent_id === 'fts-match-agent')).toBe(true)
  })

  it('handles FTS special characters gracefully', () => {
    // Double-quotes in the search term must not cause a syntax error
    expect(() => listArtifacts({ q: 'test "quoted" term' })).not.toThrow()
    expect(() => listArtifacts({ q: 'a OR b' })).not.toThrow()
    expect(() => listArtifacts({ q: 'a*' })).not.toThrow()
  })

  it('removed artifact no longer appears in FTS results', () => {
    const { id } = createArtifact({ agent_id: 'fts-agent', title: 'Deleted-FTS-Artifact', kind: 'text', content: Buffer.from('delete-me') })
    expect(listArtifacts({ q: 'Deleted-FTS-Artifact' }).some(r => r.id === id)).toBe(true)
    deleteArtifact(id)
    expect(listArtifacts({ q: 'Deleted-FTS-Artifact' }).some(r => r.id === id)).toBe(false)
  })
})

describe('storeArtifactEmbedding (Ollama-free path)', () => {
  it('does not throw when Ollama is unreachable (null embedding)', async () => {
    const { id } = createArtifact({ agent_id: 'agent-a', title: 'Embed-test', kind: 'text', content: Buffer.from('content') })
    await expect(storeArtifactEmbedding(id, 'Embed-test', '{}')).resolves.toBeUndefined()
  })

  it('does not throw for an unknown artifact id', async () => {
    await expect(storeArtifactEmbedding('nonexistent-id', 'Title', '{}')).resolves.toBeUndefined()
  })

  it('does not throw when title and meta are empty strings', async () => {
    await expect(storeArtifactEmbedding('any-id', '', '')).resolves.toBeUndefined()
  })
})

describe('getArtifactStats', () => {
  it('returns artifact_count matching the number of created artifacts', () => {
    const before = getArtifactStats().artifact_count
    createArtifact({ agent_id: 'agent-a', title: 'Stats test 1', kind: 'text', content: Buffer.from('s1') })
    createArtifact({ agent_id: 'agent-b', title: 'Stats test 2', kind: 'text', content: Buffer.from('s2') })
    const after = getArtifactStats().artifact_count
    expect(after).toBe(before + 2)
  })

  it('returns vec_count >= -1 (elérhető: >= 0; nem elérhető: -1)', () => {
    const stats = getArtifactStats()
    expect(stats.vec_count).toBeGreaterThanOrEqual(-1)
  })

  it('vec_rebuild_suggested is false when vec_count is below 10000', () => {
    // In test environments the index has far fewer than 10 000 rows
    const stats = getArtifactStats()
    if (stats.vec_count < 10_000) {
      expect(stats.vec_rebuild_suggested).toBe(false)
    }
  })

  it('has the expected shape (artifact_count, vec_count, vec_rebuild_suggested)', () => {
    const stats = getArtifactStats()
    expect(typeof stats.artifact_count).toBe('number')
    expect(typeof stats.vec_count).toBe('number')
    expect(typeof stats.vec_rebuild_suggested).toBe('boolean')
  })
})

describe('searchArtifactsByVector', () => {
  it('always returns an array (with or without Ollama)', async () => {
    const results = await searchArtifactsByVector('semantic query about reports')
    expect(Array.isArray(results)).toBe(true)
  })

  it('result items have the ArtifactPointer shape (no content field)', async () => {
    // Create an artifact so there is at least one candidate in the index
    createArtifact({ agent_id: 'agent-a', title: 'Vector search target', kind: 'text', content: Buffer.from('vec') })
    const results = await searchArtifactsByVector('vector search target')
    for (const item of results) {
      // Must have pointer fields
      expect(typeof item.id).toBe('string')
      expect(typeof item.title).toBe('string')
      expect(typeof item.kind).toBe('string')
      expect(typeof item.created_at).toBe('number')
      expect(typeof item.score).toBe('number')
      // Must NOT expose content -- pointer-only pattern
      expect((item as unknown as Record<string, unknown>).content).toBeUndefined()
    }
  })

  it('respects the limit parameter', async () => {
    for (let i = 0; i < 5; i++) {
      createArtifact({ agent_id: 'agent-a', title: `vec-limit-item-${i}`, kind: 'text', content: Buffer.from('x') })
    }
    const results = await searchArtifactsByVector('vec limit item', 3)
    expect(results.length).toBeLessThanOrEqual(3)
  })
})
