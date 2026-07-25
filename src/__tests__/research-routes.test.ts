// Functional tests for the read-only research viewer (routes/research.ts).
// Exercises the real handler against temporary fixture dirs, with emphasis on
// the path-traversal arm: encoded ../ sequences, non-.md names, and unknown
// agents must all be rejected before any filesystem read happens.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tryHandleResearch } from '../web/routes/research.js'
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

const SUB_AGENT_ID = 'zz-research-test-sub'
const SUB_RESEARCH_DIR = join(agentDir(SUB_AGENT_ID), 'research')
const MAIN_RESEARCH_DIR = join(PROJECT_ROOT, 'research')
const MAIN_SEED = join(MAIN_RESEARCH_DIR, 'zz-test-main-research.md')

describe('research routes', () => {
  beforeEach(() => {
    mkdirSync(SUB_RESEARCH_DIR, { recursive: true })
    writeFileSync(join(SUB_RESEARCH_DIR, 'alpha.md'), '# Alpha Report\n\nBody\n')
    mkdirSync(MAIN_RESEARCH_DIR, { recursive: true })
    writeFileSync(MAIN_SEED, '# Main Research\n\nBody\n')
  })
  afterEach(() => {
    rmSync(agentDir(SUB_AGENT_ID), { recursive: true, force: true })
    rmSync(MAIN_SEED, { force: true })
  })

  it('lists seeded docs for sub-agent and main agent', async () => {
    const { ctx, out } = fakeCtx('/api/research')
    expect(await tryHandleResearch(ctx)).toBe(true)
    expect(out.status).toBe(200)
    const sub = out.body.find((a: any) => a.agent === SUB_AGENT_ID)
    expect(sub?.docs.map((d: any) => d.name)).toContain('alpha.md')
    expect(sub?.docs.find((d: any) => d.name === 'alpha.md')?.title).toBe('Alpha Report')
    const main = out.body.find((a: any) => a.agent === MAIN_AGENT_ID)
    expect(main?.docs.map((d: any) => d.name)).toContain('zz-test-main-research.md')
  })

  it('serves a single doc with content', async () => {
    const { ctx, out } = fakeCtx(`/api/research/${SUB_AGENT_ID}/alpha.md`)
    expect(await tryHandleResearch(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.content).toContain('Alpha Report')
  })

  it('rejects encoded path traversal in the file name', async () => {
    // %2e%2e%2f => "../" after the handler's decodeURIComponent
    const { ctx, out } = fakeCtx(`/api/research/${SUB_AGENT_ID}/%2e%2e%2f%2e%2e%2fsecret.md`)
    expect(await tryHandleResearch(ctx)).toBe(true)
    expect(out.status).toBe(400)
  })

  it('rejects traversal aimed at dotfiles outside research/', async () => {
    const { ctx, out } = fakeCtx(`/api/research/${SUB_AGENT_ID}/%2e%2e%2f.env`)
    expect(await tryHandleResearch(ctx)).toBe(true)
    expect(out.status).toBe(400)
  })

  it('rejects non-.md file names', async () => {
    const { ctx, out } = fakeCtx(`/api/research/${SUB_AGENT_ID}/notes.txt`)
    expect(await tryHandleResearch(ctx)).toBe(true)
    expect(out.status).toBe(400)
  })

  it('rejects unknown agents', async () => {
    const { ctx, out } = fakeCtx('/api/research/zz-no-such-agent/alpha.md')
    expect(await tryHandleResearch(ctx)).toBe(true)
    expect(out.status).toBe(404)
  })

  it('404s on a missing but well-formed file name', async () => {
    const { ctx, out } = fakeCtx(`/api/research/${SUB_AGENT_ID}/missing.md`)
    expect(await tryHandleResearch(ctx)).toBe(true)
    expect(out.status).toBe(404)
  })

  it('ignores non-research paths', async () => {
    const { ctx } = fakeCtx('/api/agents')
    expect(await tryHandleResearch(ctx)).toBe(false)
  })
})
