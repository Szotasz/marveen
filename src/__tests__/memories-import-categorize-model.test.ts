/**
 * Regression test for the memory-import categorizer picking a model on its own.
 *
 * Root cause: with no `gemma4` installed, POST /api/memories/import fell back to
 * the first non-embed model Ollama listed. On a real install that was a 1.3B
 * code model: it scored no better than tagging every chunk warm, returned
 * unparseable output half the time, and held the GPU for ~8s per chunk.
 *
 * Fix: the model is opt-in via MEMORY_IMPORT_CATEGORIZE_MODEL. Unset = no model
 * call at all; set but not installed = no model call either; set and installed
 * = exactly that model, never a substitute.
 */
import { Readable } from 'node:stream'
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import { initDatabase, getAgentMemories } from '../db.js'
import { tryHandleMemories } from '../web/routes/memories.js'
import type { RouteContext } from '../web/routes/types.js'

const state = vi.hoisted(() => ({ model: '' }))

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return {
    ...actual,
    MAIN_AGENT_ID: 'agent-a',
    ALLOWED_CHAT_ID: 'test-chat',
    OLLAMA_URL: 'http://ollama.test',
    get MEMORY_IMPORT_CATEGORIZE_MODEL() { return state.model },
  }
})

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

// The reference host's shape: the intended model IS installed, next to an
// embedding model and two unrelated ones.
const INSTALLED = ['nomic-embed-text:latest', 'deepseek-coder:1.3b', 'gemma3:4b', 'gemma4:31b']
// A host without the intended model. The old code picked the first non-embed
// entry here (deepseek-coder:1.3b) -- the regression this suite pins.
const INSTALLED_NO_GEMMA4 = ['nomic-embed-text:latest', 'deepseek-coder:1.3b', 'gemma3:4b']
let installedList: string[] = INSTALLED
const fetchMock = vi.fn()

function generateCalls(): string[] {
  return fetchMock.mock.calls
    .filter(([url]) => String(url).endsWith('/api/generate'))
    .map(([, init]) => JSON.parse(init.body).model)
}

async function runImport(agentId: string, chunks: string[]) {
  let responseBody = ''
  const res = { writeHead: vi.fn(), setHeader: vi.fn(), end: (b?: string) => { responseBody = b || '' } }
  const req = Readable.from([Buffer.from(JSON.stringify({ agent_id: agentId, chunks }))])
  const ctx = {
    req: req as any, res: res as any, path: '/api/memories/import', method: 'POST',
    url: new URL('http://localhost:3420/api/memories/import'),
  } as RouteContext
  expect(await tryHandleMemories(ctx)).toBe(true)
  return JSON.parse(responseBody)
}

beforeAll(() => {
  initDatabase(':memory:')
  vi.stubGlobal('fetch', fetchMock)
})

beforeEach(() => {
  fetchMock.mockReset()
  installedList = INSTALLED
  fetchMock.mockImplementation(async (url: string) => {
    const u = String(url)
    if (u.endsWith('/api/tags')) {
      return { json: async () => ({ models: installedList.map(name => ({ name })) }) }
    }
    if (u.endsWith('/api/generate')) {
      return { json: async () => ({ response: '{"tier": "hot", "keywords": "deadline, pr"}' }) }
    }
    return { json: async () => ({}) }
  })
})

afterAll(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('POST /api/memories/import categorize model', () => {
  it('unset: auto-detects the installed gemma4 and categorizes with it', async () => {
    state.model = ''
    const out = await runImport('agent-auto', ['Holnap 10-kor döntés a PR-ról.'])
    expect(generateCalls()).toEqual(['gemma4:31b'])
    expect(out.stats.hot).toBe(1)
  })

  it('unset without gemma4: no model call, everything warm', async () => {
    state.model = ''
    installedList = INSTALLED_NO_GEMMA4
    const out = await runImport('agent-unset', ['Holnap 10-kor döntés a PR-ról.'])
    expect(out.stats).toEqual({ hot: 0, warm: 1, cold: 0, shared: 0 })
    expect(generateCalls()).toEqual([])
  })

  // The regression itself: with no gemma4 present, the old code ran
  // deepseek-coder:1.3b, which scored no better than all-warm. Absence of a
  // categorizer must never turn into "run whatever is installed".
  it('unset without gemma4: never falls back to an arbitrary installed model', async () => {
    state.model = ''
    installedList = INSTALLED_NO_GEMMA4
    await runImport('agent-nofallback', ['Holnap 10-kor döntés a PR-ról.'])
    expect(generateCalls()).toEqual([])
  })

  // An embedding model cannot answer /api/generate; matching one would be a
  // silent no-op dressed up as a working categorizer.
  it('unset: an embedding model is never auto-detected', async () => {
    state.model = ''
    installedList = ['gemma4-embed:latest', 'nomic-embed-text:latest']
    await runImport('agent-embed', ['Holnap 10-kor döntés a PR-ról.'])
    expect(generateCalls()).toEqual([])
  })

  it('set but not installed: never substitutes another model', async () => {
    state.model = 'gemma4:e4b'
    const out = await runImport('agent-missing', ['Holnap 10-kor döntés a PR-ról.'])
    expect(out.stats.warm).toBe(1)
    expect(generateCalls()).toEqual([])
  })

  it('set and installed: uses exactly that model and keeps its tier', async () => {
    state.model = 'gemma3:4b'
    const out = await runImport('agent-set', ['Holnap 10-kor döntés a PR-ról.'])
    expect(out.stats.hot).toBe(1)
    expect(generateCalls()).toEqual(['gemma3:4b'])
    expect(getAgentMemories('agent-set', 5)[0].category).toBe('hot')
  })

  it('bare name matches the :latest tag', async () => {
    state.model = 'nomic-embed-text'
    await runImport('agent-bare', ['x'])
    expect(generateCalls()).toEqual(['nomic-embed-text:latest'])
  })
})
