import { describe, it, expect, vi, beforeAll } from 'vitest'
import { Readable } from 'node:stream'
import { initDatabase, getDb, retractMemory } from '../db.js'
import { tryHandleMemories } from '../web/routes/memories.js'
import { DEDUP_RECENT_LIMIT } from '../web/memory-dedup.js'

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, MAIN_AGENT_ID: 'agent-a', ALLOWED_CHAT_ID: 'test-chat', OLLAMA_URL: '' }
})

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

async function post(body: Record<string, unknown>, auth?: { kind: 'token'; agent: string }): Promise<{ status: number; body: any }> {
  const path = '/api/memories'
  let responseBody = ''
  let status = 200
  const res = {
    writeHead: (code: number) => { status = code },
    end: (b?: string) => { responseBody = b || '' },
  }
  const ctx = {
    req: Readable.from([Buffer.from(JSON.stringify(body))]) as any,
    res: res as any, auth, path, method: 'POST', url: new URL(`http://localhost:3420${path}`),
  }
  await tryHandleMemories(ctx)
  return { status, body: responseBody ? JSON.parse(responseBody) : null }
}

const count = (content: string) =>
  (getDb().prepare('SELECT COUNT(*) AS n FROM memories WHERE content = ?').get(content) as { n: number }).n

const rowById = (id: number) =>
  getDb().prepare('SELECT id, retracted_at FROM memories WHERE id = ?').get(id) as { id: number; retracted_at: number | null } | undefined

// Push a row of `agent` past the dedup recent window: DEDUP_RECENT_LIMIT distinct
// saves, every one of which must go through as a plain 200 save.
const saveFillers = async (agent: string, prefix: string) => {
  for (let i = 0; i < DEDUP_RECENT_LIMIT; i++) {
    const r = await post({ agent_id: agent, content: `${prefix} filler ${i}` })
    expect(r.status).toBe(200)
  }
}

beforeAll(() => { initDatabase(':memory:') })

describe('POST /api/memories duplicate refusal', () => {
  it('refuses an exact repeat by the same agent and keeps one row', async () => {
    const content = 'the staging database lives on host alpha'
    const first = await post({ agent_id: 'agent-x', content })
    expect(first.status).toBe(200)
    expect(first.body.ok).toBe(true)
    const second = await post({ agent_id: 'agent-x', content })
    expect(second.status).toBe(409)
    expect(second.body.error).toBe('duplicate')
    expect(second.body.duplicate_of[0].id).toBe(first.body.id)
    expect(second.body.duplicate_of[0].match).toBe('exact')
    expect(count(content)).toBe(1)
  })

  it('does not treat another agent\'s row as a candidate', async () => {
    const content = 'rotate the api keys every quarter without fail'
    expect((await post({ agent_id: 'agent-x', content })).status).toBe(200)
    expect((await post({ agent_id: 'agent-y', content })).status).toBe(200)
  })

  it('allow_duplicate: true saves a second row', async () => {
    const content = 'backups run nightly at three in the morning'
    await post({ agent_id: 'agent-x', content })
    const r = await post({ agent_id: 'agent-x', content, allow_duplicate: true })
    expect(r.status).toBe(200)
    expect(count(content)).toBe(2)
  })

  it('allow_duplicate as a string is not an override', async () => {
    const content = 'logs are shipped to the central collector hourly'
    await post({ agent_id: 'agent-x', content })
    const r = await post({ agent_id: 'agent-x', content, allow_duplicate: 'true' })
    expect(r.status).toBe(409)
  })

  it('refuses a near-duplicate as similar', async () => {
    await post({ agent_id: 'agent-x', content: 'n1 n2 n3 n4 n5 n6 n7 n8 n9 n10' })
    const r = await post({ agent_id: 'agent-x', content: 'n1 n2 n3 n4 n5 n6 n7 n8 n9 n11' })
    expect(r.status).toBe(409)
    expect(r.body.duplicate_of[0].match).toBe('similar')
  })

  it('finds a verbatim repeat older than the recent window, but not a near-duplicate of it', async () => {
    const old = 'o1 o2 o3 o4 o5 o6 o7 o8 o9 o10'
    const first = await post({ agent_id: 'agent-w', content: old })
    expect(first.status).toBe(200)
    // Direct inserts: saveAgentMemory would also request an embedding per row.
    const now = Math.floor(Date.now() / 1000)
    const ins = getDb().prepare("INSERT INTO memories (chat_id, content, sector, created_at, accessed_at, agent_id, category) VALUES ('test-chat', ?, 'semantic', ?, ?, 'agent-w', 'warm')")
    getDb().transaction(() => { for (let i = 0; i < DEDUP_RECENT_LIMIT; i++) ins.run(`filler ${i}`, now, now) })()
    const verbatim = await post({ agent_id: 'agent-w', content: old })
    expect(verbatim.status).toBe(409)
    expect(verbatim.body.duplicate_of[0].id).toBe(first.body.id)
    expect(verbatim.body.duplicate_of[0].match).toBe('exact')
    // Similar matching is bounded to the newest rows by design.
    expect((await post({ agent_id: 'agent-w', content: 'o1 o2 o3 o4 o5 o6 o7 o8 o9 o11' })).status).toBe(200)
  })

  it('checks a body without agent_id against MAIN_AGENT_ID rows', async () => {
    const content = 'the vpn gateway requires a hardware token login'
    const first = await post({ agent_id: 'agent-a', content })
    expect(first.status).toBe(200)
    const second = await post({ content })
    expect(second.status).toBe(409)
    expect(second.body.duplicate_of[0].id).toBe(first.body.id)
  })

  it('a retracted row is not a candidate (recent window)', async () => {
    const content = 'the nightly archive job writes its output to the cold storage bucket'
    const first = await post({ agent_id: 'agent-r1', content })
    expect(first.status).toBe(200)
    expect(retractMemory(first.body.id, 'agent-r1')).toBe('retracted')
    const second = await post({ agent_id: 'agent-r1', content })
    expect(second.status).toBe(200)
    expect(second.body.ok).toBe(true)
    expect(second.body.id).not.toBe(first.body.id)
  })

  it('a retracted row is not a candidate (older than the window)', async () => {
    const content = 'the metrics exporter answers scrape requests on a fixed local port'
    const first = await post({ agent_id: 'agent-r2', content })
    expect(first.status).toBe(200)
    await saveFillers('agent-r2', 'agent-r2')
    expect(retractMemory(first.body.id, 'agent-r2')).toBe('retracted')
    const again = await post({ agent_id: 'agent-r2', content })
    expect(again.status).toBe(200)
    expect(again.body.ok).toBe(true)
  })

  it('a supersedes save with the same text is saved', async () => {
    const content = 'the deploy pipeline promotes container images to production every friday'
    const first = await post({ agent_id: 'agent-s1', content })
    expect(first.status).toBe(200)
    const r = await post({ agent_id: 'agent-s1', content, supersedes: [first.body.id] })
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(r.body.superseded).toEqual([first.body.id])
    expect(rowById(first.body.id)?.retracted_at).not.toBeNull()
  })

  it('the superseded row is not a candidate even when it is older than the window', async () => {
    const content = 'the queue worker retries failed jobs with exponential backoff delays'
    const first = await post({ agent_id: 'agent-s2', content })
    expect(first.status).toBe(200)
    await saveFillers('agent-s2', 'agent-s2')
    const r = await post({ agent_id: 'agent-s2', content, supersedes: [first.body.id] })
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(r.body.superseded).toEqual([first.body.id])
  })

  it('supersedes does not excuse a repeat of ANOTHER live row', async () => {
    const x = 'the certificate rotation script renews tls keys before they expire'
    const y = 'the dashboard graphs request latency aggregated over five minute buckets'
    const first = await post({ agent_id: 'agent-d1', content: x })
    expect(first.status).toBe(200)
    const second = await post({ agent_id: 'agent-d1', content: y })
    expect(second.status).toBe(200)
    const r = await post({ agent_id: 'agent-d1', content: x, supersedes: [second.body.id] })
    expect(r.status).toBe(409)
    expect(r.body.error).toBe('duplicate')
    expect(r.body.duplicate_of[0].id).toBe(first.body.id)
    expect(rowById(second.body.id)?.retracted_at).toBeNull()
  })

  it('a supersedes save without agent_id is checked as the X-Agent-Id author', async () => {
    const x = 'the object storage gateway enforces versioning on every uploaded artifact'
    const y = 'cluster pods restart whenever their liveness probe times out'
    const first = await post({ agent_id: 'agent-h1', content: x })
    expect(first.status).toBe(200)
    const second = await post({ agent_id: 'agent-h1', content: y })
    expect(second.status).toBe(200)
    const r = await post({ content: x, supersedes: [second.body.id] }, { kind: 'token', agent: 'agent-h1' })
    expect(r.status).toBe(409)
    expect(r.body.error).toBe('duplicate')
    expect(r.body.duplicate_of[0].id).toBe(first.body.id)
  })

  it('the refusal hint names both ways out', async () => {
    const content = 'the audit log retains every configuration change for two years'
    const first = await post({ agent_id: 'agent-k1', content })
    expect(first.status).toBe(200)
    const second = await post({ agent_id: 'agent-k1', content })
    expect(second.status).toBe(409)
    expect(second.body.hint).toContain('allow_duplicate: true')
    expect(second.body.hint).toContain('supersedes: [<its id>]')
  })
})
