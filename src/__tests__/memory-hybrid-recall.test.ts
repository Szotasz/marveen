import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../db.js', () => ({
  hybridSearch: vi.fn(),
  searchMemories: vi.fn(),
  recentMemories: vi.fn(),
  touchMemory: vi.fn(),
  saveMemory: vi.fn(),
  listKanbanCardsSummary: vi.fn().mockReturnValue([]),
}))

vi.mock('../config.js', () => ({
  MAIN_AGENT_ID: 'agent-a',
  ALLOWED_CHAT_ID: 'chat-1',
  OLLAMA_URL: 'http://localhost:11434',
  APP_TZ: 'Europe/Budapest',
}))

vi.mock('../agent.js', () => ({
  runAgent: vi.fn().mockResolvedValue({ text: null }),
}))

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

vi.mock('../prompt-safety.js', () => ({
  wrapUntrusted: vi.fn((_tag: string, s: string) => s),
  UNTRUSTED_PREAMBLE: '',
}))

import { buildMemoryContext } from '../memory.js'
import * as db from '../db.js'

const mockHybridSearch = vi.mocked(db.hybridSearch)
const mockRecentMemories = vi.mocked(db.recentMemories)
const mockTouchMemory = vi.mocked(db.touchMemory)

function makeMemory(id: number, content: string, sector: 'semantic' | 'episodic' = 'semantic') {
  return {
    id,
    content,
    sector,
    category: 'warm',
    agent_id: 'agent-a',
    chat_id: 'chat-1',
    salience: 1,
    created_at: 0,
    updated_at: null,
    accessed_at: 0,
    topic_key: null,
    keywords: null,
    auto_generated: 0,
    embedding: null,
    embedding_blob: null,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockRecentMemories.mockReturnValue([])
})

describe('buildMemoryContext uses hybridSearch', () => {
  it('calls hybridSearch with MAIN_AGENT_ID and the user message', async () => {
    mockHybridSearch.mockResolvedValue([])
    await buildMemoryContext('chat-1', 'what is my preferred language?')
    expect(mockHybridSearch).toHaveBeenCalledWith('agent-a', 'what is my preferred language?', 5, undefined)
  })

  it('passes tenantId to hybridSearch and recentMemories when provided', async () => {
    mockHybridSearch.mockResolvedValue([])
    await buildMemoryContext('chat-1', 'query', 'tenant-1')
    expect(mockHybridSearch).toHaveBeenCalledWith('agent-a', 'query', 5, 'tenant-1')
    expect(mockRecentMemories).toHaveBeenCalledWith('chat-1', 5, 'tenant-1')
  })

  it('returns empty string when no memories found', async () => {
    mockHybridSearch.mockResolvedValue([])
    const result = await buildMemoryContext('chat-1', 'anything')
    expect(result).toBe('')
  })

  it('combines hybridSearch results and recent memories, deduplicating by id', async () => {
    const m1 = makeMemory(1, 'hybrid result one')
    const m2 = makeMemory(2, 'recent memory')
    mockHybridSearch.mockResolvedValue([m1, m2])
    mockRecentMemories.mockReturnValue([m2, makeMemory(3, 'extra recent')])

    const result = await buildMemoryContext('chat-1', 'query')
    // m2 appears in both -- should appear only once
    expect(result).toContain('hybrid result one')
    expect(result).toContain('extra recent')
    const occurrences = (result.match(/recent memory/g) || []).length
    expect(occurrences).toBe(1)
  })

  it('touches each found memory', async () => {
    const m1 = makeMemory(10, 'touch me')
    mockHybridSearch.mockResolvedValue([m1])
    await buildMemoryContext('chat-1', 'query')
    expect(mockTouchMemory).toHaveBeenCalledWith(10)
  })

  it('does NOT call searchMemories (FTS-only path retired)', async () => {
    mockHybridSearch.mockResolvedValue([])
    await buildMemoryContext('chat-1', 'anything')
    expect(vi.mocked(db.searchMemories)).not.toHaveBeenCalled()
  })

  it('gracefully returns empty when hybridSearch resolves empty and no recent', async () => {
    mockHybridSearch.mockResolvedValue([])
    mockRecentMemories.mockReturnValue([])
    const result = await buildMemoryContext('chat-1', 'nothing here')
    expect(result).toBe('')
  })
})
