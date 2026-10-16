/**
 * Default install (MAIN_AGENT_ID = 'marveen'): saveMemory rows keep the same
 * owner they always had, so the agent_id fix changes nothing there.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'marveen',
  ALLOWED_CHAT_ID: 'test-chat',
  OLLAMA_URL: '',
  EMBED_URL: '',
}))
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

import { initDatabase, getDb, saveMemory, getAgentMemories, clearMemoryCache } from '../db.js'

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

describe('saveMemory agent_id (default install)', () => {
  it("still writes agent_id 'marveen'", () => {
    saveMemory('chat-d', 'numbatone default', 'episodic')
    const row = getDb().prepare('SELECT agent_id, category FROM memories WHERE content = ?')
      .get('numbatone default') as { agent_id: string; category: string }
    expect(row.agent_id).toBe('marveen')
    expect(row.category).toBe('warm')
  })

  it("the row is in the 'marveen' list", () => {
    clearMemoryCache()
    expect(getAgentMemories('marveen', 50).map(m => m.content)).toContain('numbatone default')
  })
})
