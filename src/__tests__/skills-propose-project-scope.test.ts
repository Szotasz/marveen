// SKILLPROPOSESCOPE1104 (Marveen 68194, Samu 68195): a proposal of a name that lives in the PROJECT root's
// .claude/skills replaces it THERE (same hash binding, its scripts/ and references/ kept), never as a second, global
// copy; a name that lives in both roots is refused (409). A new name still goes to the global root.
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpHome = mkdtempSync(join(tmpdir(), 'skills-scope-home-'))
const tmpRoot = mkdtempSync(join(tmpdir(), 'skills-scope-root-'))
const realHome = process.env.HOME
process.env.HOME = tmpHome
afterAll(() => { process.env.HOME = realHome; rmSync(tmpHome, { recursive: true, force: true }); rmSync(tmpRoot, { recursive: true, force: true }) })

vi.mock('../settings-store.js', async (orig) => {
  const actual = await orig<typeof import('../settings-store.js')>()
  return { ...actual, getEffectiveSettingValue: (k: string) => (k === 'SKILL_QUARANTINE' ? '1' : actual.getEffectiveSettingValue(k)) }
})
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  PROJECT_ROOT: tmpRoot, STORE_DIR: join(tmpRoot, 'store'), MAIN_AGENT_ID: 'host-main',
}))

const q = await import('../web/skill-quarantine.js')
const { tryHandleSkills } = await import('../web/routes/skills.js')
type Auth = import('../web/routes/types.js').RouteContext['auth']

async function call(method: string, path: string, body: unknown, auth: Auth) {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = { writeHead(s: number) { out.status = s; return res }, setHeader() {}, end(c?: string) { if (c) try { out.body = JSON.parse(c) } catch { out.body = c } } }
  const raw = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = Readable.from(raw) as unknown as http.IncomingMessage
  req.headers = {}
  const url = new URL(`http://localhost${path}`)
  expect(await tryHandleSkills({ req, res, path: url.pathname, method, url, auth } as any)).toBe(true)
  return out
}
const TOKEN: Auth = { kind: 'token', agent: 'soma' }
const GLOBAL = join(tmpHome, '.claude', 'skills')
const PROJECT = join(tmpRoot, '.claude', 'skills')
const MD = '---\nname: sync-skill\ndescription: x\n---\n# new text\n'
const propose = (name: string) => call('POST', '/api/skills/propose', { name, skill_md: MD.replace('sync-skill', name) }, TOKEN)
const pending = () => { try { return readdirSync(join(tmpRoot, 'store', 'skills-pending')).filter((f) => !f.startsWith('_')) } catch { return [] } }

function liveSkill(root: string, name: string) {
  const d = join(root, name)
  mkdirSync(join(d, 'scripts'), { recursive: true })
  mkdirSync(join(d, 'references'), { recursive: true })
  writeFileSync(join(d, 'SKILL.md'), '---\nname: ' + name + '\ndescription: old\n---\n# old\n')
  writeFileSync(join(d, 'scripts', 'run.py'), 'print(1)\n')
  writeFileSync(join(d, 'references', 'r.md'), 'ref\n')
}

beforeAll(() => { process.env.NODE_ENV = 'test' })
beforeEach(() => {
  rmSync(GLOBAL, { recursive: true, force: true })
  rmSync(PROJECT, { recursive: true, force: true })
  rmSync(join(tmpRoot, 'store'), { recursive: true, force: true })
})

describe('proposeTarget and the propose route', () => {
  it('a name living only in the project root: queued for the PROJECT root, replaces it there, no global copy', async () => {
    liveSkill(PROJECT, 'sync-skill')
    const r = await propose('sync-skill')
    expect(r.status).toBe(200)
    expect(r.body.target).toBe('project')
    expect(r.body.replaces).toBe(true)
    const p = q.getPending(r.body.id)!
    expect(p.target).toEqual({ scope: 'project' })
    expect(q.approvePending(r.body.id, p.hash)).toMatchObject({ ok: true })
    expect(readFileSync(join(PROJECT, 'sync-skill', 'SKILL.md'), 'utf-8')).toContain('# new text')
    // its other files are kept
    expect(readFileSync(join(PROJECT, 'sync-skill', 'scripts', 'run.py'), 'utf-8')).toBe('print(1)\n')
    expect(readFileSync(join(PROJECT, 'sync-skill', 'references', 'r.md'), 'utf-8')).toBe('ref\n')
    // and no second, global copy
    expect(existsSync(join(GLOBAL, 'sync-skill'))).toBe(false)
  })
  it('a name living in BOTH roots: 409, nothing queued, neither copy touched', async () => {
    liveSkill(PROJECT, 'sync-skill')
    liveSkill(GLOBAL, 'sync-skill')
    const r = await propose('sync-skill')
    expect(r.status).toBe(409)
    expect(String(r.body.error)).toContain('both')
    expect(pending()).toEqual([])
    expect(readFileSync(join(PROJECT, 'sync-skill', 'SKILL.md'), 'utf-8')).toContain('# old')
    expect(readFileSync(join(GLOBAL, 'sync-skill', 'SKILL.md'), 'utf-8')).toContain('# old')
  })
  it('a name living only globally, or nowhere: the global root, as before', async () => {
    liveSkill(GLOBAL, 'g-skill')
    const g = await propose('g-skill')
    expect(g.body.target).toBe('global')
    expect(g.body.replaces).toBe(true)
    const n = await propose('new-skill')
    expect(n.body.target).toBe('global')
    expect(n.body.replaces).toBe(false)
    expect(existsSync(join(PROJECT, 'new-skill'))).toBe(false)
  })
  it('a waiting proposal for the project root blocks a second one of the same name (quarantine on)', async () => {
    liveSkill(PROJECT, 'sync-skill')
    expect((await propose('sync-skill')).status).toBe(200)
    expect((await propose('sync-skill')).status).toBe(409)
  })
})
