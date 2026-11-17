// Functional test for GET /api/skills/local -- calls the real handler against
// a temporary filesystem fixture. Proves the endpoint actually returns skills
// for the main agent (PROJECT_ROOT path) and for a sub-agent, not just that
// the source text contains the right patterns.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, readFileSync, mkdtempSync, existsSync, readdirSync, statSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { RouteContext } from '../web/routes/types.js'

// ENFORCED sandbox: the earlier version wrote skills into the REAL
// <repoRoot>/.claude/skills/ and the real agents/ tree (2026-07-27
// test-suite-mutates-live-state incident class). PROJECT_ROOT and the whole
// agent-dir resolution are redirected into an mkdtemp root; the handler under
// test is imported AFTER the mocks so its module graph sees the sandbox.
const tmpRoot = mkdtempSync(join(tmpdir(), 'skills-local-'))
const AGENTS_TMP = join(tmpRoot, 'agents')

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: tmpRoot }
})
vi.mock('../web/agent-config.js', async (orig) => {
  const actual = await orig<typeof import('../web/agent-config.js')>()
  const { MAIN_AGENT_ID } = await import('../config.js')
  return {
    ...actual,
    AGENTS_BASE_DIR: AGENTS_TMP,
    agentDir: (name: string) => join(AGENTS_TMP, name),
    agentConfigRoot: (name: string) => (name === MAIN_AGENT_ID ? tmpRoot : join(AGENTS_TMP, name)),
    listAgentNames: () =>
      existsSync(AGENTS_TMP)
        ? readdirSync(AGENTS_TMP).filter((f) => statSync(join(AGENTS_TMP, f)).isDirectory())
        : [],
  }
})

const { tryHandleSkills } = await import('../web/routes/skills.js')
const { PROJECT_ROOT, MAIN_AGENT_ID } = await import('../config.js')
const { agentDir } = await import('../web/agent-config.js')

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

function fakeCtxWithBody(path: string, method: string, bodyObj: object, auth?: RouteContext['auth']): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const bodyStr = JSON.stringify(bodyObj)
  const req: any = {
    on(event: string, handler: Function) {
      if (event === 'data') handler(Buffer.from(bodyStr))
      else if (event === 'end') handler()
      return req
    },
    destroy() {},
  }
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req, res, path: url.pathname, method, url, auth } as RouteContext
  return { ctx, out }
}
// The dashboard's skill editor runs in the owner's session; a main-agent skill edit is owner-only (LOW-F2-5).
const OWNER: RouteContext['auth'] = { kind: 'session' }

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

describe('GET /api/skills/:name?agent=<id> (agent-local detail)', () => {
  beforeEach(() => {
    seedSkill(MAIN_SKILL_DIR, 'main agent test skill')
    seedSkill(SUB_SKILL_DIR, 'sub-agent test skill')
  })
  afterEach(() => {
    rmSync(MAIN_SKILL_DIR, { recursive: true, force: true })
    rmSync(join(agentDir(SUB_AGENT_ID), '.claude'), { recursive: true, force: true })
    try { rmSync(agentDir(SUB_AGENT_ID), { recursive: true, force: true }) } catch { /* ok */ }
  })

  it('returns 200 with non-empty content for main-agent local skill', async () => {
    const { ctx, out } = fakeCtx(
      `/api/skills/zz-test-main-local-skill?agent=${encodeURIComponent(MAIN_AGENT_ID)}`,
    )
    const handled = await tryHandleSkills(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body).toHaveProperty('name', 'zz-test-main-local-skill')
    expect(out.body).toHaveProperty('source', 'agent')
    expect(out.body).toHaveProperty('agentId', MAIN_AGENT_ID)
    expect(typeof out.body.content).toBe('string')
    expect(out.body.content.length).toBeGreaterThan(0)
  })

  it('returns 200 with non-empty content for sub-agent local skill', async () => {
    const { ctx, out } = fakeCtx(
      `/api/skills/zz-test-sub-local-skill?agent=${encodeURIComponent(SUB_AGENT_ID)}`,
    )
    await tryHandleSkills(ctx)
    expect(out.status).toBe(200)
    expect(out.body).toHaveProperty('source', 'agent')
    expect(out.body).toHaveProperty('agentId', SUB_AGENT_ID)
    expect(out.body.content.length).toBeGreaterThan(0)
  })

  it('returns 404 for non-existent agent-local skill', async () => {
    const { ctx, out } = fakeCtx(
      `/api/skills/does-not-exist?agent=${encodeURIComponent(MAIN_AGENT_ID)}`,
    )
    await tryHandleSkills(ctx)
    expect(out.status).toBe(404)
  })

  it('rejects path traversal in skill name (agent param)', async () => {
    const { ctx, out } = fakeCtx(
      `/api/skills/${encodeURIComponent('../../../etc/passwd')}?agent=${encodeURIComponent(MAIN_AGENT_ID)}`,
    )
    await tryHandleSkills(ctx)
    expect(out.status).toBe(404)
  })

  it('rejects traversal-looking agent param with 404 not 500', async () => {
    // Previously agentDir() threw for unknown/traversal agent ids -> generic 500.
    // After whitelist validation, unknown ids return 404 before agentDir is called.
    const { ctx, out } = fakeCtx(
      `/api/skills/some-skill?agent=${encodeURIComponent('../../etc')}`,
    )
    await tryHandleSkills(ctx)
    expect(out.status).toBe(404)
  })
})

describe('PUT /api/skills/:name?agent=<id> (agent-local edit)', () => {
  beforeEach(() => {
    seedSkill(MAIN_SKILL_DIR, 'main agent test skill')
    seedSkill(SUB_SKILL_DIR, 'sub-agent test skill')
  })
  afterEach(() => {
    rmSync(MAIN_SKILL_DIR, { recursive: true, force: true })
    rmSync(join(agentDir(SUB_AGENT_ID), '.claude'), { recursive: true, force: true })
    try { rmSync(agentDir(SUB_AGENT_ID), { recursive: true, force: true }) } catch { /* ok */ }
  })

  it('writes updated content to main-agent local skill SKILL.md', async () => {
    const newContent = '---\nname: test\ndescription: updated\n---\n# Updated\n'
    const { ctx, out } = fakeCtxWithBody(
      `/api/skills/zz-test-main-local-skill?agent=${encodeURIComponent(MAIN_AGENT_ID)}`,
      'PUT',
      { content: newContent },
      OWNER,
    )
    const handled = await tryHandleSkills(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body).toHaveProperty('ok', true)

    // Verify file was actually written
    const written = readFileSync(join(MAIN_SKILL_DIR, 'SKILL.md'), 'utf-8')
    expect(written).toBe(newContent)
  })

  it('writes updated content to sub-agent local skill SKILL.md', async () => {
    const newContent = '---\nname: test\ndescription: sub updated\n---\n# Sub Updated\n'
    const { ctx, out } = fakeCtxWithBody(
      `/api/skills/zz-test-sub-local-skill?agent=${encodeURIComponent(SUB_AGENT_ID)}`,
      'PUT',
      { content: newContent },
      OWNER,
    )
    await tryHandleSkills(ctx)
    expect(out.status).toBe(200)

    const written = readFileSync(join(SUB_SKILL_DIR, 'SKILL.md'), 'utf-8')
    expect(written).toBe(newContent)
  })


  it('returns 404 for PUT on non-existent agent-local skill', async () => {
    const { ctx, out } = fakeCtxWithBody(
      `/api/skills/no-such-skill?agent=${encodeURIComponent(MAIN_AGENT_ID)}`,
      'PUT',
      { content: '# x' },
      OWNER,
    )
    await tryHandleSkills(ctx)
    expect(out.status).toBe(404)
  })

  it('rejects path traversal in PUT skill name', async () => {
    const { ctx, out } = fakeCtxWithBody(
      `/api/skills/${encodeURIComponent('../../../etc/passwd')}?agent=${encodeURIComponent(MAIN_AGENT_ID)}`,
      'PUT',
      { content: 'evil' },
      OWNER,
    )
    await tryHandleSkills(ctx)
    expect(out.status).toBe(400)
  })

  it('rejects traversal-looking agent param in PUT with 404 not 500', async () => {
    const { ctx, out } = fakeCtxWithBody(
      `/api/skills/some-skill?agent=${encodeURIComponent('../../etc')}`,
      'PUT',
      { content: 'evil' },
      OWNER,
    )
    await tryHandleSkills(ctx)
    expect(out.status).toBe(404)
  })
  // SKILLPUTSCOPE1114: the non-owner refusals (sub-agent target, unknown agent name) are rows of the owner-gate table in
  // owner-gate-round3.test.ts, which has the database refuseOwner reads.
})

// SKILLPUTSCOPE1114: links. Every target here is a probe file written for the test, in a folder of its own, never a
// real key or store file. The shapes in real use (measured on a live install) must keep working: a global skill that
// is a link to a sibling folder under the same root, and a sub-agent skill that is a link into the agent's own folder.
describe('SKILLPUTSCOPE1114: a skill folder or SKILL.md that is a link', () => {
  const PROBE_DIR = join(tmpRoot, 'probe-outside')
  const PROBE_MD = join(PROBE_DIR, 'SKILL.md')
  const PROBE_TEXT = 'PROBE-FILE-WRITTEN-FOR-THIS-TEST\n'
  const SUB_SKILLS = join(agentDir(SUB_AGENT_ID), '.claude', 'skills')
  const OWN_TARGET = join(agentDir(SUB_AGENT_ID), '.agents', 'skills', 'zz-own')
  const savedHome = process.env.HOME
  const HOME_SANDBOX = join(tmpRoot, 'home')
  const GLOBAL = join(HOME_SANDBOX, '.claude', 'skills')

  beforeEach(() => {
    mkdirSync(PROBE_DIR, { recursive: true })
    writeFileSync(PROBE_MD, PROBE_TEXT)
    mkdirSync(SUB_SKILLS, { recursive: true })
    // An agent-placed link out of its folder, and a SKILL.md that is a link out of its skill folder.
    symlinkSync(PROBE_DIR, join(SUB_SKILLS, 'zz-link-out'))
    mkdirSync(join(SUB_SKILLS, 'zz-md-out'), { recursive: true })
    symlinkSync(PROBE_MD, join(SUB_SKILLS, 'zz-md-out', 'SKILL.md'))
    // The real shape: a link into the agent's own folder.
    mkdirSync(OWN_TARGET, { recursive: true })
    writeFileSync(join(OWN_TARGET, 'SKILL.md'), '---\nname: own\ndescription: own linked\n---\n')
    symlinkSync('../../.agents/skills/zz-own', join(SUB_SKILLS, 'zz-own'))
    // Global root in a sandbox HOME: a sibling link under the root (real shape) and a link out of it.
    process.env.HOME = HOME_SANDBOX
    mkdirSync(join(GLOBAL, 'skills', 'zz-sibling'), { recursive: true })
    writeFileSync(join(GLOBAL, 'skills', 'zz-sibling', 'SKILL.md'), '---\nname: sibling\ndescription: sibling linked\n---\n')
    symlinkSync('skills/zz-sibling', join(GLOBAL, 'zz-sibling'))
    symlinkSync(PROBE_DIR, join(GLOBAL, 'zz-global-out'))
  })
  afterEach(() => {
    process.env.HOME = savedHome
    for (const d of [PROBE_DIR, HOME_SANDBOX, agentDir(SUB_AGENT_ID)]) rmSync(d, { recursive: true, force: true })
  })

  const get = async (path: string) => {
    const { ctx, out } = fakeCtx(path)
    await tryHandleSkills(ctx)
    return out
  }
  const put = async (path: string) => {
    const { ctx, out } = fakeCtxWithBody(path, 'PUT', { content: 'EDITED\n' }, OWNER)
    await tryHandleSkills(ctx)
    return out
  }
  const sub = (name: string) => `/api/skills/${name}?agent=${encodeURIComponent(SUB_AGENT_ID)}`

  it('GET ?agent: a skill folder linked out of the agent folder is not read', async () => {
    const out = await get(sub('zz-link-out'))
    expect(out.status).toBe(404)
    expect(JSON.stringify(out.body)).not.toContain('PROBE-FILE')
  })
  it('GET ?agent: a SKILL.md linked out of its skill folder is not read', async () => {
    const out = await get(sub('zz-md-out'))
    expect(out.status).toBe(404)
    expect(JSON.stringify(out.body)).not.toContain('PROBE-FILE')
  })
  it('GET ?agent: a link into the agent\'s own folder still reads', async () => {
    const out = await get(sub('zz-own'))
    expect(out.status).toBe(200)
    expect(out.body.description).toBe('own linked')
  })
  it('PUT ?agent: refuses both links out, and the probe file is unchanged', async () => {
    expect((await put(sub('zz-link-out'))).status).toBe(400)
    expect((await put(sub('zz-md-out'))).status).toBe(400)
    expect(readFileSync(PROBE_MD, 'utf-8')).toBe(PROBE_TEXT)
  })
  it('PUT ?agent: a link into the agent\'s own folder writes there', async () => {
    expect((await put(sub('zz-own'))).status).toBe(200)
    expect(readFileSync(join(OWN_TARGET, 'SKILL.md'), 'utf-8')).toBe('EDITED\n')
  })
  it('main agent: a skill linked out of its .claude/skills is refused, even into the project root (the store is there)', async () => {
    const mainSkills = join(PROJECT_ROOT, '.claude', 'skills')
    mkdirSync(mainSkills, { recursive: true })
    symlinkSync(PROBE_DIR, join(mainSkills, 'zz-main-out'))
    try {
      const main = `/api/skills/zz-main-out?agent=${encodeURIComponent(MAIN_AGENT_ID)}`
      const out = await get(main)
      expect(out.status).toBe(404)
      expect(JSON.stringify(out.body)).not.toContain('PROBE-FILE')
      expect((await put(main)).status).toBe(400)
      expect(readFileSync(PROBE_MD, 'utf-8')).toBe(PROBE_TEXT)
    } finally {
      rmSync(join(mainSkills, 'zz-main-out'), { force: true })
    }
  })
  it('global: a sibling link under the root reads and writes; a link out of the root does neither', async () => {
    expect((await get('/api/skills/zz-sibling')).body.description).toBe('sibling linked')
    const out = await get('/api/skills/zz-global-out')
    expect(out.status).toBe(404)
    expect(JSON.stringify(out.body)).not.toContain('PROBE-FILE')
    expect((await put('/api/skills/zz-sibling')).status).toBe(200)
    expect(readFileSync(join(GLOBAL, 'skills', 'zz-sibling', 'SKILL.md'), 'utf-8')).toBe('EDITED\n')
    expect((await put('/api/skills/zz-global-out')).status).toBe(400)
    expect(readFileSync(PROBE_MD, 'utf-8')).toBe(PROBE_TEXT)
  })
})
