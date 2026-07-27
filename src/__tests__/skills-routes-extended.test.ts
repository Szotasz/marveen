import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

const { FAKE_HOME, SKILL_DIR, AGENT_SKILL_DIR, PROJECT_SKILL_DIR } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir, join } = [require('node:os'), require('node:path')].reduce((a, b) => ({ ...a, ...b }), {}) as any
  const home = mkdtempSync(require('node:path').join(tmpdir(), 'skills-test-'))
  const skillsDir = require('node:path').join(home, '.claude', 'skills')
  mkdirSync(skillsDir, { recursive: true })
  const existing = require('node:path').join(skillsDir, 'my-skill')
  mkdirSync(existing, { recursive: true })
  writeFileSync(require('node:path').join(existing, 'SKILL.md'), '---\nname: my-skill\ndescription: A test skill\n---\n# My Skill\n')

  // Agent-local skill: known-agent has my-skill installed
  const agentSkillDir = require('node:path').join(home, 'agents', 'known-agent', '.claude', 'skills', 'my-skill')
  mkdirSync(agentSkillDir, { recursive: true })
  writeFileSync(require('node:path').join(agentSkillDir, 'SKILL.md'), '---\nname: my-skill\ndescription: Agent skill\n---\n# My Skill\n')

  // Project-local (MAIN_AGENT_ID) skill
  const projectSkillDir = require('node:path').join(home, '.claude', 'skills', 'my-skill')
  // Already exists as SKILL_DIR/my-skill above; use a separate named skill for project-agent tests
  const projectLocalSkillDir = require('node:path').join(home, '.claude', 'skills', 'project-skill')
  mkdirSync(projectLocalSkillDir, { recursive: true })
  writeFileSync(require('node:path').join(projectLocalSkillDir, 'SKILL.md'), '---\nname: project-skill\ndescription: Project skill\n---\n# Project Skill\n')

  return { FAKE_HOME: home, SKILL_DIR: skillsDir, AGENT_SKILL_DIR: agentSkillDir, PROJECT_SKILL_DIR: projectLocalSkillDir }
})

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: vi.fn().mockReturnValue(FAKE_HOME) }
})
vi.mock('../web/agent-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/agent-config.js')>()
  return {
    ...actual,
    listAgentNames: vi.fn().mockReturnValue(['known-agent']),
    agentDir: vi.fn().mockImplementation((name: string) => require('node:path').join(FAKE_HOME, 'agents', name)),
    readFileOr: vi.fn().mockImplementation((path: string, fallback: string) => {
      try { return require('node:fs').readFileSync(path, 'utf-8') } catch { return fallback }
    }),
    AGENTS_BASE_DIR: require('node:path').join(FAKE_HOME, 'agents'),
  }
})
vi.mock('../web/agent-scaffold.js', () => ({
  generateSkillMd: vi.fn().mockResolvedValue('---\nname: new-skill\ndescription: A new skill\n---\n# New Skill\n'),
  scaffoldAgentDir: vi.fn(),
  generateClaudeMd: vi.fn().mockResolvedValue('# Agent'),
  generateSoulMd: vi.fn().mockResolvedValue('# Soul'),
  writeAgentSettingsFromProfile: vi.fn(),
}))
vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: vi.fn().mockImplementation((path: string, content: string) => {
    require('node:fs').writeFileSync(path, content)
  }),
}))
vi.mock('../web/multipart.js', () => ({
  parseMultipart: vi.fn().mockReturnValue({ file: null }),
}))
vi.mock('../web/sanitize.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/sanitize.js')>()
  return { ...actual }
})
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>()
  return { ...actual, MAIN_AGENT_ID: 'marveen', PROJECT_ROOT: FAKE_HOME }
})

import { tryHandleSkills } from '../web/routes/skills.js'

function makeCtx(method: string, path: string, body?: object): {
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
    end(b?: string) { try { out.body = JSON.parse(b?.toString() || 'null') } catch { out.body = b } },
  } as any
  const url = new URL(`http://localhost:3420${path}`)
  return { ctx: { req, res, path: url.pathname, method, url } as RouteContext, out }
}

describe('tryHandleSkills', () => {
  it('GET /api/skills returns list including seeded skill', async () => {
    const { ctx, out } = makeCtx('GET', '/api/skills')
    expect(await tryHandleSkills(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(Array.isArray(out.body)).toBe(true)
    expect(out.body.some((s: any) => s.name === 'my-skill')).toBe(true)
  })

  it('GET /api/skills/local returns 200 empty list when no local dirs', async () => {
    const { ctx, out } = makeCtx('GET', '/api/skills/local')
    expect(await tryHandleSkills(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(Array.isArray(out.body)).toBe(true)
  })

  it('GET /api/skills/export returns 404 when skills dir missing', async () => {
    const { homedir } = await import('node:os')
    vi.mocked(homedir).mockReturnValueOnce('/nonexistent-path-xyz-99')
    const { ctx, out } = makeCtx('GET', '/api/skills/export')
    expect(await tryHandleSkills(ctx)).toBe(true)
    expect(out.status).toBe(404)
  })

  it('GET /api/skills/:name returns skill detail', async () => {
    const { ctx, out } = makeCtx('GET', '/api/skills/my-skill')
    expect(await tryHandleSkills(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.name).toBe('my-skill')
  })

  it('GET /api/skills/:name returns 404 for unknown skill', async () => {
    const { ctx, out } = makeCtx('GET', '/api/skills/nonexistent-skill')
    expect(await tryHandleSkills(ctx)).toBe(true)
    expect(out.status).toBe(404)
  })

  it('POST /api/skills returns 400 when name missing', async () => {
    const { ctx, out } = makeCtx('POST', '/api/skills', { description: 'A skill' })
    expect(await tryHandleSkills(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toMatch(/name/i)
  })

  it('POST /api/skills returns 400 when description missing', async () => {
    const { ctx, out } = makeCtx('POST', '/api/skills', { name: 'new-skill' })
    expect(await tryHandleSkills(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toMatch(/description/i)
  })

  it('POST /api/skills returns 409 when skill already exists', async () => {
    const { ctx, out } = makeCtx('POST', '/api/skills', { name: 'my-skill', description: 'Duplicate' })
    expect(await tryHandleSkills(ctx)).toBe(true)
    expect(out.status).toBe(409)
  })

  it('POST /api/skills creates new skill', async () => {
    const { ctx, out } = makeCtx('POST', '/api/skills', { name: 'brand-new-skill', description: 'Test skill' })
    expect(await tryHandleSkills(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.ok).toBe(true)
    expect(out.body.name).toBe('brand-new-skill')
    // Cleanup
    require('node:fs').rmSync(require('node:path').join(SKILL_DIR, 'brand-new-skill'), { recursive: true, force: true })
  })

  it('POST /api/skills/import returns 400 when no file', async () => {
    const { ctx, out } = makeCtx('POST', '/api/skills/import')
    expect(await tryHandleSkills(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toMatch(/no file/i)
  })

  it('POST /api/skills/:name/assign returns 404 for non-existent skill', async () => {
    const { ctx, out } = makeCtx('POST', '/api/skills/ghost-skill/assign', { agents: [] })
    expect(await tryHandleSkills(ctx)).toBe(true)
    expect(out.status).toBe(404)
  })

  it('POST /api/skills/:name/assign assigns to empty list', async () => {
    const { ctx, out } = makeCtx('POST', '/api/skills/my-skill/assign', { agents: [] })
    expect(await tryHandleSkills(ctx)).toBe(true)
    expect(out.body.ok).toBe(true)
  })

  it('PUT /api/skills/:name returns 403 for plugin skill (contains colon)', async () => {
    const { ctx, out } = makeCtx('PUT', '/api/skills/some-plugin:my-skill', { content: '# Updated' })
    expect(await tryHandleSkills(ctx)).toBe(true)
    expect(out.status).toBe(403)
  })

  it('PUT /api/skills/:name returns 404 for nonexistent skill', async () => {
    const { ctx, out } = makeCtx('PUT', '/api/skills/ghost-skill', { content: '# Ghost' })
    expect(await tryHandleSkills(ctx)).toBe(true)
    expect(out.status).toBe(404)
  })

  it('PUT /api/skills/:name updates skill content', async () => {
    const { ctx, out } = makeCtx('PUT', '/api/skills/my-skill', { content: '---\nname: my-skill\ndescription: Updated\n---\n# Updated\n' })
    expect(await tryHandleSkills(ctx)).toBe(true)
    expect(out.body.ok).toBe(true)
  })

  it('GET /api/skills/:name?agent= returns 404 for unknown agent', async () => {
    const { ctx, out } = makeCtx('GET', '/api/skills/my-skill?agent=ghost-agent')
    expect(await tryHandleSkills(ctx)).toBe(true)
    expect(out.status).toBe(404)
  })

  it('PUT /api/skills/:name?agent= returns 404 for unknown agent', async () => {
    const { ctx, out } = makeCtx('PUT', '/api/skills/my-skill?agent=ghost-agent', { content: '# x' })
    expect(await tryHandleSkills(ctx)).toBe(true)
    expect(out.status).toBe(404)
  })

  it('GET /api/skills/project-skill?agent=marveen returns main-agent local skill', async () => {
    const { ctx, out } = makeCtx('GET', '/api/skills/project-skill?agent=marveen')
    expect(await tryHandleSkills(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.name).toBe('project-skill')
    expect(out.body.agentId).toBe('marveen')
  })

  it('PUT /api/skills/project-skill?agent=marveen updates main-agent local skill', async () => {
    const { ctx, out } = makeCtx('PUT', '/api/skills/project-skill?agent=marveen', { content: '---\nname: project-skill\ndescription: Updated\n---\n# Updated\n' })
    expect(await tryHandleSkills(ctx)).toBe(true)
    expect(out.body.ok).toBe(true)
  })

  it('returns false for unmatched route', async () => {
    const { ctx } = makeCtx('GET', '/api/other')
    expect(await tryHandleSkills(ctx)).toBe(false)
  })
})
