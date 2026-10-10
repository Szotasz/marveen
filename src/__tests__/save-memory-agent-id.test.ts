/**
 * saveMemory must stamp the main agent's id on the row.
 *
 * The INSERT used to omit agent_id, so the column default ('marveen') applied.
 * MAIN_AGENT_ID is configurable (installers derive it from the bot name) and
 * every per-agent memory reader filters `(agent_id = ? OR category = 'shared')`,
 * so on an install whose main agent is not called 'marveen' the rows written
 * here (the nightly daily-log digest) never showed up in that agent's list,
 * search or recall. This file runs with MAIN_AGENT_ID mocked to 'orin'.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { rmSync } from 'node:fs'

// runDailyDigest creates its scratch dirs under homedir(); point that at a
// throwaway directory so the test never writes into the real home.
const { fakeHome } = await vi.hoisted(async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  return { fakeHome: fs.mkdtempSync(path.join(os.tmpdir(), 'save-memory-agent-id-')) }
})

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => fakeHome, default: { ...actual, homedir: () => fakeHome } }
})
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'orin',
  ALLOWED_CHAT_ID: 'test-chat',
  OLLAMA_URL: '',
  EMBED_URL: '',
}))
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))
vi.mock('../agent.js', () => ({
  runAgent: vi.fn(async () => ({ text: 'quokkadigest summary of the day' })),
}))

import {
  initDatabase,
  getDb,
  saveMemory,
  getAgentMemories,
  searchAgentMemories,
  recallSearch,
  recallByDateRange,
  clearMemoryCache,
} from '../db.js'
import { runDailyDigest, saveConversationTurn } from '../memory.js'

type Row = { agent_id: string; category: string; sector: string; topic_key: string | null; content: string }

function rowByContent(content: string): Row {
  return getDb().prepare('SELECT agent_id, category, sector, topic_key, content FROM memories WHERE content = ?')
    .get(content) as Row
}

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})
afterAll(() => {
  rmSync(fakeHome, { recursive: true, force: true })
})

describe('saveMemory agent_id (MAIN_AGENT_ID = orin)', () => {
  it('stamps MAIN_AGENT_ID when no agentId is passed (fails on the unfixed INSERT)', () => {
    saveMemory('chat-a', 'wombatone default owner', 'episodic')
    expect(rowByContent('wombatone default owner').agent_id).toBe('orin')
  })

  it('keeps the other columns as before: warm category, given sector, null topic', () => {
    saveMemory('chat-a', 'wombattwo columns', 'semantic')
    const row = rowByContent('wombattwo columns')
    expect(row.category).toBe('warm')
    expect(row.sector).toBe('semantic')
    expect(row.topic_key).toBeNull()
  })

  it('stores topicKey together with the default owner', () => {
    saveMemory('chat-a', 'wombatthree topic', 'semantic', 'tk-1')
    const row = rowByContent('wombatthree topic')
    expect(row.topic_key).toBe('tk-1')
    expect(row.agent_id).toBe('orin')
  })

  it('honours an explicit agentId', () => {
    saveMemory('chat-a', 'wombatfour explicit', 'semantic', undefined, 'dev2')
    expect(rowByContent('wombatfour explicit').agent_id).toBe('dev2')
  })

  it("the row is in the main agent's list (getAgentMemories)", () => {
    clearMemoryCache()
    const list = getAgentMemories('orin', 100)
    expect(list.map(m => m.content)).toContain('wombatone default owner')
  })

  it("the row is NOT in the list of an agent literally called 'marveen'", () => {
    clearMemoryCache()
    const list = getAgentMemories('marveen', 100)
    expect(list.map(m => m.content)).not.toContain('wombatone default owner')
  })

  it("an explicitly owned row stays out of the main agent's list", () => {
    clearMemoryCache()
    expect(getAgentMemories('orin', 100).map(m => m.content)).not.toContain('wombatfour explicit')
    expect(getAgentMemories('dev2', 100).map(m => m.content)).toContain('wombatfour explicit')
  })

  it("the row is found by the main agent's search (searchAgentMemories)", () => {
    const hits = searchAgentMemories('orin', 'wombatone', 10)
    expect(hits.map(m => m.content)).toContain('wombatone default owner')
  })

  it('the row is found by recallSearch scoped to the main agent', () => {
    const res = recallSearch('wombatone', 'orin')
    expect(res.memories.map(m => m.content)).toContain('wombatone default owner')
  })

  it('the row is in recallByDateRange scoped to the main agent', () => {
    const res = recallByDateRange('2000-01-01', '2999-12-31', 'orin')
    expect(res.memories.map(m => m.content)).toContain('wombatone default owner')
  })

  it("a save evicts the owner's cached list, so the new row shows up at once", () => {
    const before = getAgentMemories('orin', 77)
    expect(before.map(m => m.content)).not.toContain('wombatfive cached')
    saveMemory('chat-a', 'wombatfive cached', 'episodic')
    expect(getAgentMemories('orin', 77).map(m => m.content)).toContain('wombatfive cached')
  })

  it("a save with an explicit agentId evicts THAT agent's cached list", () => {
    const before = getAgentMemories('dev2', 33)
    expect(before.map(m => m.content)).not.toContain('wombatsix explicit cached')
    saveMemory('chat-a', 'wombatsix explicit cached', 'semantic', undefined, 'dev2')
    expect(getAgentMemories('dev2', 33).map(m => m.content)).toContain('wombatsix explicit cached')
  })

  it('saveConversationTurn saves a semantic turn under MAIN_AGENT_ID', async () => {
    await saveConversationTurn('chat-turn', 'remember that wombatseven is the preferred name', 'noted')
    const row = getDb().prepare("SELECT agent_id, sector FROM memories WHERE chat_id = 'chat-turn'")
      .get() as { agent_id: string; sector: string }
    expect(row.sector).toBe('semantic')
    expect(row.agent_id).toBe('orin')
  })

  it('the nightly digest (runDailyDigest) is saved under MAIN_AGENT_ID', async () => {
    saveMemory('chat-digest', 'digest input one', 'episodic')
    saveMemory('chat-digest', 'digest input two', 'episodic')
    const digest = await runDailyDigest('chat-digest')
    expect(digest).toBe('quokkadigest summary of the day')
    const row = getDb().prepare("SELECT agent_id FROM memories WHERE content LIKE '[Napi naplo %' AND content LIKE '%quokkadigest%'")
      .get() as { agent_id: string }
    expect(row.agent_id).toBe('orin')
    expect(searchAgentMemories('orin', 'quokkadigest', 10).length).toBe(1)
  })
})
