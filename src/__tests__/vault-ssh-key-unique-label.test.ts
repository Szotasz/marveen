// Two SSH keys under one label looked alike in a server's key dropdown
// ("label (username)") and in the delete question. A label now names one key:
// generate and import refuse a taken label (without case) with a 409, and the
// legacy per-server generate-key, which makes its label up itself, numbers it.
import { describe, it, expect, vi, afterAll } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { RouteContext } from '../web/routes/types.js'

const tmpRoot = mkdtempSync(join(tmpdir(), 'vault-ssh-key-unique-label-'))
afterAll(() => { rmSync(tmpRoot, { recursive: true, force: true }) })
mkdirSync(join(tmpRoot, 'store'), { recursive: true })

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: tmpRoot, STORE_DIR: join(tmpRoot, 'store') }
})

const { initDatabase, listVaultSshKeys, createVaultSshServer } = await import('../db.js')
const { tryHandleVaultSshKeys } = await import('../web/routes/vault-ssh-keys.js')
const { tryHandleVaultSsh } = await import('../web/routes/vault-ssh.js')

initDatabase(':memory:')

function mkRes() {
  return {
    statusCode: 0,
    body: '',
    writeHead(status: number) { this.statusCode = status; return this },
    end(data?: string) { if (data !== undefined) this.body += data },
  }
}

async function call(handler: (ctx: RouteContext) => Promise<boolean>, path: string, body: unknown) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage
  const res = mkRes()
  // VAULTSSHOWNER1109: SSH writes are owner actions; this suite tests the label rule, so the caller is the owner.
  await handler({ req, res: res as unknown as http.ServerResponse, path, method: 'POST', url: new URL(`http://127.0.0.1:3420${path}`), auth: { kind: 'session', user: 'owner' } })
  return { status: res.statusCode, json: JSON.parse(res.body || '{}') }
}

const generate = (label: string, username = 'deploy') => call(tryHandleVaultSshKeys, '/api/vault/ssh-keys', { label, username })
const importKey = (label: string, privateKey: string) => call(tryHandleVaultSshKeys, '/api/vault/ssh-keys/import', { label, username: 'deploy', privateKey })
const labels = () => listVaultSshKeys().map(k => k.label).sort()

function freshPrivateKey(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vault-ssh-key-unique-fixture-'))
  const keyPath = join(dir, 'k')
  try {
    execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', keyPath, '-N', '', '-C', 'fixture'], { stdio: 'pipe' })
    return readFileSync(keyPath, 'utf-8')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('an SSH key label names one key', () => {
  it('generate: a second key under a taken label is refused with 409 label_taken, and nothing is stored', async () => {
    expect((await generate('alma')).status).toBe(201)
    const again = await generate('alma')
    expect(again.status).toBe(409)
    expect(again.json.code).toBe('label_taken')
    expect(labels()).toEqual(['alma'])
  })

  it('the label is compared without case and after trimming', async () => {
    expect((await generate('Alma')).status).toBe(409)
    expect((await generate('  ALMA  ')).status).toBe(409)
    expect(labels()).toEqual(['alma'])
  })

  it('the same username under another label is fine', async () => {
    expect((await generate('korte')).status).toBe(201)
    expect(labels()).toEqual(['alma', 'korte'])
  })

  it('import: a taken label is refused the same way, a free one is imported', async () => {
    const taken = await importKey('alma', freshPrivateKey())
    expect(taken.status).toBe(409)
    expect(taken.json.code).toBe('label_taken')
    expect((await importKey('imported', freshPrivateKey())).status).toBe(201)
    expect(labels()).toEqual(['alma', 'imported', 'korte'])
  })

  it('legacy generate-key numbers the label it makes up instead of refusing', async () => {
    createVaultSshServer({ id: 'web', name: 'web', host: 'web.invalid', port: 22, username: 'deploy', description: null })
    const path = '/api/vault/ssh-servers/web/generate-key'
    expect((await call(tryHandleVaultSsh, path, {})).status).toBe(200)
    expect((await call(tryHandleVaultSsh, path, {})).status).toBe(200)
    expect((await call(tryHandleVaultSsh, path, {})).status).toBe(200)
    expect(labels().filter(l => l.startsWith('web (deploy)'))).toEqual(['web (deploy)', 'web (deploy) 2', 'web (deploy) 3'])
  })
})

describe('the keygen modal says why', () => {
  const APP = readFileSync(new URL('../../web/app.js', import.meta.url), 'utf-8')
  const HU = readFileSync(new URL('../../web/lang/hu.js', import.meta.url), 'utf-8')
  const EN = readFileSync(new URL('../../web/lang/en.js', import.meta.url), 'utf-8')

  it('a label_taken refusal shows the translated toast and puts the focus back on the label', () => {
    const i = APP.indexOf("const res = await fetch('/api/vault/ssh-keys', {")
    expect(i).toBeGreaterThan(-1)
    const handler = APP.slice(i, APP.indexOf('const pubkey =', i))
    expect(handler).toContain("data.code === 'label_taken' ? t('vault.ssh.toast.label_taken', { name: label })")
    expect(handler).toContain("document.getElementById('sshKeygenLabelInput').focus()")
  })

  it('the missing-field toast is translated, no unaccented "Cimke" left', () => {
    expect(APP).not.toContain('Cimke és felhasználónév')
    expect(APP).toContain("showToast(t('vault.ssh.toast.label_user_required'))")
  })

  it.each(['vault.ssh.toast.label_taken', 'vault.ssh.toast.label_user_required'])('%s is in both languages', (key) => {
    expect(HU).toContain(`'${key}':`)
    expect(EN).toContain(`'${key}':`)
  })
})
