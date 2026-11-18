// The carriers and the CLAUDE.md editor around a package agent (MIOAGENTINSTALL1114, PR-I3; plan 4.2, 7.5, 10.3).
//
//  - the agent export refuses a package agent (409 with what to do instead), the bundle export-all and the fleet
//    export leave it out and name it; the agent and fleet bundle imports never bring a .package/ folder in;
//  - the editor (PUT /api/agents/:name with claudeMd) answers 409 package_shell_required for a package agent when
//    the bytes to save do not start with the shell (the shared case list), writes exactly the request's bytes
//    otherwise, and puts the fleet-roster block back after the save;
//  - the dashboard summary takes a package agent's description from its record and names the package.
// Mutant rows 25 and 44 (the editor's B1 and B2) of plan 10.4 are pinned here. A temp PROJECT_ROOT and store.
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

const REPO = join(__dirname, '..', '..')
const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-agent-package-carriers-'))
process.env.CLAUDECLAW_ENV_DIR = tmpRoot
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<object>()), PROJECT_ROOT: tmpRoot, STORE_DIR: join(tmpRoot, 'store'), MAIN_AGENT_ID: 'agent-a',
}))
mkdirSync(join(tmpRoot, 'store'), { recursive: true })
mkdirSync(join(tmpRoot, 'templates', 'profiles'), { recursive: true })
for (const f of readdirSync(join(REPO, 'templates', 'profiles'))) copyFileSync(join(REPO, 'templates', 'profiles', f), join(tmpRoot, 'templates', 'profiles', f))

const { initDatabase, getDb, createDashboardUser } = await import('../db.js')
const { createSession, _clearSessionCacheForTest } = await import('../web/auth-sessions.js')
const { SESSION_COOKIE_NAME } = await import('../web/auth-gate.js')
const { tryHandleAgents } = await import('../web/routes/agents.js')
const B = await import('../web/agent-bundle.js')
const { exportFleet } = await import('../web/fleet-transfer.js')
const M = await import('../web/agent-package/marker.js')

const AGENTS = join(tmpRoot, 'agents')
const P = M.PACKAGE_SHELL_PREFIX_TEXT
const FIXTURE = JSON.parse(readFileSync(join(REPO, 'scripts', '__tests__', 'fixtures', 'package-shell-cases.json'), 'utf8')) as {
  prefix: Array<{ name: string; b64: string; shell: boolean }>
}

function makeAgent(name: string, files: Record<string, string>): string {
  const d = join(AGENTS, name)
  for (const [p, t] of Object.entries(files)) {
    mkdirSync(join(d, p, '..'), { recursive: true })
    writeFileSync(join(d, p), t)
  }
  return d
}
const RECORD = JSON.stringify({ schema: 1, payloadSha256: 'a'.repeat(64), kid: 'k', installedAt: 'x', updatedAt: 'x', payload: { slug: 'pkg', version: '1.2.0', description: 'Keeps the invoices in order.' } })
const PKG_FILES = { 'CLAUDE.md': `${P}\n${M.FLEET_ROSTER_BEGIN}\nx\n<!-- END GENERATED: fleet-roster -->\n`, 'PACKAGE.md': 'p\n', 'SOUL.md': 's\n', '.package/manifest.json': RECORD, 'agent-config.json': '{}' }
const HAND_FILES = { 'CLAUDE.md': '# Hand\n\nA hand-made agent.\n', 'SOUL.md': 's\n', 'agent-config.json': '{}' }

let ownerId = 0
async function hit(method: string, path: string, body?: unknown) {
  const raw = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = Readable.from(raw) as unknown as http.IncomingMessage
  req.headers = { cookie: `${SESSION_COOKIE_NAME}=${createSession({ userId: ownerId, username: 'owner' })}` }
  ;(req as any).url = path
  ;(req as any).method = method
  const out: { status: number; body: any; headers: Record<string, unknown> } = { status: 0, body: null, headers: {} }
  const res: any = {
    writeHead(s: number, h?: Record<string, unknown>) { out.status = s; Object.assign(out.headers, h ?? {}); return res },
    setHeader() {},
    end(c?: string | Buffer) { if (c && typeof c === 'string') { try { out.body = JSON.parse(c) } catch { out.body = c } } },
  }
  const url = new URL(`http://127.0.0.1:3420${path}`)
  expect(await tryHandleAgents({ req, res, path: url.pathname, method, url, auth: { kind: 'session' } } as any, join(REPO, 'web'))).toBe(true)
  return { ...out, status: out.status || 200 }
}

beforeAll(() => { initDatabase(':memory:') })
beforeEach(() => {
  getDb().exec('DELETE FROM auth_sessions; DELETE FROM dashboard_users')
  _clearSessionCacheForTest()
  ownerId = createDashboardUser('owner', 'x'.repeat(60)).id
  rmSync(AGENTS, { recursive: true, force: true })
  mkdirSync(AGENTS, { recursive: true })
})
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }))

describe('the carriers (plan 4.2, N4; mutant 25)', () => {
  it('the agent export refuses a package agent with what to do instead; a hand-made one exports', async () => {
    makeAgent('pkg', PKG_FILES)
    makeAgent('hand', HAND_FILES)
    const r = await hit('GET', '/api/agents/pkg/export')
    expect(r.status).toBe(409)
    expect(r.body).toMatchObject({ error: 'package_agent_not_exportable' })
    expect(r.body.message).toContain('install the package again from the catalog')
    expect((await hit('GET', '/api/agents/hand/export')).status).toBe(200)
  })

  it('the shell alone (a lost record) still counts as a package agent for the export', () => {
    const d = makeAgent('shell-only', { 'CLAUDE.md': P, 'PACKAGE.md': 'p\n' })
    expect(() => B.stageAgentDirForExport(d, join(tmpRoot, 'stage-x'), false)).toThrow(B.PackageAgentExportError)
  })

  it('the bundle export-all leaves package agents out and names them', async () => {
    makeAgent('pkg', PKG_FILES)
    makeAgent('hand', HAND_FILES)
    const r = await hit('GET', '/api/agents/export-all')
    expect(r.status).toBe(200)
    expect(r.headers['X-Skipped-Package-Agents']).toBe('pkg')
    const out = join(tmpRoot, 'all.tar.gz')
    const m = B.exportAllAgentsBundle(out, ['pkg', 'hand'])
    expect(m.agents).toEqual(['hand'])
    expect(m.skippedPackageAgents).toEqual(['pkg'])
  })

  it('the fleet export leaves package agents out and names them', () => {
    makeAgent('pkg', PKG_FILES)
    makeAgent('hand', HAND_FILES)
    const e = exportFleet()
    expect(e.skippedPackageAgents).toEqual(['pkg'])
    const names = (JSON.parse(e.data).agents as Array<{ name: string }>).map((a) => a.name)
    expect(names).toContain('hand')
    expect(names).not.toContain('pkg')
  })

  it('an imported archive never brings a .package/ folder (agent and fleet bundles)', () => {
    const stage = join(tmpRoot, 'craft')
    rmSync(stage, { recursive: true, force: true })
    mkdirSync(join(stage, 'agent', '.package'), { recursive: true })
    writeFileSync(join(stage, 'manifest.json'), JSON.stringify({ schemaVersion: 1, agentName: 'imported', includesSecrets: false }))
    writeFileSync(join(stage, 'agent', 'CLAUDE.md'), '# imported\n')
    writeFileSync(join(stage, 'agent', '.package', 'manifest.json'), RECORD)
    execFileSync('tar', ['-czf', join(tmpRoot, 'a.tgz'), '-C', stage, 'manifest.json', 'agent'])
    const r = B.importAgentBundle(readFileSync(join(tmpRoot, 'a.tgz')), { resolveDest: (n) => join(AGENTS, n) })
    expect(r.name).toBe('imported')
    expect(existsSync(join(AGENTS, 'imported', 'CLAUDE.md'))).toBe(true)
    expect(existsSync(join(AGENTS, 'imported', '.package'))).toBe(false)

    const fstage = join(tmpRoot, 'fcraft')
    rmSync(fstage, { recursive: true, force: true })
    mkdirSync(join(fstage, 'agents', 'fimported', '.package'), { recursive: true })
    writeFileSync(join(fstage, 'manifest.json'), JSON.stringify({ schemaVersion: 1, kind: 'fleet', agents: ['fimported'], includesSecrets: false }))
    writeFileSync(join(fstage, 'agents', 'fimported', 'CLAUDE.md'), '# f\n')
    writeFileSync(join(fstage, 'agents', 'fimported', '.package', 'manifest.json'), RECORD)
    execFileSync('tar', ['-czf', join(tmpRoot, 'f.tgz'), '-C', fstage, 'manifest.json', 'agents'])
    B.importAllAgentsBundle(readFileSync(join(tmpRoot, 'f.tgz')), { resolveDest: (n) => join(AGENTS, n) })
    expect(existsSync(join(AGENTS, 'fimported', 'CLAUDE.md'))).toBe(true)
    expect(existsSync(join(AGENTS, 'fimported', '.package'))).toBe(false)
  })
})

describe('the CLAUDE.md editor (plan 4.2, 7.5; Dani B1, B2; mutants 25, 44)', () => {
  for (const c of FIXTURE.prefix) {
    it(`${c.name}: ${c.shell ? 'saved, byte for byte' : '409 package_shell_required, nothing written'}`, async () => {
      const d = makeAgent('pkg', PKG_FILES)
      const text = Buffer.from(c.b64, 'base64').toString('utf8')
      // A case whose bytes are not valid UTF-8 cannot travel in a JSON string; every case here is.
      expect(Buffer.from(text, 'utf8').equals(Buffer.from(c.b64, 'base64'))).toBe(true)
      const before = readFileSync(join(d, 'CLAUDE.md'))
      const r = await hit('PUT', '/api/agents/pkg', { claudeMd: text })
      if (c.shell) {
        expect(r.status).toBe(200)
        const saved = readFileSync(join(d, 'CLAUDE.md'))
        // The request's bytes, then (when the save dropped it) the roster block the writer puts back.
        expect(saved.subarray(0, Buffer.byteLength(text)).equals(Buffer.from(text, 'utf8'))).toBe(true)
        expect(M.hasLaunchTrace(saved)).toBe(true)
      } else {
        expect(r).toMatchObject({ status: 409, body: { error: 'package_shell_required' } })
        expect(readFileSync(join(d, 'CLAUDE.md')).equals(before)).toBe(true)
      }
    })
  }

  it('a corrupt but non-empty record: the editor still guards the shell (B2)', async () => {
    makeAgent('pkg', { ...PKG_FILES, '.package/manifest.json': '{not json' })
    expect((await hit('PUT', '/api/agents/pkg', { claudeMd: '# no shell\n' })).status).toBe(409)
  })

  it('a hand-made agent saves any text as before', async () => {
    const d = makeAgent('hand', HAND_FILES)
    expect((await hit('PUT', '/api/agents/hand', { claudeMd: '﻿# BOM and all\r\n' })).status).toBe(200)
    expect(readFileSync(join(d, 'CLAUDE.md'), 'utf8')).toBe('﻿# BOM and all\r\n')
  })

  it('a refused save writes no other field of the same request either', async () => {
    const d = makeAgent('pkg', PKG_FILES)
    const r = await hit('PUT', '/api/agents/pkg', { claudeMd: '# no shell\n', soulMd: 'changed\n' })
    expect(r.status).toBe(409)
    expect(readFileSync(join(d, 'SOUL.md'), 'utf8')).toBe('s\n')
  })
})

describe('the dashboard summary (plan 4.2, M13; mutant 25)', () => {
  it('a package agent: the description from its record, and the package field; a hand-made one: as before', async () => {
    makeAgent('pkg', PKG_FILES)
    makeAgent('hand', HAND_FILES)
    const pkg = await hit('GET', '/api/agents/pkg')
    expect(pkg.body.description).toBe('Keeps the invoices in order.')
    expect(pkg.body.package).toEqual({ slug: 'pkg', version: '1.2.0' })
    const hand = await hit('GET', '/api/agents/hand')
    expect(hand.body.description).toBe('A hand-made agent.')
    expect(hand.body.package).toBeNull()
  })
})
