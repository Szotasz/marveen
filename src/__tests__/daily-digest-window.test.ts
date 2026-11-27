/**
 * The nightly digest must not read its own previous output.
 *
 * The digest runs once a day and saves itself as an episodic memory, so the
 * previous digest sits exactly on the next window's lower edge
 * (created_at >= now - 86400). On a quiet day it alone lifted the count over the
 * threshold of two, and the model wrote yesterday's summary up again as today's.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import { rmSync } from 'node:fs'

const { fakeHome, runAgent } = await vi.hoisted(async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  return {
    fakeHome: fs.mkdtempSync(path.join(os.tmpdir(), 'daily-digest-window-')),
    runAgent: vi.fn(async (_prompt: string) => ({ text: 'numbatdigest summary' })),
  }
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
vi.mock('../agent.js', () => ({ runAgent }))

import { initDatabase, getDb, saveMemory } from '../db.js'
import { runDailyDigest, DAILY_DIGEST_PREFIX } from '../memory.js'

function saveAt(content: string, createdAt: number) {
  saveMemory('test-chat', content, 'episodic')
  getDb().prepare('UPDATE memories SET created_at = ? WHERE content = ?').run(createdAt, content)
}

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})
// The digest reads the day's rows from the whole store, so each case starts empty.
beforeEach(() => {
  runAgent.mockClear()
  getDb().prepare('DELETE FROM memories').run()
})
afterAll(() => {
  rmSync(fakeHome, { recursive: true, force: true })
})

describe('runDailyDigest leaves earlier digests out', () => {
  it("a quiet day (yesterday's digest on the window edge + one real memory) is skipped", async () => {
    const now = Math.floor(Date.now() / 1000)
    saveAt(`${DAILY_DIGEST_PREFIX}2026. 10. 31.] wombat work summarised`, now - 86400 + 1)
    saveAt('one real thing happened today', now - 3600)

    expect(await runDailyDigest('test-chat')).toBeNull()
    expect(runAgent).not.toHaveBeenCalled()
  })

  it('a normal day is summarised from its own memories only, and the saved digest carries the prefix', async () => {
    const now = Math.floor(Date.now() / 1000)
    saveAt(`${DAILY_DIGEST_PREFIX}2026. 10. 31.] yesterdaydigest text`, now - 86400 + 1)
    saveAt('quollmemory one', now - 7200)
    saveAt('quollmemory two', now - 3600)

    expect(await runDailyDigest('test-chat')).toBe('numbatdigest summary')
    const prompt = runAgent.mock.calls[0][0] as string
    expect(prompt).toContain('quollmemory one')
    expect(prompt).toContain('quollmemory two')
    expect(prompt).not.toContain('yesterdaydigest')

    // The row it saves must carry the prefix the filter looks for, or tomorrow's
    // run would read it back in.
    const row = getDb().prepare("SELECT content FROM memories WHERE content LIKE '%numbatdigest%'")
      .get() as { content: string }
    expect(row.content.startsWith(DAILY_DIGEST_PREFIX)).toBe(true)
  })
})
