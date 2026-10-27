// The vault resolver scripts wait for the dashboard at most a bounded time, and that time fits inside a
// scheduled task's preCheck limit (PRECHECK_TIMEOUT_MS): a preCheck that resolves a secret through the dashboard
// must get its own answer (the audit-mode local fallback, or the enforce-mode exit 5) before the runner kills it.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PRECHECK_TIMEOUT_MS } from '../web/schedule-runner.js'

const ROOT = mkdtempSync(join(tmpdir(), 'vault-resolve-budget-test-'))
let server: Server
let serverUrl = ''
let delayMs = 0
let requests = 0

type Res = { code: number; stdout: string; stderr: string; ms: number }

function resolveRun(stdin: string, env: Record<string, string> = {}): Promise<Res> {
  const t0 = Date.now()
  return new Promise(resolve => {
    const child = execFile(
      process.execPath,
      [join(ROOT, 'scripts', 'vault-resolve.mjs')],
      { env: { PATH: process.env.PATH || '', HOME: join(ROOT, 'home'), VAULT_RESOLVE_URL: serverUrl, MARVEEN_AGENT_ID: 'zz-agent', ...env } },
      (error, stdout, stderr) => {
        const code = error && typeof (error as unknown as { code?: number }).code === 'number' ? (error as unknown as { code: number }).code : error ? 1 : 0
        resolve({ code, stdout, stderr, ms: Date.now() - t0 })
      },
    )
    child.stdin?.end(stdin)
  })
}

beforeAll(async () => {
  mkdirSync(join(ROOT, 'scripts'), { recursive: true })
  mkdirSync(join(ROOT, 'dist', 'web'), { recursive: true })
  mkdirSync(join(ROOT, 'store'), { recursive: true })
  mkdirSync(join(ROOT, 'home'), { recursive: true })
  for (const f of ['vault-resolve.mjs', 'vault-dashboard-client.mjs']) {
    copyFileSync(join(process.cwd(), 'scripts', f), join(ROOT, 'scripts', f))
  }
  writeFileSync(join(ROOT, 'package.json'), '{ "type": "module" }\n')
  writeFileSync(join(ROOT, 'dist', 'web', 'vault.js'), `export function getSecret(id) { return 'local-' + id }\n`)
  writeFileSync(join(ROOT, 'store', '.dashboard-token'), 'tok-x')
  server = createServer((req, res) => {
    let data = ''
    req.on('data', c => { data += c })
    req.on('end', () => {
      requests++
      const ids: string[] = data ? JSON.parse(data).ids : []
      const values: Record<string, string> = {}
      for (const id of ids) values[id] = 'dash-' + id
      setTimeout(() => {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ values, missing: [], refused: [] }))
      }, delayMs)
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/vault/resolve`
})

beforeEach(() => { delayMs = 0; requests = 0 })

afterAll(async () => {
  server.closeAllConnections?.()
  await new Promise<void>(r => server.close(() => r()))
  rmSync(ROOT, { recursive: true, force: true })
})

describe('vault resolve wait budget', () => {
  it('B1 the default wait leaves room inside the preCheck limit', async () => {
    const mod = await import(join(process.cwd(), 'scripts', 'vault-dashboard-client.mjs'))
    expect(Number.isFinite(mod.VAULT_RESOLVE_DEFAULT_TIMEOUT_MS)).toBe(true)
    // the fallback after the wait (local vault import, decrypt) and the node start need the other half
    expect(mod.VAULT_RESOLVE_DEFAULT_TIMEOUT_MS).toBeLessThanOrEqual(PRECHECK_TIMEOUT_MS / 2)
  })

  it('B2 audit mode, dashboard slower than the budget: warns "timeout" and resolves locally', async () => {
    delayMs = 2000
    const r = await resolveRun('X=A\n', { VAULT_RESOLVE_TIMEOUT_MS: '300' })
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('X=local-A\n')
    expect(r.stderr).toContain('timeout')
    expect(r.ms).toBeLessThan(1800)
  })

  it('B3 enforce mode, dashboard slower than the budget: exit 5 within the budget, nothing resolved', async () => {
    delayMs = 2000
    const r = await resolveRun('X=A\n', { VAULT_RESOLVE_TIMEOUT_MS: '300', VAULT_ACL_MODE: 'enforce' })
    expect(r.code).toBe(5)
    expect(r.stdout).toBe('')
    expect(r.ms).toBeLessThan(1800)
  })

  it('B4 the budget is shared by all batches (250 ids = 3 batches), not given to each', async () => {
    delayMs = 400
    const ids = Array.from({ length: 250 }, (_, i) => `id${i}`)
    const stdin = ids.map((id, i) => `E${i}=${id}`).join('\n') + '\n'
    // 3 x 400 ms = 1200 ms of waiting against a 900 ms budget: the call as a whole must time out
    const r = await resolveRun(stdin, { VAULT_RESOLVE_TIMEOUT_MS: '900', VAULT_ACL_MODE: 'enforce' })
    expect(r.code).toBe(5)
    expect(r.stderr).toContain('timeout')
  })

  it('B5 control: the same 3 batches pass when the budget covers them', async () => {
    delayMs = 400
    const ids = Array.from({ length: 250 }, (_, i) => `id${i}`)
    const stdin = ids.map((id, i) => `E${i}=${id}`).join('\n') + '\n'
    const r = await resolveRun(stdin, { VAULT_RESOLVE_TIMEOUT_MS: '5000', VAULT_ACL_MODE: 'enforce' })
    expect(r.code).toBe(0)
    expect(requests).toBe(3)
    expect(r.stdout.split('\n')[0]).toBe('E0=dash-id0')
  })

  it('B6 a malformed VAULT_RESOLVE_TIMEOUT_MS falls back to the default (no hang, no zero wait)', async () => {
    for (const bad of ['abc', '0', '-5', '']) {
      const r = await resolveRun('X=A\n', { VAULT_RESOLVE_TIMEOUT_MS: bad })
      expect(r.code, `value ${JSON.stringify(bad)}`).toBe(0)
      expect(r.stdout, `value ${JSON.stringify(bad)}`).toBe('X=dash-A\n')
    }
  })
})
