// Acceptance test for the shared skills directory queue: export (zip), assign
// (cp), quarantine approve and agent-skill delete must run one at a time, so a
// delete or an approval issued while an export's zip child is reading the
// global root takes effect only after the zip ended -- and a failed export must
// not wedge the operation queued behind it.
import { describe, it, expect, afterEach, afterAll, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, readFileSync, mkdtempSync, existsSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable, Writable } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'

const H = vi.hoisted(() => ({ root: '' }))
const tmpRoot = mkdtempSync(join(tmpdir(), 'skills-dir-queue-'))
H.root = tmpRoot
const fakeHome = join(tmpRoot, 'home')
const realHome = process.env.HOME
process.env.HOME = fakeHome
const bin = join(tmpRoot, 'bin')
const log = join(tmpRoot, 'tool.log')

vi.mock('../config.js', async (orig) => ({
  ...(await orig<typeof import('../config.js')>()),
  PROJECT_ROOT: tmpRoot, STORE_DIR: join(tmpRoot, 'store'), MAIN_AGENT_ID: 'host-main',
}))
vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>()
  const homedir = () => `${H.root}/home`
  return { ...actual, homedir, default: { ...actual, homedir } }
})
vi.mock('../web/agent-config.js', async (orig) => ({
  ...(await orig<typeof import('../web/agent-config.js')>()),
  listAgentNames: () => ['a1'],
}))
// The fleet import itself is not under test here: a stand-in writes one global
// skill synchronously, the way the real import writes them.
vi.mock('../web/fleet-transfer.js', () => ({
  MIN_VAULT_PASSWORD_LEN: 12,
  UserFacingError: class UserFacingError extends Error {},
  exportFleet: () => { throw new Error('exportFleet is not used in this test') },
  importFleet: () => {
    const dir = join(`${H.root}/home`, '.claude', 'skills', 's5')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '# s5\n')
    return { applied: true }
  },
}))

mkdirSync(bin, { recursive: true })
// The route runs zip with cwd = the global skills root, so PROBE_SKILL=s1
// probes <root>/s1/SKILL.md at the moment the zip ends.
writeFileSync(join(bin, 'zip'), `#!/bin/sh
printf 'zip start\n' >> "$TOOL_LOG"
if [ -n "$FAKE_SLEEP" ]; then sleep "$FAKE_SLEEP"; fi
if [ -f "$PROBE_SKILL/SKILL.md" ]; then printf 'zip end saw=yes\n' >> "$TOOL_LOG"; else printf 'zip end saw=no\n' >> "$TOOL_LOG"; fi
if [ -n "$FAKE_FAIL" ]; then echo "zip failed" >&2; exit 12; fi
printf 'ZIPDATA' > "$2"
exit 0
`)
chmodSync(join(bin, 'zip'), 0o755)
writeFileSync(log, '')
const origPath = process.env.PATH
process.env.PATH = `${bin}:${origPath}`
process.env.TOOL_LOG = log

const { tryHandleSkills } = await import('../web/routes/skills.js')
const { tryHandleAgentsSkills } = await import('../web/routes/agents-skills.js')
const q = await import('../web/skill-quarantine.js')
const { tryHandleFleet } = await import('../web/routes/fleet.js')

afterEach(() => {
  delete process.env.FAKE_SLEEP
  delete process.env.FAKE_FAIL
  delete process.env.PROBE_SKILL
  writeFileSync(log, '')
})
afterAll(() => {
  process.env.PATH = origPath
  process.env.HOME = realHome
  delete process.env.TOOL_LOG
  rmSync(tmpRoot, { recursive: true, force: true })
})

function makeRes() {
  const chunks: Buffer[] = []
  const res = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb() } }) as any
  res.statusCode = 200
  res.headers = {} as Record<string, unknown>
  res.setHeader = (k: string, v: unknown) => { res.headers[k.toLowerCase()] = v }
  res.writeHead = (s: number, h?: Record<string, unknown>) => { res.statusCode = s; for (const [k, v] of Object.entries(h ?? {})) res.headers[k.toLowerCase()] = v; return res }
  const done = new Promise<void>((r) => res.on('finish', () => r()))
  return { res, chunks, done }
}

async function call(handler: typeof tryHandleSkills, method: string, path: string, body?: unknown, auth?: import('../web/routes/types.js').RouteContext['auth']) {
  const { res, chunks, done } = makeRes()
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { headers: {} })
  const url = new URL('http://localhost' + path)
  await handler({ req, res, path: url.pathname, method, url, auth } as any)
  await done
  return { status: res.statusCode as number, body: Buffer.concat(chunks) }
}

const SESSION = { kind: 'session', user: 'owner' } as const

function makeSkill(name: string) {
  const dir = join(fakeHome, '.claude', 'skills', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `# ${name}\n`)
}

function readLog(): string[] {
  return readFileSync(log, 'utf8').split('\n').filter(Boolean)
}

async function waitForLog(line: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (readLog().some((l) => l === line)) return
    await sleep(20)
  }
  throw new Error(`timed out waiting for tool log line "${line}"; log was: ${JSON.stringify(readLog())}`)
}

describe('skill directory operations run one at a time', () => {
  it('a delete of a global skill issued while the export zips takes effect after the zip ended', async () => {
    makeSkill('s1')
    process.env.FAKE_SLEEP = '1'
    process.env.PROBE_SKILL = 's1'
    const exp = call(tryHandleSkills, 'GET', '/api/skills/export')
    await waitForLog('zip start')
    const del = call(tryHandleAgentsSkills, 'DELETE', '/api/agents/host-main/skills/s1')
    const [e, d] = await Promise.all([exp, del])
    expect(e.status).toBe(200)
    expect(e.body.toString()).toBe('ZIPDATA')
    expect(d.status).toBe(200)
    expect(readLog()).toContain('zip end saw=yes')
    expect(existsSync(join(fakeHome, '.claude', 'skills', 's1'))).toBe(false)
  })

  it('an approval issued while the export zips installs after the zip ended', async () => {
    makeSkill('s0')
    const meta = q.queueGeneratedSkill({ scope: 'global' }, 's2', '---\nname: s2\ndescription: x\n---\n# s2\n')
    const hash = JSON.parse((await call(tryHandleSkills, 'GET', `/api/skills/pending/${meta.id}`)).body.toString()).hash
    process.env.FAKE_SLEEP = '1'
    process.env.PROBE_SKILL = 's2'
    const exp = call(tryHandleSkills, 'GET', '/api/skills/export')
    await waitForLog('zip start')
    const ap = call(tryHandleSkills, 'POST', `/api/skills/pending/${meta.id}/approve`, { hash }, SESSION)
    const [e, a] = await Promise.all([exp, ap])
    expect(e.status).toBe(200)
    expect(a.status).toBe(200)
    expect(readLog()).toContain('zip end saw=no')
    expect(existsSync(join(fakeHome, '.claude', 'skills', 's2', 'SKILL.md'))).toBe(true)
  })

  it('a delete queued behind an approval of the same skill sees it installed', async () => {
    makeSkill('s0')
    const meta = q.queueGeneratedSkill({ scope: 'global' }, 's4', '---\nname: s4\ndescription: x\n---\n# s4\n')
    const hash = JSON.parse((await call(tryHandleSkills, 'GET', `/api/skills/pending/${meta.id}`)).body.toString()).hash
    process.env.FAKE_SLEEP = '1'
    const exp = call(tryHandleSkills, 'GET', '/api/skills/export')
    await waitForLog('zip start')
    const ap = call(tryHandleSkills, 'POST', `/api/skills/pending/${meta.id}/approve`, { hash }, SESSION)
    // The approval reads its body before it queues; the delete must queue after it, while zip still holds the queue.
    await sleep(200)
    expect(readLog().some((l) => l.startsWith('zip end'))).toBe(false)
    const del = call(tryHandleAgentsSkills, 'DELETE', '/api/agents/host-main/skills/s4')
    const [, a, d] = await Promise.all([exp, ap, del])
    expect(a.status).toBe(200)
    expect(d.status).toBe(200)
    expect(existsSync(join(fakeHome, '.claude', 'skills', 's4'))).toBe(false)
  })

  it('a failed export does not wedge the delete queued behind it', async () => {
    makeSkill('s3')
    process.env.FAKE_SLEEP = '0.5'
    process.env.FAKE_FAIL = '1'
    const exp = call(tryHandleSkills, 'GET', '/api/skills/export')
    await waitForLog('zip start')
    const del = call(tryHandleAgentsSkills, 'DELETE', '/api/agents/host-main/skills/s3')
    const [e, d] = await Promise.all([exp, del])
    expect(e.status).toBe(500)
    expect(JSON.parse(e.body.toString())).toEqual({ error: 'Export failed' })
    expect(d.status).toBe(200)
    expect(existsSync(join(fakeHome, '.claude', 'skills', 's3'))).toBe(false)
  })

  it('a delete of a missing skill is still 404', async () => {
    const r = await call(tryHandleAgentsSkills, 'DELETE', '/api/agents/host-main/skills/nope')
    expect(r.status).toBe(404)
    expect(JSON.parse(r.body.toString())).toEqual({ error: 'Skill not found' })
  })

  it('a fleet import issued while the export zips writes its skills after the zip ended', async () => {
    process.env.FAKE_SLEEP = '1'
    process.env.PROBE_SKILL = 's5'
    const exp = call(tryHandleSkills, 'GET', '/api/skills/export')
    await waitForLog('zip start')
    const imp = call(tryHandleFleet, 'POST', '/api/fleet/import?apply=true', {})
    const [e, i] = await Promise.all([exp, imp])
    expect(e.status).toBe(200)
    expect(i.status).toBe(200)
    expect(readLog()).toContain('zip end saw=no')
    expect(existsSync(join(fakeHome, '.claude', 'skills', 's5', 'SKILL.md'))).toBe(true)
  })
})
