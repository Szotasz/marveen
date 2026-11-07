// HOSTINGERDOCKER1107: in the container (MARVEEN_DEPLOYMENT=docker in .env, written by docker/first-boot.sh) the image
// owns the code and the claude CLI version: the dashboard runs no update.sh and installs no CLI, update.sh refuses,
// channels.sh neither self-heals nor updates claude, and the Updates page says how to update instead.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const env: Record<string, string> = {}
vi.mock('../env.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../env.js')>()),
  readEnvFile: (keys?: string[]) => (keys ? Object.fromEntries(keys.filter((k) => k in env).map((k) => [k, env[k]!])) : { ...env }),
}))

const { deployment, MANAGED_BY_IMAGE } = await import('../web/deployment.js')
const { tryHandleUpdates } = await import('../web/routes/updates.js')
const ROOT = join(__dirname, '..', '..')
const src = (p: string) => readFileSync(join(ROOT, p), 'utf8')

function fakeCtx(path: string, method: string, body = '') {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res = { writeHead(status: number) { out.status = status; return res }, end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) }, setHeader() { /* noop */ } }
  const req = new EventEmitter() as any
  setTimeout(() => { if (body) req.emit('data', Buffer.from(body)); req.emit('end') }, 1)
  const url = new URL(`http://localhost:3420${path}`)
  return { ctx: { req, res, path: url.pathname, method, url } as any, out }
}

beforeEach(() => { for (const k of Object.keys(env)) delete env[k] })

describe('deployment()', () => {
  it('docker only for the exact value; anything else is a native install', () => {
    expect(deployment(() => ({ MARVEEN_DEPLOYMENT: 'docker' }))).toBe('docker')
    for (const v of [{}, { MARVEEN_DEPLOYMENT: '' }, { MARVEEN_DEPLOYMENT: 'Docker' }, { MARVEEN_DEPLOYMENT: 'docker ' }]) {
      expect(deployment(() => v as Record<string, string>), JSON.stringify(v)).toBe('native')
    }
  })
})

describe('the update routes in the container', () => {
  it('POST /api/updates/apply and /api/updates/cli/apply: 409 managed-by-image, before anything runs', async () => {
    env.MARVEEN_DEPLOYMENT = 'docker'
    for (const path of ['/api/updates/apply', '/api/updates/cli/apply']) {
      const c = fakeCtx(path, 'POST', JSON.stringify({ target: '2.1.311', autoStash: true }))
      expect(await tryHandleUpdates(c.ctx)).toBe(true)
      expect(c.out.status, path).toBe(409)
      expect(c.out.body).toEqual(MANAGED_BY_IMAGE)
    }
  })

  it('GET /api/updates names the deployment, in both modes', async () => {
    env.MARVEEN_DEPLOYMENT = 'docker'
    const d = fakeCtx('/api/updates', 'GET')
    await tryHandleUpdates(d.ctx)
    expect(d.out.body.deployment).toBe('docker')
    delete env.MARVEEN_DEPLOYMENT
    const n = fakeCtx('/api/updates', 'GET')
    await tryHandleUpdates(n.ctx)
    expect(n.out.body.deployment).toBe('native')
  })
})

describe('the scripts and the page', () => {
  it('channels.sh: in Docker mode no self-heal install and no daily update, decided before either', () => {
    const ch = src('scripts/channels.sh')
    const gate = ch.indexOf('if marveen_in_docker; then')
    const heal = ch.indexOf('claude_install "binary missing -- self-heal"')
    expect(gate).toBeGreaterThan(-1)
    expect(heal).toBeGreaterThan(gate)
    expect(ch).toContain("grep -qx 'MARVEEN_DEPLOYMENT=docker' \"$INSTALL_DIR/.env\"")
    // the branch sets neither daily check
    const branch = ch.slice(gate, ch.indexOf('elif ! command -v claude', gate))
    expect(branch).not.toMatch(/DAILY_CLAUDE_CHECK=|claude_install|claude_native_update/)
  })

  it('update.sh refuses in Docker mode before any git step', () => {
    const up = src('update.sh')
    const guard = up.indexOf("grep -qx 'MARVEEN_DEPLOYMENT=docker' \"$INSTALL_DIR/.env\"")
    expect(guard).toBeGreaterThan(-1)
    expect(up.indexOf('git fetch')).toBeGreaterThan(guard)
    expect(up.slice(guard, guard + 400)).toContain('exit 3')
  })

  it('the Updates page says how to update, and hides the apply button and the CLI box', () => {
    const app = src('web/app.js')
    expect(app).toContain("if (data.deployment === 'docker') {")
    expect(app).toContain("summary.textContent = t('updates.docker_managed')")
    expect(app).toContain("if (d.deployment === 'docker') { box.hidden = true; return }")
    for (const lang of ['hu', 'en']) expect(src(`web/lang/${lang}.js`)).toContain("'updates.docker_managed':")
  })
})
