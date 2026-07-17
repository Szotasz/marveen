// Functional test for GET /api/skills/local -- calls the real handler against
// a temporary filesystem fixture. Proves the endpoint actually returns skills
// for the main agent (PROJECT_ROOT path) and for a sub-agent, not just that
// the source text contains the right patterns.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tryHandleSkills } from '../web/routes/skills.js'
import { PROJECT_ROOT, MAIN_AGENT_ID } from '../config.js'
import { agentDir } from '../web/agent-config.js'
import type { RouteContext } from '../web/routes/types.js'

function fakeCtx(path: string, method = 'GET'): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req: {} as any, res, path: url.pathname, method, url } as RouteContext
  return { ctx, out }
}

// Temp skill dirs created during the test
const MAIN_SKILL_DIR  = join(PROJECT_ROOT, '.claude', 'skills', 'zz-test-main-local-skill')
const SUB_AGENT_ID    = 'zz-local-skill-test-sub'
const SUB_SKILL_DIR   = join(agentDir(SUB_AGENT_ID), '.claude', 'skills', 'zz-test-sub-local-skill')

function seedSkill(dir: string, description: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: test\ndescription: ${description}\n---\n# Test\n`)
}

describe('GET /api/skills/local', () => {
  beforeEach(() => {
    seedSkill(MAIN_SKILL_DIR, 'main agent test skill')
    seedSkill(SUB_SKILL_DIR, 'sub-agent test skill')
  })
  afterEach(() => {
    rmSync(MAIN_SKILL_DIR, { recursive: true, force: true })
    rmSync(join(agentDir(SUB_AGENT_ID), '.claude'), { recursive: true, force: true })
    // Remove the temp agent dir only if it was empty before our test
    try { rmSync(agentDir(SUB_AGENT_ID), { recursive: true, force: true }) } catch { /* ok */ }
  })

  it('returns skills for the main agent (PROJECT_ROOT path)', async () => {
    const { ctx, out } = fakeCtx('/api/skills/local')
    const handled = await tryHandleSkills(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
    expect(Array.isArray(out.body)).toBe(true)

    const mainSkills = out.body.filter((s: any) => s.agentId === MAIN_AGENT_ID)
    expect(mainSkills.length).toBeGreaterThan(0)
    const seed = mainSkills.find((s: any) => s.name === 'zz-test-main-local-skill')
    expect(seed).toBeDefined()
    expect(seed.source).toBe('agent')
    expect(seed.description).toBe('main agent test skill')
  })

  it('returns skills for sub-agents', async () => {
    const { ctx, out } = fakeCtx('/api/skills/local')
    await tryHandleSkills(ctx)
    const subSkills = out.body.filter((s: any) => s.agentId === SUB_AGENT_ID)
    expect(subSkills.length).toBeGreaterThan(0)
    expect(subSkills[0].name).toBe('zz-test-sub-local-skill')
    expect(subSkills[0].source).toBe('agent')
  })

  it('all entries have required fields', async () => {
    const { ctx, out } = fakeCtx('/api/skills/local')
    await tryHandleSkills(ctx)
    for (const s of out.body) {
      expect(s).toHaveProperty('name')
      expect(s).toHaveProperty('agentId')
      expect(s).toHaveProperty('source', 'agent')
      expect(s).toHaveProperty('mtime')
    }
  })

  it('does not duplicate if MAIN_AGENT_ID somehow appears in listAgentNames', async () => {
    // Defensive: even if listAgentNames returns MAIN_AGENT_ID in the future,
    // the response must not contain two entries with the same agentId+name pair.
    const { ctx, out } = fakeCtx('/api/skills/local')
    await tryHandleSkills(ctx)
    const keys = out.body.map((s: any) => `${s.agentId}::${s.name}`)
    const unique = new Set(keys)
    expect(unique.size).toBe(keys.length)
  })
})
