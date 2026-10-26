// End to end through helperDispatch with a real (in-memory) database: a due
// watch task whose card got a matching comment produces exactly ONE
// inter-agent message from "helper" to the owning agent, makes zero model
// calls, and switches itself off; a later tick sends nothing more.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'helper-e2e-'))
mkdirSync(join(root, 'store'), { recursive: true })
const tmpHome = join(root, 'home')
mkdirSync(tmpHome, { recursive: true })
const realHome = process.env.HOME
process.env.HOME = tmpHome

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  PROJECT_ROOT: root,
  STORE_DIR: join(root, 'store'),
  MAIN_AGENT_ID: 'marveen',
}))
vi.mock('../settings-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../settings-store.js')>()),
  getEffectiveSettingValue: (key: string) => (key === 'HELPER_ENABLED' ? '1' : key === 'HELPER_PROVIDER_ID' ? 'ollama' : ''),
}))
const sendOwnerMessage = vi.fn(async () => ({ sent: true }))
vi.mock('../notify.js', () => ({ sendOwnerMessage }))
vi.mock('../web/schedule-registry.js', () => ({
  filterRegisteredTasks: <T,>(tasks: T[]) => tasks,
  backfillScheduledTaskRegistryOnce: () => ({ ran: false, registered: [] }),
  verifyScheduledTask: () => ({ ok: true }),
  describeVerdict: () => '',
  registerScheduledTask: () => 'test-hash',
  unregisterScheduledTask: () => true,
}))

let db: typeof import('../db.js')
let d: typeof import('../web/helper/dispatch.js')
let io: typeof import('../web/scheduled-tasks-io.js')
const fetchSpy = vi.fn(async () => { throw new Error('no model call expected') })

beforeAll(async () => {
  writeFileSync(join(root, 'store', 'custom-providers.json'), JSON.stringify({ providers: [{ id: 'ollama', label: 'Ollama', baseUrl: 'http://127.0.0.1:11434', authHeader: 'none', vaultKey: null, helperModel: 'qwen3:14b' }] }))
  vi.stubGlobal('fetch', fetchSpy)
  db = await import('../db.js')
  db.initDatabase(':memory:')
  d = await import('../web/helper/dispatch.js')
  io = await import('../web/scheduled-tasks-io.js')
})
afterAll(() => {
  vi.unstubAllGlobals()
  process.env.HOME = realHome
  rmSync(root, { recursive: true, force: true })
})

const helperMessages = () => db.listAgentMessages(100).filter((m) => m.from_agent === 'helper')

describe('helperDispatch watch, end to end', () => {
  it('one matching comment -> one message, zero model calls, task switched off', async () => {
    io.writeScheduledTask('release-watch', {
      prompt: 'Szólj, ha kiadták a CRM-et.', schedule: '* * * * *', agent: 'marveen', enabled: true, type: 'heartbeat',
      watch: { kind: 'kanban-comment', target: 'card1', authorPrefix: 'fejlesztes-', match: 'KIADVA', needsJudgement: true },
    })
    db.addKanbanComment('card1', 'fejlesztes-vezeto', 'KIADVA az elo CRM-en, Elo HEAD a -> b')
    db.addKanbanComment('card1', 'c3po', 'KIADVA? (not the watched author)')
    const task = { ...io.readScheduledTask('release-watch')!, createdAt: 0 }

    expect(d.helperDispatch(task, Date.now(), { fallbackRun: async () => {} })).toBe(true)
    await vi.waitFor(() => expect(io.readScheduledTask('release-watch')!.enabled).toBe(false))
    const msgs = helperMessages()
    expect(msgs).toHaveLength(1)
    expect(msgs[0].to_agent).toBe('marveen')
    expect(msgs[0].content).toMatch(/^\[HELPER-ESCALATE task=release-watch type=watch event=kanban-comment ref=card:card1\]/)
    expect(msgs[0].content).toContain('(minta)')
    expect(fetchSpy).not.toHaveBeenCalled()

    // The next tick (same comments, same state) sends nothing more.
    d.helperDispatch(task, Date.now(), { fallbackRun: async () => {} })
    await new Promise((r) => setTimeout(r, 50))
    expect(helperMessages()).toHaveLength(1)
    const runs = readFileSync(join(root, 'store', 'helper-runs.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    expect(runs[0]).toMatchObject({ task: 'release-watch', outcome: 'escalate', modelCalls: 0 })
  })
})
