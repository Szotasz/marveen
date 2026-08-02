import { describe, it, expect, beforeAll } from 'vitest'
import { initDatabase } from '../db.js'
import {
  createArtifact, listArtifacts, getArtifact, deleteArtifact,
} from '../artifacts-db.js'

beforeAll(() => { initDatabase(':memory:') })

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
