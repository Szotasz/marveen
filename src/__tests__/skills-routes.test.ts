import { describe, it, expect, vi, afterAll } from 'vitest'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

const { FAKE_HOME, FAKE_PROJECT } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os')

  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-test-'))
  const fakeProject = path.join(fakeHome, 'project')

  // Create user skills dir with one skill
  const skillsDir = path.join(fakeHome, '.claude', 'skills')
  const mySkillDir = path.join(skillsDir, 'my-skill')
  fs.mkdirSync(mySkillDir, { recursive: true })
  fs.writeFileSync(path.join(mySkillDir, 'SKILL.md'), `---
name: my-skill
description: "A test skill"
keywords: testing, unit
---

# My Skill

Do the thing.
`)

  // Create plugins dir with a plugin skill
  const pluginDir = path.join(fakeHome, '.claude', 'plugins', 'cache', 'my-plugin', 'skills', 'plug-skill')
  fs.mkdirSync(pluginDir, { recursive: true })
  fs.writeFileSync(path.join(pluginDir, 'SKILL.md'), `---
name: plug-skill
description: "Plugin skill"
---
Plugin content.
`)

  // Create agent dir with local skill
  const agentsBase = path.join(fakeHome, 'agents')
  const agentSkillDir = path.join(agentsBase, 'agent-b', '.claude', 'skills', 'agent-local-skill')
  fs.mkdirSync(agentSkillDir, { recursive: true })
  fs.writeFileSync(path.join(agentSkillDir, 'SKILL.md'), `---
name: agent-local-skill
description: "agent-b local skill"
---
Local.
`)

  // Create main agent skills
  const mainSkillDir = path.join(fakeProject, '.claude', 'skills', 'main-skill')
  fs.mkdirSync(mainSkillDir, { recursive: true })
  fs.writeFileSync(path.join(mainSkillDir, 'SKILL.md'), `---
name: main-skill
description: "Main agent skill"
---
Main skill content.
`)

  return { FAKE_HOME: fakeHome, FAKE_PROJECT: fakeProject }
})

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: vi.fn().mockReturnValue(FAKE_HOME) }
})

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: FAKE_PROJECT, MAIN_AGENT_ID: 'marveen' }
})

vi.mock('../web/agent-config.js', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require('node:path') as typeof import('node:path')
  const actual = await importOriginal<typeof import('../web/agent-config.js')>()
  return {
    ...actual,
    AGENTS_BASE_DIR: nodePath.join(FAKE_HOME, 'agents'),
    listAgentNames: vi.fn().mockReturnValue(['agent-b']),
    agentDir: vi.fn().mockImplementation((name: string) => nodePath.join(FAKE_HOME, 'agents', name)),
    readFileOr: vi.fn().mockImplementation((filePath: string, def: string) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      try { return require('node:fs').readFileSync(filePath, 'utf-8') } catch { return def }
    }),
  }
})

vi.mock('../web/agent-scaffold.js', () => ({
  generateSkillMd: vi.fn().mockResolvedValue('---\nname: generated-skill\n---\nContent.'),
}))

vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

vi.mock('../db.js', () => ({
  getSkill: vi.fn().mockReturnValue(undefined),
  createSkill: vi.fn().mockImplementation((opts: any) => ({ ...opts, is_global: opts.is_global ? 1 : 0, created_by: null, created_at: 0, updated_at: 0 })),
  updateSkill: vi.fn().mockReturnValue(undefined),
  deleteSkill: vi.fn().mockReturnValue(true),
  seedSkillIfAbsent: vi.fn().mockReturnValue(true),
  listSkillsForTenant: vi.fn().mockReturnValue([]),
  listAllSkills: vi.fn().mockReturnValue([]),
  grantSkillAccess: vi.fn(),
  revokeSkillAccess: vi.fn().mockReturnValue(true),
  listSkillAccess: vi.fn().mockReturnValue([]),
}))

import { tryHandleSkills } from '../web/routes/skills.js'

afterAll(() => {
  rmSync(FAKE_HOME, { recursive: true, force: true })
})

function makeCtx(method: string, path: string, body?: object, params?: Record<string, string>): {
  ctx: RouteContext; out: { status: number; body: any }
} {
  const buf = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0)
  const req = new EventEmitter() as any
  req.method = method
  req.headers = {}
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  const out = { status: 200, body: null as any }
  const res = {
    writeHead(s: number) { out.status = s },
    end(b?: string) { try { out.body = JSON.parse(b || 'null') } catch { out.body = b } },
    setHeader: vi.fn(),
    pipe: vi.fn(),
  } as any
  const url = new URL(`http://localhost:3420${path}`)
  if (params) { for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v) }
  return { ctx: { req, res, path: url.pathname, method, url } as RouteContext, out }
}

describe('tryHandleSkills', () => {
  describe('GET /api/skills', () => {
    it('returns skills list including user and plugin skills', async () => {
      const { ctx, out } = makeCtx('GET', '/api/skills')
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(200)
      expect(Array.isArray(out.body)).toBe(true)
      const userSkill = out.body.find((s: any) => s.name === 'my-skill')
      expect(userSkill).toBeDefined()
      expect(userSkill.source).toBe('user')
      expect(userSkill.description).toBe('A test skill')
    })

    it('includes plugin skills', async () => {
      const { ctx, out } = makeCtx('GET', '/api/skills')
      await tryHandleSkills(ctx)
      const pluginSkill = out.body.find((s: any) => s.name?.includes('plug-skill'))
      expect(pluginSkill).toBeDefined()
      expect(pluginSkill.source).toBe('plugin')
    })
  })

  describe('GET /api/skills/local', () => {
    it('returns local (agent-specific) skills', async () => {
      const { ctx, out } = makeCtx('GET', '/api/skills/local')
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(200)
      expect(Array.isArray(out.body)).toBe(true)
      const localSkill = out.body.find((s: any) => s.name === 'agent-local-skill')
      expect(localSkill).toBeDefined()
      expect(localSkill.agentId).toBe('agent-b')
      expect(localSkill.source).toBe('agent')
    })
  })

  describe('GET /api/skills/:name', () => {
    it('returns 200 with skill detail for known skill', async () => {
      const { ctx, out } = makeCtx('GET', '/api/skills/my-skill')
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(200)
      expect(out.body.name).toBe('my-skill')
      expect(out.body.description).toBe('A test skill')
      expect(out.body.source).toBe('user')
    })

    it('returns 404 for unknown global skill', async () => {
      const { ctx, out } = makeCtx('GET', '/api/skills/nonexistent-skill-x99')
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(404)
    })

    it('returns skill with ?agent=agent-b for agent-local skill', async () => {
      const { ctx, out } = makeCtx('GET', '/api/skills/agent-local-skill', undefined, { agent: 'agent-b' })
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(200)
      expect(out.body.source).toBe('agent')
      expect(out.body.agentId).toBe('agent-b')
    })

    it('returns 404 when agent is invalid with ?agent=', async () => {
      const { ctx, out } = makeCtx('GET', '/api/skills/some-skill', undefined, { agent: 'unknown-agent-x99' })
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(404)
    })

    it('returns plugin skill for "plugin:skill" name format', async () => {
      const { ctx, out } = makeCtx('GET', '/api/skills/my-plugin%3Aplug-skill')
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(200)
      expect(out.body.source).toBe('plugin')
    })
  })

  describe('POST /api/skills', () => {
    it('returns 400 when name is missing', async () => {
      const { ctx, out } = makeCtx('POST', '/api/skills', { name: '', description: 'test' })
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(400)
      expect(out.body.error).toMatch(/required/i)
    })

    it('returns 400 when description is missing', async () => {
      const { ctx, out } = makeCtx('POST', '/api/skills', { name: 'new-skill', description: '' })
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(400)
      expect(out.body.error).toBe('required')
      expect(out.body.field).toBe('description')
    })

    it('returns 409 when skill already exists', async () => {
      const { ctx, out } = makeCtx('POST', '/api/skills', { name: 'my-skill', description: 'Already exists' })
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(409)
    })

    it('creates skill and returns 200 for new valid skill', async () => {
      const { ctx, out } = makeCtx('POST', '/api/skills', { name: 'brand-new-skill', description: 'A new skill' })
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(200)
      expect(out.body.ok).toBe(true)
      expect(out.body.name).toBe('brand-new-skill')
      // cleanup
      rmSync(join(FAKE_HOME, '.claude', 'skills', 'brand-new-skill'), { recursive: true, force: true })
    })
  })

  describe('PUT /api/skills/:name', () => {
    it('updates skill content for existing skill', async () => {
      const { ctx, out } = makeCtx('PUT', '/api/skills/my-skill', { content: '# Updated\nNew content' })
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(200)
      expect(out.body.ok).toBe(true)
    })

    it('returns 404 for unknown skill on PUT', async () => {
      const { ctx, out } = makeCtx('PUT', '/api/skills/nonexistent-x99', { content: 'new content' })
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(404)
    })

    it('returns 403 for plugin skill PUT', async () => {
      const { ctx, out } = makeCtx('PUT', '/api/skills/my-plugin%3Aplug-skill', { content: 'new' })
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(403)
      expect(out.body.error).toBe('forbidden')
      expect(out.body.hint).toMatch(/plugin/i)
    })
  })

  describe('unmatched route', () => {
    it('returns false for unmatched route', async () => {
      const { ctx } = makeCtx('GET', '/api/other')
      expect(await tryHandleSkills(ctx)).toBe(false)
    })
  })
})
