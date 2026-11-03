// DISPATCHSKIP1022, the settings round trip: the value is written through the
// REAL settings layer (validation + config-overrides.json + the effective
// getter), not a mocked getter, and the next /move acts on it. Also pins that an
// overrides file written before the key was registered is picked up as is.
//
// Sandboxed like settings-store.test.ts: STORE_DIR is baked into OVERRIDES_PATH
// at import time, so the sandbox is mocked in before the modules load.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { existsSync, mkdirSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import type http from 'node:http'

const SANDBOX = mkdtempSync(join(tmpdir(), 'dispatch-skip-settings-'))
const STORE = join(SANDBOX, 'store')
const mockCreateAgentMessage = vi.fn()

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))
vi.mock('../config.js', async (orig) => ({
  ...(await orig<typeof import('../config.js')>()),
  PROJECT_ROOT: SANDBOX,
  STORE_DIR: STORE,
  MAIN_AGENT_ID: 'orin',
  BOT_NAME: 'Botond',
  OWNER_NAME: 'Owner',
}))
vi.mock('../env.js', async (orig) => ({ ...(await orig<typeof import('../env.js')>()), readEnvFile: () => ({}) }))
vi.mock('../db.js', async (orig) => {
  const actual = await orig<typeof import('../db.js')>()
  return { ...actual, createAgentMessage: (...a: unknown[]) => mockCreateAgentMessage(...a) }
})
vi.mock('../web/agent-config.js', async (orig) => ({
  ...(await orig<typeof import('../web/agent-config.js')>()),
  listAgentNames: () => ['dex', 'pm'],
  readAgentDisplayName: (n: string) => n,
}))
vi.mock('../web/agent-process.js', async (orig) => ({
  ...(await orig<typeof import('../web/agent-process.js')>()),
  isAgentRunning: () => true,
}))

const { OVERRIDES_PATH, setOverride, clearOverride, reloadOverridesForTest } = await import('../settings-store.js')
const { initDatabase, createKanbanCard } = await import('../db.js')
const { tryHandleKanban } = await import('../web/routes/kanban.js')

async function move(id: string, status: string, actor?: string): Promise<void> {
  const req = Readable.from([Buffer.from(JSON.stringify({ status, sort_order: 0, actor }))]) as unknown as http.IncomingMessage
  const res = { writeHead: vi.fn(), end: vi.fn(), setHeader: vi.fn() } as unknown as http.ServerResponse
  const path = `/api/kanban/${encodeURIComponent(id)}/move`
  const handled = await tryHandleKanban({ req, res, path, method: 'POST', url: new URL(`http://localhost${path}`) } as never)
  expect(handled).toBe(true)
}

const sentTo = (who: string) => mockCreateAgentMessage.mock.calls.filter((c) => c[1] === who)

beforeEach(() => {
  vi.clearAllMocks()
  initDatabase(':memory:')
  mkdirSync(STORE, { recursive: true })
  if (existsSync(OVERRIDES_PATH)) rmSync(OVERRIDES_PATH)
  reloadOverridesForTest()
})

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true })
})

describe('KANBAN_DISPATCH_SKIP_AGENTS through the real settings layer (DISPATCHSKIP1022)', () => {
  it('the sandbox holds: OVERRIDES_PATH is inside it', () => {
    expect(OVERRIDES_PATH).toBe(join(STORE, 'config-overrides.json'))
  })

  it('saved, it skips the next move; cleared, the same card is woken once by the move after', async () => {
    expect(setOverride('KANBAN_DISPATCH_SKIP_AGENTS', 'pm')).toEqual({ ok: true })
    createKanbanCard({ id: 'c-s', title: 't', assignee: 'pm' })
    await move('c-s', 'in_progress', 'orin')
    expect(mockCreateAgentMessage).not.toHaveBeenCalled()
    expect(clearOverride('KANBAN_DISPATCH_SKIP_AGENTS').ok).toBe(true)
    await move('c-s', 'in_progress', 'orin')
    expect(sentTo('pm')).toHaveLength(1)
  })

  it('an invalid value is refused by the settings layer and changes nothing', async () => {
    expect(setOverride('KANBAN_DISPATCH_SKIP_AGENTS', 'pm; dex').ok).toBe(false)
    createKanbanCard({ id: 'c-i', title: 't', assignee: 'pm' })
    await move('c-i', 'in_progress', 'orin')
    expect(sentTo('pm')).toHaveLength(1)
  })

  it('an overrides file written before the key existed is honoured as is (no migration)', async () => {
    writeFileSync(OVERRIDES_PATH, JSON.stringify({ KANBAN_DISPATCH_SKIP_AGENTS: 'pm,dex' }))
    reloadOverridesForTest()
    createKanbanCard({ id: 'c-f', title: 't', assignee: 'dex' })
    await move('c-f', 'in_progress', 'orin')
    expect(mockCreateAgentMessage).not.toHaveBeenCalled()
  })
})
