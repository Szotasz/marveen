// Functional tests for the read-only research viewer (routes/research.ts).
// Exercises the real handler against temporary fixture dirs, with emphasis on
// the path-traversal arm: encoded ../ sequences, non-.md names, and unknown
// agents must all be rejected before any filesystem read happens.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, mkdtempSync, existsSync, readdirSync, statSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { RouteContext } from '../web/routes/types.js'

// ENFORCED sandbox: the earlier version used the REAL PROJECT_ROOT/agents
// tree, creating <repoRoot>/research/ and agents/zz-.../ in a live checkout
// (2026-07-27 test-suite-mutates-live-state incident class). PROJECT_ROOT and
// the whole agent-dir resolution are redirected into an mkdtemp root; the
// handler under test is imported AFTER the mocks so its module graph sees the
// sandbox.
const tmpRoot = mkdtempSync(join(tmpdir(), 'research-routes-'))
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

const { tryHandleResearch } = await import('../web/routes/research.js')
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

// Subfolder recursion arm. The listing used to be flat (readdirSync of the
// root only), so the doc name was a bare filename and traversal was blocked by
// a single regex plus basename(name) === name. Recursion makes "/" legal
// inside a name and both of those defenses fall, hence this block: the happy
// path (a) proves the recursion, (b) proves the traversal guard still holds on
// a SUBFOLDER path -- the flat cases above never exercise that -- and (c)
// proves symlink containment, which is the arm the symlinked research root
// makes easy to get wrong in either direction (reject everything / allow
// everything). Mutation check for (c): weaken resolveInside() in
// routes/research.ts so it stops comparing against the resolved root and (c)
// must go red; if it stays green the test is blind.
describe('research routes -- subfolders and symlinks', () => {
  const SUB_DIR_L1 = join(SUB_RESEARCH_DIR, 'nested')
  const SUB_DIR_L2 = join(SUB_DIR_L1, 'deeper')
  // Escape target lives OUTSIDE the research root but inside the sandbox, so
  // a successful read would be a real containment failure, not a missing file.
  const OUTSIDE_DIR = join(agentDir(SUB_AGENT_ID), 'outside')
  const OUTSIDE_FILE = join(OUTSIDE_DIR, 'leaked.md')

  beforeEach(() => {
    // Self-contained: the sibling describe's hooks do not run here, so this
    // block seeds and tears down its own tree (otherwise the symlinkSync calls
    // hit EEXIST on the second test).
    rmSync(agentDir(SUB_AGENT_ID), { recursive: true, force: true })
    mkdirSync(SUB_DIR_L2, { recursive: true })
    writeFileSync(join(SUB_RESEARCH_DIR, 'alpha.md'), '# Alpha Report\n\nBody\n')
    writeFileSync(join(SUB_DIR_L1, 'beta.md'), '# Beta Report\n\nNested body\n')
    writeFileSync(join(SUB_DIR_L2, 'gamma.md'), '# Gamma Report\n\nDeeper body\n')
    mkdirSync(OUTSIDE_DIR, { recursive: true })
    writeFileSync(OUTSIDE_FILE, '# Leaked\n\nSHOULD NOT BE SERVED\n')
    symlinkSync(OUTSIDE_FILE, join(SUB_RESEARCH_DIR, 'escape.md'))
    symlinkSync(OUTSIDE_DIR, join(SUB_RESEARCH_DIR, 'escapedir'))
  })
  afterEach(() => {
    rmSync(agentDir(SUB_AGENT_ID), { recursive: true, force: true })
  })

  it('(a) lists docs from subfolders as relative paths', async () => {
    const { ctx, out } = fakeCtx('/api/research')
    expect(await tryHandleResearch(ctx)).toBe(true)
    expect(out.status).toBe(200)
    const names = out.body.find((a: any) => a.agent === SUB_AGENT_ID).docs.map((d: any) => d.name)
    expect(names).toContain('alpha.md')
    expect(names).toContain('nested/beta.md')
    expect(names).toContain('nested/deeper/gamma.md')
    const beta = out.body
      .find((a: any) => a.agent === SUB_AGENT_ID)
      .docs.find((d: any) => d.name === 'nested/beta.md')
    expect(beta.title).toBe('Beta Report')
  })

  it('(a) serves a doc that lives in a subfolder', async () => {
    const { ctx, out } = fakeCtx(`/api/research/${SUB_AGENT_ID}/${encodeURIComponent('nested/deeper/gamma.md')}`)
    expect(await tryHandleResearch(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.name).toBe('nested/deeper/gamma.md')
    expect(out.body.content).toContain('Deeper body')
  })

  it('(b) rejects raw ../ on a subfolder path', async () => {
    const { ctx, out } = fakeCtx(`/api/research/${SUB_AGENT_ID}/${encodeURIComponent('nested/../../outside/leaked.md')}`)
    expect(await tryHandleResearch(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.content).toBeUndefined()
  })

  it('(b) rejects encoded %2e%2e%2f on a subfolder path', async () => {
    const { ctx, out } = fakeCtx(`/api/research/${SUB_AGENT_ID}/nested%2f%2e%2e%2f%2e%2e%2foutside%2fleaked.md`)
    expect(await tryHandleResearch(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.content).toBeUndefined()
  })

  it('(b) rejects a subfolder path whose leading segment is ..', async () => {
    const { ctx, out } = fakeCtx(`/api/research/${SUB_AGENT_ID}/%2e%2e%2fnested%2fbeta.md`)
    expect(await tryHandleResearch(ctx)).toBe(true)
    expect(out.status).toBe(400)
  })

  it('(c) refuses to read a symlink pointing outside the research root', async () => {
    const { ctx, out } = fakeCtx(`/api/research/${SUB_AGENT_ID}/escape.md`)
    expect(await tryHandleResearch(ctx)).toBe(true)
    expect(out.status).toBe(404)
    expect(out.body.content).toBeUndefined()
  })

  it('(c) refuses to read through a symlinked directory pointing outside', async () => {
    const { ctx, out } = fakeCtx(`/api/research/${SUB_AGENT_ID}/${encodeURIComponent('escapedir/leaked.md')}`)
    expect(await tryHandleResearch(ctx)).toBe(true)
    expect(out.status).toBe(404)
    expect(out.body.content).toBeUndefined()
  })

  it('(c) omits escaping symlinks from the listing', async () => {
    const { ctx, out } = fakeCtx('/api/research')
    expect(await tryHandleResearch(ctx)).toBe(true)
    const names = out.body.find((a: any) => a.agent === SUB_AGENT_ID).docs.map((d: any) => d.name)
    expect(names).not.toContain('escape.md')
    expect(names.some((n: string) => n.startsWith('escapedir/'))).toBe(false)
  })

  it('serves a symlink that stays inside the research root', async () => {
    symlinkSync(join(SUB_DIR_L1, 'beta.md'), join(SUB_RESEARCH_DIR, 'inside-link.md'))
    const { ctx, out } = fakeCtx(`/api/research/${SUB_AGENT_ID}/inside-link.md`)
    expect(await tryHandleResearch(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.content).toContain('Nested body')
  })
})

// Symlinked research ROOT -- the shape a real install takes when `research`
// is a symlink out of the checkout. Its own block because the fixtures above
// use a real directory, where the unresolved and the resolved root are the
// same string: measured 2026-08-25, deliberately regressing resolveInside() to
// compare against the UNRESOLVED research path left all 17 tests above GREEN,
// while the page was silently empty in production. So it needs a fixture where
// the two paths differ.
// Mutation check: make realResearchRoot() return researchDir(agent) without
// realpathSync and the (d) tests must go red.
describe('research routes -- symlinked research root', () => {
  const LINK_AGENT_ID = 'zz-research-test-link'
  const LINK_AGENT_DIR = agentDir(LINK_AGENT_ID)
  // The real store deliberately lives outside the agent dir, so the resolved
  // root is nowhere near the path the handler starts from.
  const REAL_STORE = join(tmpRoot, 'zz-real-research-store')
  const REAL_STORE_SUB = join(REAL_STORE, 'nested')
  const LEAK_DIR = join(tmpRoot, 'zz-real-leak')
  const LEAK_FILE = join(LEAK_DIR, 'leaked.md')

  beforeEach(() => {
    rmSync(LINK_AGENT_DIR, { recursive: true, force: true })
    rmSync(REAL_STORE, { recursive: true, force: true })
    rmSync(LEAK_DIR, { recursive: true, force: true })
    mkdirSync(REAL_STORE_SUB, { recursive: true })
    writeFileSync(join(REAL_STORE, 'root-doc.md'), '# Root Doc\n\nVia symlinked root\n')
    writeFileSync(join(REAL_STORE_SUB, 'sub-doc.md'), '# Sub Doc\n\nNested via symlinked root\n')
    mkdirSync(LEAK_DIR, { recursive: true })
    writeFileSync(LEAK_FILE, '# Leaked\n\nSHOULD NOT BE SERVED\n')
    symlinkSync(LEAK_FILE, join(REAL_STORE, 'escape.md'))
    mkdirSync(LINK_AGENT_DIR, { recursive: true })
    symlinkSync(REAL_STORE, join(LINK_AGENT_DIR, 'research'))
  })
  afterEach(() => {
    rmSync(LINK_AGENT_DIR, { recursive: true, force: true })
    rmSync(REAL_STORE, { recursive: true, force: true })
    rmSync(LEAK_DIR, { recursive: true, force: true })
  })

  it('(d) lists docs through a symlinked research root, subfolders included', async () => {
    const { ctx, out } = fakeCtx('/api/research')
    expect(await tryHandleResearch(ctx)).toBe(true)
    const group = out.body.find((a: any) => a.agent === LINK_AGENT_ID)
    expect(group, 'symlinked research root produced no docs at all').toBeTruthy()
    const names = group.docs.map((d: any) => d.name)
    expect(names).toContain('root-doc.md')
    expect(names).toContain('nested/sub-doc.md')
  })

  it('(d) serves a doc through a symlinked research root', async () => {
    const { ctx, out } = fakeCtx(`/api/research/${LINK_AGENT_ID}/${encodeURIComponent('nested/sub-doc.md')}`)
    expect(await tryHandleResearch(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.content).toContain('Nested via symlinked root')
  })

  it('(d) still refuses a symlink escaping the RESOLVED root', async () => {
    const { ctx, out } = fakeCtx(`/api/research/${LINK_AGENT_ID}/escape.md`)
    expect(await tryHandleResearch(ctx)).toBe(true)
    expect(out.status).toBe(404)
    expect(out.body.content).toBeUndefined()
  })

  it('(d) omits the escaping symlink from the listing', async () => {
    const { ctx, out } = fakeCtx('/api/research')
    expect(await tryHandleResearch(ctx)).toBe(true)
    const names = out.body.find((a: any) => a.agent === LINK_AGENT_ID).docs.map((d: any) => d.name)
    expect(names).not.toContain('escape.md')
  })
})
