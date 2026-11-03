// The two vault resolver scripts ask the dashboard (POST /api/vault/resolve) first and fall back to the
// local vault module only as decided: silently without a token, with a WARNING in audit mode, never in enforce mode.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, existsSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseEnvContent } from '../env-parse.js'

const ROOT = mkdtempSync(join(tmpdir(), 'vault-resolve-dashboard-test-'))
const TOKEN_FILE = join(ROOT, 'store', '.dashboard-token')
const IMPORT_LOG = join(ROOT, 'stub-imported.log')

type Req = { headers: Record<string, string | string[] | undefined>; body: any }
let server: Server
let serverUrl = ''
let deadUrl = ''
let requests: Req[] = []
let answer: unknown = { values: {}, missing: [], refused: [] }
const outputs: string[] = []

type Res = { code: number; stdout: string; stderr: string }

function run(script: string, args: string[], opts: { stdin?: string; env?: Record<string, string> } = {}): Promise<Res> {
  return new Promise(resolve => {
    const child = execFile(
      process.execPath,
      [join(ROOT, 'scripts', script), ...args],
      { env: { PATH: process.env.PATH || '', HOME: join(ROOT, 'home'), VAULT_RESOLVE_URL: serverUrl, MARVEEN_AGENT_ID: 'zz-agent', ...opts.env } },
      (error, stdout, stderr) => {
        const code = error && typeof (error as unknown as { code?: number }).code === 'number' ? (error as unknown as { code: number }).code : error ? 1 : 0
        outputs.push(stdout, stderr)
        resolve({ code, stdout, stderr })
      },
    )
    child.stdin?.end(opts.stdin ?? '')
  })
}
const resolveRun = (stdin: string, env?: Record<string, string>) => run('vault-resolve.mjs', [], { stdin, env })
const headersRun = (env?: Record<string, string>) => run('vault-headers-helper.mjs', ['Authorization=Bearer:::A'], { env })

beforeAll(async () => {
  mkdirSync(join(ROOT, 'scripts'), { recursive: true })
  mkdirSync(join(ROOT, 'dist', 'web'), { recursive: true })
  mkdirSync(join(ROOT, 'store'), { recursive: true })
  mkdirSync(join(ROOT, 'home'), { recursive: true })
  for (const f of ['vault-resolve.mjs', 'vault-headers-helper.mjs', 'vault-dashboard-client.mjs']) {
    copyFileSync(join(process.cwd(), 'scripts', f), join(ROOT, 'scripts', f))
  }
  writeFileSync(join(ROOT, 'package.json'), '{ "type": "module" }\n')
  writeFileSync(join(ROOT, 'dist', 'web', 'vault.js'),
    `import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(IMPORT_LOG)}, 'imported\\n')
export function getSecret(id) { return id === 'nope' ? null : 'local-' + id }
`)
  server = createServer((req, res) => {
    let data = ''
    req.on('data', c => { data += c })
    req.on('end', () => {
      requests.push({ headers: req.headers, body: data ? JSON.parse(data) : null })
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(answer))
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/vault/resolve`
  // a port nothing listens on: bind, read the port, close
  const tmp = createServer()
  await new Promise<void>(r => tmp.listen(0, '127.0.0.1', () => r()))
  deadUrl = `http://127.0.0.1:${(tmp.address() as AddressInfo).port}/api/vault/resolve`
  await new Promise<void>(r => tmp.close(() => r()))
})

beforeEach(() => {
  requests = []
  answer = { values: {}, missing: [], refused: [] }
  writeFileSync(TOKEN_FILE, 'tok-x')
  rmSync(IMPORT_LOG, { force: true })
  rmSync(join(ROOT, '.env'), { force: true })
  rmSync(join(ROOT, 'store', 'config-overrides.json'), { force: true })
})

afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()))
  rmSync(ROOT, { recursive: true, force: true })
})

describe('vault-resolve via the dashboard', () => {
  it('S1 resolves through the dashboard without loading the local vault', async () => {
    answer = { values: { A: 'dash-A' }, missing: [], refused: [] }
    const r = await resolveRun('X=A\n')
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('X=dash-A\n')
    expect(requests).toHaveLength(1)
    expect(requests[0].headers.authorization).toBe('Bearer tok-x')
    expect(requests[0].headers['x-agent-id']).toBe('zz-agent')
    expect(requests[0].body).toEqual({ ids: ['A'] })
    expect(existsSync(IMPORT_LOG)).toBe(false)
  })

  it('S2 an acl refusal exits 4', async () => {
    answer = { values: {}, missing: [], refused: [{ id: 'A', reason: 'acl' }] }
    const r = await resolveRun('X=A\n')
    expect(r.code).toBe(4)
    expect(r.stderr).toContain('refused by the vault allowlist')
  })

  it('S3 a missing id exits 3', async () => {
    answer = { values: {}, missing: ['A'], refused: [] }
    expect((await resolveRun('X=A\n')).code).toBe(3)
  })

  it('S4 audit mode, server closed: warns and resolves locally', async () => {
    const r = await resolveRun('X=A\n', { VAULT_RESOLVE_URL: deadUrl })
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('X=local-A\n')
    expect(r.stderr).toContain('WARNING')
  })

  it('S5 enforce mode, server closed: exit 5, nothing resolved', async () => {
    const r = await resolveRun('X=A\n', { VAULT_RESOLVE_URL: deadUrl, VAULT_ACL_MODE: 'enforce' })
    expect(r.code).toBe(5)
    expect(r.stdout).toBe('')
    expect(existsSync(IMPORT_LOG)).toBe(false)
  })

  it('S6 no token file: silent local path', async () => {
    rmSync(TOKEN_FILE)
    const r = await resolveRun('X=A\n')
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('X=local-A\n')
    expect(r.stderr).toBe('')
    expect(requests).toHaveLength(0)
  })

  it('S9 VAULT_ACL_MODE is read from <root>/.env', async () => {
    writeFileSync(join(ROOT, '.env'), 'VAULT_ACL_MODE=enforce\n')
    const r = await resolveRun('X=A\n', { VAULT_RESOLVE_URL: deadUrl })
    expect(r.code).toBe(5)
  })
})

describe('token file problems', () => {
  it('S16 a two-line token is malformed: audit warns without the token, enforce exits 5', async () => {
    writeFileSync(TOKEN_FILE, 'tok-x\nsecond')
    const audit = await resolveRun('X=A\n')
    expect(audit.code).toBe(0)
    expect(audit.stderr).toContain('malformed dashboard token')
    expect(audit.stderr).not.toContain('tok-x')
    const enforce = await resolveRun('X=A\n', { VAULT_ACL_MODE: 'enforce' })
    expect(enforce.code).toBe(5)
    expect(enforce.stderr).not.toContain('tok-x')
    expect(requests).toHaveLength(0)
  })
  it('S17 an empty token file warns in audit and resolves locally', async () => {
    writeFileSync(TOKEN_FILE, '')
    const r = await resolveRun('X=A\n')
    expect(r.stderr).toContain('WARNING')
    expect(r.stderr).toContain('empty dashboard token')
    expect(r.stdout).toBe('X=local-A\n')
  })
  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)('S18 an unreadable token file is reported', async () => {
    chmodSync(TOKEN_FILE, 0o000)
    try {
      const r = await resolveRun('X=A\n')
      expect(r.stderr).toContain('unreadable dashboard token')
    } finally {
      chmodSync(TOKEN_FILE, 0o600)
    }
  })
  it('S19 with no token file a 201-character id is resolved locally', async () => {
    rmSync(TOKEN_FILE)
    const id = 'a'.repeat(201)
    const r = await resolveRun(`X=${id}\n`)
    expect(r.code).toBe(0)
    expect(r.stdout).toBe(`X=local-${id}\n`)
  })
})

describe('envFileSetting matches the server grammar', () => {
  const contents = [
    'VAULT_ACL_MODE=audit\nVAULT_ACL_MODE=enforce\n', 'export VAULT_ACL_MODE=enforce\n', 'VAULT_ACL_MODE=enforce # strict\n',
    'VAULT_ACL_MODE = enforce\n', 'VAULT_ACL_MODE="enforce" # strict\n', 'VAULT_ACL_MODE="enforce"\n', "VAULT_ACL_MODE='enforce'\n",
    '#VAULT_ACL_MODE=enforce\n', 'VAULT_ACL_MODE="\n', 'VAULT_ACL_MODE=enforce\r\n', 'VAULT_ACL_MODE=a=b\n', 'OTHER=1\n', '',
  ]
  it.each(contents.map(c => [c]))('S20 %j equals parseEnvContent', async (content) => {
    writeFileSync(join(ROOT, '.env'), content)
    const mod = await import(join(process.cwd(), 'scripts', 'vault-dashboard-client.mjs'))
    expect(mod.envFileSetting(ROOT, 'VAULT_ACL_MODE')).toBe(parseEnvContent(content, ['VAULT_ACL_MODE']).VAULT_ACL_MODE ?? '')
  })
  it.each([
    ['VAULT_ACL_MODE = enforce\n', 'enforce'],
    ['export VAULT_ACL_MODE=enforce\n', ''],
    ['VAULT_ACL_MODE=enforce # strict\n', 'enforce # strict'],
  ])('S21 %j -> %j', async (content, expected) => {
    writeFileSync(join(ROOT, '.env'), content)
    const mod = await import(join(process.cwd(), 'scripts', 'vault-dashboard-client.mjs'))
    expect(mod.envFileSetting(ROOT, 'VAULT_ACL_MODE')).toBe(expected)
  })
})

describe('the mode from the Settings page file', () => {
  const overrides = (content: string) => writeFileSync(join(ROOT, 'store', 'config-overrides.json'), content)
  it('O1 an override of enforce enforces', async () => {
    overrides('{"VAULT_ACL_MODE":"enforce"}')
    const r = await resolveRun('X=A\n', { VAULT_RESOLVE_URL: deadUrl })
    expect(r.code).toBe(5)
    expect(existsSync(IMPORT_LOG)).toBe(false)
  })
  it('O2 the override wins over .env', async () => {
    overrides('{"VAULT_ACL_MODE":"audit"}')
    writeFileSync(join(ROOT, '.env'), 'VAULT_ACL_MODE=enforce\n')
    const r = await resolveRun('X=A\n', { VAULT_RESOLVE_URL: deadUrl })
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('WARNING')
    expect(r.stdout).toBe('X=local-A\n')
  })
  it('O3 an unreadable override file counts as empty', async () => {
    overrides('not json')
    writeFileSync(join(ROOT, '.env'), 'VAULT_ACL_MODE=enforce\n')
    expect((await resolveRun('X=A\n', { VAULT_RESOLVE_URL: deadUrl })).code).toBe(5)
  })
  it('O4 enforce in the environment cannot be undone by the override', async () => {
    overrides('{"VAULT_ACL_MODE":"audit"}')
    expect((await resolveRun('X=A\n', { VAULT_RESOLVE_URL: deadUrl, VAULT_ACL_MODE: 'enforce' })).code).toBe(5)
  })
})

describe('only ids that cannot be sent', () => {
  const L = 'a'.repeat(201)
  it('U1 enforce with a token file: missing, nothing local', async () => {
    const r = await resolveRun(`X=${L}\n`, { VAULT_RESOLVE_URL: deadUrl, VAULT_ACL_MODE: 'enforce' })
    expect(r.code).toBe(3)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('no secret in the vault for label')
    expect(existsSync(IMPORT_LOG)).toBe(false)
  })
  it('U2 audit with a token file: no request, nothing local', async () => {
    const r = await resolveRun(`X=${L}\n`)
    expect(r.code).toBe(3)
    expect(requests).toHaveLength(0)
    expect(existsSync(IMPORT_LOG)).toBe(false)
  })
  it('U3 enforce without a token file: nothing local', async () => {
    rmSync(TOKEN_FILE)
    const r = await resolveRun(`X=${L}\n`, { VAULT_ACL_MODE: 'enforce' })
    expect(r.code).toBe(3)
    expect(existsSync(IMPORT_LOG)).toBe(false)
  })
  it('U4 the headers helper follows the same rule', async () => {
    const arg = `Authorization=Bearer:::${L}`
    const r = await run('vault-headers-helper.mjs', [arg], { env: { VAULT_RESOLVE_URL: deadUrl, VAULT_ACL_MODE: 'enforce' } })
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('{}')
    expect(existsSync(IMPORT_LOG)).toBe(false)
    rmSync(TOKEN_FILE)
    const r2 = await run('vault-headers-helper.mjs', [arg], {})
    expect(r2.stdout).toContain('local-')
  })
  it('U6 a mixed request in the audit fallback: the sendable id locally, the unsendable one missing', async () => {
    const r = await resolveRun(`X=A\nY=${L}\n`, { VAULT_RESOLVE_URL: deadUrl })
    expect(r.code).toBe(3)
    expect(r.stdout).toBe('X=local-A\n')
    expect(r.stderr).toContain('WARNING')
    expect(r.stderr).toContain('no secret in the vault for label')
    const h = await run('vault-headers-helper.mjs', ['Authorization=Bearer:::A', `X-Long=Bearer:::${L}`], { env: { VAULT_RESOLVE_URL: deadUrl } })
    expect(h.stdout).toBe('{"Authorization":"Bearer local-A"}')
  })
  it('U5 the headers helper: either a token file or enforce keeps it off the local vault', async () => {
    const arg = `Authorization=Bearer:::${L}`
    const r = await run('vault-headers-helper.mjs', [arg], {})
    expect(r.stdout).toBe('{}')
    expect(requests).toHaveLength(0)
    rmSync(TOKEN_FILE)
    const r2 = await run('vault-headers-helper.mjs', [arg], { env: { VAULT_ACL_MODE: 'enforce' } })
    expect(r2.stdout).toBe('{}')
    expect(existsSync(IMPORT_LOG)).toBe(false)
  })
})

describe('vault-resolve input handling and batching', () => {
  it('S11 env audit does not undo .env enforce', async () => {
    writeFileSync(join(ROOT, '.env'), 'VAULT_ACL_MODE=enforce\n')
    const r = await resolveRun('X=A\n', { VAULT_RESOLVE_URL: deadUrl, VAULT_ACL_MODE: 'audit' })
    expect(r.code).toBe(5)
  })
  it('S12 a trailing space in the id is trimmed', async () => {
    answer = { values: { A: 'dash-A' }, missing: [], refused: [] }
    const r = await resolveRun('X=A \n')
    expect(r.stdout).toBe('X=dash-A\n')
    expect(requests[0].body).toEqual({ ids: ['A'] })
  })
  it('S13 an empty id is not sent and counts as missing', async () => {
    answer = { values: { A: 'dash-A' }, missing: [], refused: [] }
    const r = await resolveRun('X=A\nY=\n')
    expect(requests).toHaveLength(1)
    expect(requests[0].body).toEqual({ ids: ['A'] })
    expect(r.code).toBe(3)
    expect(r.stdout).toBe('X=dash-A\n')
  })
  it('S14 150 ids go out in two requests of 100 and 50', async () => {
    const input = Array.from({ length: 150 }, (_, i) => `V${i}=id${i}`).join('\n') + '\n'
    const r = await resolveRun(input)
    expect(requests.map(q => q.body.ids.length)).toEqual([100, 50])
    expect(r.code).toBe(3)
  })
  it('S15 malformed input beats exit 5 in enforce with the server closed', async () => {
    const r = await resolveRun('junk\nX=A', { VAULT_RESOLVE_URL: deadUrl, VAULT_ACL_MODE: 'enforce' })
    expect(r.code).toBe(2)
  })
})

describe('vault-headers-helper via the dashboard', () => {
  it('S7 resolves through the dashboard; enforce with the server closed exits 5', async () => {
    answer = { values: { A: 'dash-A' }, missing: [], refused: [] }
    const ok = await headersRun()
    expect(ok.code).toBe(0)
    expect(JSON.parse(ok.stdout)).toEqual({ Authorization: 'Bearer dash-A' })
    expect(existsSync(IMPORT_LOG)).toBe(false)
    const closed = await headersRun({ VAULT_RESOLVE_URL: deadUrl, VAULT_ACL_MODE: 'enforce' })
    expect(closed.code).toBe(5)
  })
})

describe('token and agent name', () => {
  it('S8 the token never reaches stdout or stderr', () => {
    expect(outputs.length).toBeGreaterThan(0)
    for (const o of outputs) expect(o).not.toContain('tok-x')
  })

  it('S10 claimedAgentName', async () => {
    const mod = await import(join(process.cwd(), 'scripts', 'vault-dashboard-client.mjs'))
    const saved = { id: process.env.MARVEEN_AGENT_ID, name: process.env.MARVEEN_AGENT_NAME }
    try {
      process.env.MARVEEN_AGENT_ID = 'from-env'
      expect(mod.claimedAgentName('/srv/app/agents/zz-sub/work')).toBe('from-env')
      delete process.env.MARVEEN_AGENT_ID
      delete process.env.MARVEEN_AGENT_NAME
      expect(mod.claimedAgentName('/srv/app/agents/zz-sub/work')).toBe('zz-sub')
      expect(mod.claimedAgentName('/srv/app')).toBe('')
      expect(mod.claimedAgentName('/x/agents/Bad Name/y')).toBe('')
    } finally {
      if (saved.id !== undefined) process.env.MARVEEN_AGENT_ID = saved.id
      if (saved.name !== undefined) process.env.MARVEEN_AGENT_NAME = saved.name
    }
  })
})
