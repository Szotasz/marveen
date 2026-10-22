// Acceptance test: the zip / cp calls in the skills routes must run off the
// event loop, as an argv (no shell), with stdin closed.
import { describe, it, expect, afterEach, afterAll, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, readFileSync, mkdtempSync, existsSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable, Writable } from 'node:stream'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'

const H = vi.hoisted(() => ({ root: '' }))
const tmpRoot = mkdtempSync(join(tmpdir(), 'skills-cli-'))
H.root = tmpRoot
const fakeHome = join(tmpRoot, 'home')
const bin = join(tmpRoot, 'bin')
const log = join(tmpRoot, 'tool.log')

vi.mock('../config.js', async (orig) => ({ ...(await orig<typeof import('../config.js')>()), PROJECT_ROOT: tmpRoot }))
vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>()
  const homedir = () => `${H.root}/home`
  return { ...actual, homedir, default: { ...actual, homedir } }
})
vi.mock('../web/agent-config.js', async (orig) => ({
  ...(await orig<typeof import('../web/agent-config.js')>()),
  listAgentNames: () => ['a1', 'a2'],
}))

mkdirSync(bin, { recursive: true })
writeFileSync(join(bin, 'zip'), `#!/bin/sh
{ printf 'zip cwd=%s\\n' "$(pwd)"; for a in "$@"; do printf 'arg=%s\\n' "$a"; done; printf 'zip end-args\\n'; } >> "$TOOL_LOG"
if [ -n "$FAKE_READ_STDIN" ]; then cat > /dev/null; fi
if [ -n "$FAKE_SLEEP" ]; then sleep "$FAKE_SLEEP"; fi
if [ -n "$FAKE_FAIL" ]; then echo "zip failed" >&2; exit 12; fi
printf 'ZIPDATA' > "$2"
exit 0
`)
writeFileSync(join(bin, 'cp'), `#!/bin/sh
{ printf 'cp start\\n'; for a in "$@"; do printf 'arg=%s\\n' "$a"; done; } >> "$TOOL_LOG"
if [ -n "$FAKE_SLEEP" ]; then sleep "$FAKE_SLEEP"; fi
if [ -n "$FAKE_CP_FAIL" ]; then printf 'cp end\\n' >> "$TOOL_LOG"; echo "cp failed" >&2; exit 1; fi
/bin/cp "$@"; rc=$?; printf 'cp end\\n' >> "$TOOL_LOG"; exit $rc
`)
chmodSync(join(bin, 'zip'), 0o755)
chmodSync(join(bin, 'cp'), 0o755)
writeFileSync(log, '')
const origPath = process.env.PATH
process.env.PATH = `${bin}:${origPath}`
process.env.TOOL_LOG = log

const { tryHandleSkills } = await import('../web/routes/skills.js')

afterEach(() => {
  delete process.env.FAKE_SLEEP
  delete process.env.FAKE_FAIL
  delete process.env.FAKE_CP_FAIL
  delete process.env.FAKE_READ_STDIN
  writeFileSync(log, '')
})
afterAll(() => {
  process.env.PATH = origPath
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

async function call(method: string, path: string, body?: unknown) {
  const { res, chunks, done } = makeRes()
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { headers: {} })
  const url = new URL('http://localhost' + path)
  await tryHandleSkills({ req, res, path: url.pathname, method, url } as any)
  await done
  return { status: res.statusCode as number, headers: res.headers as Record<string, unknown>, body: Buffer.concat(chunks) }
}

// A stall that starts right at enable() goes unseen, so the meter gets a few samples in first.
async function stallDuring(fn: () => Promise<unknown>): Promise<number> {
  const h = monitorEventLoopDelay({ resolution: 10 })
  h.enable()
  try { await sleep(30); await fn(); await sleep(50) } finally { h.disable() }
  return h.max / 1e6
}
const STALL_MAX_MS = 750

function makeSkill(name: string) {
  const dir = join(fakeHome, '.claude', 'skills', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `# ${name}\n`)
}

describe('skills routes run zip/cp asynchronously', () => {
  it('instrument positive control: a synchronous busy-wait is measured', async () => {
    const stall = await stallDuring(async () => { const t = Date.now(); while (Date.now() - t < 300) { /* spin */ } })
    expect(stall).toBeGreaterThanOrEqual(250)
  })

  it('export streams the zip with the same args, cleans up, and does not stall', async () => {
    makeSkill('s1')
    process.env.FAKE_SLEEP = '1.5'
    let r!: Awaited<ReturnType<typeof call>>
    const stall = await stallDuring(async () => { r = await call('GET', '/api/skills/export') })
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toBe('application/zip')
    expect(r.body.toString()).toBe('ZIPDATA')
    const lines = readFileSync(log, 'utf8').split('\n')
    const end = lines.indexOf('zip end-args')
    expect(lines.slice(0, end + 1).filter((l) => l.startsWith('zip cwd='))).toEqual([`zip cwd=${join(fakeHome, '.claude', 'skills')}`])
    const tmpZip = lines[2].slice('arg='.length)
    expect(tmpZip).toMatch(/skills-export-[0-9a-f-]+\.zip$/)
    expect(lines.slice(1, end)).toEqual(['arg=-r', `arg=${tmpZip}`, 'arg=.', 'arg=--include', 'arg=*/SKILL.md', 'arg=--include', 'arg=*/references/*'])
    await sleep(50)
    expect(existsSync(tmpZip)).toBe(false)
    expect(stall).toBeLessThan(STALL_MAX_MS)
  })

  it('export failure returns 500', async () => {
    makeSkill('s1')
    process.env.FAKE_FAIL = '1'
    const r = await call('GET', '/api/skills/export')
    expect(r.status).toBe(500)
    expect(JSON.parse(r.body.toString())).toEqual({ error: 'Export failed' })
  })

  it('export closes stdin', async () => {
    makeSkill('s1')
    process.env.FAKE_READ_STDIN = '1'
    const winner = await Promise.race([call('GET', '/api/skills/export'), sleep(5000).then(() => 'timeout' as const)])
    expect(winner).not.toBe('timeout')
    expect((winner as Awaited<ReturnType<typeof call>>).status).toBe(200)
  })

  it('assign copies with cp -r and does not stall', async () => {
    makeSkill('s2')
    const stale = join(tmpRoot, 'agents', 'a2', '.claude', 'skills', 's2')
    mkdirSync(stale, { recursive: true })
    writeFileSync(join(stale, 'SKILL.md'), 'stale')
    process.env.FAKE_SLEEP = '1.5'
    let r!: Awaited<ReturnType<typeof call>>
    const stall = await stallDuring(async () => { r = await call('POST', '/api/skills/s2/assign', { agents: ['a1'] }) })
    expect(r.status).toBe(200)
    expect(JSON.parse(r.body.toString())).toEqual({ ok: true })
    const dest = join(tmpRoot, 'agents', 'a1', '.claude', 'skills', 's2')
    expect(readFileSync(join(dest, 'SKILL.md'), 'utf8')).toBe('# s2\n')
    expect(existsSync(stale)).toBe(false)
    const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean)
    expect(lines).toEqual(['cp start', 'arg=-r', `arg=${join(fakeHome, '.claude', 'skills', 's2')}`, `arg=${join(tmpRoot, 'agents', 'a1', '.claude', 'skills', 's2')}`, 'cp end'])
    expect(stall).toBeLessThan(STALL_MAX_MS)
  })

  it('assign replaces an existing copy', async () => {
    makeSkill('s3')
    const dest = join(tmpRoot, 'agents', 'a1', '.claude', 'skills', 's3')
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dest, 'old.txt'), 'old')
    const r = await call('POST', '/api/skills/s3/assign', { agents: ['a1'] })
    expect(r.status).toBe(200)
    expect(existsSync(join(dest, 'SKILL.md'))).toBe(true)
    expect(existsSync(join(dest, 'old.txt'))).toBe(false)
  })

  it('overlapping assigns run one after the other and end in a state a serial order gives', async () => {
    makeSkill('s4')
    process.env.FAKE_SLEEP = '1'
    const [a, b] = await Promise.all([
      call('POST', '/api/skills/s4/assign', { agents: ['a1'] }),
      call('POST', '/api/skills/s4/assign', { agents: ['a2'] }),
    ])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    const has = (agent: string) => existsSync(join(tmpRoot, 'agents', agent, '.claude', 'skills', 's4', 'SKILL.md'))
    expect([has('a1'), has('a2')].filter(Boolean)).toHaveLength(1)
    let open = 0, worst = 0
    for (const l of readFileSync(log, 'utf-8').split('\n')) {
      if (l === 'cp start') worst = Math.max(worst, ++open)
      else if (l === 'cp end') open--
    }
    expect(worst).toBe(1)
  })

  it('a double submit of the same assign leaves one copy, not a nested one', async () => {
    makeSkill('s5')
    process.env.FAKE_SLEEP = '1'
    await Promise.all([
      call('POST', '/api/skills/s5/assign', { agents: ['a1'] }),
      call('POST', '/api/skills/s5/assign', { agents: ['a1'] }),
    ])
    expect(existsSync(join(tmpRoot, 'agents', 'a1', '.claude', 'skills', 's5', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(tmpRoot, 'agents', 'a1', '.claude', 'skills', 's5', 's5'))).toBe(false)
  })

  it('a failed assign does not wedge the ones after it', async () => {
    makeSkill('s6')
    process.env.FAKE_CP_FAIL = '1'
    await expect(call('POST', '/api/skills/s6/assign', { agents: ['a1'] })).rejects.toThrow()
    delete process.env.FAKE_CP_FAIL
    const r = await call('POST', '/api/skills/s6/assign', { agents: ['a1'] })
    expect(r.status).toBe(200)
    expect(existsSync(join(tmpRoot, 'agents', 'a1', '.claude', 'skills', 's6', 'SKILL.md'))).toBe(true)
  })
})
