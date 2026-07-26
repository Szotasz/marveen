import { describe, it, expect, vi, beforeEach } from 'vitest'
import { initDatabase, getDb, createApproval } from '../db.js'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../web/agent-config.js', () => ({
  agentDir: () => '/tmp/agent-a',
  agentConfigRoot: () => '/tmp',
  listAgentNames: () => ['agent-a'],
  readAgentDisplayName: (name: string) => name,
}))

vi.mock('../web/agent-process.js', () => ({
  isAgentRunning: () => false,
}))

vi.mock('../web/agent-team.js', () => ({
  readAgentTeam: () => ({ role: 'agent' }),
}))

const { tryHandleOverview } = await import('../web/routes/overview.js')

function fakeCtx(path: string, method = 'GET'): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
    setHeader() { return res },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req: { headers: {} } as any, res, path: url.pathname, method, url } as RouteContext
  return { ctx, out }
}

beforeEach(() => {
  initDatabase(':memory:')
})

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------

describe('GET /api/overview — response shape', () => {
  it('returns true and 200 for the overview path', async () => {
    const { ctx, out } = fakeCtx('/api/overview')
    const handled = await tryHandleOverview(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
  })

  it('returns false for unrelated paths', async () => {
    const { ctx } = fakeCtx('/api/kanban')
    expect(await tryHandleOverview(ctx)).toBe(false)
  })

  it('response includes all required top-level fields', async () => {
    const { ctx, out } = fakeCtx('/api/overview')
    await tryHandleOverview(ctx)
    expect(out.body).toHaveProperty('agents')
    expect(out.body).toHaveProperty('tasksToday')
    expect(out.body).toHaveProperty('tasksYesterday')
    expect(out.body).toHaveProperty('memories')
    expect(out.body).toHaveProperty('skills')
    expect(out.body).toHaveProperty('tokensToday')
    expect(out.body).toHaveProperty('costTodayUsd')
    expect(out.body).toHaveProperty('pendingApprovals')
    expect(out.body).toHaveProperty('errors4h')
    expect(out.body).toHaveProperty('unreadMessages')
    expect(out.body).toHaveProperty('stuckTasks')
    expect(out.body).toHaveProperty('activity')
  })

  it('agents object contains total, running and list', async () => {
    const { ctx, out } = fakeCtx('/api/overview')
    await tryHandleOverview(ctx)
    const agents = out.body.agents
    expect(agents).toHaveProperty('total')
    expect(agents).toHaveProperty('running')
    expect(agents).toHaveProperty('list')
    expect(Array.isArray(agents.list)).toBe(true)
  })

  it('each agent in list has lastActive field', async () => {
    const { ctx, out } = fakeCtx('/api/overview')
    await tryHandleOverview(ctx)
    for (const a of out.body.agents.list) {
      expect(Object.prototype.hasOwnProperty.call(a, 'lastActive')).toBe(true)
    }
  })

  // Fix-revert proof: if we remove the activity agent field, this fails.
  it('each activity item has an agent field', async () => {
    const now = Math.floor(Date.now() / 1000)
    getDb().prepare(
      "INSERT INTO memories (chat_id, agent_id, content, sector, salience, category, keywords, created_at, accessed_at) VALUES ('0','agent-a','test memory','semantic',1.0,'warm','test',?,?)"
    ).run(now, now)

    const { ctx, out } = fakeCtx('/api/overview')
    await tryHandleOverview(ctx)
    const activityItems = out.body.activity
    if (activityItems.length > 0) {
      for (const item of activityItems) {
        expect(Object.prototype.hasOwnProperty.call(item, 'agent')).toBe(true)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// tokensToday and costTodayUsd
// ---------------------------------------------------------------------------

describe('GET /api/overview — tokensToday and costTodayUsd', () => {
  it('returns 0 when no token_usage rows exist', async () => {
    const { ctx, out } = fakeCtx('/api/overview')
    await tryHandleOverview(ctx)
    expect(out.body.tokensToday).toBe(0)
    expect(out.body.costTodayUsd).toBe(0)
  })

  it('counts tokens from today\'s token_usage rows', async () => {
    const startOfDay = new Date()
    startOfDay.setHours(0, 0, 0, 0)
    const todaySec = Math.floor(startOfDay.getTime() / 1000) + 3600

    getDb().prepare(
      "INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens) VALUES ('agent-a','s1',?,1000,200,0,0)"
    ).run(todaySec)

    const { ctx, out } = fakeCtx('/api/overview')
    await tryHandleOverview(ctx)
    // Fix-revert proof: removing the token_usage SELECT in overview.ts would return 0 here.
    expect(out.body.tokensToday).toBe(1200)
  })

  it('does not count yesterday\'s token_usage rows in tokensToday', async () => {
    const startOfDay = new Date()
    startOfDay.setHours(0, 0, 0, 0)
    const yesterdaySec = Math.floor(startOfDay.getTime() / 1000) - 3600

    getDb().prepare(
      "INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens) VALUES ('agent-a','s1',?,500,100,0,0)"
    ).run(yesterdaySec)

    const { ctx, out } = fakeCtx('/api/overview')
    await tryHandleOverview(ctx)
    expect(out.body.tokensToday).toBe(0)
  })

  it('estimates costTodayUsd > 0 when tokens are present today', async () => {
    const startOfDay = new Date()
    startOfDay.setHours(0, 0, 0, 0)
    const todaySec = Math.floor(startOfDay.getTime() / 1000) + 3600

    getDb().prepare(
      "INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, model) VALUES ('agent-a','s1',?,100000,5000,0,0,'claude-sonnet-4')"
    ).run(todaySec)

    const { ctx, out } = fakeCtx('/api/overview')
    await tryHandleOverview(ctx)
    // Fix-revert proof: removing estimateTokenCostUsd call returns 0.
    expect(out.body.costTodayUsd).toBeGreaterThan(0)
  })

  it('assigns higher cost to opus than sonnet for the same token count', async () => {
    const startOfDay = new Date()
    startOfDay.setHours(0, 0, 0, 0)
    const base = Math.floor(startOfDay.getTime() / 1000) + 7200

    const db = getDb()
    db.prepare(
      "INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, model) VALUES ('agent-a','s1',?,10000,1000,0,0,'claude-sonnet-4')"
    ).run(base)
    const { ctx: ctx1, out: out1 } = fakeCtx('/api/overview')
    await tryHandleOverview(ctx1)
    const costSonnet = out1.body.costTodayUsd

    // Reset DB and use opus model
    initDatabase(':memory:')
    getDb().prepare(
      "INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, model) VALUES ('agent-a','s2',?,10000,1000,0,0,'claude-opus-4')"
    ).run(base)
    const { ctx: ctx2, out: out2 } = fakeCtx('/api/overview')
    await tryHandleOverview(ctx2)
    const costOpus = out2.body.costTodayUsd

    // Fix-revert proof: without model-based pricing both costs would be equal.
    expect(costOpus).toBeGreaterThan(costSonnet)
  })
})

// ---------------------------------------------------------------------------
// pendingApprovals
// ---------------------------------------------------------------------------

describe('GET /api/overview — pendingApprovals', () => {
  it('returns 0 when no approvals exist', async () => {
    const { ctx, out } = fakeCtx('/api/overview')
    await tryHandleOverview(ctx)
    expect(out.body.pendingApprovals).toBe(0)
  })

  it('counts only pending approvals', async () => {
    // Fix-revert proof: removing the pendingApprovals COUNT query returns 0.
    createApproval({ id: 'ap-1', agent_id: 'agent-a', category: 'test', action_description: 'do something' })
    createApproval({ id: 'ap-2', agent_id: 'agent-a', category: 'test', action_description: 'do something else' })
    // Resolve one
    getDb().prepare("UPDATE approvals SET status='approved', resolved_at=? WHERE id='ap-2'").run(Math.floor(Date.now() / 1000))

    const { ctx, out } = fakeCtx('/api/overview')
    await tryHandleOverview(ctx)
    expect(out.body.pendingApprovals).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// unreadMessages
// ---------------------------------------------------------------------------

describe('GET /api/overview — unreadMessages', () => {
  it('returns 0 when no pending messages', async () => {
    const { ctx, out } = fakeCtx('/api/overview')
    await tryHandleOverview(ctx)
    expect(out.body.unreadMessages).toBe(0)
  })

  it('counts pending agent messages', async () => {
    const now = Math.floor(Date.now() / 1000)
    getDb().prepare(
      "INSERT INTO agent_messages (from_agent, to_agent, content, status, created_at) VALUES ('agent-a','main-agent','hello','pending',?)"
    ).run(now)

    const { ctx, out } = fakeCtx('/api/overview')
    await tryHandleOverview(ctx)
    // Fix-revert proof: removing the unreadMessages COUNT query returns 0.
    expect(out.body.unreadMessages).toBe(1)
  })

  it('does not count delivered messages', async () => {
    const now = Math.floor(Date.now() / 1000)
    getDb().prepare(
      "INSERT INTO agent_messages (from_agent, to_agent, content, status, created_at, delivered_at) VALUES ('agent-a','main-agent','done','delivered',?,?)"
    ).run(now, now)

    const { ctx, out } = fakeCtx('/api/overview')
    await tryHandleOverview(ctx)
    expect(out.body.unreadMessages).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// activity feed — 4h filter
// ---------------------------------------------------------------------------

describe('GET /api/overview — activity feed 4h filter', () => {
  it('includes memories from the last 4h', async () => {
    const now = Math.floor(Date.now() / 1000)
    const recentSec = now - 3600 // 1h ago
    getDb().prepare(
      "INSERT INTO memories (chat_id, agent_id, content, sector, salience, category, keywords, created_at, accessed_at) VALUES ('0','agent-a','recent event','semantic',1.0,'warm','event',?,?)"
    ).run(recentSec, recentSec)

    const { ctx, out } = fakeCtx('/api/overview')
    await tryHandleOverview(ctx)
    // Fix-revert proof: removing the 4h filter from the WHERE clause would include all memories regardless.
    const texts = out.body.activity.map((a: any) => a.text)
    expect(texts.some((t: string) => t.includes('recent event'))).toBe(true)
  })

  it('excludes memories older than 4h', async () => {
    const now = Math.floor(Date.now() / 1000)
    const oldSec = now - 5 * 3600 // 5h ago
    getDb().prepare(
      "INSERT INTO memories (chat_id, agent_id, content, sector, salience, category, keywords, created_at, accessed_at) VALUES ('0','agent-a','old event','semantic',1.0,'warm','event',?,?)"
    ).run(oldSec, oldSec)

    const { ctx, out } = fakeCtx('/api/overview')
    await tryHandleOverview(ctx)
    const texts = out.body.activity.map((a: any) => a.text)
    expect(texts.some((t: string) => t.includes('old event'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// lastActive per agent
// ---------------------------------------------------------------------------

describe('GET /api/overview — agents.list lastActive', () => {
  it('is null when no token_usage exists for the agent', async () => {
    const { ctx, out } = fakeCtx('/api/overview')
    await tryHandleOverview(ctx)
    const agentA = out.body.agents.list.find((a: any) => a.id === 'agent-a')
    expect(agentA).toBeDefined()
    expect(agentA.lastActive).toBeNull()
  })

  it('reflects the max token_usage timestamp for each agent', async () => {
    const ts1 = Math.floor(Date.now() / 1000) - 100
    const ts2 = Math.floor(Date.now() / 1000) - 50
    const db = getDb()
    db.prepare(
      "INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens) VALUES ('agent-a','s1',?,10,5,0,0)"
    ).run(ts1)
    db.prepare(
      "INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens) VALUES ('agent-a','s2',?,10,5,0,0)"
    ).run(ts2)

    const { ctx, out } = fakeCtx('/api/overview')
    await tryHandleOverview(ctx)
    // Fix-revert proof: removing the lastActive MAX query would leave all lastActive as null.
    const agentA = out.body.agents.list.find((a: any) => a.id === 'agent-a')
    expect(agentA.lastActive).toBe(ts2)
  })
})
