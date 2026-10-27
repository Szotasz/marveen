import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initDatabase, getDb, saveMemory, saveAgentMemory, appendDailyLog } from '../db.js'
import { EMBED_MODEL, EMBED_DIMS } from '../config.js'

// Pins that every fire-and-forget write path (saveMemory, saveAgentMemory,
// appendDailyLog mirror) records embedIdentity() in embedding_model. A NULL
// there would otherwise go unnoticed by the other tests.
const IDENTITY = EMBED_DIMS > 0 ? `${EMBED_MODEL}@${EMBED_DIMS}` : EMBED_MODEL
const AGENT = 'write-path-agent'
const CHAT = 'test-chat'
const VECTOR = [0.1, 0.2, 0.3]

type Row = { embedding: string | null; embedding_model: string | null }

function row(id: number): Row {
  return getDb().prepare('SELECT embedding, embedding_model FROM memories WHERE id = ?').get(id) as Row
}

let vector: number[] = VECTOR
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
  vector = VECTOR
  fetchMock = vi.fn(async () => ({ json: async () => ({ embedding: vector }) }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function expectStored(id: number) {
  await vi.waitFor(() => {
    const r = row(id)
    expect(r.embedding).not.toBeNull()
    expect(JSON.parse(r.embedding as string)).toEqual(VECTOR)
    expect(r.embedding_model).toBe(IDENTITY)
  })
}

describe('write paths record the embedding model identity', () => {
  it('saveMemory', async () => {
    const content = 'unique save memory content for write path test'
    saveMemory(CHAT, content, 'semantic', undefined, AGENT)
    const rows = getDb().prepare('SELECT id FROM memories WHERE content = ?').all(content) as { id: number }[]
    expect(rows).toHaveLength(1)
    await expectStored(rows[0].id)
  })

  it('saveAgentMemory', async () => {
    const { id } = saveAgentMemory(AGENT, 'agent memory content for write path test', 'warm')
    await expectStored(id)
  })

  it('appendDailyLog mirror', async () => {
    const { memoryId } = appendDailyLog(AGENT, 'daily log content for write path test', { mirror: true })
    expect(typeof memoryId).toBe('number')
    await expectStored(memoryId as number)
  })

  it('leaves both columns NULL when no vector comes back', async () => {
    vector = []
    const { id } = saveAgentMemory(AGENT, 'no vector content for write path test', 'warm')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))
    expect(row(id)).toEqual({ embedding: null, embedding_model: null })
  })
})
